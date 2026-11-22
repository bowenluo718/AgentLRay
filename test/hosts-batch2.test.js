'use strict';
// 批次二（体验与自救）Node 侧用例：
//   A-4 网络切换触发重连（kick：立即探活 → 跳过退避立即重连）
//   A-5 稳定本地端口（ssh / dsh loopback 在 host 生命周期内复用同一端口）
//   A-6 身份 pin 的显式清除入口（删除信任记录后可重连）
// 用本机 mock HTTP 服务模拟远端 AgentLRay；ssh 用 fixtures/ssh-mock.cjs 转发。

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const express = require('express');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-batch2-'));
process.env.HOME = tmpHome;
// 探活缩短到毫秒级；退避故意拉长到 60s —— kick 用例必须证明「跳过退避」，而不是碰巧等到下一档。
process.env.AGENTLRAY_HOST_PROBE_MS = '100';
process.env.AGENTLRAY_HOST_PROBE_TIMEOUT_MS = '300';
process.env.AGENTLRAY_HOST_BACKOFF_MS = '60000';

const {
  HOSTS_FILE,
  openHost,
  closeHost,
  getRuntime,
  kickHost,
  kickAllHosts,
  forgetHostTrust,
  shutdownHosts,
  setRuntimeForTest,
  setReconnectForTest,
} = require('../lib/hosts');
const { pickLocalPort, isPortFree } = require('../lib/transport');
const { createLoopbackEndpoint } = require('../lib/dsh/loopback-client');
const { identityStoreFor } = require('../lib/dsh/identity');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 3000, label = 'condition') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** 取一个当前空闲的本地端口（监听后立刻释放）。 */
async function freePort() {
  const srv = net.createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** mock 远端：GET /api/version → { bootId, version }。返回 { baseUrl, port, close }。 */
function startMockRemote() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bootId: 'mock-boot', version: '9.9.9' }));
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        port,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function writeHosts(hosts) {
  fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
  fs.writeFileSync(HOSTS_FILE, JSON.stringify({ hosts }));
}

beforeEach(() => {
  shutdownHosts();
  try {
    fs.rmSync(HOSTS_FILE);
  } catch {
    /* 不存在则忽略 */
  }
});

after(() => {
  shutdownHosts();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

// ---- A-5 稳定本地端口 ----

test('A-5 pickLocalPort：优先复用空闲的期望端口，被占用时回退随机', async () => {
  const port = await freePort();
  assert.equal(await pickLocalPort(port), port);

  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(port, '127.0.0.1', resolve));
  try {
    const fallback = await pickLocalPort(port);
    assert.notEqual(fallback, port, '端口被占用时必须回退随机端口');
    assert.ok(await isPortFree(fallback));
  } finally {
    await new Promise((resolve) => holder.close(resolve));
  }

  const any = await pickLocalPort(null);
  assert.ok(await isPortFree(any), '未指定期望端口时应返回可用随机端口');
});

test('A-5 loopback 端点：复用期望本地端口，被占用时回退且不报错', async () => {
  const fakeClient = { rpc: async () => ({ status: 200, headers: [], done: true }) };
  const port = await freePort();

  const first = await createLoopbackEndpoint(fakeClient, { port: 3800, localPort: port });
  assert.equal(Number(new URL(first.url).port), port);
  // 同一期望端口再次创建：旧端点仍占用 → 回退随机端口（不抛错）。
  const second = await createLoopbackEndpoint(fakeClient, { port: 3800, localPort: port });
  assert.notEqual(Number(new URL(second.url).port), port);
  await second.close();
  await first.close();
});

test('A-5 ssh 重连前后 baseUrl 不变（稳定本地转发端口）', async () => {
  const remote = await startMockRemote();
  const id = 'stable-port';
  writeHosts([
    {
      id,
      label: id,
      type: 'ssh',
      ssh: { host: '127.0.0.1', remoteAgentLrayPort: remote.port },
    },
  ]);
  process.env.AGENTLRAY_SSH_BIN = path.join(__dirname, 'fixtures', 'ssh-mock.cjs');
  try {
    const first = await openHost(id);
    assert.equal(first.status, 'connected');
    const baseUrl = first.baseUrl;
    assert.ok(first.child, 'ssh 隧道应已建立');

    // 杀链路：子进程退出 → linkLost（退避 60s）→ kick 跳过退避立即重连。
    first.child.kill();
    await waitUntil(() => getRuntime(id)?.phase === 'reconnecting', 4000, 'reconnecting');
    const started = Date.now();
    await kickHost(id);
    await waitUntil(() => getRuntime(id)?.phase === 'connected', 3000, 'reconnected');
    assert.ok(Date.now() - started < 2500, 'kick 必须跳过 60s 退避');
    assert.equal(getRuntime(id).baseUrl, baseUrl, '重连后本地转发端口必须保持不变');
  } finally {
    closeHost(id);
    delete process.env.AGENTLRAY_SSH_BIN;
    await remote.close();
  }
});

// ---- A-4 kick ----

test('A-4 kick：链路健康时只探活，不打断连接、不触发重连', async () => {
  const remote = await startMockRemote();
  const id = 'kick-healthy';
  setRuntimeForTest(id, remote.baseUrl, { bootId: 'boot' });
  const entry = getRuntime(id);
  entry.spec = { id, type: 'ssh' };
  entry.reconnectable = true;
  let reconnectCalls = 0;
  entry.reconnectFn = async () => {
    reconnectCalls += 1;
    return getRuntime(id);
  };
  try {
    const rt = await kickHost(id);
    assert.equal(rt.phase, 'connected');
    assert.equal(reconnectCalls, 0, '健康链路不得触发重连');
    assert.equal(getRuntime(id).phase, 'connected');
  } finally {
    closeHost(id);
    await remote.close();
  }
});

test('A-4 kick：链路已死时跳过 60s 退避立即重连', async () => {
  const remote = await startMockRemote();
  const id = 'kick-dead';
  setRuntimeForTest(id, remote.baseUrl, { bootId: 'boot' });
  const entry = getRuntime(id);
  entry.spec = { id, type: 'ssh' };
  entry.reconnectable = true;
  let calls = 0;
  entry.reconnectFn = async () => {
    calls += 1;
    const rt = getRuntime(id);
    rt.phase = 'connected';
    rt.status = 'connected';
    rt.error = null;
    rt.reconnectable = false;
    return rt;
  };

  await remote.close(); // 链路已死
  const started = Date.now();
  await kickHost(id);
  await waitUntil(() => calls >= 1, 2500, 'immediate reconnect');
  assert.ok(Date.now() - started < 2500, 'kick 不得等待 60s 退避档位');
  assert.equal(getRuntime(id).phase, 'connected');
  closeHost(id);
});

test('A-4 kickAllHosts：对所有运行中的主机执行（网络切换后一次触发）', async () => {
  const ids = ['kick-all-a', 'kick-all-b'];
  for (const id of ids) {
    setRuntimeForTest(id, 'http://127.0.0.1:1', { bootId: 'boot' });
    const entry = getRuntime(id);
    entry.spec = { id, type: 'ssh' };
    entry.reconnectable = true;
    entry.reconnectFn = async () => {
      const rt = getRuntime(id);
      rt.phase = 'connected';
      rt.status = 'connected';
      rt.error = null;
      rt.reconnectable = false;
      return rt;
    };
  }
  const results = await kickAllHosts();
  assert.deepEqual(
    results.map((r) => r.id).sort(),
    ids.slice().sort()
  );
  await waitUntil(() => ids.every((id) => getRuntime(id)?.phase === 'connected'), 3000, 'all reconnected');
  for (const id of ids) closeHost(id);
});

test('A-4 kickHost：未运行的主机不主动建链（返回 null）', async () => {
  assert.equal(await kickHost('never-opened'), null);
});

// A-1/A-6 语义守卫：retryable=false 的失败（KEY_CHANGED / DSH_AUTH_REQUIRED / ...）必须留在
// failed 等用户处理。kick 由系统网络事件触发，若对它重连，就把「须显式忘记此主机」变成自动重试。
test('A-4 kick：failed 且 retryable=false（KEY_CHANGED）不得被网络事件触发重连', async () => {
  const id = 'kick-key-changed';
  const entry = setReconnectForTest(id, { id, type: 'dsh' }, async () => {
    throw new Error('不应被调用');
  });
  // 模拟 finalizeFailure(KEY_CHANGED)：failed + retryable=false（spec 仍在 → reconnectable=true）。
  entry.phase = 'failed';
  entry.status = 'failed';
  entry.error = { code: 'KEY_CHANGED', message: '公钥已变化', retryable: false };

  const rt = await kickHost(id);
  assert.equal(rt.phase, 'failed', 'kick 不得改变不可重试的失败态');
  assert.equal(rt.error.code, 'KEY_CHANGED');
  closeHost(id);
});

test('A-4 kick：failed 且 retryable=true 时跳过退避立即重连', async () => {
  const id = 'kick-transient-failed';
  let calls = 0;
  const entry = setReconnectForTest(id, { id, type: 'ssh' }, async () => {
    calls += 1;
    const rt = getRuntime(id);
    rt.phase = 'connected';
    rt.status = 'connected';
    rt.error = null;
    rt.reconnectable = false;
    return rt;
  });
  entry.phase = 'failed';
  entry.status = 'failed';
  entry.error = { code: 'UNREACHABLE', message: '临时不可达', retryable: true };

  const started = Date.now();
  await kickHost(id);
  await waitUntil(() => calls >= 1, 2500, 'immediate reconnect from transient failed');
  assert.ok(Date.now() - started < 2500, 'kick 不得等待 60s 退避档位');
  assert.equal(getRuntime(id).phase, 'connected');
  closeHost(id);
});

// ---- A-6 身份 pin 清除 ----

const DEVICE_ID = '11111111-1111-4111-8111-111111111111';

function writePeers(scope, deviceId) {
  const store = identityStoreFor(scope);
  fs.mkdirSync(path.dirname(store.peersFile), { recursive: true });
  fs.writeFileSync(
    store.peersFile,
    JSON.stringify({
      schemaVersion: 1,
      peers: [{ deviceId, name: 'peer', platform: 'android', publicKey: 'PUBKEY', fingerprint: 'AAAA BBBB' }],
    })
  );
}

test('A-6 forgetHostTrust：清除 client / probe 信任库中的设备钉扎', async () => {
  writeHosts([
    { id: 'dsh-peer', label: 'dsh', type: 'dsh', dsh: { deviceId: DEVICE_ID, remoteAgentLrayPort: 3800 } },
  ]);
  writePeers('client', DEVICE_ID);
  writePeers('probe', DEVICE_ID);

  const result = await forgetHostTrust('dsh-peer');
  assert.equal(result.deviceId, DEVICE_ID);
  assert.equal(result.removed, 2);
  for (const scope of ['client', 'probe']) {
    const store = identityStoreFor(scope);
    await store.loadPeers();
    assert.equal(store.trustedPeer(DEVICE_ID), undefined, `${scope} 信任库应已清空该设备`);
  }
});

test('A-6 forgetHostTrust：未知主机 not-found、ssh 主机不支持', async () => {
  writeHosts([{ id: 'ssh-peer', label: 'ssh', type: 'ssh', ssh: { host: 'devbox' } }]);
  await assert.rejects(() => forgetHostTrust('no-such'), (e) => e.code === 'not-found');
  await assert.rejects(() => forgetHostTrust('ssh-peer'), (e) => e.code === 'unsupported');
});

// ---- 路由（对外契约）----

test('路由：POST /api/hosts/:id/kick 与 DELETE /api/hosts/:id/trust', async () => {
  writeHosts([
    { id: 'dsh-peer', label: 'dsh', type: 'dsh', dsh: { deviceId: DEVICE_ID, remoteAgentLrayPort: 3800 } },
  ]);
  writePeers('client', DEVICE_ID);
  const app = express();
  require('../lib/routes/hosts')(app, { includeLocal: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  try {
    // 未连接的主机：kick 幂等返回当前状态（不建链）。
    const kick = await fetch(`http://127.0.0.1:${port}/api/hosts/dsh-peer/kick`, { method: 'POST' });
    assert.equal(kick.status, 200);
    const kickBody = await kick.json();
    assert.equal(kickBody.id, 'dsh-peer');
    assert.equal(kickBody.phase, 'disconnected');

    const trust = await fetch(`http://127.0.0.1:${port}/api/hosts/dsh-peer/trust`, { method: 'DELETE' });
    assert.equal(trust.status, 200);
    const trustBody = await trust.json();
    assert.equal(trustBody.deviceId, DEVICE_ID);

    const missing = await fetch(`http://127.0.0.1:${port}/api/hosts/nope/kick`, { method: 'POST' });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// ---- D-1 / A-4 宿主网络状态上报 ----

test('D-1 路由：POST /api/network/status 首次上报不 kick，切网 / DNS 变化触发 kickAllHosts', async () => {
  const network = require('../lib/routes/network');
  network._resetForTest();
  const id = 'net-kick';
  setRuntimeForTest(id, 'http://127.0.0.1:1', { bootId: 'boot' });
  const entry = getRuntime(id);
  entry.spec = { id, type: 'ssh' };
  entry.reconnectable = true;
  let calls = 0;
  // kick 会先探活真实 baseUrl：返回 200 让链路判定为健康，仅验证「触发了探活」。
  // 探活失败路径（链路已死 → 立即重连）已由上方 A-4 用例覆盖。
  const probe = await startMockRemote();
  entry.baseUrl = probe.baseUrl;
  let hits = 0;
  probe.server.on('request', (req) => {
    if (req.url === '/api/version') hits += 1;
  });
  entry.reconnectFn = async () => {
    calls += 1;
    const rt = getRuntime(id);
    rt.phase = 'connected';
    rt.status = 'connected';
    rt.error = null;
    rt.reconnectable = false;
    return rt;
  };

  const app = express();
  app.use(express.json());
  network(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const post = (body) =>
    fetch(`http://127.0.0.1:${port}/api/network/status`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    // 首次上报（无前值）：只记录，不 kick。
    const first = await post({ transport: 'wifi', blocked: false });
    assert.equal(first.status, 200);
    assert.equal((await first.json()).transport, 'wifi');
    await sleep(100);
    assert.equal(calls, 0, '首次上报不得触发 kick');

    // 同一传输方式、无 DNS 变化：不 kick。
    await (await post({ transport: 'wifi', blocked: false })).json();
    await sleep(100);
    assert.equal(calls, 0, '传输方式未变化且 DNS 未变化不得触发 kick');

    // 切网 / DNS 变化 → kick 全部主机（探活即证明已触发；探活失败后走退避，不影响计数）。
    // Wi-Fi → 4G：传输方式变化 → kick（A-4）。
    const switched = await post({ transport: 'cellular', blocked: false });
    assert.equal(switched.status, 200);
    await waitUntil(() => hits >= 1, 2500, 'kick on transport change');

    // DNS 变化同样触发（即使传输方式不变）。
    const before = hits;
    await (await post({ transport: 'cellular', dnsChanged: true })).json();
    await waitUntil(() => hits > before, 2500, 'kick on dns change');

    // 非白名单 transport 归一为 null；GET 读取最近一次上报。
    await (await post({ transport: 'bluetooth-pan' })).json();
    const got = await (await fetch(`http://127.0.0.1:${port}/api/network/status`)).json();
    assert.equal(got.status.transport, null);
    assert.equal(typeof got.serverTime, 'number');
  } finally {
    closeHost(id);
    await new Promise((resolve) => server.close(resolve));
    await probe.close();
    network._resetForTest();
  }
});
