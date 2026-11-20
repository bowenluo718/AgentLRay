'use strict';
// 薄服务（thin service，design-thin-service）后端契约测试：
// - GET /api/mode：完整 → {mode:'full'}，薄 → {mode:'thin',version}。
// - 薄服务 /api/hosts 无 local 宿主（只返回远端）。
// - 薄服务 proxy 不透传系统配置：/api/settings 读写 403、/api/platforms/:id/(mount|replace)
//   写面 403；GET /api/platforms 列表与 GET /api/ui-selection 只读仍转发。
// - 薄服务 dsh 强制 client（role 恒 client，无论存储/请求值）。
// - /api/mode 是本地资源：hostId=remote 时不被转发（403）。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-service-test-'));
process.env.HOME = tmpHome;
process.env.AGENTLRAY_NO_PLUGINS = '1';
const { LOCAL_ID, createHost, setRuntimeForTest, closeHost } = require('../lib/hosts');
const mountProxyRoutes = require('../lib/routes/proxy');
const mountModeRoutes = require('../lib/routes/mode');
const mountHostsRoutes = require('../lib/routes/hosts');
const mountDshRoutes = require('../lib/routes/dsh');

// mock 远端 AgentLRay：数据面 + 只读 ui-selection + platforms 列表。
let remote;
const remotePort = 0;
before(async () => {
  remote = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/api/version')) {
      res.writeHead(200);
      res.end(JSON.stringify({ bootId: 'remote-1', version: '9.9.9' }));
    } else if (req.url.startsWith('/api/sessions')) {
      res.writeHead(200);
      res.end(JSON.stringify([{ id: 's1', platform: 'codex' }]));
    } else if (req.url.startsWith('/api/ui-selection')) {
      res.writeHead(200);
      res.end(JSON.stringify({ selectedPlatforms: ['codex'] }));
    } else if (req.url.startsWith('/api/platforms')) {
      res.writeHead(200);
      res.end(JSON.stringify([{ id: 'codex' }]));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'not found' }));
    }
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  remote.port = remote.address().port;
});
after(() => {
  remote?.close();
  closeHost('remote1');
});

// 组装薄 Express app（挂载顺序对齐 bin/thin-server.js：proxy 网关在前）。
function makeApp() {
  const app = express();
  mountProxyRoutes(app, { thin: true });
  mountModeRoutes(app, { mode: 'thin' });
  app.get('/api/version', (_req, res) => res.json({ bootId: 'thin-1', version: '0.1.1' }));
  app.use(express.json());
  mountHostsRoutes(app, { includeLocal: false });
  mountDshRoutes(app, { forceClient: true });
  // 本地兜底：证明 local 请求未转发（thin 无本地 hosts 行，但 proxy 网关放行 local）。
  app.get('/api/sessions', (_req, res) => res.json([{ where: 'local-thin' }]));
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
            const req = http.request(
              { host: '127.0.0.1', port, path: pathStr, method, headers },
              (res) => {
                let b = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (b += c));
                res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
              }
            );
            req.on('error', reject);
            req.end(body);
          }),
      });
    });
  });
}

test('薄服务 GET /api/mode → {mode:thin, version, capabilities}', async () => {
  const app = express();
  mountProxyRoutes(app, { thin: true });
  mountModeRoutes(app, { mode: 'thin', capabilities: { transports: ['dsh'], nativeSave: true } });
  app.get('/api/version', (_req, res) => res.json({ bootId: 'thin-1', version: '0.1.1' }));
  app.use(express.json());
  mountHostsRoutes(app, { includeLocal: false });
  mountDshRoutes(app, { forceClient: true });
  app.get('/api/sessions', (_req, res) => res.json([{ where: 'local-thin' }]));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/mode`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), {
      mode: 'thin',
      version: '0.1.1',
      capabilities: { transports: ['dsh'], nativeSave: true },
    });
  } finally {
    server.close();
  }
});

test('完整实例 GET /api/mode → {mode:full}（无 version）', async () => {
  const app = express();
  mountModeRoutes(app, { mode: 'full' });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/mode`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { mode: 'full' });
  } finally {
    server.close();
  }
});

test('薄服务 /api/hosts 无 local 宿主', async () => {
  const app = await startApp();
  try {
    const r = await app.request('/api/hosts');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.ok(Array.isArray(body.hosts), '响应应含 hosts 数组');
    assert.ok('lastHostId' in body, '响应应含 lastHostId 顶层字段');
    assert.ok(!body.hosts.some((h) => h.id === LOCAL_ID), '薄服务不应返回 local');
  } finally {
    app.server.close();
  }
});

// 回归守卫（Bug 1 前端 adoptThinHost 依赖的前置契约）：未连上（无运行时）的远端主机
// 在 /api/hosts 里必须如实报 disconnected——前端 thin boot 依据 target.status === 'connected'
// 才 adoptThinHost；若后端对未连主机误报 connected，前端会误采用死主机并置 hostReady。
test('薄服务 /api/hosts 对未连接远端如实报 disconnected（前端 adopt 守卫依赖）', async () => {
  await createHost({ id: 'thin-offline', label: '离线机', ssh: { host: 'offline.invalid' } });
  const app = await startApp();
  try {
    const r = await app.request('/api/hosts');
    assert.equal(r.status, 200);
    const { hosts } = JSON.parse(r.body);
    const target = hosts.find((h) => h.id === 'thin-offline');
    assert.ok(target, '已保存的远端主机应在列表内');
    assert.equal(target.status, 'disconnected', '未连接主机的运行时状态必须为 disconnected');
  } finally {
    app.server.close();
  }
});

test('薄服务 proxy 不透传 /api/settings（GET/PUT 均 403）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remote.port}`);
  const app = await startApp();
  try {
    const get = await app.request('/api/settings', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(get.status, 403);
    const put = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'X-Host-Id': 'remote1', 'content-type': 'application/json' },
      body: JSON.stringify({ kanban: { maxPerStatus: 5 } }),
    });
    assert.equal(put.status, 403);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('薄服务 proxy 不透传 /api/settings/cli-bins（403）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remote.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/settings/cli-bins', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 403);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('薄服务 proxy 不透传 platforms mount/replace 写面（403），列表 GET 仍转发', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remote.port}`);
  const app = await startApp();
  try {
    const mount = await app.request('/api/platforms/codex/mount', {
      method: 'PUT',
      headers: { 'X-Host-Id': 'remote1', 'content-type': 'application/json' },
      body: JSON.stringify({ mounted: true }),
    });
    assert.equal(mount.status, 403);
    const replace = await app.request('/api/platforms/codex/replace', {
      method: 'DELETE',
      headers: { 'X-Host-Id': 'remote1' },
    });
    assert.equal(replace.status, 403);
    // 只读列表仍透传远端。
    const list = await app.request('/api/platforms', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(list.status, 200);
    assert.deepEqual(JSON.parse(list.body), [{ id: 'codex' }]);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('薄服务保留 GET /api/ui-selection 只读透传（恢复远端平台选择）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remote.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/ui-selection', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), { selectedPlatforms: ['codex'] });
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('薄服务数据面仍透传（会话列表转发远端）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remote.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/sessions', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body), [{ id: 's1', platform: 'codex' }]);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('薄服务 /api/mode 是本地资源（hostId=remote 不转发，403）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remote.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/mode', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 403);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('薄服务 dsh 强制 client（GET config role 恒 client）', async () => {
  const app = await startApp();
  try {
    const r = await app.request('/api/dsh/config');
    assert.equal(r.status, 200);
    const cfg = JSON.parse(r.body);
    assert.equal(cfg.role, 'client');
  } finally {
    app.server.close();
  }
});

test('薄服务 dsh PUT config 强制 client（请求 role=host 也被强制）', async () => {
  const app = await startApp();
  try {
    const r = await app.request('/api/dsh/config', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'host', deviceName: 'thin-dev' }),
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).role, 'client');
  } finally {
    app.server.close();
  }
});
