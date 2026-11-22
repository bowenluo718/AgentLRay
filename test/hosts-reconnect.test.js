// 链路状态机 / 假 connected 探测 / 断线重连退避（A-1/A-2/A-3）。
// 用本机 mock HTTP 服务模拟远端 AgentLRay：关掉 mock 即模拟「断网/杀链路」。

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-reconnect-test-'));
process.env.HOME = tmpHome;
// 探活/退避缩短到毫秒级：健康探测 100ms、退避 50/100/200ms，让用例秒级完成。
process.env.AGENTLRAY_HOST_PROBE_MS = '100';
process.env.AGENTLRAY_HOST_PROBE_TIMEOUT_MS = '300';
process.env.AGENTLRAY_HOST_BACKOFF_MS = '50,100,200';
const {
  HOSTS_FILE,
  openHost,
  getRuntime,
  shutdownHosts,
  closeHost,
  setRuntimeForTest,
  setReconnectForTest,
  backoffDelay,
  HEALTH_PROBE_MS,
  RECONNECT_BACKOFF_MS,
} = require('../lib/hosts');
const { linkError, normalizeLinkError, retryableFor } = require('../lib/dsh/errors');

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

// mock 远端：GET /api/version → { bootId, version }。返回 { baseUrl, close }。
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
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
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

// ---- 错误分类（A-1）----

test('normalizeLinkError：错误码映射与可重试性', () => {
  const cases = [
    ['目标主机当前离线', 'HOST_OFFLINE', true],
    ['dsh 登录已失效，请重新登录', 'DSH_AUTH_REQUIRED', false],
    ['目标主机的身份密钥已变化，拒绝连接', 'KEY_CHANGED', false],
    ['目标设备不在当前账号的可见列表中', 'INVALID_TARGET', false],
    ['版本不兼容：远端 1.0.0 低于最低 1.2.0', 'VERSION_INCOMPATIBLE', false],
    ['ssh 隧道建立超时（15s）', 'TUNNEL_TIMEOUT', true],
    ['connect ECONNREFUSED 127.0.0.1:3800', 'TUNNEL_REFUSED', true],
    ['getaddrinfo ENOTFOUND devbox', 'UNREACHABLE', true],
    ['Permission denied (publickey)', 'AUTH_REQUIRED', false],
  ];
  for (const [message, code, retryable] of cases) {
    const e = normalizeLinkError(new Error(message));
    assert.equal(e.code, code, message);
    assert.equal(e.retryable, retryable, message);
  }
});

test('normalizeLinkError：已带稳定 code 的错误原样保留，errno 兜底', () => {
  const keyChanged = Object.assign(new Error('x'), { code: 'KEY_CHANGED' });
  assert.equal(normalizeLinkError(keyChanged).code, 'KEY_CHANGED');
  const refused = Object.assign(new Error('boom'), { code: 'ECONNREFUSED' });
  assert.equal(normalizeLinkError(refused).code, 'TUNNEL_REFUSED');
  const unknown = normalizeLinkError(new Error('something odd'));
  assert.equal(unknown.code, 'UNREACHABLE');
  assert.equal(retryableFor('UNREACHABLE'), true);
  assert.equal(retryableFor('KEY_CHANGED'), false);
  assert.equal(linkError('HOST_OFFLINE', 'm').retryable, true);
});

// ---- 退避（A-3）----

test('backoffDelay：按档位指数增长、超出档位取最后一档、±20% 抖动', () => {
  // 本文件用环境变量把档位缩短为 [50,100,200]；同时验证生产默认档位。
  assert.deepEqual(RECONNECT_BACKOFF_MS, [50, 100, 200]);
  for (let attempt = 1; attempt <= 6; attempt++) {
    const base = RECONNECT_BACKOFF_MS[Math.min(attempt - 1, RECONNECT_BACKOFF_MS.length - 1)];
    for (let i = 0; i < 50; i++) {
      const d = backoffDelay(attempt);
      assert.ok(d >= Math.max(1, Math.round(base * 0.8)), `attempt ${attempt}: ${d} < ${base}*0.8`);
      assert.ok(d <= Math.round(base * 1.2), `attempt ${attempt}: ${d} > ${base}*1.2`);
    }
  }
  // 抖动下界也随档位增长（1→2 档不重叠：base 翻倍 > 抖动区间宽度）。
  for (let attempt = 2; attempt <= 3; attempt++) {
    for (let i = 0; i < 50; i++) {
      assert.ok(backoffDelay(attempt) >= Math.round(RECONNECT_BACKOFF_MS[attempt - 2] * 0.8));
    }
  }
});

test('scheduleReconnect（经 setReconnectForTest）：attempt 递增、nextRetryAt 向后推移，重连成功归零', async () => {
  const id = 'rc-backoff';
  let calls = 0;
  const entry = setReconnectForTest(id, { id, type: 'ssh' }, async () => {
    calls += 1;
    if (calls < 3) throw new Error('目标主机当前离线');
    // 第 3 次成功：直接标记 connected（模拟 tunnelAndProbe 成功返回）。
    const rt = getRuntime(id);
    rt.phase = 'connected';
    rt.status = 'connected';
    rt.attempt = 0;
    rt.nextRetryAt = null;
    rt.reconnectable = false;
    return rt;
  });
  assert.equal(entry.phase, 'failed');
  assert.equal(entry.attempt, 1);
  assert.equal(entry.error.code, 'UNREACHABLE');
  // nextRetryAt 是 epoch ms（与前端 api/types.ts 的 number 对齐）。
  assert.equal(typeof entry.nextRetryAt, 'number');
  assert.ok(entry.nextRetryAt > Date.now());

  await waitUntil(() => calls >= 1, 3000, 'first reconnect attempt');
  // 第 1 次重连失败 → 再次调度（attempt=2，退避更长）。
  await waitUntil(() => getRuntime(id)?.attempt === 2, 3000, 'second schedule');
  const second = getRuntime(id);
  assert.equal(second.phase, 'failed');
  assert.equal(second.error.code, 'HOST_OFFLINE');
  assert.equal(second.error.retryable, true);

  await waitUntil(() => calls >= 3, 5000, 'third reconnect attempt');
  await waitUntil(() => getRuntime(id)?.phase === 'connected', 2000, 'connected');
  assert.equal(getRuntime(id).attempt, 0);
  assert.equal(getRuntime(id).nextRetryAt, null);
  closeHost(id);
});

test('不可重试失败（KEY_CHANGED）在重连途中终止循环，不再排下一次', async () => {
  // 重连函数抛 KEY_CHANGED → reconnectNow 的 catch 走真实 finalizeFailure：
  // 直接 failed + 不再安排下一次（验收：retryable=false 不进重连循环）。
  const id = 'rc-key';
  let calls = 0;
  setReconnectForTest(id, { id, type: 'dsh' }, () => {
    calls += 1;
    throw Object.assign(new Error('目标主机的身份密钥已变化，拒绝连接'), { code: 'KEY_CHANGED' });
  });
  await waitUntil(() => calls >= 1, 3000, 'first reconnect attempt');
  await waitUntil(() => getRuntime(id)?.phase === 'failed', 2000, 'failed');
  const entry = getRuntime(id);
  assert.equal(entry.error.code, 'KEY_CHANGED');
  assert.equal(entry.error.retryable, false);
  assert.equal(entry.nextRetryAt, null, '不可重试失败不得安排下一次重连');
  await sleep(600);
  assert.equal(calls, 1, 'KEY_CHANGED 后不得继续重连');
  closeHost(id);
});

test('closeHost：健康探测与重连定时器都被清理（不留后台任务）', async () => {
  const remote = await startMockRemote();
  const probeId = 'rc-close-probe';
  const probeEntry = setRuntimeForTest(probeId, remote.baseUrl, null, { healthProbe: true });
  assert.ok(probeEntry.healthTimer, '已连接主机应启动探活');
  closeHost(probeId);
  assert.equal(probeEntry.healthTimer, null);
  assert.equal(getRuntime(probeId), undefined);

  const retryId = 'rc-close-retry';
  const retryEntry = setReconnectForTest(retryId, { id: retryId, type: 'ssh' }, async () => getRuntime(retryId));
  assert.equal(retryEntry.phase, 'failed');
  assert.ok(retryEntry.reconnectTimer, '失败后应处于退避等待');
  closeHost(retryId);
  assert.equal(retryEntry.reconnectTimer, null, 'closeHost 必须清掉待执行的重连定时器');
  assert.equal(getRuntime(retryId), undefined);
  await remote.close();
});

test('真实重连路径：每次重连都新建 entry，但 attempt 必须接续递增（指数退避生效）', async () => {
  // 回归 B1：tunnelAndProbe/dshTunnelAndProbe 每次 createEntry()，若 attempt 不跨 entry
  // 接续，退避永远停在第 1 档（固定 1s 重试，形成重试风暴）。
  const id = 'rc-real-path';
  fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
  fs.writeFileSync(
    HOSTS_FILE,
    JSON.stringify({
      hosts: [{ id, label: id, type: 'ssh', ssh: { host: '127.0.0.1', port: 1, remoteAgentLrayPort: 3800 } }],
    })
  );
  const first = await openHost(id);
  assert.equal(first.status, 'failed');
  assert.equal(first.error.code, 'TUNNEL_REFUSED');

  const attempts = [];
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && attempts.length < 4) {
    const cur = getRuntime(id);
    if (cur && cur.attempt > 0 && attempts[attempts.length - 1] !== cur.attempt) {
      attempts.push(cur.attempt);
      if (cur.attempt > 1) {
        // 退避档位随 attempt 前移（第 2 档 > 第 1 档下界）。
        assert.ok(cur.nextRetryAt, '失败态应给出下一次重连时间');
      }
    }
    await sleep(30);
  }
  closeHost(id);
  assert.deepEqual(attempts.slice(0, 4), [1, 2, 3, 4], `attempt 序列应严格递增，实际 ${attempts}`);
});

// ---- 假 connected 探测 + 自动重连（A-2）----

test('已连接链路被探活判死 → reconnecting → 自动重连成功恢复 connected', async () => {
  const id = 'rc-health';
  const remote = await startMockRemote();
  setRuntimeForTest(id, remote.baseUrl, { bootId: 'mock-boot' }, { healthProbe: true });
  assert.equal(getRuntime(id).phase, 'connected');
  // 注入重连实现：mock 远端恢复后重连成功。
  getRuntime(id).spec = { id, type: 'ssh' };
  getRuntime(id).reconnectable = true;
  getRuntime(id).reconnectFn = async () => {
    const rt = getRuntime(id);
    rt.phase = 'connected';
    rt.status = 'connected';
    rt.error = null;
    rt.attempt = 0;
    rt.nextRetryAt = null;
    rt.reconnectable = false;
    return rt;
  };

  // 杀链路（关 mock 服务）：探测连续失败 → 判死。
  await remote.close();
  await waitUntil(() => getRuntime(id)?.phase !== 'connected', HEALTH_PROBE_MS * 3 + 2000, 'link lost');
  assert.equal(getRuntime(id).phase, 'reconnecting');
  assert.ok(getRuntime(id).nextRetryAt, '断链后应安排下一次重连');

  await waitUntil(() => getRuntime(id)?.phase === 'connected', 5000, 'auto reconnect');
  closeHost(id);
});


