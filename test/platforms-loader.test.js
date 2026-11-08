'use strict';
// 自定义平台加载器（lib/platforms/loader.js）单测 + 冒烟：
//  - id 正则合法/非法
//  - id 与内置冲突（不覆盖内置）、与先前自定义冲突
//  - 坏文件三型（导出非对象 / 缺必需函数 / require 抛错）各自 broken 且不影响同目录好文件
//  - AGENTLRAY_NO_PLUGINS=1 逃生（注入 broken、不加载任何自定义）
//  - listPlatformInfo() 顺序与形状（capabilities 布尔推导、broken 条目形状）
//  - 冒烟：一个抛错适配器 + 一个正常适配器 → bin/sessions.js 可查询该自定义平台、
//    server 用该 HOME 正常启动、broken 条目经 listPlatformInfo 可见（含 error）
//
// loader 顶部基于 process.env.HOME（经 lib/config.js）求值平台目录
// ~/.agentlray/platforms → 必须在 require 相关模块之前先设临时 HOME。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-loader-test-'));
process.env.HOME = tmpHome;
// setup-env.cjs 已全局注入空的 AGENTLRAY_PLATFORMS_DIR；本测试用临时 HOME 下
// 的目录放置自定义适配器，需在此重置两个来源目录为 HOME 派生路径。
process.env.AGENTLRAY_PLATFORMS_DIR = path.join(tmpHome, '.agentlray', 'platforms');
// project 来源指仓库自带 platforms/（随包分发的 dsh/gemini/hermes 项目平台），
// 保证 4 内置 + 3 项目平台的 7 平台基线；自定义/坏适配器走 user 来源。
process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = path.join(__dirname, '..', 'platforms');

const { loadPlatformAdapters, PLATFORM_DIR } = require('../lib/platforms/loader');
const { PLATFORMS, listPlatformInfo } = require('../lib/platforms');

const platformDir = path.join(tmpHome, '.agentlray', 'platforms');

// 清空既有 *.js 并清 require 缓存，避免跨用例残留（同目录共享）。
function resetPlatformDir() {
  fs.mkdirSync(platformDir, { recursive: true });
  for (const name of fs.readdirSync(platformDir)) {
    const file = path.join(platformDir, name);
    delete require.cache[file];
    fs.unlinkSync(file);
  }
}

// 写一个适配器文件，写前清对应 require 缓存（同路径复写时取新内容）。
function writeAdapter(name, source) {
  const file = path.join(platformDir, name);
  delete require.cache[file];
  fs.writeFileSync(file, source);
  return file;
}

// 全新 registry 跑一次加载（隔离真实 PLATFORMS，供纯加载器用例）。
function loadFresh() {
  return loadPlatformAdapters({});
}

const FULL_ADAPTER = (id, label) => `'use strict';
module.exports = {
  id: ${JSON.stringify(id)},
  label: ${JSON.stringify(label)},
  defaultDir: () => '/tmp/sessions',
  list: async (dir) => [],
  parse: async (filePath) => ({ session: { id: 'x' }, messages: [] }),
  getSession: async (dir, id) => null,
};
`;

test('合法适配器：校验通过写入 registry，customAdapters 含该条目', () => {
  resetPlatformDir();
  writeAdapter('a-ok.js', FULL_ADAPTER('my-copilot', 'My Copilot'));
  const registry = {};
  const { customAdapters, brokenAdapters } = loadPlatformAdapters(registry);
  assert.equal(brokenAdapters.length, 0);
  assert.equal(customAdapters.length, 1);
  assert.equal(registry['my-copilot'], customAdapters[0]);
  assert.equal(registry['my-copilot'].id, 'my-copilot');
});

test('id 正则：非法 id（大写/下划线/前导连字符）broken，合法 id（含数字开头/连字符）加载', () => {
  resetPlatformDir();
  writeAdapter('a-valid.js', FULL_ADAPTER('my-1co', 'valid'));
  writeAdapter('b-upper.js', FULL_ADAPTER('My', 'upper'));
  writeAdapter('c-underscore.js', FULL_ADAPTER('my_platform', 'underscore'));
  writeAdapter('d-lead-hyphen.js', FULL_ADAPTER('-abc', 'lead'));
  writeAdapter('e-digit.js', FULL_ADAPTER('1abc', 'digit'));
  const { customAdapters, brokenAdapters } = loadFresh();
  assert.deepEqual(
    brokenAdapters.map((b) => [b.id, b.error]),
    [
      ['My', 'id 不合法（需匹配 ^[a-z0-9][a-z0-9-]*$）：My'],
      ['my_platform', 'id 不合法（需匹配 ^[a-z0-9][a-z0-9-]*$）：my_platform'],
      ['-abc', 'id 不合法（需匹配 ^[a-z0-9][a-z0-9-]*$）：-abc'],
    ]
  );
  assert.deepEqual(customAdapters.map((a) => a.id), ['my-1co', '1abc']);
});

test('id 与内置冲突：broken（含「id 已被占用」），`codex` 仍为内置不被覆盖', () => {
  resetPlatformDir();
  writeAdapter('dup-codex.js', FULL_ADAPTER('codex', 'Fake Codex'));
  const before = PLATFORMS.codex;
  const { customAdapters, brokenAdapters } = loadPlatformAdapters(PLATFORMS);
  assert.equal(customAdapters.length, 0);
  assert.equal(brokenAdapters.length, 1);
  assert.equal(brokenAdapters[0].file, 'dup-codex.js');
  assert.equal(brokenAdapters[0].id, 'codex');
  assert.match(brokenAdapters[0].error, /id 已被占用/);
  assert.equal(PLATFORMS.codex, before, '内置 codex 未被覆盖');
  assert.equal(PLATFORMS.codex.label, 'Codex');
});

test('id 与先前自定义冲突：后加载者 broken，前者保留', () => {
  resetPlatformDir();
  writeAdapter('a-first.js', FULL_ADAPTER('fancy', 'First'));
  writeAdapter('b-second.js', FULL_ADAPTER('fancy', 'Second'));
  const registry = {};
  const { customAdapters, brokenAdapters } = loadPlatformAdapters(registry);
  assert.equal(customAdapters.length, 1);
  assert.equal(customAdapters[0].id, 'fancy');
  assert.equal(brokenAdapters.length, 1);
  assert.equal(brokenAdapters[0].file, 'b-second.js');
  assert.match(brokenAdapters[0].error, /id 已被占用/);
  assert.equal(registry.fancy.id, 'fancy');
});

test('坏文件三型（导出非对象/缺必需函数/require 抛错）各自 broken 且不影响同目录好文件', () => {
  resetPlatformDir();
  writeAdapter('a-ok.js', FULL_ADAPTER('good', 'Good'));
  writeAdapter('b-notobj.js', "module.exports = 'hello';");
  writeAdapter('c-missing.js', `'use strict';
module.exports = {
  id: 'missing-fn',
  label: 'Missing',
  defaultDir: () => '/tmp',
  list: async () => [],
  parse: async () => ({ session: { id: 'x' }, messages: [] }),
  // getSession 缺失
};
`);
  writeAdapter('d-throw.js', "throw new Error('boom from thrower');");

  const registry = {};
  const { customAdapters, brokenAdapters } = loadPlatformAdapters(registry);
  assert.equal(customAdapters.length, 1);
  assert.equal(customAdapters[0].id, 'good');
  assert.equal(brokenAdapters.length, 3);
  const byFile = Object.fromEntries(brokenAdapters.map((b) => [b.file, b]));
  assert.match(byFile['b-notobj.js'].error, /导出非对象/);
  assert.match(byFile['c-missing.js'].error, /缺少必需函数 getSession/);
  assert.match(byFile['d-throw.js'].error, /boom from thrower/);
  for (const b of brokenAdapters) {
    assert.equal(b.label, null);
  }
  assert.equal(registry.good.id, 'good');
  assert.equal(registry['missing-fn'], undefined, '缺必需函数的适配器不写入 registry');
});

test('AGENTLRAY_NO_PLUGINS=1：注入 broken 逃生条目，不加载任何自定义', () => {
  resetPlatformDir();
  writeAdapter('a-ok.js', FULL_ADAPTER('my-copilot', 'My Copilot'));
  process.env.AGENTLRAY_NO_PLUGINS = '1';
  try {
    const registry = {};
    const { customAdapters, brokenAdapters } = loadPlatformAdapters(registry);
    assert.equal(customAdapters.length, 0);
    assert.deepEqual(brokenAdapters, [
      {
        file: '(AGENTLRAY_NO_PLUGINS=1)',
        label: null,
        id: null,
        error: '自定义平台已禁用（AGENTLRAY_NO_PLUGINS=1）',
      },
    ]);
    assert.equal(Object.keys(registry).length, 0);
  } finally {
    delete process.env.AGENTLRAY_NO_PLUGINS;
  }
});

// 重新触发 lib/platforms 模块初始化（删缓存 + 重新 require），使模块级 CUSTOM/BROKEN
// 反映当前 ~/.agentlray/platforms 内容（loader 的平台目录已按 HOME 求值，目录不变）。
function reloadPlatforms() {
  delete require.cache[require.resolve('../lib/platforms')];
  return require('../lib/platforms');
}

test('listPlatformInfo：顺序（内置插入序 → 自定义字母序 → broken）与形状（能力位布尔、broken 无 label/error）', () => {
  resetPlatformDir();
  writeAdapter('a-apple.js', FULL_ADAPTER('apple', 'Apple'));
  writeAdapter('b-zebra.js', FULL_ADAPTER('zebra', 'Zebra'));
  writeAdapter('z-bad.js', "module.exports = () => {};"); // 导出函数非对象 → broken

  const { listPlatformInfo: freshList } = reloadPlatforms();
  const info = freshList();

  assert.deepEqual(
    info.map((p) => p.id),
    ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini', 'hermes', 'apple', 'zebra', null]
  );

  // 内置：openclaw list 为 null → 能力位 false；needsAgent 推导为布尔。
  const openclaw = info[0];
  assert.equal(openclaw.builtin, true);
  assert.equal(openclaw.broken, false);
  assert.equal(openclaw.capabilities.list, false);
  assert.equal(openclaw.capabilities.find, true);
  assert.equal(openclaw.capabilities.getSession, true);
  assert.equal(openclaw.capabilities.needsAgent, true);
  assert.ok(!('error' in openclaw), '内置无 error 字段');
  const hermes = info[6];
  assert.equal(hermes.capabilities.list, true);
  assert.equal(hermes.capabilities.find, false);
  assert.equal(hermes.capabilities.parse, false);
  assert.equal(hermes.capabilities.watchParse, false);

  // 自定义：builtin false、label 保留、list 能力位 true
  const apple = info[7];
  assert.equal(apple.builtin, false);
  assert.equal(apple.label, 'Apple');
  assert.equal(apple.capabilities.list, true);

  // broken：全 false 能力位、label null、error 可见
  const broken = info[9];
  assert.equal(broken.id, null);
  assert.equal(broken.label, null);
  assert.equal(broken.builtin, false);
  assert.equal(broken.broken, true);
  assert.deepEqual(broken.capabilities, {
    list: false,
    find: false,
    parse: false,
    getSession: false,
    collectFiles: false,
    watchParse: false,
    needsAgent: false,
  });
  assert.match(broken.error, /导出非对象/);
});

// --- 冒烟 ---
// 临时 HOME 里放「一个抛错适配器 + 一个正常适配器」；正常适配器自包含、零第三方依赖
// （仅 Node 内置），读 <defaultDir> 下 *.jsonl 会话。子进程各自全新 init，
// 因此 HOME=tmpHome 即会被加载器读取。
const SMOKE_ADAPTER = `'use strict';
// 冒烟用自定义平台适配器：自包含、零第三方依赖（仅 Node 内置），读 <dir>/<id>.jsonl。
const fs = require('fs');
const path = require('path');

function sortDesc(a, b) {
  const aMs = Date.parse(a.timestamp || '') || 0;
  const bMs = Date.parse(b.timestamp || '') || 0;
  return bMs - aMs;
}
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
    return sessions.sort(sortDesc);
  },
  parse: async (filePath) => {
    const messages = [];
    for (const line of fs.readFileSync(filePath, 'utf8').split('\\n')) {
      if (!line) continue;
      try { messages.push(MESSAGE(JSON.parse(line))); } catch { /* 跳过坏行 */ }
    }
    const id = path.basename(filePath).replace(/\\.jsonl$/, '');
    return { session: { id, cwd: path.dirname(filePath), timestamp: messages[0] ? messages[0].timestamp : null }, messages };
  },
  getSession: async (dir, sessionId) => {
    const file = path.join(dir, sessionId + '.jsonl');
    try { fs.statSync(file); } catch { return null; }
    return module.exports.parse(file);
  },
};
`;

function runCli(home, args, extraEnv = {}) {
  const bin = path.join(REPO_ROOT, 'bin', 'agentlray.js');
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
  });
}

async function readPlatformInfo(home, extraEnv = {}) {
  const script = `const { listPlatformInfo } = require('./lib/platforms'); process.stdout.write(JSON.stringify(listPlatformInfo()));`;
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: home, ...extraEnv },
  });
  assert.equal(res.status, 0, `listPlatformInfo 子进程失败: ${res.stderr}`);
  return JSON.parse(res.stdout);
}

async function bootServer(home, extraEnv = {}) {
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    env: { ...process.env, HOME: home, PORT: String(port), HOST: '127.0.0.1', ...extraEnv },
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
        return { child, port };
      }
    } catch {
      /* 尚未监听 */
    }
    await new Promise((r) => setTimeout(r, 60));
  }
  throw new Error(`server never became ready on port ${port}: ${stderr.trim()}`);
}

test('冒烟：抛错适配器 + 正常适配器 → CLI 可查自定义平台、server 正常启动、broken 可见', async () => {
  resetPlatformDir();
  writeAdapter('01-throw.js', "throw new Error('boom from thrower');");
  writeAdapter('02-smoke.js', SMOKE_ADAPTER);

  // 造几个会话文件（JSONL，单行 JSON 记录）
  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-smoke-data-'));
  const records1 = [
    JSON.stringify({ id: 'm1', type: 'user', timestamp: '2026-10-25T01:00:00.000Z', content: '你好' }),
    JSON.stringify({ id: 'm2', type: 'assistant', timestamp: '2026-10-25T01:00:05.000Z', content: '你好！' }),
    JSON.stringify({ id: 'm3', type: 'user', timestamp: '2026-10-26T01:00:00.000Z', content: '再来' }),
  ];
  const records2 = [JSON.stringify({ id: 'n1', type: 'user', timestamp: '2026-10-27T01:00:00.000Z', content: '列表' })];
  fs.writeFileSync(path.join(smokeDir, 'sess-1.jsonl'), records1.join('\n') + '\n');
  fs.writeFileSync(path.join(smokeDir, 'sess-2.jsonl'), records2.join('\n') + '\n');

  // 1) CLI：node bin/agentlray.js sessions list --platform smoke-copilot --json
  const res = runCli(tmpHome, ['sessions', 'list', '--platform', 'smoke-copilot', '--json'], {
    SMOKE_COPILOT_DIR: smokeDir,
  });
  assert.equal(res.status, 0, `CLI 失败: ${res.stderr}`);
  const data = JSON.parse(res.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, 'sessions');
  assert.equal(data.platform, 'smoke-copilot');
  const sessions = data.sessions; // 单平台 list 顶层 sessions（非多平台 platforms 分块）
  assert.ok(Array.isArray(sessions), `应有 sessions 数组，实际: ${Object.keys(data).join(',')}`);
  assert.deepEqual(sessions.map((s) => s.id).sort(), ['sess-1', 'sess-2']);
  // 摘要携带状态推导依赖字段
  assert.ok(sessions.every((s) => s.timestamp && s.lastActivity != null && s.messageCount >= 1));

  // 2) listPlatformInfo：自定义平台与 broken 条目均可见（含 error），内置行为不变
  const info = await readPlatformInfo(tmpHome);
  const smoke = info.find((p) => p.id === 'smoke-copilot');
  assert.ok(smoke, '自定义平台在 listPlatformInfo 中可见');
  assert.equal(smoke.builtin, false);
  assert.equal(smoke.capabilities.list, true);
  assert.equal(smoke.capabilities.getSession, true);
  assert.equal(smoke.capabilities.watchParse, false);
  const broken = info.find((p) => p.broken === true);
  assert.ok(broken, 'broken 条目可见');
  assert.match(broken.error, /boom from thrower/);
  assert.equal(broken.label, null);
  assert.equal(info.filter((p) => p.builtin).length, 7, '内置 7 平台保持');
  assert.equal(info.filter((p) => p.capabilities.needsAgent).length, 1);

  // 3) server：用同一个含坏适配器的 HOME 正常启动不中断
  const { child } = await bootServer(tmpHome);
  try {
    assert.ok(child.pid > 0);
  } finally {
    child.kill('SIGKILL');
  }
});
