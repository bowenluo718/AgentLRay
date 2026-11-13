'use strict';
// 网关 host 路由中间件（multi-host，P0）：
// - X-Host-Id=local（或缺省）→ next() 走本地路由。
// - 远端 connected → 转发到隧道 baseUrl（数据面）。
// - 写设置面（settings / platforms mount|replace / cli-bins）→ 403。
// - 远端未连接 → 503。
// 用测试专用 setRuntimeForTest 注入 connected 运行时（指向本机 mock server），
// 避免真实 ssh spawn 依赖。

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'));
process.env.HOME = tmpHome;
const { LOCAL_ID, setRuntimeForTest, closeHost } = require('../lib/hosts');
const mountProxyRoutes = require('../lib/routes/proxy');
const { isConsentedWrite } = mountProxyRoutes;

// mock 远端 AgentLRay：模拟 /api/version /api/sessions（数据面）+ /api/settings（写面）。
let remote; // http.Server
const remotePorts = {};
// 记录 mock 收到的最后一个 URL（断言转发是否剥离 ?host= / X-Host-Id）。
let receivedUrl = null;
// 记录 mock 收到的最后一个请求体（POST 透传 body 断言）。
let receivedBody = null;

before(async () => {
  remote = http.createServer((req, res) => {
    receivedUrl = req.url;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      receivedBody = body;
      res.setHeader('content-type', 'application/json');
      if (req.url.startsWith('/api/version')) {
        res.writeHead(200);
        res.end(JSON.stringify({ bootId: 'remote-1', version: '9.9.9' }));
      } else if (req.url.startsWith('/api/sessions')) {
        res.writeHead(200);
        res.end(JSON.stringify([{ id: 's1', platform: 'codex' }]));
      } else if (req.url.startsWith('/api/watch')) {
        res.writeHead(200);
        res.end(JSON.stringify({ sse: 'ok' }));
      } else if (req.url.startsWith('/api/ui-selection')) {
        res.writeHead(200);
        res.end(JSON.stringify({ selectedPlatforms: ['codex'] }));
      } else if (req.url.startsWith('/api/prompts/analyze')) {
        res.writeHead(200);
        res.end(JSON.stringify({ clusters: ['c1'], llm: true }));
      } else if (req.url.startsWith('/api/prompts/rewrite')) {
        res.writeHead(200);
        res.end(JSON.stringify({ rewritten: true }));
      } else if (req.url.includes('/sessions/new')) {
        res.writeHead(200);
        res.end(JSON.stringify({ triggered: true, platform: 'codex' }));
      } else if (req.url.includes('/resume-command')) {
        res.writeHead(200);
        res.end(JSON.stringify({ supported: true, bin: 'codex', args: ['-r'], command: 'codex resume s1' }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });
  });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  remotePorts.port = remote.address().port;
});

after(() => {
  remote?.close();
  closeHost('remote1');
});

// 本地路由：「local 走本地」验证用（返回固定 JSON，证明未转发到远端）。
// 挂载顺序对齐生产 server.js：proxy 网关在 express.json 之前（透传原始 body 流）。
function makeApp() {
  const app = express();
  mountProxyRoutes(app);
  app.use(express.json());
  app.get('/api/hello', (_req, res) => res.json({ where: 'local' }));
  app.get('/api/settings', (_req, res) => res.json({ where: 'settings' }));
  app.put('/api/settings', (_req, res) => res.json({ ok: 'local-settings' }));
  app.get('/api/platforms/x/mount', (_req, res) => res.json({ ok: 'local' }));
  app.get('/api/hosts', (_req, res) => res.json([{ id: 'local' }]));
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
                let body = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (body += c));
                res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
              }
            );
            req.on('error', reject);
            req.end(body);
          }),
      });
    });
  });
}

// P1 合意写放行审计登记：resume/create + prompts analyze/rewrite 显式入册（写面网关放行审计）。
test('P1 合意写放行审计登记（resume/create + prompts analyze/rewrite）', () => {
  assert.equal(isConsentedWrite('GET', '/api/prompts/analyze'), true);
  assert.equal(isConsentedWrite('POST', '/api/prompts/rewrite'), true);
  assert.equal(isConsentedWrite('POST', '/api/codex/sessions/new'), true);
  assert.equal(isConsentedWrite('POST', '/api/omp/sessions/new'), true);
  // resume-command 是 GET 数据面，不属于合意写登记；写设置面不受合意登记放行。
  assert.equal(isConsentedWrite('GET', '/api/codex/sessions/s1/resume-command'), false);
  assert.equal(isConsentedWrite('PUT', '/api/settings'), false);
  assert.equal(isConsentedWrite('PUT', '/api/platforms/codex/mount'), false);
});

test('X-Host-Id 缺省/local → 走本地路由（未转发）', async () => {
  const app = await startApp();
  try {
    const r = await app.request('/api/hello');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).where, 'local');
    const rLocal = await app.request('/api/hello', { headers: { 'X-Host-Id': 'local' } });
    assert.equal(JSON.parse(rLocal.body).where, 'local');
  } finally {
    app.server.close();
  }
});

test('X-Host-Id=remote（connected）→ 数据面转发到 mock 远端', async () => {
  // 注入远端 connected 运行时，baseUrl 指向 mock server。
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/version', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).bootId, 'remote-1');
    const sessions = await app.request('/api/sessions', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(sessions.status, 200);
    assert.equal(JSON.parse(sessions.body)[0].id, 's1');
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('X-Host-Id=?host= query（SSE 场景）→ 同样转发', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/version?host=remote1');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).bootId, 'remote-1');
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('SSE ?host= 转发剥离 host 参数（远端不再二次路由 → 不 503）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    // 远端 mock 收到 /api/watch?host=remote1 会被剥离成 /api/watch。
    const r = await app.request('/api/watch?host=remote1&platform=codex&sessionId=s1');
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).sse, 'ok');
    // 转发路径不含 host 参数，但保留其余 query（platform/sessionId）。
    assert.equal(receivedUrl, '/api/watch?platform=codex&sessionId=s1');
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('本机设置（PUT /api/settings）远端 → 本地化走本地路由（200 本地 mock）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/settings', {
      method: 'PUT',
      headers: { 'X-Host-Id': 'remote1', 'content-type': 'application/json' },
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).ok, 'local-settings');
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('本机设置（GET /api/settings）远端 → 本地化走本地路由（200 本地 mock）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/settings', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).where, 'settings');
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('GET /api/ui-selection 远端 → 透传取远端真源', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
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

test('GET /api/settings/cli-bins 远端 → 仍 403（本机化仅精确匹配 /api/settings）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/settings/cli-bins', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 403);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('写设置面（platforms/:id/mount）远端 → 403', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/platforms/codex/mount', {
      method: 'PUT',
      headers: { 'X-Host-Id': 'remote1', 'content-type': 'application/json' },
    });
    assert.equal(r.status, 403);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('主机管理（/api/hosts）远端 → 403 不透传（本地网关资源）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/hosts', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 403);
    const rSub = await app.request('/api/hosts/abc/test', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(rSub.status, 403);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('远端未连接 → 503', async () => {
  closeHost('remote1'); // 确保未连接
  const app = await startApp();
  try {
    const r = await app.request('/api/sessions', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 503);
    assert.match(r.body, /未连接/);
  } finally {
    app.server.close();
  }
});

// ---- P1 合意写透传（design R2-Q5 / R3-Q6）----
// resume/create + prompts analyze/rewrite 在选中主机的远端真实执行，代理放行透传。

test('P1 create（POST /api/:platform/sessions/new）远端 → 透传 body', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const payload = JSON.stringify({ message: 'hello', cwd: '/tmp/x' });
    const r = await app.request('/api/codex/sessions/new', {
      method: 'POST',
      headers: { 'X-Host-Id': 'remote1', 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).triggered, true);
    // 远端收到完整请求体（原始 body 流透传，未被网关 json parser 消费）。
    assert.equal(receivedBody, payload);
    assert.match(receivedUrl, /^\/api\/codex\/sessions\/new$/);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('P1 resume-command（GET /api/:platform/sessions/:id/resume-command）远端 → 透传', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/codex/sessions/s1/resume-command', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).supported, true);
    assert.equal(JSON.parse(r.body).command, 'codex resume s1');
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('P1 prompts analyze（GET /api/prompts/analyze）远端 → 透传（远端 LLM 后端）', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const r = await app.request('/api/prompts/analyze?platform=codex', { headers: { 'X-Host-Id': 'remote1' } });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).llm, true);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});

test('P1 prompts rewrite（POST /api/prompts/rewrite）远端 → 透传 body', async () => {
  setRuntimeForTest('remote1', `http://127.0.0.1:${remotePorts.port}`);
  const app = await startApp();
  try {
    const payload = JSON.stringify({ text: '写个排序' });
    const r = await app.request('/api/prompts/rewrite', {
      method: 'POST',
      headers: { 'X-Host-Id': 'remote1', 'content-type': 'application/json' },
      body: payload,
    });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).rewritten, true);
    assert.equal(receivedBody, payload);
  } finally {
    app.server.close();
    closeHost('remote1');
  }
});
