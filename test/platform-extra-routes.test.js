'use strict';
// P2 平台等价 v2「会话核心面泛化」的通用能力路由测试。
//   - 通用 agents / children / spawn 路由按 capability 挂载
//     （/api/:platform/agents*、…/children*、…/spawn-map|spawn-tree）
//   - openclaw 通用 needsAgent 清单/详情 → 平台默认目录（不复用 top-level DATA_DIR）
//   - 平台 disabled（重启生效）后对应通用路由返回结构化 404（platformIssue.code=disabled）
//   - top-level legacy 别名（/api/agents*、/api/spawn-*）仅 openclaw 挂载时可用，
//     openclaw 卸载后消失（404）
// 所有用例都跑在临时 AGENTLRAY_HOME / 隔离 platform 目录下，绝不碰真实 ~/.agentlray。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer, getJson } = require('./helpers');

const CLAUDE_A = 'aaaa1111-2222-4333-8444-555566667777';
const CLAUDE_B = 'bbbb1111-2222-4333-8444-555566667778';
const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';

describe('平台等价 P2：通用能力路由', () => {
  let srv;
  let agentsRoot;
  before(async () => {
    srv = await startServer();
    // 造两个 openclaw agent 会话，用于 needsAgent 清单/详情/agents 端点。
    agentsRoot = path.join(srv.home, '.openclaw', 'agents');
    const mk = async (agent, id) => {
      const dir = path.join(agentsRoot, agent, 'sessions');
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, `${id}.jsonl`),
        `${JSON.stringify({ type: 'session', id, timestamp: '2026-01-10T09:00:00.000Z', cwd: `/workspace/${id}` })}\n` +
          `${JSON.stringify({
            type: 'message',
            timestamp: '2026-01-10T09:00:02.000Z',
            message: { role: 'user', content: [{ type: 'text', text: `${id} task` }] },
          })}\n`
      );
    };
    await mk('alpha-ag', 'oc-a1');
    await mk('beta-ag', 'oc-b9');
  });
  after(async () => {
    await fsp.rm(agentsRoot, { recursive: true, force: true }).catch(() => {});
    await srv.stop();
  });

  it('claude-code agents 端点（无 listAgents）→ 结构化 404 JSON（capability-missing）', async () => {
    // 非 needsAgent 平台不提供 listAgents hook：统一 404 JSON（而不是 next() 落到 SPA 的
    // 200 HTML，前端拿不到 JSON 时只会显示空数据/无响应）。
    const body = await getJson(srv.base, '/api/claude-code/agents', 404);
    assert.equal(body.platformIssue?.platform, 'claude-code');
    assert.equal(body.platformIssue.code, 'capability-missing');
  });

  it('openclaw 通用 agents 端点列出 agents + 单 agent 会话', async () => {
    // 通用 /api/openclaw/agents：委托 openclaw 适配器 listAgents。
    const agents = await getJson(srv.base, '/api/openclaw/agents');
    assert.deepEqual(agents, ['alpha-ag', 'beta-ag']);

    // 通用 /api/openclaw/agents/:name/sessions：委托 listForAgent。
    const beta = await getJson(srv.base, '/api/openclaw/agents/beta-ag/sessions');
    assert.equal(beta.length, 1);
    assert.equal(beta[0].id, 'oc-b9');

    // 通用 /api/openclaw/agents/:name/sessions/:id：委托 getSession + agent 字段。
    const detail = await getJson(srv.base, '/api/openclaw/agents/beta-ag/sessions/oc-b9');
    assert.equal(detail.session.id, 'oc-b9');

    // 不存在 agent → 404（listForAgent 对缺失目录抛 ENOENT）。
    const nope = await fetch(`${srv.base}/api/openclaw/agents/no-such-ag/sessions`);
    assert.equal(nope.status, 404);
  });

  it('claude-code 通用 children 端点列子会话 + 详情', async () => {
    const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children`);
    assert.equal(children.length, 1);
    assert.equal(children[0].name, 'agent-fx001');

    const detail = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children/agent-fx001`);
    assert.ok(detail.session || detail.messages, '子会话详情应含解析结果');

    // 无子会话的父会话 → 空数组
    const empty = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_B}/children`);
    assert.deepEqual(empty, []);
  });

  it('omp 通用 children 端点列子会话 + 子文件缺失 404', async () => {
    const children = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children`);
    assert.equal(children.length, 1);
    assert.equal(children[0].name, 'Scout');

    // 子文件不存在的 name → getChild 抛 ENOENT → 404 'Subagent not found'
    const missing = await fetch(`${srv.base}/api/omp/sessions/${OMP1}/children/NoSuchAgent`);
    assert.equal(missing.status, 404);
    // Scout 存在 → 200（parseOmpSessionFile 返回 { session, messages }，session.id 为其真实 id）
    const scout = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children/Scout`);
    assert.equal(scout.session.id, '019a0000-0000-7000-8000-00000000cccc');
    assert.ok(Array.isArray(scout.messages));
  });

  it('能力位：仅声明 listChildren 的平台挂上 children 能力（capabilityBits 单源）', async () => {
    // children 路由按 `typeof platform.listChildren === 'function'` 挂载，路由纯数据
    // 层不落 404 区分（未挂载的能力路径会落到 SPA 兜底/静态 404，取决于部署形态）。
    // 这里直接断言 platform info 的能力位（capabilityBits 单一真源）：omp/claude-code
    // 有 children+spawn 缺能力位，dsh/gemini/hermes 无。
    const list = await getJson(srv.base, '/api/platforms');
    const cap = Object.fromEntries(list.filter((p) => !p.broken).map((p) => [p.id, p.capabilities]));
    assert.equal(cap.omp.children, true);
    assert.equal(cap['claude-code'].children, true);
    assert.equal(cap.openclaw.children, false);
    for (const p of ['dsh', 'gemini', 'hermes']) {
      assert.equal(cap[p].children, false, `${p} should not advertise children`);
      assert.equal(cap[p].listForAgent, false, `${p} should not advertise listForAgent`);
    }
    // agents 路由按 listAgents/listForAgent 能力挂载：仅 needsAgent 平台（openclaw）
    assert.equal(cap.openclaw.listAgents, true);
    assert.equal(cap.openclaw.listForAgent, true);
    assert.equal(cap.omp.listAgents, false);
    assert.equal(cap['claude-code'].listAgents, false);
  });

  it('openclaw 通用 spawn 端点返回空 spawn 关系（无 spawn 数据 → 结构完整）', async () => {
    // openclaw 适配器有 spawnMap/spawnTree hook；夹具无 spawn 记录 → 空/零计数。
    const tree = await getJson(srv.base, '/api/openclaw/spawn-tree');
    assert.equal(typeof tree.totalSessions, 'number');
    assert.equal(typeof tree.totalSpawnCalls, 'number');
    assert.ok(Array.isArray(tree.trees));
  });
});

describe('平台等价 P2：legacy 别名与卸载 404', () => {
  const { spawn } = require('node:child_process');
  const os = require('node:os');
  const REPO_ROOT = path.join(__dirname, '..');
  let mountedSrv;
  before(async () => {
    mountedSrv = await startServer();
  });
  after(async () => {
    await mountedSrv.stop();
  });

  // 用自建 home 手动 spawn 一个 server（写入 disabled 配置后才启动 → require 期即卸载），
  // 验证 openclaw 卸载后 top-level legacy 别名与 openclaw 通用路由一并 404。
  async function spawnDisabledServer(disabledIds) {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentlray-p2-dis-'));
    // 复制夹具 home（给其它平台会话数据），再写入 disabled 配置。
    await fsp.cp(path.join(__dirname, 'fixtures', 'home'), home, { recursive: true });
    await fsp.mkdir(path.join(home, '.agentlray'), { recursive: true });
    await fsp.writeFile(
      path.join(home, '.agentlray', 'settings.json'),
      JSON.stringify({ platforms: { disabled: disabledIds, replaced: [] } })
    );
    const port = 21000 + Math.floor(Math.random() * 8000);
    const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
      env: {
        ...process.env,
        HOME: home,
        // lib/config 用 AGENTLRAY_HOME || os.homedir() 解析数据目录与 settings 路径；
        // 显式钉死 AGENTLRAY_HOME，确保 require lib/platforms 时读到我们写入的
        // settings.json（disabled 配置），且不依赖 os.homedir() 的进程级缓存。
        AGENTLRAY_HOME: home,
        PORT: String(port),
        OPENCLAW_DIR: path.join(home, '.openclaw', 'agents'),
        AGENTLRAY_PLATFORMS_DIR: path.join(home, '.none-user'),
        AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, '.none-project'),
      },
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/version`);
        if (res.ok) {
          res.body?.cancel?.();
          return { base: `http://127.0.0.1:${port}`, home, stop: () => child.kill('SIGKILL') };
        }
      } catch {
        /* not ready */
      }
      await new Promise((r) => setTimeout(r, 60));
    }
    child.kill('SIGKILL');
    await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
    throw new Error('disabled server never became ready');
  }

  it('openclaw 挂载时 top-level legacy 别名可达', async () => {
    // 夹具 home 无 agents 目录 → /api/agents 返回 200 []
    const agents = await getJson(mountedSrv.base, '/api/agents');
    assert.deepEqual(agents, []);
    await getJson(mountedSrv.base, '/api/spawn-map'); // openclaw 挂载 → hook 存在 → 200
  });

  it('openclaw 卸载后 top-level legacy 别名消失、通用 openclaw 路由结构化 404', async () => {
    const srvOff = await spawnDisabledServer(['openclaw']);
    try {
      // 已挂载平台：通用路由返回 JSON；平台未挂载：结构化 404（platformIssue.code=disabled，
      // 而不是 SPA HTML —— 前端据 code 提示「已停用，重启后生效」）。
      for (const p of ['/api/openclaw/sessions']) {
        const body = await getJson(srvOff.base, p, 404);
        assert.equal(body.platformIssue?.platform, 'openclaw', p);
        assert.equal(body.platformIssue.code, 'disabled', p);
      }
      // top-level legacy 别名随 openclaw 卸载一并消失（不再是业务路由）→ SPA 回落。
      for (const p of ['/api/agents', '/api/spawn-map', '/api/spawn-tree']) {
        const res = await fetch(srvOff.base + p);
        const ct = res.headers.get('content-type') || '';
        assert.ok(
          ct.includes('text/html'),
          `${p} should fall back to SPA HTML when openclaw is unmounted (got ${ct})`
        );
      }
      // 对照组：仍然挂载的平台通用列表是 JSON。
      const codex = await getJson(srvOff.base, '/api/codex/sessions');
      assert.ok(Array.isArray(codex));
    } finally {
      srvOff.stop();
      await fsp.rm(srvOff.home, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('omp 卸载后其通用 children 路由结构化 404（codex 仍挂载）', async () => {
    const srvOff = await spawnDisabledServer(['omp']);
    try {
      const body = await getJson(srvOff.base, '/api/omp/sessions/x/children', 404);
      assert.equal(body.platformIssue?.platform, 'omp');
      assert.equal(body.platformIssue.code, 'disabled');
      // codex 仍挂载 → 通用列表正常 JSON
      const codex = await getJson(srvOff.base, '/api/codex/sessions');
      assert.ok(Array.isArray(codex));
    } finally {
      srvOff.stop();
      await fsp.rm(srvOff.home, { recursive: true, force: true }).catch(() => {});
    }
  });
});
