'use strict';
// agentlray platform CLI（bin/platform.js）测试：
//  - platform list --json 与 lib/platforms.listPlatformInfo()（GET /api/platforms 同源）完全一致
//  - platform list 纯文本行标注 内置/自定义/broken（broken 附 error）
//  - AGENTLRAY_NO_PLUGINS=1 时 list 自定义缺席、含逃生 broken 说明
//  - platform validate <正常适配器>：校验通过并调真实 list(defaultDir()) 报会话计数/首条 id
//  - platform validate <坏文件>：缺 label / 缺必需函数 / id 非法 / 文件不存在 → exit 1 + kind:error 携带原因
//  - 「校验通过但会话不可读」：defaultDir 目录不存在（list 抛错）→ exit 1 + error kind
//  - --help / 未知子命令
//
// loader 顶部基于 process.env.HOME（经 lib/config.js）求值平台目录
// ~/.agentlray/platforms → 必须在 require ../lib/platforms 之前先写适配器并设临时 HOME。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'agentlray.js');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-platform-cli-'));
process.env.HOME = tmpHome;
// setup-env.cjs 已全局注入空的 AGENTLRAY_PLATFORMS_DIR；本测试在临时 HOME 下
// 写入自定义适配器，需在此把两个来源目录重置为 HOME 派生路径，使适配器可被加载。
process.env.AGENTLRAY_PLATFORMS_DIR = path.join(tmpHome, '.agentlray', 'platforms');
// project 来源指仓库自带 platforms/（随包分发的 dsh/gemini/hermes 项目平台），
// 保证 4 内置 + 3 项目平台的 7 平台基线；自定义适配器走 user 来源。
process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = path.join(REPO_ROOT, 'platforms');

function writeAdapter(name, source) {
  const dir = path.join(tmpHome, '.agentlray', 'platforms');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  delete require.cache[file];
  fs.writeFileSync(file, source);
  return file;
}

function writeSessionJsonl(dir, id, records) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function runCli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
  });
}

// 正常适配器：读取 <defaultDir> 下 *.jsonl 会话，最新在前（供 validate 计数与 firstId 断言）。
const SMOKE_ADAPTER = `'use strict';
const fs = require('fs');
const path = require('path');
module.exports = {
  id: 'smoke-copilot',
  label: 'Smoke Copilot',
  defaultDir: () => process.env.SMOKE_COPILOT_DIR,
  list: async (dir) => {
    const sessions = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      const file = path.join(dir, name);
      const lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean);
      const last = lines
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
        .pop();
      sessions.push({
        id: name.replace(/\\.jsonl$/, ''),
        timestamp: last && last.timestamp ? last.timestamp : null,
        lastActivity: last && last.timestamp ? last.timestamp : null,
        mtimeMs: fs.statSync(file).mtimeMs,
        messageCount: lines.length,
        cwd: dir,
        tail: null,
        firstUserMessage: null,
      });
    }
    sessions.sort((a, b) => {
      const aMs = Date.parse(a.timestamp || '0') || 0;
      const bMs = Date.parse(b.timestamp || '0') || 0;
      return bMs - aMs;
    });
    return sessions;
  },
  parse: async (filePath) => ({ session: { id: path.basename(filePath, '.jsonl'), cwd: path.dirname(filePath) }, messages: [] }),
  getSession: async (dir, sessionId) => ({ session: { id: sessionId, cwd: dir }, messages: [] }),
};
`;

// 顶层布置：一个抛错适配器 + 一个正常适配器，再 require ../lib/platforms，使本进程的
// listPlatformInfo() 与 CLI 子进程（各自全新 init、读同一 platforms 目录）同源可比。
writeAdapter('01-throw.js', "throw new Error('boom-from-platform-cli');");
writeAdapter('02-smoke.js', SMOKE_ADAPTER);

// 当前进程与 CLI 子进程都读 SMOKE_COPILOT_DIR 求 smoke-copilot 的 defaultDir()；
// 必须在 require platforms（联到 adapter defaultDir()）前设好，否则 listPlatformInfo
// 的 defaultDir 在当前进程为 null、CLI 侧为实际路径，deepEqual 失配。
const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-platform-data-'));
process.env.SMOKE_COPILOT_DIR = smokeDir;
writeSessionJsonl(smokeDir, 'sess-1', [
  { id: 'm1', type: 'user', timestamp: '2026-10-25T01:00:00.000Z', content: '你好' },
  { id: 'm2', type: 'assistant', timestamp: '2026-10-25T01:00:05.000Z', content: '你好！' },
]);
writeSessionJsonl(smokeDir, 'sess-2', [
  { id: 'n1', type: 'user', timestamp: '2026-10-27T01:00:00.000Z', content: '列表' },
]);

const { listPlatformInfo } = require('../lib/platforms');

test('platform list --json 与 listPlatformInfo()（/api/platforms 同源）完全一致', () => {
  const res = runCli(tmpHome, ['platform', 'list', '--json'], { SMOKE_COPILOT_DIR: smokeDir });
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, 'platforms');
  const info = data.platforms;
  assert.deepEqual(info, listPlatformInfo(), 'CLI list 输出应与 listPlatformInfo 完全一致');
  assert.equal(info.filter((p) => p.builtin).length, 7, '内置 7 平台');
  const smoke = info.find((p) => p.id === 'smoke-copilot');
  assert.equal(smoke.builtin, false);
  assert.equal(smoke.broken, false);
  assert.equal(smoke.capabilities.list, true);
  const broken = info.find((p) => p.broken === true);
  assert.ok(broken, 'broken 条目可见');
  assert.match(broken.error, /boom-from-platform-cli/);
  assert.equal(broken.label, null);
});

test('platform list 纯文本行标注 内置/自定义/broken（broken 附 error）', () => {
  const res = runCli(tmpHome, ['platform', 'list'], { SMOKE_COPILOT_DIR: smokeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /Builtin\s+openclaw\s+OpenClaw/);
  assert.match(res.stdout, /Builtin\s+codex\s+Codex/);
  assert.match(res.stdout, /Custom\s+smoke-copilot\s+Smoke Copilot/);
  assert.match(res.stdout, /Broken\s+.*boom-from-platform-cli/);
});

test('platform list --json AGENTLRAY_NO_PLUGINS=1 时自定义缺席、含逃生 broken 说明', () => {
  const res = runCli(tmpHome, ['platform', 'list', '--json'], {
    SMOKE_COPILOT_DIR: smokeDir,
    AGENTLRAY_NO_PLUGINS: '1',
  });
  assert.equal(res.status, 0, res.stderr);
  const info = JSON.parse(res.stdout).platforms;
  assert.equal(info.find((p) => p.id === 'smoke-copilot'), undefined, '自定义平台应缺席');
  assert.equal(info.filter((p) => p.builtin).length, 7, '内置平台不受影响');
  const broken = info.filter((p) => p.broken);
  assert.equal(broken.length, 1, '仅一条逃生说明');
  assert.match(broken[0].error, /已禁用|AGENTLRAY_NO_PLUGINS=1/);
});

// ---- validate ----
// 独立适配器文件（不入 platforms 目录），id 与既有不冲突。
const VALIDATE_ADAPTER = `'use strict';
const fs = require('fs');
const path = require('path');
module.exports = {
  id: 'cli-validate',
  label: 'CLI Validate',
  defaultDir: () => process.env.SMOKE_COPILOT_DIR,
  list: async (dir) => {
    const sessions = [];
    for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
      const file = path.join(dir, name);
      const lines = fs.readFileSync(file, 'utf8').split('\\n').filter(Boolean);
      let lastTs = null;
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const rec = JSON.parse(lines[i]);
          if (rec && rec.timestamp) {
            lastTs = rec.timestamp;
            break;
          }
        } catch {
          /* 跳过坏行 */
        }
      }
      sessions.push({ id: name.replace(/\\.jsonl$/, ''), timestamp: lastTs, lastActivity: lastTs, mtimeMs: 0, cwd: dir });
    }
    sessions.sort((a, b) => (Date.parse(b.timestamp || '0') || 0) - (Date.parse(a.timestamp || '0') || 0));
    return sessions;
  },
  parse: async (filePath) => ({ session: { id: path.basename(filePath, '.jsonl'), cwd: path.dirname(filePath) }, messages: [] }),
  getSession: async (dir, sessionId) => null,
};
`;

function writeValidateFile() {
  const file = path.join(tmpHome, 'cli-validate.js');
  fs.writeFileSync(file, VALIDATE_ADAPTER);
  return file;
}

test('platform validate 正常适配器 --json：ok:true、sessionCount、firstId', () => {
  const file = writeValidateFile();
  const res = runCli(tmpHome, ['platform', 'validate', file, '--json'], { SMOKE_COPILOT_DIR: smokeDir });
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, 'platform-validate');
  assert.equal(data.ok, true);
  assert.deepEqual(data.platform, { id: 'cli-validate', label: 'CLI Validate' });
  assert.equal(data.sessionCount, 2);
  assert.equal(data.firstId, 'sess-2', '最新会话（时间降序首位）');
  assert.match(data.note, /可信/);
});

test('platform validate 正常适配器纯文本：含计数与首条 id，stderr 附信任提示', () => {
  const file = writeValidateFile();
  const res = runCli(tmpHome, ['platform', 'validate', file], { SMOKE_COPILOT_DIR: smokeDir });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /id=cli-validate/);
  assert.match(res.stdout, /sessions=2/);
  assert.match(res.stdout, /firstId=sess-2/);
  assert.match(res.stderr, /注意：.*可信/);
});

test('platform validate 坏文件：缺 label / 缺必需函数 / id 非法 / 文件不存在 → exit 1 + kind:error', () => {
  // 缺 label（键缺失 → undefined）
  const noLabel = path.join(tmpHome, 'cli-nolabel.js');
  fs.writeFileSync(
    noLabel,
    `'use strict';\nmodule.exports = { id: 'cli-nolabel', defaultDir: () => '${smokeDir}', list: async () => [], parse: async () => ({ session: { id: 'x' }, messages: [] }), getSession: async () => null };\n`
  );
  // 缺必需函数 getSession
  const noFn = path.join(tmpHome, 'cli-nofn.js');
  fs.writeFileSync(
    noFn,
    `'use strict';\nmodule.exports = { id: 'cli-nofn', label: 'No Fn', defaultDir: () => '${smokeDir}', list: async () => [], parse: async () => null };\n`
  );
  // id 非法（大写 + 下划线）
  const badId = path.join(tmpHome, 'cli-badid.js');
  fs.writeFileSync(
    badId,
    `'use strict';\nmodule.exports = { id: 'Bad_ID', label: 'Bad Id', defaultDir: () => '${smokeDir}', list: async () => [], parse: async () => null, getSession: async () => null };\n`
  );

  const cases = [
    [noLabel, /label 必须是字符串/],
    [noFn, /缺少必需函数 getSession/],
    [badId, /id 不合法/],
    [path.join(tmpHome, 'does-not-exist.js'), /不存在/],
  ];
  for (const [file, expected] of cases) {
    const res = runCli(tmpHome, ['platform', 'validate', file, '--json']);
    assert.equal(res.status, 1, `${file} 应 exit 1，实际 ${res.status}`);
    const data = JSON.parse(res.stdout);
    assert.equal(data.schemaVersion, 1);
    assert.equal(data.kind, 'error');
    assert.equal(data.error.code, 'validate');
    assert.match(data.error.message, expected, `${file} 错误信息应含原因`);
  }
});

test('platform validate 「校验通过但会话不可读」：defaultDir 目录不存在（list 抛错）→ exit 1 + error kind', () => {
  const file = path.join(tmpHome, 'cli-nodir.js');
  fs.writeFileSync(
    file,
    `'use strict';\nconst fs = require('fs');\nmodule.exports = { id: 'cli-nodir', label: 'No Dir', defaultDir: () => '/nonexistent-platform-dir-xyz', list: async (dir) => { fs.readdirSync(dir); return []; }, parse: async () => null, getSession: async () => null };\n`
  );
  const res = runCli(tmpHome, ['platform', 'validate', file, '--json']);
  assert.equal(res.status, 1, `应 exit 1，实际 ${res.status}`);
  const data = JSON.parse(res.stdout);
  assert.equal(data.kind, 'error');
  assert.equal(data.error.code, 'validate-sessions');
  assert.match(data.error.message, /校验通过但会话不可读/);
  assert.match(data.error.message, /list\(.*\) 抛错/);
});

// 隔离 HOME，只用于承载 settings.json（平台目录仍继承 tmpHome，适配器文件保持在
// tmpHome 下一份，避免同 id / list 的用例与其它 validate 用例互相影响）。
function settingsHome(settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-platform-cli-home-'));
  fs.mkdirSync(path.join(home, '.agentlray'), { recursive: true });
  fs.writeFileSync(path.join(home, '.agentlray', 'settings.json'), JSON.stringify(settings));
  return home;
}

test('platform validate 与加载器同口径：同 id 未声明替代拒绝，已声明替代允许通过', () => {
  const file = path.join(tmpHome, 'codex-replacement.js');
  fs.writeFileSync(
    file,
    `'use strict';\nmodule.exports = { id: 'codex', label: 'Codex Replacement', defaultDir: () => process.env.SMOKE_COPILOT_DIR, list: async () => [], parse: async () => null, getSession: async () => null };\n`
  );

  const rejected = runCli(tmpHome, ['platform', 'validate', file, '--json']);
  assert.equal(rejected.status, 1, '未声明替代时应拒绝同 id');
  assert.equal(JSON.parse(rejected.stdout).error.code, 'validate');
  assert.match(JSON.parse(rejected.stdout).error.message, /id 已被占用/);

  const home = settingsHome({ platforms: { replaced: ['codex'] } });
  const ok = runCli(home, ['platform', 'validate', file, '--json'], { SMOKE_COPILOT_DIR: smokeDir });
  assert.equal(ok.status, 0, ok.stderr);
  const data = JSON.parse(ok.stdout);
  assert.equal(data.ok, true);
  assert.deepEqual(data.platform, { id: 'codex', label: 'Codex Replacement' });
});

test('platform validate 允许 list 为 null（与 loader 一致）：跳过会话枚举并给出说明', () => {
  const file = path.join(tmpHome, 'cli-null-list.js');
  fs.writeFileSync(
    file,
    `'use strict';\nmodule.exports = { id: 'cli-null-list', label: 'Null List', defaultDir: () => process.env.SMOKE_COPILOT_DIR, list: null, parse: async () => null, getSession: async () => null };\n`
  );
  const res = runCli(tmpHome, ['platform', 'validate', file, '--json'], { SMOKE_COPILOT_DIR: smokeDir });
  assert.equal(res.status, 0, res.stderr);
  const data = JSON.parse(res.stdout);
  assert.equal(data.ok, true);
  assert.equal(data.sessionCount, null);
  assert.equal(data.firstId, null);
  assert.match(data.sessionsNote, /跳过会话枚举/);
});

test('platform --help 与未知子命令', () => {
  const help = runCli(tmpHome, ['platform', '--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage:.*platform list/s);
  assert.match(help.stdout, /platform validate <file>/);
  assert.match(help.stdout, /信任边界/);

  const unknown = runCli(tmpHome, ['platform', 'bogus', '--json']);
  assert.equal(unknown.status, 1);
  const data = JSON.parse(unknown.stdout);
  assert.equal(data.kind, 'error');
  assert.equal(data.error.code, 'usage');
  assert.match(data.error.message, /Unknown subcommand 'bogus'/);
});
