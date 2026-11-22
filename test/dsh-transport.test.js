'use strict';
// dsh 远程主机连接（design-dsh-host-connection）：
// - hosts.json 的 type=dsh 目标规范化与 CRUD（不含 ssh 凭据字段）。
// - hosts.json 顶层 dsh section：密码加密落盘、角色/服务器/放行端口校验，
//   以及旧 settings.json dsh section 的一次性迁移（migrateDshSectionOnce）。
// - inbound peer 的 via 字段（ssh / dsh）。
// - loopback 通道：请求校验、放行端口闸门、连接方↔被连接方的真实 HTTP 转发往返。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-test-'));
process.env.HOME = tmpHome;

const { normalizeHost, listHosts, createHost, updateHost, deleteHost } = require('../lib/hosts');
const {
  loadDshSettings,
  saveDshSettings,
  migrateDshSectionOnce,
  normalizeServerUrl,
} = require('../lib/dsh/settings');
const { HOSTS_FILE } = require('../lib/hosts');
const { SETTINGS_FILE } = require('../lib/settings');
const { registerPeer, snapshot, clear } = require('../lib/inbound');
const { parseLoopbackRequest } = require('../lib/dsh/loopback');
const { DshLoopbackHost } = require('../lib/dsh/loopback-host');
const { TUNNEL_HEADER, tunnelSecret } = require('../lib/tunnel-headers');
const { createLoopbackEndpoint } = require('../lib/dsh/loopback-client');
const { createHostRouter } = require('../lib/dsh/host');

beforeEach(async () => {
  clear();
  try {
    fs.rmSync(SETTINGS_FILE);
  } catch {
    /* 不存在则忽略 */
  }
  try {
    fs.rmSync(HOSTS_FILE);
  } catch {
    /* 不存在则忽略 */
  }
});

// ---- hosts.json：type=dsh 目标 ----

test('normalizeHost：dsh 目标只保留设备 id 与远端端口（默认 3800）', () => {
  const h = normalizeHost({ id: 'remote', label: '远端', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  assert.equal(h.type, 'dsh');
  assert.deepEqual(h.dsh, { deviceId: 'dev-1', remoteAgentLrayPort: 3800 });
  // dsh 目标不带 ssh 凭据字段（避免与 ssh 主机混淆）。
  assert.equal(h.ssh, undefined);
});

test('normalizeHost：dsh 目标缺 deviceId / 端口越界均拒绝', () => {
  assert.throws(() => normalizeHost({ id: 'a', label: 'x', type: 'dsh', dsh: {} }), /dsh\.deviceId 必填/);
  assert.throws(
    () => normalizeHost({ id: 'a', label: 'x', type: 'dsh', dsh: { deviceId: 'd', remoteAgentLrayPort: 0 } }),
    /dsh\.remoteAgentLrayPort/
  );
  assert.throws(
    () => normalizeHost({ id: 'a', label: 'x', type: 'dsh', dsh: { deviceId: 'd', remoteAgentLrayPort: 70000 } }),
    /dsh\.remoteAgentLrayPort/
  );
});

test('dsh 主机 CRUD：落盘只有 dsh 字段，编辑不误伤 ssh 凭据分支', async () => {
  const created = await createHost({ id: 'remote', label: '远端', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  assert.equal(created.type, 'dsh');
  assert.deepEqual(created.dsh, { deviceId: 'dev-1', remoteAgentLrayPort: 3800 });

  const raw = JSON.parse(fs.readFileSync(path.join(tmpHome, '.agentlray', 'hosts.json'), 'utf8'));
  assert.equal(raw.hosts.length, 1);
  assert.equal(raw.hosts[0].ssh, undefined);

  // 编辑（改端口）不能因缺少 ssh 段而报错。
  const updated = await updateHost('remote', {
    label: '远端2',
    type: 'dsh',
    dsh: { deviceId: 'dev-1', remoteAgentLrayPort: 3999 },
  });
  assert.equal(updated.dsh.remoteAgentLrayPort, 3999);
  assert.equal((await listHosts())[0].label, '远端2');

  await deleteHost('remote');
  assert.equal((await listHosts()).length, 0);
});

// ---- hosts.json 顶层 dsh section ----

test('dsh 设置：账号密码不落盘（design-dsh-login-methods D4）', async () => {
  await saveDshSettings({ role: 'host', serverUrl: 'http://127.0.0.1:18123', email: 'a@b.c', password: 's3cret-pw' });
  const stored = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.equal(stored.dsh.role, 'host');
  // 账号密码不再写入 hosts.json（新模型不落盘）。
  assert.equal(stored.dsh.email, undefined);
  assert.equal(stored.dsh.passwordEnc, undefined);
  // 明文密码也不得落盘。
  assert.equal(JSON.stringify(stored).includes('s3cret-pw'), false);
  // 明文密码不出现于任何文件。
  if (fs.existsSync(SETTINGS_FILE)) {
    assert.equal(JSON.stringify(fs.readFileSync(SETTINGS_FILE, 'utf8')).includes('s3cret-pw'), false);
  }

  const view = await loadDshSettings();
  assert.equal(view.email, undefined); // 清理：配置视图不含账号密码字段
  assert.equal(view.passwordEnc, undefined);
  assert.equal(view.hasPassword, undefined);
});

test('dsh 设置：账号密码参数被忽略、绝不持久化', async () => {
  await saveDshSettings({ email: 'a@b.c', password: 'first-pw' });
  await saveDshSettings({ role: 'client' });
  // 全程不落账号密码。
  const stored = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.equal(stored.dsh.email, undefined);
  assert.equal(stored.dsh.passwordEnc, undefined);
  // 配置字段照常保存。
  assert.equal(stored.dsh.role, 'client');
});

test('dsh 设置：非法角色 / 服务器地址 / 放行端口均拒绝', async () => {
  await assert.rejects(() => saveDshSettings({ role: 'peer' }), /dsh\.role/);
  await assert.rejects(() => saveDshSettings({ serverUrl: 'ftp://x' }), /dsh\.serverUrl/);
  await assert.rejects(() => saveDshSettings({ allowedPorts: [0] }), /dsh\.allowedPorts/);
});

test('normalizeServerUrl：主机名合法性——拒绝单段/畸形地址，放行域名、IP 与 localhost', async () => {
  // 单段主机名（无点）拒绝：避免被内网 DNS 搜索域静默补全到错误主机。
  assert.throws(() => normalizeServerUrl('https://relay'), /主机名无效/);
  // 畸形 URL 拒绝。
  assert.throws(() => normalizeServerUrl('https://'), /不是合法地址/);
  // localhost 放行：解析走 /etc/hosts，不受搜索域影响，PC 自托管中继是合法场景。
  assert.equal(normalizeServerUrl('http://localhost:3800'), 'http://localhost:3800');
  // 合法域名 / IPv4 / IPv6 放行，且保留原大小写与路径、仅去尾部斜杠。
  assert.equal(normalizeServerUrl('https://dsh.r2049.cn/'), 'https://dsh.r2049.cn');
  assert.equal(normalizeServerUrl('http://127.0.0.1:18123'), 'http://127.0.0.1:18123');
  assert.equal(normalizeServerUrl('http://[::1]:3800'), 'http://[::1]:3800');
  assert.equal(normalizeServerUrl('https://Example.COM/base/'), 'https://Example.COM/base');
  // 空值仍归一为空串（不改既有语义）。
  assert.equal(normalizeServerUrl(''), '');
});

test('dsh 设置：保存单段服务器地址被拒绝（服务端兜底）', async () => {
  await assert.rejects(() => saveDshSettings({ serverUrl: 'https://relay' }), /dsh\.serverUrl/);
});

test('dsh 设置：放行端口去重且保序，默认 [3800]', async () => {
  assert.deepEqual((await loadDshSettings()).allowedPorts, [3800]);
  await saveDshSettings({ allowedPorts: [3801, 3801, 8080] });
  assert.deepEqual((await loadDshSettings()).allowedPorts, [3801, 8080]);
});

test('dsh 迁移：settings.json 旧 dsh 首次读取拷入 hosts.json（不含账号密码），且幂等', async () => {
  // 种旧数据：settings.json 顶层 dsh（含旧 email/passwordEnc）。
  fs.writeFileSync(
    SETTINGS_FILE,
    JSON.stringify({
      dsh: {
        role: 'host',
        serverUrl: 'http://127.0.0.1:18123',
        email: 'a@b.c',
        passwordEnc: 'v1:legacycipher',
        deviceName: 'legacybox',
        allowedPorts: [3800, 8080],
      },
    })
  );
  await migrateDshSectionOnce();
  const file = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  // 只迁移配置字段，旧 email/passwordEnc 不搬（账号密码不落盘，D4）。
  assert.deepEqual(file.dsh, {
    role: 'host',
    serverUrl: 'http://127.0.0.1:18123',
    deviceName: 'legacybox',
    allowedPorts: [3800, 8080],
  });
  // 幂等：再次迁移不覆盖（改 hosts.json 的 dsh 后再跑一次，保持新值）。
  file.dsh.serverUrl = 'http://127.0.0.1:19999';
  fs.writeFileSync(HOSTS_FILE, JSON.stringify(file));
  await migrateDshSectionOnce();
  assert.equal(JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).dsh.serverUrl, 'http://127.0.0.1:19999');
  // loadDshSettings 返回迁移后的配置（不含账号密码字段）。
  const view = await loadDshSettings();
  assert.equal(view.deviceName, 'legacybox');
  assert.equal(view.email, undefined);
  assert.equal(view.passwordEnc, undefined);
});

test('dsh 迁移：settings.json 无 dsh 时迁移为 no-op', async () => {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ui: {} }));
  await migrateDshSectionOnce();
  assert.equal(fs.existsSync(HOSTS_FILE), false);
});

test('hosts.json 顶层 dsh：主机 CRUD 写盘不冲掉 dsh 配置', async () => {
  await saveDshSettings({ role: 'both', serverUrl: 'http://127.0.0.1:18123' });
  await createHost({ id: 'remote', label: '远端', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  let file = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.equal(file.hosts.length, 1);
  assert.ok(file.dsh); // 顶层 dsh 保留
  assert.equal(file.dsh.role, 'both');

  await updateHost('remote', { label: '远端2', type: 'dsh', dsh: { deviceId: 'dev-1', remoteAgentLrayPort: 3999 } });
  file = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.equal(file.hosts[0].label, '远端2');
  assert.equal(file.dsh.role, 'both'); // 顶层 dsh 仍保留
});

// ---- inbound peer：via 字段 ----

test('inbound peer：默认 ssh，显式 dsh；快照带 via', () => {
  registerPeer({ peerId: 'peer-a', label: 'A' });
  registerPeer({ peerId: 'peer-b', label: 'B', via: 'dsh' });
  const snap = snapshot();
  assert.equal(snap.count, 2);
  assert.equal(snap.peers.find((p) => p.peerId === 'peer-a').via, 'ssh');
  assert.equal(snap.peers.find((p) => p.peerId === 'peer-b').via, 'dsh');
});

test('inbound peer：同一 peer 再次上报刷新 via', () => {
  registerPeer({ peerId: 'peer-a', label: 'A', via: 'dsh' });
  registerPeer({ peerId: 'peer-a', label: 'A2' });
  assert.equal(snapshot().peers[0].via, 'ssh');
});

// ---- loopback 通道 ----

test('loopback 请求校验：非法操作/端口/路径/首部/请求体均拒绝', () => {
  assert.throws(() => parseLoopbackRequest({ op: 'tcp.open' }), /不支持的 loopback 操作/);
  assert.throws(() => parseLoopbackRequest({ op: 'http.open', id: 'i', port: 80 }), /1024–65535/);
  assert.throws(
    () => parseLoopbackRequest({ op: 'http.open', id: 'i', port: 3800, path: 'no-slash', method: 'GET' }),
    /路径非法/
  );
  assert.throws(
    () => parseLoopbackRequest({ op: 'http.open', id: 'i', port: 3800, path: '/x', method: 'TRACE' }),
    /HTTP 方法/
  );
  assert.throws(
    () => parseLoopbackRequest({ op: 'http.open', id: 'i', port: 3800, path: '/x', method: 'GET', headers: [['bad header', 'v']] }),
    /首部名非法/
  );
  assert.throws(
    () => parseLoopbackRequest({ op: 'http.open', id: 'i', port: 3800, path: '/x', method: 'GET', body: 'not base64!' }),
    /base64/
  );
});

test('loopback 宿主：未放行端口拒绝，放行端口真实转发到本机 HTTP 服务', async (t) => {
  const seen = {};
  const backend = http.createServer((req, res) => {
    seen.headers = req.headers;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ hit: req.url }));
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const backendPort = backend.address().port;
  const host = new DshLoopbackHost(() => [backendPort]);
  t.after(() => host.closeAll());

  assert.deepEqual((await host.call({ op: 'describe' })).ports, [backendPort]);
  await assert.rejects(() => host.call({ op: 'http.open', id: 'x', port: backendPort + 1, path: '/a', method: 'GET' }), /未在 dsh 放行列表/);

  const head = await host.call({ op: 'http.open', id: 'x', port: backendPort, path: '/a', method: 'GET' });
  assert.equal(head.status, 200);
  // 响应可能分多块返回：读到 done 为止。
  let body = '';
  for (;;) {
    const chunk = await host.call({ op: 'http.read', id: 'x' });
    body += Buffer.from(chunk.data, 'base64').toString('utf8');
    if (chunk.done) break;
  }
  assert.equal(body, '{"hit":"/a"}');
  // 隧道内可信标记（C-1 信任连接认证）：被连接方进程密钥注入，本机其他进程无法伪造。
  assert.equal(seen.headers[TUNNEL_HEADER], tunnelSecret());
});

test('真实 API app 挂在 unix socket 上：loopback 宿主请求免令牌，TCP 端口仍 401', async (t) => {
  const express = require('express');
  const { apiAuthGuard } = require('../lib/auth');
  const { startInboundSocket, inboundSocketPath } = require('../lib/inbound-socket');
  const sockHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sock-'));
  t.after(() => fs.rmSync(sockHome, { recursive: true, force: true }));

  const app = express();
  app.use('/api', apiAuthGuard({ token: 'tok-0123456789', isRemoteHost: async () => false }));
  app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
  const sock = await startInboundSocket({ app, home: sockHome });
  t.after(() => sock.close());
  const tcp = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => tcp.once('listening', resolve));
  t.after(() => new Promise((resolve) => tcp.close(resolve)));

  const tcpPort = tcp.address().port;
  const host = new DshLoopbackHost(() => [tcpPort, 1]);
  t.after(() => host.closeAll());

  // 对照组：本机 TCP 直连没有令牌 → 401。
  assert.equal((await fetch(`http://127.0.0.1:${tcpPort}/api/sessions`)).status, 401);

  // 被连接方在 unix socket 上听同一个 app：宿主按 socket 路径转发（dsh 放行列表即 socket 路径）。
  const file = inboundSocketPath(sockHome);
  const socketHost = new DshLoopbackHost(() => [file]);
  t.after(() => socketHost.closeAll());
  const head = await socketHost.call({ op: 'http.open', id: 's1', port: file, path: '/api/sessions', method: 'GET' });
  assert.equal(head.status, 200);
  let body = '';
  for (;;) {
    const chunk = await socketHost.call({ op: 'http.read', id: 's1' });
    body += Buffer.from(chunk.data, 'base64').toString('utf8');
    if (chunk.done) break;
  }
  assert.deepEqual(JSON.parse(body), { ok: true });
});

test('loopback 连接方端点：请求经通道转发到远端端口并回传响应', async (t) => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`remote:${req.url}`);
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => backend.close(resolve)));
  const backendPort = backend.address().port;

  // 假连接方：把 loopback.call 直接交给被连接方宿主（等价于加密通道内的一次 RPC）。
  const host = new DshLoopbackHost(() => [backendPort]);
  t.after(() => host.closeAll());
  const fakeClient = {
    async rpc(method, params) {
      assert.equal(method, 'loopback.call');
      return host.call(params);
    },
  };

  const endpoint = await createLoopbackEndpoint(fakeClient, { port: backendPort });
  t.after(() => endpoint.close());
  const response = await fetch(`${endpoint.url}/ping?x=1`);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'remote:/ping?x=1');
});

test('host 路由：loopback.call 透传，未知方法返回 METHOD_NOT_FOUND', async () => {
  const host = new DshLoopbackHost(() => [3800]);
  const router = createHostRouter(host);
  const ok = await router.handle({ id: 'r1', type: 'rpc.request', payload: { method: 'loopback.call', params: { op: 'describe' } } });
  assert.equal(ok.type, 'rpc.response');
  assert.deepEqual(ok.payload.result.ports, [3800]);

  const bad = await router.handle({ id: 'r2', type: 'rpc.request', payload: { method: 'codex.app.call', params: {} } });
  assert.equal(bad.type, 'rpc.error');
  assert.equal(bad.payload.code, 'METHOD_NOT_FOUND');
  host.closeAll();
});
