'use strict';
// dsh 远程主机连接（design-dsh-host-connection）：
// - hosts.json 的 type=dsh 目标规范化与 CRUD（不含 ssh 凭据字段）。
// - settings.json 的 dsh section：密码加密落盘、角色/服务器/放行端口校验。
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
const { loadDshSettings, saveDshSettings, loadDshCredentials } = require('../lib/dsh/settings');
const { SETTINGS_FILE } = require('../lib/settings');
const { registerPeer, snapshot, clear } = require('../lib/inbound');
const { parseLoopbackRequest } = require('../lib/dsh/loopback');
const { DshLoopbackHost } = require('../lib/dsh/loopback-host');
const { createLoopbackEndpoint } = require('../lib/dsh/loopback-client');
const { createHostRouter } = require('../lib/dsh/host');

beforeEach(async () => {
  clear();
  try {
    fs.rmSync(SETTINGS_FILE);
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

// ---- settings.json：dsh section ----

test('dsh 设置：密码加密落盘、GET 视图只给 hasPassword', async () => {
  await saveDshSettings({ role: 'host', serverUrl: 'http://127.0.0.1:18123', email: 'a@b.c', password: 's3cret-pw' });
  const stored = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  assert.equal(stored.dsh.role, 'host');
  assert.equal(stored.dsh.email, 'a@b.c');
  assert.ok(stored.dsh.passwordEnc.startsWith('v1:'));
  // 明文密码不得落盘。
  assert.equal(JSON.stringify(stored).includes('s3cret-pw'), false);

  const view = await loadDshSettings();
  assert.equal(view.hasPassword, true);
  assert.equal(view.passwordEnc.startsWith('v1:'), true);
  assert.equal((await loadDshCredentials()).password, 's3cret-pw');
});

test('dsh 设置：密码缺省保留、空串清除', async () => {
  await saveDshSettings({ email: 'a@b.c', password: 'first-pw' });
  await saveDshSettings({ role: 'client' });
  assert.equal((await loadDshCredentials()).password, 'first-pw');
  await saveDshSettings({ password: '' });
  assert.equal((await loadDshSettings()).hasPassword, false);
  assert.equal(await loadDshCredentials(), null);
});

test('dsh 设置：非法角色 / 服务器地址 / 放行端口均拒绝', async () => {
  await assert.rejects(() => saveDshSettings({ role: 'peer' }), /dsh\.role/);
  await assert.rejects(() => saveDshSettings({ serverUrl: 'ftp://x' }), /dsh\.serverUrl/);
  await assert.rejects(() => saveDshSettings({ allowedPorts: [0] }), /dsh\.allowedPorts/);
});

test('dsh 设置：放行端口去重且保序，默认 [3800]', async () => {
  assert.deepEqual((await loadDshSettings()).allowedPorts, [3800]);
  await saveDshSettings({ allowedPorts: [3801, 3801, 8080] });
  assert.deepEqual((await loadDshSettings()).allowedPorts, [3801, 8080]);
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
  const backend = http.createServer((req, res) => {
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
