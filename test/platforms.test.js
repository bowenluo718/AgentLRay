'use strict';
// P1 服务端表面测试：自定义平台扩展计划的服务端可见性。
// 以临时 HOME 落盘「一个正常 JSONL 适配器 + 一个抛错适配器」，起真实 server 验证：
//  - GET /api/platforms 与 listPlatformInfo() 同源（7 内置 + 自定义 + broken）
//  - 自定义平台列表/详情/export(md+html)/OTLP 走通
//  - 能力缺位：无 collectFiles → search 正常缺位；无 watchParse → /api/watch 400
//  - PUT /api/settings 的 ui section 白名单认可自定义 id、未知 id 400
//  - 内置 codex 列表/详情/export 行为不变（回归面）
//
// 适配器目录 ~/.agentlray/platforms 在 lib/config.js 内基于 process.env.HOME
// 求值 → 每次起 server / 取 listPlatformInfo 都用独立临时 HOME，互不污染。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { getJson, sendJson } = require('./helpers.js');

const REPO_ROOT = path.join(__dirname, '..');
const CODEX1 = '01900000-0000-7000-8000-000000000001';

// 正常 JSONL 适配器：读 <defaultDir>/<sessionId>.jsonl（每行一条 JSON 记录）。
// 实现 list/parse/getSession + find（OTLP 需要 find+parse、export 需 getSession）；
// 故意不声明 collectFiles / watchParse，验证缺位语义。
const SMOKE_ADAPTER = `'use strict';
const fs = require('fs');
const path = require('path');

const MESSAGE = (rec) => ({
  id: null,
  timestamp: rec.timestamp || null,
  role: rec.type === 'user' ? 'user' : 'assistant',
  content: typeof rec.content === 'string' ? [{ type: 'text', text: rec.content }] : [],
  usage: null,
  model: null,
  provider: null,
  toolCallId: null,
  toolName: null,
  details: null,
  isError: false,
});

module.exports = {
  id: 'smoke-copilot',
  label: 'Smoke Copilot',
  defaultDir: () => process.env.SMOKE_COPILOT_DIR,
  list: async (dir) => {
    const sessions = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      const file = path.join(dir, name);
      let lastTs = null;
      let messageCount = 0;
      let firstUser = null;
      for (const line of fs.readFileSync(file, 'utf8').split('\\n')) {
        if (!line) continue;
        messageCount++;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (rec && typeof rec.timestamp === 'string') lastTs = rec.timestamp;
        if (rec && rec.type === 'user' && firstUser === null) firstUser = rec.content;
      }
      sessions.push({
        id: name.replace(/\\.jsonl$/, ''),
        timestamp: lastTs,
        lastActivity: lastTs,
        mtimeMs: fs.statSync(file).mtimeMs,
        messageCount,
        cwd: dir,
        tail: null,
        firstUserMessage: firstUser,
      });
    }
    const toMs = (s) => Date.parse(s.timestamp || '') || 0;
    return sessions.sort((a, b) => toMs(b) - toMs(a));
  },
  find: async (dir, sessionId) => {
    const file = path.join(dir, sessionId + '.jsonl');
    try { fs.statSync(file); return file; } catch { return null; }
  },
  parse: async (filePath) => {
    const messages = [];
    let lastTs = null;
    for (const line of fs.readFileSync(filePath, 'utf8').split('\\n')) {
      if (!line) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec && typeof rec.timestamp === 'string') lastTs = rec.timestamp;
      messages.push(MESSAGE(rec));
    }
    return {
      session: { id: path.basename(filePath).replace(/\\.jsonl$/, ''), cwd: path.dirname(filePath), timestamp: lastTs },
      messages,
    };
  },
  getSession: async (dir, sessionId) => {
    const file = await module.exports.find(dir, sessionId);
    return file ? module.exports.parse(file) : null;
  },
  resume: {
    bin: 'smoke-cli',
    args: (id) => ['--resume', id],
  },
};
`;

// 抛错适配器：加载期 require 抛错 → broken。
const BROKEN_ADAPTER = "throw new Error('boom from broken');";

// 用独立临时 HOME 起 server：写入两个适配器 + 2 个会话 jsonl，返回 { base, home, dataDir }。
async function startCustomServer(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-platforms-test-'));
  // 复制既有 fixture home（.codex/.omp 等内置数据），供内置平台回归断言；
  // 自定义适配器/会话数据随后独立写入。
  fs.cpSync(path.join(__dirname, 'fixtures', 'home'), home, { recursive: true });
  const platDir = path.join(home, '.agentlray', 'platforms');
  fs.mkdirSync(platDir, { recursive: true });
  fs.writeFileSync(path.join(platDir, 'a-smoke-copilot.js'), SMOKE_ADAPTER);
  fs.writeFileSync(path.join(platDir, 'z-broken.js'), BROKEN_ADAPTER);

  const dataDir = path.join(home, 'smoke-sessions');
  fs.mkdirSync(dataDir, { recursive: true });
  const rec1 = [
    JSON.stringify({ id: 'm1', type: 'user', timestamp: '2026-10-25T01:00:00.000Z', content: '你好' }),
    JSON.stringify({ id: 'm2', type: 'assistant', timestamp: '2026-10-25T01:00:05.000Z', content: '你好！有什么可以帮你？' }),
    JSON.stringify({ id: 'm3', type: 'user', timestamp: '2026-10-26T01:00:00.000Z', content: '再来' }),
  ];
  const rec2 = [JSON.stringify({ id: 'n1', type: 'user', timestamp: '2026-10-27T01:00:00.000Z', content: '列表' })];
  fs.writeFileSync(path.join(dataDir, 'sess-1.jsonl'), rec1.join('\n') + '\n');
  fs.writeFileSync(path.join(dataDir, 'sess-2.jsonl'), rec2.join('\n') + '\n');

  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    // setup-env.cjs 会全局注入空的 AGENTLRAY_PLATFORMS_DIR，须覆盖为临时 HOME 下的
    // 平台目录，使本测试落盘的自定义适配器可加载。
    env: {
      ...process.env,
      HOME: home,
      AGENTLRAY_PLATFORMS_DIR: platDir,
      AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(__dirname, '..', 'platforms'),
      PORT: String(port),
      HOST: '127.0.0.1',
      SMOKE_COPILOT_DIR: dataDir,
    },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before ready: ${stderr.trim()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (res.ok) {
        await res.json();
        break;
      }
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  if (Date.now() >= deadline) {
    child.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
    throw new Error(`server never became ready on port ${port}: ${stderr.trim()}`);
  }

  const base = `http://127.0.0.1:${port}`;
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          resolve();
        }, 3000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  return { base, home, dataDir };
}

// 子进程里用同一 HOME 求值 listPlatformInfo()，作为 /api/platforms 的期望值。
async function readPlatformInfo(home, dataDir) {
  const script = `const { listPlatformInfo } = require('./lib/platforms'); process.stdout.write(JSON.stringify(listPlatformInfo()));`;
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: home,
      AGENTLRAY_PLATFORMS_DIR: path.join(home, '.agentlray', 'platforms'),
      AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(__dirname, '..', 'platforms'),
      SMOKE_COPILOT_DIR: dataDir,
    },
  });
  assert.equal(res.status, 0, `listPlatformInfo 子进程失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

async function getText(base, pathname, expectedStatus = 200) {
  const res = await fetch(base + pathname);
  const body = await res.text();
  assert.equal(res.status, expectedStatus, `${pathname} → ${res.status}: ${body.slice(0, 300)}`);
  return body;
}

test('P1 服务端表面：自定义平台 /api/platforms、列表/详情/export/OTLP、能力缺位、watch 400、白名单', async (t) => {
  const { base, home, dataDir } = await startCustomServer(t);

  await t.test('GET /api/platforms 与 listPlatformInfo 同源：7 内置 + 自定义 + broken', async () => {
    const got = await getJson(base, '/api/platforms');
    const expected = await readPlatformInfo(home, dataDir);
    assert.deepEqual(got, expected, '响应必须是 listPlatformInfo 的准确形状');

    assert.ok(got.find((p) => p.id === 'codex').builtin, '内置 codex 保留');
    assert.equal(got.filter((p) => p.builtin && !p.broken).length, 7, '内置 7 平台保持');

    const smoke = got.find((p) => p.id === 'smoke-copilot');
    assert.deepEqual(
      smoke,
      {
        id: 'smoke-copilot',
        label: 'Smoke Copilot',
        builtin: false,
        origin: 'user',
        overrides: null,
        replacementPending: false,
        replaced: false,
        mounted: true,
        configuredMounted: true,
        restartRequired: false,
        capabilities: {
          list: true,
          find: true,
          parse: true,
          getSession: true,
          collectFiles: false,
          watchParse: false,
          needsAgent: false,
          listForAgent: false,
          listAllAgents: false,
          listAgents: false,
          children: false,
          spawn: false,
          watch: false,
          search: false,
          insights: false,
          prompts: false,
          toolAudit: false,
          inspect: false,
          // find+parse 且无需 agent → 文件型可导出 OTLP（与 surfacePlatforms('otlp') 同口径）
          otlp: true,
        },
        resume: true,
        create: false,
        bin: null,
        execSpawnCommands: [],
        dirSettingKey: null,
        dirSettingLabel: null,
        dirSettingHint: null,
        dirParam: null,
        defaultDir: dataDir,
        color: null,
        broken: false,
      },
      '自定义正常适配器的 v2 平台信息形状'
    );

    const broken = got.find((p) => p.broken === true);
    assert.ok(broken, 'broken 条目可见');
    assert.equal(broken.label, null);
    assert.equal(broken.builtin, false);
    assert.equal(broken.mounted, false);
    assert.equal(broken.configuredMounted, false);
    assert.equal(broken.origin, 'user');
    assert.deepEqual(
      broken.capabilities,
      {
        list: false,
        find: false,
        parse: false,
        getSession: false,
        collectFiles: false,
        watchParse: false,
        needsAgent: false,
      },
      'broken 条目仅保留 7 个基础能力字段（v2 全 false 位不展开）'
    );
    assert.equal(broken.resume, false);
    assert.equal(broken.create, false);
    assert.equal(broken.bin, null);
    assert.match(broken.error, /boom from broken/);
  });

  await t.test('自定义平台列表/详情走通，未知会话 404', async () => {
    const list = await getJson(base, '/api/smoke-copilot/sessions');
    assert.ok(Array.isArray(list));
    assert.deepEqual(list.map((s) => s.id).sort(), ['sess-1', 'sess-2']);
    assert.ok(list.every((s) => s.timestamp && s.lastActivity != null && s.messageCount >= 1));

    const detail = await getJson(base, '/api/smoke-copilot/sessions/sess-1');
    assert.equal(detail.session.id, 'sess-1');
    assert.equal(detail.messages.length, 3);
    assert.equal(detail.messages[0].role, 'user');
    assert.equal(detail.messages[0].content[0].text, '你好');

    const notFound = await getText(base, '/api/smoke-copilot/sessions/no-such', 404);
    assert.match(notFound, /not found/i);
  });

  await t.test('自定义平台复制恢复命令（resume-command）走通', async () => {
    const withCwd = await getJson(
      base,
      '/api/smoke-copilot/sessions/sess-1/resume-command?cwd=' + encodeURIComponent('/tmp/proj space')
    );
    assert.equal(withCwd.supported, true);
    assert.equal(withCwd.bin, 'smoke-cli');
    assert.deepEqual(withCwd.args, ['--resume', 'sess-1']);
    assert.equal(withCwd.command, "cd '/tmp/proj space' && smoke-cli --resume sess-1");

    // 未传 cwd → 命令不含 cd 前缀（与前端 detail cwd 缺省一致）
    const noCwd = await getJson(base, '/api/smoke-copilot/sessions/sess-1/resume-command');
    assert.equal(noCwd.supported, true);
    assert.equal(noCwd.command, 'smoke-cli --resume sess-1');

    // 命令构建纯拼串，不依赖会话存在（未知 id 同样返回命令）
    const unknown = await getJson(base, '/api/smoke-copilot/sessions/no-such/resume-command');
    assert.equal(unknown.supported, true);
    assert.equal(unknown.command, 'smoke-cli --resume no-such');
  });

  await t.test('自定义平台 export（md+html）与 OTLP 走通', async () => {
    const md = await getText(base, '/api/smoke-copilot/sessions/sess-1/export?format=md');
    assert.ok(md.includes('| Platform | smoke-copilot |'), 'md 导出含平台名');
    assert.ok(md.includes('你好'), 'md 导出含会话内容');

    const html = await getText(base, '/api/smoke-copilot/sessions/sess-1/export?format=html');
    assert.ok(html.startsWith('<!doctype html>'), 'html 导出完整');

    const otlp = await getJson(base, '/api/otlp/smoke-copilot/sess-1');
    const service = otlp.resourceSpans[0].resource.attributes.find((a) => a.key === 'service.name');
    assert.equal(service.value.stringValue, 'agentlray');
    assert.ok(otlp.resourceSpans[0].scopeSpans[0].spans.length >= 1, 'OTLP 至少一个 span');
  });

  await t.test('能力缺位：search 无 collectFiles 正常缺位；watch 无 watchParse 返回 400', async () => {
    const search = await getJson(base, '/api/search?platform=smoke-copilot&q=你好');
    assert.ok(Array.isArray(search), '无 collectFiles 的 custom 平台 search 正常返回（缺位语义）');
    assert.deepEqual(search, [], 'search 不命中任何内置文件（scope 限定 custom）');

    const watch = await getJson(base, '/api/watch?platform=smoke-copilot&sessionId=sess-1', 400);
    assert.equal(watch.error, '平台不支持实时尾随');
  });

  await t.test('PUT /api/settings 的 ui section 白名单认可自定义 id，未知 id 400', async () => {
    const saved = await sendJson(base, 'PUT', '/api/settings', {
      ui: { platform: 'codex', selectedPlatforms: ['codex', 'smoke-copilot'] },
    });
    assert.deepEqual(saved.ui, { platform: 'codex', selectedPlatforms: ['codex', 'smoke-copilot'] });
    const allUi = (await getJson(base, '/api/settings')).ui;
    assert.deepEqual(allUi, { platform: 'codex', selectedPlatforms: ['codex', 'smoke-copilot'] }, '落盘可回读');

    const bad = await sendJson(base, 'PUT', '/api/settings', { ui: { platform: 'nope' } }, 400);
    assert.match(bad.error, /platform must be one of/);
  });

  await t.test('内置 codex 列表/详情/export 行为不变', async () => {
    const list = await getJson(base, '/api/codex/sessions');
    assert.equal(list.length, 2);

    const detail = await getJson(base, `/api/codex/sessions/${CODEX1}`);
    assert.equal(detail.session.id, CODEX1);

    const md = await getText(base, `/api/codex/sessions/${CODEX1}/export?format=md`);
    assert.ok(md.includes('| Platform | codex |'), 'codex md 导出不变');
  });
});

// 回归：自定义平台的 Prompts 页签应能提取真人 prompt（lib/prompts.js 通用 JSONL
// 提取器）。用 claude-code 同构记录形状（rec.type==='user' + rec.message?.content）
// 的 collectFiles 适配器，断言 /api/prompts 按目录分组返回真人 prompt。
test('自定义平台 /api/prompts 提取真人 prompt（generic JSONL 提取器回归）', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-platforms-prompts-test-'));
  const platDir = path.join(home, '.agentlray', 'platforms');
  fs.mkdirSync(platDir, { recursive: true });

  const ADAPTER = `'use strict';
const fs = require('fs');
const path = require('path');
module.exports = {
  id: 'co-mind-like',
  label: 'Co Mind Like',
  defaultDir: () => process.env.PROMPTS_DIR,
  list: async () => [],
  find: async (dir, id) => null,
  parse: async () => ({ session: { id: 'x', cwd: null, timestamp: null }, messages: [] }),
  getSession: async () => null,
  collectFiles: async (dir) => {
    const files = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      files.push({ path: path.join(dir, name), file: name, sessionId: name.replace(/\\.jsonl$/, '') });
    }
    return files;
  },
  watchParse: () => null,
  needsAgent: false,
};
`;
  fs.writeFileSync(path.join(platDir, 'co-mind-like.js'), ADAPTER);

  const dataDir = path.join(home, 'prompts-data');
  fs.mkdirSync(dataDir, { recursive: true });
  // claude-code 同构记录：type:'user' + message.content（真实 prompt + 噪音）。
  // 每个会话文件一个目录（真实存储布局：<项目slug>/<sessionId>.jsonl）。
  const sessA = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-25T01:00:00.000Z', cwd: '/proj/a', slug: 'proj-a', message: { content: '分析并总结 resolve.js 实现' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-10-25T01:00:05.000Z', message: { content: '好的，我来分析。' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-10-26T01:00:00.000Z', cwd: '/proj/a', slug: 'proj-a', message: { content: '再加一条约束：不要用可选链。' } }),
  ];
  const sessB = [
    JSON.stringify({ type: 'user', timestamp: '2026-10-26T02:00:00.000Z', cwd: '/proj/b', slug: 'proj-b', message: { content: '另一个项目的问题' } }),
  ];
  fs.writeFileSync(path.join(dataDir, 'sess-a.jsonl'), sessA.join('\n') + '\n');
  fs.writeFileSync(path.join(dataDir, 'sess-b.jsonl'), sessB.join('\n') + '\n');

  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    env: {
      ...process.env,
      HOME: home,
      AGENTLRAY_PLATFORMS_DIR: platDir,
      AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(__dirname, '..', 'platforms'),
      PORT: String(port),
      HOST: '127.0.0.1',
      PROMPTS_DIR: dataDir,
    },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before ready: ${stderr.trim()}`);
    try {
      const res = await fetch(`${base}/api/version`);
      if (res.ok) {
        await res.json();
        break;
      }
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  t.after(() => child.kill('SIGKILL'));
  if (Date.now() >= deadline) {
    throw new Error(`server never became ready: ${stderr.trim()}`);
  }

  const data = await getJson(base, '/api/prompts?platform=co-mind-like');
  assert.equal(data.platform, 'co-mind-like');
  assert.equal(data.totalSessions, 2, '两个会话均提取');
  assert.equal(data.totalPrompts, 3, '三个真人 prompt（assistant/噪音不计数）');
  assert.equal(data.groups.length, 2, '按目录分组（/proj/a 与 /proj/b）');
  const texts = data.groups.flatMap((g) => g.sessions.flatMap((s) => s.prompts.map((p) => p.text)));
  assert.ok(texts.includes('分析并总结 resolve.js 实现'), '首个 prompt 命中');
  assert.ok(texts.includes('再加一条约束：不要用可选链。'), '第二条 prompt 命中');
  assert.ok(texts.includes('另一个项目的问题'), '另一目录 prompt 命中');
  assert.ok(!texts.includes('好的，我来分析。'), 'assistant 文本不进入 prompts');
});
