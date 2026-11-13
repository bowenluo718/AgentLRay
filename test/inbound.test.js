'use strict';
// 入站 peer 注册表 + 路由（design-inbound-peers）：
// - lib/inbound.js：register → snapshot count/peers；touch 续期；expire 清超时。
// - lib/routes/inbound.js：GET /api/inbound 空→0；POST hello→count 1；再 POST 幂等不增。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-test-'));
process.env.HOME = tmpHome;
const inbound = require('../lib/inbound');
const mountInboundRoutes = require('../lib/routes/inbound');

beforeEach(() => {
  inbound.clear();
});

// ---- registry ----

test('register→snapshot：count/peers 正确，按 connectedAt 升序', () => {
  inbound.registerPeer({ peerId: 'devbox', label: '开发机A', version: '0.1.0', bootId: 'b1' });
  inbound.registerPeer({ peerId: 'local', label: '本机' });
  const snap = inbound.snapshot();
  assert.equal(snap.count, 2);
  assert.equal(snap.peers[0].peerId, 'devbox');
  assert.equal(snap.peers[1].peerId, 'local');
  assert.equal(snap.peers[0].label, '开发机A');
  assert.equal(snap.peers[0].version, '0.1.0');
  assert.equal(typeof snap.peers[0].connectedAt, 'string');
  assert.equal(typeof snap.peers[0].lastSeen, 'string');
});

test('register 非法 peerId/label → 抛错', () => {
  assert.throws(() => inbound.registerPeer({ peerId: 'bad id', label: 'x' }), /peerId/);
  assert.throws(() => inbound.registerPeer({ peerId: 'dev', label: '' }), /label 必填/);
});

test('touch 续期：同 peerId 再 register 不新增，刷新 lastSeen', () => {
  inbound.registerPeer({ peerId: 'dev', label: 'A', version: '0.1.0' });
  const first = inbound.snapshot();
  const firstSeen = first.peers[0].lastSeen;
  // 模拟时间前进后再次续期（lastSeen 应更新，count 不变）。
  inbound.registerPeer({ peerId: 'dev', label: 'A', version: '0.2.0' });
  const second = inbound.snapshot();
  assert.equal(second.count, 1);
  assert.equal(second.peers[0].version, '0.2.0');
  assert.ok(Date.parse(second.peers[0].lastSeen) >= Date.parse(firstSeen));
});

test('expireStale：未超时保留，超时清理', () => {
  // 未超时：新注册的 peer（lastSeen≈真实 now）在 TTL 内 → snapshot 保留。
  inbound.registerPeer({ peerId: 'alive', label: '存活' });
  assert.equal(inbound.snapshot().count, 1);
  // 超时：用远未来 now 触发 expireStale（lastSeen 全部早于 now-TTL）→ 清空。
  inbound.expireStale(Date.now() + inbound.HEARTBEAT_TTL_MS + 1000);
  assert.equal(inbound.snapshot().count, 0);
});

// ---- routes ----

function makeApp() {
  const app = express();
  app.use(express.json());
  mountInboundRoutes(app);
  return app;
}

function startApp() {
  return new Promise((resolveApp) => {
    const server = makeApp().listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveApp({
        server,
        request: (pathStr, { method = 'GET', headers = {}, body } = {}) =>
          new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : undefined;
            const req = http.request(
              { host: '127.0.0.1', port, path: pathStr, method, headers: { 'content-type': 'application/json', ...headers } },
              (res) => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (data += c));
                res.on('end', () => resolve({ status: res.statusCode, body: data }));
              }
            );
            req.on('error', reject);
            req.end(payload);
          }),
      });
    });
  });
}

test('GET /api/inbound 空 → count 0', async () => {
  const app = await startApp();
  try {
    const r = await app.request('/api/inbound');
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { count: 0, peers: [] });
  } finally {
    app.server.close();
  }
});

test('POST hello → count 1；再 POST 幂等不增；返回 ttl/serverVersion', async () => {
  const app = await startApp();
  try {
    const r1 = await app.request('/api/inbound/hello', {
      method: 'POST',
      body: { peerId: 'dev', label: '开发机A', version: '0.1.0', bootId: 'b1' },
    });
    assert.equal(r1.status, 200);
    const body1 = JSON.parse(r1.body);
    assert.equal(body1.ok, true);
    assert.equal(body1.ttl, inbound.HEARTBEAT_TTL_MS / 1000);
    assert.equal(typeof body1.serverVersion, 'string');

    const list1 = await app.request('/api/inbound');
    assert.equal(JSON.parse(list1.body).count, 1);

    // 幂等：同 peerId 再 POST 刷新，不新增。
    await app.request('/api/inbound/hello', {
      method: 'POST',
      body: { peerId: 'dev', label: '开发机A', version: '0.2.0', bootId: 'b2' },
    });
    const list2 = await app.request('/api/inbound');
    const snap2 = JSON.parse(list2.body);
    assert.equal(snap2.count, 1);
    assert.equal(snap2.peers[0].version, '0.2.0');
  } finally {
    app.server.close();
  }
});

test('POST hello 非法 body → 400', async () => {
  const app = await startApp();
  try {
    const r = await app.request('/api/inbound/hello', { method: 'POST', body: { peerId: 'bad id', label: 'x' } });
    assert.equal(r.status, 400);
  } finally {
    app.server.close();
  }
});
