'use strict';
// Android 薄服务守卫（design-android-mobile-app §5.2/§5.4/§7.7）：
// - AGENTLRAY_DISABLE_SSH=1：ssh 主机在 create/update/open 三处被拒（400 语义）。
// - /api/mode capabilities：transports 由 DISABLE_SSH 派生，nativeSave 由 AGENTLRAY_NATIVE_SAVE。
// - lastHostId 记忆：hosts.json 顶层读写、resolveThinBootHost 优先、GET/PUT 路由透传。
// hosts.json 基于 require 期 HOME 求值 → 先设临时 HOME 再 require lib/*。

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'thin-android-guards-'));
process.env.HOME = tmpHome;
process.env.AGENTLRAY_NO_PLUGINS = '1';

const {
  HOSTS_FILE,
  LOCAL_ID,
  createHost,
  updateHost,
  openHost,
  resolveThinBootHost,
  getLastHostId,
  setLastHostId,
  shutdownHosts,
} = require('../lib/hosts');
const mountHostsRoutes = require('../lib/routes/hosts');
const mountModeRoutes = require('../lib/routes/mode');
const mountNetworkRoutes = require('../lib/routes/network');

const ENV_KEYS = ['AGENTLRAY_DISABLE_SSH', 'AGENTLRAY_NATIVE_SAVE', 'AGENTLRAY_THIN_HOST'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function resetState() {
  shutdownHosts();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  try {
    fs.rmSync(HOSTS_FILE);
  } catch {
    /* 不存在则忽略 */
  }
}

beforeEach(resetState);
afterEach(resetState);

/** 起一个只挂 hosts/mode 路由的 Express，返回 { server, request }。 */
function startApp(hostsOptions = {}, modeOptions = { mode: 'thin' }) {
  return new Promise((resolveApp) => {
    const app = express();
    app.use(express.json());
    mountHostsRoutes(app, hostsOptions);
    mountModeRoutes(app, modeOptions);
    mountNetworkRoutes(app);
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolveApp({
        server,
        request: (pathStr, { method = 'GET', body } = {}) =>
          new Promise((resolve, reject) => {
            const req = http.request(
              { host: '127.0.0.1', port, path: pathStr, method, headers: body ? { 'content-type': 'application/json' } : {} },
              (res) => {
                let b = '';
                res.setEncoding('utf8');
                res.on('data', (c) => (b += c));
                res.on('end', () => resolve({ status: res.statusCode, body: b }));
              }
            );
            req.on('error', reject);
            req.end(body ? JSON.stringify(body) : undefined);
          }),
      });
    });
  });
}

// ---- DISABLE_SSH 守卫 ----

test('DISABLE_SSH=1：createHost 拒绝 ssh，允许 dsh', async () => {
  process.env.AGENTLRAY_DISABLE_SSH = '1';
  await assert.rejects(
    () => createHost({ id: 'vias', label: 'ssh机', ssh: { host: 'h' } }),
    /仅支持 dsh/
  );
  const ok = await createHost({ id: 'viadsh', label: 'dsh机', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  assert.equal(ok.type, 'dsh');
});

test('DISABLE_SSH=1：updateHost 改为 ssh 被拒，改为 dsh 允许', async () => {
  process.env.AGENTLRAY_DISABLE_SSH = '1';
  await createHost({ id: 'h1', label: 'dsh机', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  await assert.rejects(() => updateHost('h1', { label: 'x', ssh: { host: 'h' } }), /仅支持 dsh/);
  const updated = await updateHost('h1', { label: '改名', type: 'dsh', dsh: { deviceId: 'dev-2' } });
  assert.equal(updated.dsh.deviceId, 'dev-2');
});

test('DISABLE_SSH=1：openHost 对已存在 ssh 主机防御性拒绝', async () => {
  // 先在不设开关时落一台 ssh 主机（模拟历史数据/迁移残留）。
  await createHost({ id: 'legacy-ssh', label: '旧机', ssh: { host: 'h' } });
  process.env.AGENTLRAY_DISABLE_SSH = '1';
  await assert.rejects(() => openHost('legacy-ssh'), /仅支持 dsh/);
});

test('未设 DISABLE_SSH：ssh 主机正常创建（桌面/full 无回归）', async () => {
  const h = await createHost({ id: 'sshok', label: 'ssh机', ssh: { host: 'h' } });
  assert.equal(h.type, 'ssh');
});

// ---- lastHostId 记忆 ----

test('setLastHostId/getLastHostId：写入 hosts.json 顶层并可读回', async () => {
  await createHost({ id: 'h1', label: 'dsh机', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  assert.equal(await getLastHostId(), null);
  await setLastHostId('h1');
  assert.equal(await getLastHostId(), 'h1');
  // 主机 CRUD 落盘不得冲掉顶层 lastHostId。
  await createHost({ id: 'h2', label: 'dsh机2', type: 'dsh', dsh: { deviceId: 'dev-2' } });
  assert.equal(await getLastHostId(), 'h1');
  const raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.equal(raw.lastHostId, 'h1');
  assert.equal(raw.hosts.length, 2);
});

test('resolveThinBootHost 优先 lastHostId，其次 AGENTLRAY_THIN_HOST，再 hosts[0]', async () => {
  await createHost({ id: 'a', label: 'A', type: 'dsh', dsh: { deviceId: 'dev-a' } });
  await createHost({ id: 'b', label: 'B', type: 'dsh', dsh: { deviceId: 'dev-b' } });
  await createHost({ id: 'c', label: 'C', type: 'dsh', dsh: { deviceId: 'dev-c' } });

  // 无记忆无 env → hosts[0] = a
  assert.equal((await resolveThinBootHost()).id, 'a');

  // 有 env → b
  process.env.AGENTLRAY_THIN_HOST = 'b';
  assert.equal((await resolveThinBootHost()).id, 'b');

  // 有记忆 → c（优先于 env）
  await setLastHostId('c');
  assert.equal((await resolveThinBootHost()).id, 'c');

  // 记忆指向已删除 id → 回退 env/首个
  await setLastHostId('gone');
  assert.equal((await resolveThinBootHost()).id, 'b');
});

test('DISABLE_SSH：resolveThinBootHost 过滤 ssh 主机（只连 dsh）', async () => {
  await createHost({ id: 's1', label: 'ssh机', ssh: { host: 'h' } }); // 未设开关时落盘
  await createHost({ id: 'd1', label: 'dsh机', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  process.env.AGENTLRAY_DISABLE_SSH = '1';
  // hosts[0] 是 ssh(s1)，但被过滤 → 选中 d1。
  assert.equal((await resolveThinBootHost()).id, 'd1');
  // 记忆指向 ssh 主机 → 不可连 → 回退 dsh。
  await setLastHostId('s1');
  assert.equal((await resolveThinBootHost()).id, 'd1');
});

// ---- 路由契约 ----

test('GET /api/hosts 返回 { lastHostId, hosts }（hosts 含 local）', async () => {
  await createHost({ id: 'h1', label: 'dsh机', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  await setLastHostId('h1');
  const app = await startApp();
  try {
    const r = await app.request('/api/hosts');
    assert.equal(r.status, 200);
    const body = JSON.parse(r.body);
    assert.equal(body.lastHostId, 'h1');
    assert.ok(Array.isArray(body.hosts));
    assert.equal(body.hosts[0].id, LOCAL_ID);
    assert.ok(body.hosts.some((h) => h.id === 'h1'));
  } finally {
    app.server.close();
  }
});

test('PUT /api/hosts/:id 透传 body.lastHostId 持久化记忆主机', async () => {
  await createHost({ id: 'h1', label: 'dsh机', type: 'dsh', dsh: { deviceId: 'dev-1' } });
  const app = await startApp();
  try {
    const r = await app.request('/api/hosts/h1', {
      method: 'PUT',
      body: { label: '改名', type: 'dsh', dsh: { deviceId: 'dev-1' }, lastHostId: 'h1' },
    });
    assert.equal(r.status, 200);
    assert.equal(await getLastHostId(), 'h1');
  } finally {
    app.server.close();
  }
});

// ---- /api/mode capabilities ----

test('mode capabilities：DISABLE_SSH 派生 transports=dsh，NATIVE_SAVE 派生 nativeSave', async () => {
  process.env.AGENTLRAY_DISABLE_SSH = '1';
  process.env.AGENTLRAY_NATIVE_SAVE = '1';
  const app = await startApp({ includeLocal: false }, { mode: 'thin' });
  try {
    const r = await app.request('/api/mode');
    const body = JSON.parse(r.body);
    // networkBlocked（D-1）：无原生上报时为 null。
    assert.deepEqual(body.capabilities, { transports: ['dsh'], nativeSave: true, networkBlocked: null });
  } finally {
    app.server.close();
  }
});

test('mode capabilities：未设开关时 transports=[ssh,dsh]、nativeSave=false', async () => {
  const app = await startApp({ includeLocal: false }, { mode: 'thin' });
  try {
    const r = await app.request('/api/mode');
    const body = JSON.parse(r.body);
    assert.deepEqual(body.capabilities, {
      transports: ['ssh', 'dsh'],
      nativeSave: false,
      networkBlocked: null,
    });
  } finally {
    app.server.close();
  }
});

test('mode capabilities：原生壳上报网络阻断后 networkBlocked=true（D-1）', async () => {
  const network = require('../lib/routes/network');
  network._resetForTest();
  const app = await startApp({ includeLocal: false }, { mode: 'thin' });
  try {
    const before = JSON.parse((await app.request('/api/mode')).body);
    assert.equal(before.capabilities.networkBlocked, null, '无上报时为 null（未知）');

    const posted = await app.request('/api/network/status', {
      method: 'POST',
      body: { transport: 'cellular', blocked: true },
    });
    assert.equal(posted.status, 200);

    const after = JSON.parse((await app.request('/api/mode')).body);
    assert.equal(after.capabilities.networkBlocked, true);

    await app.request('/api/network/status', {
      method: 'POST',
      body: { transport: 'cellular', blocked: false },
    });
    const restored = JSON.parse((await app.request('/api/mode')).body);
    assert.equal(restored.capabilities.networkBlocked, false, '恢复后如实上报 false');
  } finally {
    app.server.close();
    network._resetForTest();
  }
});

test('完整实例 /api/mode 不带 capabilities（保持向后兼容）', async () => {
  const app = await startApp({ includeLocal: false }, { mode: 'full' });
  try {
    const r = await app.request('/api/mode');
    assert.deepEqual(JSON.parse(r.body), { mode: 'full' });
  } finally {
    app.server.close();
  }
});

// ---- D-2 首启进度占位页 ----

test('D-2 占位页：window.__agentlrayProgress 存在，百分比/剩余时间与无总量降级', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const html = fs.readFileSync(
    path.join(__dirname, '..', 'android', 'www', 'index.html'),
    'utf8'
  );
  assert.ok(html.includes('window.__agentlrayProgress'), '占位页必须暴露原生注入入口');
  assert.ok(html.includes("id=\"progress\""), '占位页必须有进度容器');

  // 用最小 DOM 桩执行注入脚本（不引入 jsdom）：只需 classList/style/textContent。
  const script = html.slice(html.indexOf('<script>') + 8, html.indexOf('</script>'));
  const elements = {};
  const el = (id) => {
    elements[id] ??= {
      id,
      style: {},
      textContent: '',
      classList: { add(c) { this.set.add(c) }, set: new Set() },
    };
    return elements[id];
  };
  const sandbox = { window: {}, document: { getElementById: el } };
  new Function('window', 'document', script)(sandbox.window, sandbox.document);

  // 正常进度：50%，剩余 30s。
  sandbox.window.__agentlrayProgress(500, 1000, 30_000);
  assert.equal(elements.fill.style.width, '50%');
  assert.match(elements.meta.textContent, /50%/);
  assert.match(elements.meta.textContent, /30 秒/);
  assert.ok(elements.progress.classList.set.has('active'));

  // 总量未知：不假装有百分比，只报已处理项数。
  sandbox.window.__agentlrayProgress(42, 0, null);
  assert.match(elements.meta.textContent, /42 项/);
  assert.ok(!elements.meta.textContent.includes('%'));
});
