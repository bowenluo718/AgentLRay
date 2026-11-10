const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, spawn } = require('node:child_process');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');

const BIN = path.join(__dirname, '..', 'bin', 'agentlray.js');
const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'home');

async function makeTmpHome() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentlray-sessions-test-'));
  await fsp.cp(FIXTURE_HOME, tmp, { recursive: true });
  return tmp;
}

// openclaw 需要按 agent 名建目录；在临时 HOME 副本里写入夹具会话。
async function addOpenClawSession(home, agent, sessionId = 'oc-1111') {
  const sessionsDir = path.join(home, '.openclaw', 'agents', agent, 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const records = [
    { type: 'session', id: sessionId, timestamp: '2026-01-10T09:00:00.000Z', cwd: '/fixtures/project-oc' },
    {
      type: 'message',
      id: 'ocm-1',
      timestamp: '2026-01-10T09:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'fixture: openclaw needle task' }] },
    },
    {
      type: 'message',
      id: 'ocm-2',
      timestamp: '2026-01-10T09:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'fixture: openclaw done.' }] },
    },
  ];
  await fsp.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

// 夹具 HOME 派生的全部数据目录。CLI 子进程若只重定向 HOME，仍可能命中宿主进程
// 从 ~/.bashrc 导出的 DSH_DIR/OMP_DIR 等变量（如用户本机指向真实数据），导致
// resume/备份类用例时红时绿。这里与 test/helpers.js::serverEnv 保持同一套隔离。
function dataDirEnv(home) {
  return {
    OPENCLAW_DIR: path.join(home, '.openclaw', 'agents'),
    CODEX_DIR: path.join(home, '.codex', 'sessions'),
    CLAUDE_CODE_DIR: path.join(home, '.claude', 'projects'),
    OMP_DIR: path.join(home, '.omp', 'agent', 'sessions'),
    HERMES_DIR: path.join(home, '.hermes'),
    DSH_DIR: path.join(home, '.dsh', 'sessions'),
    GEMINI_DIR: path.join(home, '.gemini', 'tmp'),
    AGENTLRAY_NO_PLUGINS: '',
  };
}

function runCli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    // setup-env.cjs 会全局注入空的 AGENTLRAY_PLATFORMS_DIR，须覆盖为 HOME 派生的
    // 平台目录，使 addCustomPlatform 落盘的自定义适配器在 CLI 子进程里可见。
    env: {
      ...process.env,
      ...dataDirEnv(home),
      HOME: home,
      AGENTLRAY_PLATFORMS_DIR: path.join(home, '.agentlray', 'platforms'),
      // project 来源指向仓库自带 platforms/（含随包分发的 dsh/gemini/hermes 项目
      // 平台）；自定义加法器写 user 来源可见。与 test/helpers.js::serverEnv 同套隔离。
      AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(__dirname, '..', 'platforms'),
      AGENTLRAY_SELF_CMDLINE_MARKERS: selfCmdlineMarkers().join(path.delimiter),
      ...extraEnv,
    },
  });
}

// 本测试文件内的每个 CLI 子进程都在这份白名单下运行：把 agentlray 自身误判为 omp 持有者的
// 只可能来自本文件的用例（如并发 tool 进程），这些进程的 cmdline 只含本测试目录路径，
// 因此把「本测试目录路径」也当成本工具自身进程排除，得到与外部环境无关的稳定判定。
// 真实持有者用 `-c 'exec -a "omp --resume <fixturePath>" ...'` 启动，cmdline 不含本目录。
function selfCmdlineMarkers() {
  return [BIN, __dirname, 'agentlray-sessions-test-'];
}

// runCli 的异步版本（用 spawn 而非 spawnSync）：omp 持有/终止用例需在 CLI 运行期间
// 让本测试进程的事件循环保持自由，才能及时 reap 被 SIGKILL 的持有实例（spawnSync
// 会阻塞事件循环，使被杀的持有进程滞留为僵尸，导致 lib 侧仅用 process.kill(pid,0)
// 的存活判定误认为仍存活）。返回 { status, stdout, stderr }，语义与 spawnSync 一致。
function runCliAsync(home, args, extraEnv = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: {
        ...process.env,
        ...dataDirEnv(home),
        HOME: home,
        AGENTLRAY_PLATFORMS_DIR: path.join(home, '.agentlray', 'platforms'),
        AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, 'project-platforms'),
        AGENTLRAY_SELF_CMDLINE_MARKERS: selfCmdlineMarkers().join(path.delimiter),
        ...extraEnv,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => resolvePromise({ status: null, stdout, stderr, error: err }));
    child.on('close', (code) => resolvePromise({ status: code, stdout, stderr }));
  });
}

// 构造一个可执行假平台 CLI（spawn 用，验证 --run 传递的参数/工作目录/退出码）。
// 用 process.execPath 写 Node 脚本（跨平台可 spawn），不再依赖 #!/bin/sh：
// 语义与原 shell 版一致——逐行写 arg:参数、追加 cwd:工作目录、以指定退出码退出。
async function makeFakeBin(home, bin, exitCode = 0, outFile) {
  const bindir = path.join(home, '.fakebin');
  await fsp.mkdir(bindir, { recursive: true });
  const script =
    `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `let out = '';\n` +
    `process.argv.slice(2).forEach((a) => { out += 'arg:' + a + '\\n'; });\n` +
    `out += 'cwd:' + process.cwd() + '\\n';\n` +
    `fs.writeFileSync(${JSON.stringify(outFile)}, out);\n` +
    `process.exit(${exitCode});\n`;
  await fsp.writeFile(path.join(bindir, bin), script, { mode: 0o755 });
  return bindir;
}

// 在 temp HOME 写入自定义平台适配器 my-copilot（cli 子进程 require 期经
// lib/platforms/loader.js 并入注册表）。withResume=false 时不声明 resume
//（→ 「无原生续跑」）；bin 为 resume.bin 默认命令名。
async function addCustomPlatform(home, { withResume = true, bin = 'my-copilot-cli' } = {}) {
  const dir = path.join(home, '.agentlray', 'platforms');
  await fsp.mkdir(dir, { recursive: true });
  const resume = withResume
    ? `  resume: {\n    bin: ${JSON.stringify(bin)},\n    args: (id) => ['--resume', id],\n  },\n`
    : '';
  const source = `module.exports = {
  id: 'my-copilot',
  label: 'My Copilot',
  defaultDir: () => '/fixtures/my-copilot',
  list: async () => [],
  parse: async () => null,
  getSession: async (_dir, sessionId) =>
    sessionId === 'mp-1234'
      ? { session: { id: sessionId, cwd: '/fixtures/project-mp' }, messages: [] }
      : null,
${resume}};
`;
  await fsp.writeFile(path.join(dir, 'my-copilot.js'), source);
}

// 判定进程仍存活：已消失视为不再运行。跨平台可用——process.kill(pid, 0) 仅做
// 存活探测（Windows 同样支持），不依赖 Linux 的 /proc/<pid>/stat 僵尸判定。
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// 轮询等待文件落盘（fire-and-forget spawn 的 detach 子进程异步写日志时使用）。
async function waitForFile(filePath, { timeoutMs = 2000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fsp.access(filePath);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, stepMs));
    }
  }
  await fsp.access(filePath); // 未按时出现 → 抛错暴露
}

test('sessions --help 输出 list/show/resume/new 用法', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', '--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /sessions list/);
  assert.match(res.stdout, /sessions show/);
  assert.match(res.stdout, /sessions resume/);
  assert.match(res.stdout, /sessions new/);
});

test('sessions list 同时查询多平台（--platform 逗号多值）', async () => {
  const home = await makeTmpHome();

  const multi = runCli(home, ['sessions', 'list', '--platform', 'omp,codex', '--json']);
  assert.equal(multi.status, 0);
  const multiJson = JSON.parse(multi.stdout);
  assert.equal(multiJson.schemaVersion, 1);
  assert.equal(multiJson.kind, 'sessions');
  assert.equal(multiJson.platform, 'omp,codex');
  assert.equal(multiJson.all, false);
  assert.deepEqual(multiJson.platformIds, ['omp', 'codex']);
  assert.equal(multiJson.platforms.length, 2);
  const ompBlock = multiJson.platforms.find((p) => p.platform === 'omp');
  assert.ok(ompBlock);
  assert.equal(ompBlock.agent, null);
  assert.equal(ompBlock.total, 2);
  assert.ok(ompBlock.sessions.some((s) => s.id === '019a0000-0000-7000-8000-00000000aaaa'));
  const codexBlock = multiJson.platforms.find((p) => p.platform === 'codex');
  assert.ok(codexBlock);
  assert.ok(codexBlock.total >= 1);
  assert.ok(codexBlock.sessions.some((s) => s.id === '01900000-0000-7000-8000-000000000001'));

  // 过滤作用于每个平台块：status/match 各自独立命中
  const filtered = runCli(home, ['sessions', 'list', '--platform', 'omp,codex', '--status', 'stopped', '--json']);
  const fJson = JSON.parse(filtered.stdout);
  assert.equal(fJson.platforms.every((p) => p.total === p.sessions.length), true);

  const bad = runCli(home, ['sessions', 'list', '--platform', 'omp,nope', '--json']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown platform/);

  // all 不能与其他平台混用
  const mixed = runCli(home, ['sessions', 'list', '--platform', 'all,omp', '--json']);
  assert.equal(mixed.status, 1);
  assert.match(mixed.stderr, /cannot be combined/);
});

test('sessions list 多平台 all 语义：含全部平台、openclaw 遍历 agents', async () => {
  const home = await makeTmpHome();
  await addOpenClawSession(home, 'my-agent');
  await addOpenClawSession(home, 'other-agent');

  const all = runCli(home, ['sessions', 'list', '--platform', 'all', '--json']);
  assert.equal(all.status, 0);
  const json = JSON.parse(all.stdout);
  assert.equal(json.all, true);
  // 7 平台注册表 id 集合
  assert.deepEqual(
    [...new Set(json.platformIds)].sort(),
    ['claude-code', 'codex', 'dsh', 'gemini', 'hermes', 'omp', 'openclaw'].sort()
  );
  // openclaw：未传 --agent → 每个 agent 一段（这里两个 agent 各 1 个会话）
  const ocBlocks = json.platforms.filter((p) => p.platform === 'openclaw');
  assert.equal(ocBlocks.length, 2);
  assert.deepEqual(
    new Set(ocBlocks.map((p) => p.agent)),
    new Set(['my-agent', 'other-agent'])
  );
  assert.ok(json.platforms.every((p) => Array.isArray(p.sessions)));

  // 纯文本分段标题含平台与 agent
  const plain = runCli(home, ['sessions', 'list', '--platform', 'omp,codex']);
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /== omp ==/);
  assert.match(plain.stdout, /== codex ==/);

  // 多平台模式下 --dir 不可用
  const dirErr = runCli(home, ['sessions', 'list', '--platform', 'omp,codex', '--dir', '/tmp', '--json']);
  assert.equal(dirErr.status, 1);
  assert.match(dirErr.stderr, /仅支持单平台模式/);
});

test('sessions list 列出 omp 会话并按平台/状态过滤', async () => {
  const home = await makeTmpHome();
  const all = runCli(home, ['sessions', 'list', '--platform', 'omp', '--json']);
  assert.equal(all.status, 0);
  const allJson = JSON.parse(all.stdout);
  assert.equal(allJson.schemaVersion, 1);
  assert.equal(allJson.kind, 'sessions');
  assert.equal(allJson.platform, 'omp');
  assert.equal(allJson.total, 2);
  const ids = allJson.sessions.map((s) => s.id);
  assert.ok(ids.includes('019a0000-0000-7000-8000-00000000aaaa'));
  assert.ok(ids.includes('019a0000-0000-7000-8000-00000000bbbb'));

  // 列表须含首条用户消息与最后一条消息内容
  const aaaa = allJson.sessions.find((s) => s.id === '019a0000-0000-7000-8000-00000000aaaa');
  assert.equal(aaaa.firstUserMessage, 'fixture: omp-prompt-alpha run the failing tool');
  assert.deepEqual(aaaa.lastMessage, { role: 'assistant', text: 'fixture: the tool failed as expected.' });
  const bbbb = allJson.sessions.find((s) => s.id === '019a0000-0000-7000-8000-00000000bbbb');
  assert.deepEqual(bbbb.lastMessage, { role: 'assistant', text: 'fixture: ran the fixture-prompt checks.' });

  // 夹具时间远早于当前墙钟 → 全部 stopped；按状态过滤应只有 stopped 命中。
  const stopped = runCli(home, ['sessions', 'list', '--platform', 'omp', '--status', 'stopped', '--json']);
  assert.equal(JSON.parse(stopped.stdout).total, 2);
  const working = runCli(home, ['sessions', 'list', '--platform', 'omp', '--status', 'working', '--json']);
  assert.equal(JSON.parse(working.stdout).total, 0);

  const bad = runCli(home, ['sessions', 'list', '--platform', 'omp', '--status', 'bogus', '--json']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown status/);
});

test('sessions list 支持 --match / --since / --limit', async () => {
  const home = await makeTmpHome();

  const byMatch = runCli(home, ['sessions', 'list', '--platform', 'omp', '--match', 'omp-prompt-alpha', '--json']);
  const matchJson = JSON.parse(byMatch.stdout);
  assert.equal(matchJson.total, 1);
  assert.equal(matchJson.sessions[0].id, '019a0000-0000-7000-8000-00000000aaaa');

  // --match 也能命中最后一条消息内容（不在 title/首条用户消息里）
  const byLast = runCli(home, ['sessions', 'list', '--platform', 'omp', '--match', 'failed as expected', '--json']);
  const lastJson = JSON.parse(byLast.stdout);
  assert.equal(lastJson.total, 1);
  assert.equal(lastJson.sessions[0].id, '019a0000-0000-7000-8000-00000000aaaa');

  // bbbb 会话最后活动为 2026-01-21T09:00:05Z，早于该时刻的都被排除。
  const since = runCli(home, ['sessions', 'list', '--platform', 'omp', '--since', '2026-01-21T00:00:00Z', '--json']);
  const sinceJson = JSON.parse(since.stdout);
  assert.equal(sinceJson.total, 1);
  assert.equal(sinceJson.sessions[0].id, '019a0000-0000-7000-8000-00000000bbbb');

  const limited = runCli(home, ['sessions', 'list', '--platform', 'omp', '--limit', '1', '--json']);
  const limitJson = JSON.parse(limited.stdout);
  assert.equal(limitJson.total, 2); // 分页前总数
  assert.equal(limitJson.sessions.length, 1);

  const until = runCli(home, ['sessions', 'list', '--platform', 'omp', '--until', '2026-01-20T20:00:00Z', '--json']);
  const untilJson = JSON.parse(until.stdout);
  assert.equal(untilJson.total, 1);
  assert.equal(untilJson.sessions[0].id, '019a0000-0000-7000-8000-00000000aaaa');
});

test('sessions list openclaw 缺省合并全部 agents（--agent 下仍限定单 agent）；未知平台报错', async () => {
  const home = await makeTmpHome();
  await addOpenClawSession(home, 'my-agent', 'oc-1111');
  await addOpenClawSession(home, 'other-agent', 'oc-2222');

  // 单 agent：--agent 限定
  const withAgent = runCli(home, ['sessions', 'list', '--platform', 'openclaw', '--agent', 'my-agent', '--json']);
  assert.equal(withAgent.status, 0);
  const json = JSON.parse(withAgent.stdout);
  assert.equal(json.agent, 'my-agent');
  assert.equal(json.total, 1);
  assert.equal(json.sessions[0].id, 'oc-1111');
  assert.equal(json.sessions[0].agent, 'my-agent');

  // 无 --agent：默认全部 agents 合并（每条带来源 agent）
  const noAgent = runCli(home, ['sessions', 'list', '--platform', 'openclaw', '--json']);
  assert.equal(noAgent.status, 0);
  const all = JSON.parse(noAgent.stdout);
  assert.equal(all.agent, null);
  assert.equal(all.allAgents, true);
  assert.equal(all.total, 2);
  const ids = all.sessions.map((s) => s.id).sort();
  assert.deepEqual(ids, ['oc-1111', 'oc-2222']);
  const byAgent = Object.fromEntries(all.sessions.map((s) => [s.id, s.agent]));
  assert.equal(byAgent['oc-1111'], 'my-agent');
  assert.equal(byAgent['oc-2222'], 'other-agent');

  // 纯文本合并视图带 agent 列
  const plain = runCli(home, ['sessions', 'list', '--platform', 'openclaw']);
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /^agent/m);
  assert.match(plain.stdout, /other-agent/);
  assert.match(plain.stdout, /my-agent/);

  const unknown = runCli(home, ['sessions', 'list', '--platform', 'nope', '--json']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown platform/);

  const unknownJson = JSON.parse(unknown.stdout);
  assert.equal(unknownJson.kind, 'error');
});

test('sessions show openclaw 缺省跨全部 agents 查找并标注 agent', async () => {
  const home = await makeTmpHome();
  await addOpenClawSession(home, 'my-agent', 'oc-1111');
  await addOpenClawSession(home, 'other-agent', 'oc-2222');

  // 无 --agent：跨 agents 找到该 id，并标注归属 agent
  const found = runCli(home, ['sessions', 'show', '--platform', 'openclaw', '--id', 'oc-2222', '--json']);
  assert.equal(found.status, 0);
  const json = JSON.parse(found.stdout);
  assert.equal(json.kind, 'session');
  assert.equal(json.agent, 'other-agent');
  assert.equal(json.session.id, 'oc-2222');

  // 未命中：报错退出 1
  const missing = runCli(home, ['sessions', 'show', '--platform', 'openclaw', '--id', 'oc-nope', '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
});

test('sessions list 纯文本输出含表头与会话行', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'list', '--platform', 'codex']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /状态/);
  assert.match(res.stdout, /首条用户消息/);
  assert.match(res.stdout, /最后消息/);
  assert.match(res.stdout, /01900000-0000-7000-8000-000000000001/);
  assert.match(res.stdout, /duplicate handled/); // lastMessage 文本
});

test('sessions show 输出会话详情（json 含归一化消息）', async () => {
  const home = await makeTmpHome();

  const omp = runCli(home, ['sessions', 'show', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--json']);
  assert.equal(omp.status, 0);
  const ompJson = JSON.parse(omp.stdout);
  assert.equal(ompJson.kind, 'session');
  assert.equal(ompJson.session.id, '019a0000-0000-7000-8000-00000000aaaa');
  assert.equal(ompJson.session.cwd, '/fixtures/project-gamma');
  const roles = ompJson.messages.map((m) => m.role);
  for (const r of ['user', 'assistant', 'toolCall', 'toolResult']) assert.ok(roles.includes(r));

  const claude = runCli(home, [
    'sessions', 'show', '--platform', 'claude-code', '--id', 'aaaa1111-2222-4333-8444-555566667777', '--json',
  ]);
  assert.equal(claude.status, 0);
  const claudeJson = JSON.parse(claude.stdout);
  assert.equal(claudeJson.session.id, 'aaaa1111-2222-4333-8444-555566667777');
  const claudeRoles = claudeJson.messages.map((m) => m.role);
  // claude 的 tool_use 内嵌在 assistant 消息 content（type:'toolCall'），不会拆成独立角色
  assert.ok(claudeRoles.includes('toolResult'));
  const assistant = claudeJson.messages.find((m) => m.role === 'assistant' && Array.isArray(m.content));
  assert.ok(assistant.content.some((c) => c.type === 'toolCall'));

  const plain = runCli(home, ['sessions', 'show', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001']);
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /# Session 01900000-0000-7000-8000-000000000001/);
  assert.match(plain.stdout, /# user/);
  assert.match(plain.stdout, /# toolCall/);

  const missing = runCli(home, ['sessions', 'show', '--platform', 'omp', '--id', 'does-not-exist', '--json']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
});

test('sessions resume 默认只打印命令，含 cwd 前缀与消息转义', async () => {
  const home = await makeTmpHome();

  const codex = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001']);
  assert.equal(codex.status, 0);
  assert.equal(
    codex.stdout.trim(),
    "cd '/fixtures/project-alpha' && codex resume 01900000-0000-7000-8000-000000000001 --yolo"
  );

  const msg = runCli(home, [
    'sessions', 'resume', '--platform', 'claude-code', '--id', 'aaaa1111-2222-4333-8444-555566667777',
    '--message', "add a test with 'quotes'",
  ]);
  assert.equal(msg.status, 0);
  // POSIX 单引号转义：'add a test with '\''quotes'\'''
  assert.equal(
    msg.stdout.trim(),
    "cd '/fixtures/project-beta' && claude --dangerously-skip-permissions --resume aaaa1111-2222-4333-8444-555566667777 'add a test with '\\''quotes'\\'''"
  );

  const ompJson = runCli(home, ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--json']);
  assert.equal(ompJson.status, 0);
  const ompDoc = JSON.parse(ompJson.stdout);
  assert.equal(ompDoc.kind, 'resume');
  assert.equal(ompDoc.executed, false);
  assert.match(ompDoc.command, /omp --auto-approve --resume=019a0000-0000-7000-8000-00000000aaaa/);
  // 夹具会话未被运行中 omp 实例持有 → 非派生、直接放行
  assert.equal(ompDoc.livePid, null);
  assert.equal(ompDoc.note, null);
  assert.doesNotMatch(ompJson.stderr, /持有|派生/);

  // dsh：无 resume 契约（交互式 TUI 不可续跑）→ 明确报错
  const dsh = runCli(home, ['sessions', 'resume', '--platform', 'dsh', '--id', 'dsh-fixture-session-0001']);
  assert.equal(dsh.status, 1);
  assert.match(dsh.stderr, /no native resume/);

  const gemini = runCli(home, ['sessions', 'resume', '--platform', 'gemini', '--id', 'gemini-fixture-session-0001']);
  assert.equal(gemini.status, 0);
  assert.equal(
    gemini.stdout.trim(),
    "cd '/fixtures/project-zeta' && gemini -r gemini-fixture-session-0001 --approval-mode=yolo"
  );

  // 无原生续跑的平台明确报错（openclaw 无续跑契约）
  const unsupported = runCli(home, ['sessions', 'resume', '--platform', 'openclaw', '--id', 'oc-1111']);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /no native resume/);

  const missing = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', 'missing-session']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
});

test('sessions resume 可用 AGENTLRAY_*_BIN 环境变量覆盖平台 CLI 命令（未设置回退默认名）', async () => {
  const home = await makeTmpHome();

  // 未设置 → 默认命令名
  const def = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001', '--json']);
  const defDoc = JSON.parse(def.stdout);
  assert.equal(defDoc.bin, 'codex');

  // 各平台分别用绝对路径覆盖（gemini 有会话夹具；hermes 无夹具不可达续跑，跳过）
  const bins = {
    codex: '/home/u/.nvm/versions/node/v22.19.0/bin/codex',
    'claude-code': '/home/u/.nvm/versions/node/v22.19.0/bin/claude',
    omp: '/home/u/.nvm/versions/node/v22.19.0/bin/omp',
    gemini: '/home/u/.local/bin/gemini',
  };
  const envVar = {
    codex: 'AGENTLRAY_CODEX_BIN',
    'claude-code': 'AGENTLRAY_CLAUDE_CODE_BIN',
    omp: 'AGENTLRAY_OMP_BIN',
    gemini: 'AGENTLRAY_GEMINI_BIN',
  };
  const cases = [
    ['codex', '01900000-0000-7000-8000-000000000001'],
    ['claude-code', 'aaaa1111-2222-4333-8444-555566667777'],
    ['omp', '019a0000-0000-7000-8000-00000000aaaa'],
    ['gemini', 'gemini-fixture-session-0001'],
  ];
  for (const [platform, id] of cases) {
    const res = runCli(home, ['sessions', 'resume', '--platform', platform, '--id', id, '--json'], {
      [envVar[platform]]: bins[platform],
    });
    assert.equal(res.status, 0, `${platform} resume 应成功`);
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.bin, bins[platform], `${platform} bin 应被环境变量覆盖`);
    assert.match(doc.command, new RegExp(bins[platform].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('sessions resume 读取 web 设置面板写入的 settings.json cliBins（无环境变量时）', async () => {
  const home = await makeTmpHome();
  // 模拟 web 设置面板 PUT /api/settings（cliBins section）落盘的配置。
  await fsp.mkdir(path.join(home, '.agentlray'), { recursive: true });
  await fsp.writeFile(
    path.join(home, '.agentlray', 'settings.json'),
    JSON.stringify({
      cliBins: {
        codex: '/home/u/.nvm/versions/node/v22.19.0/bin/codex',
        'claude-code': '/home/u/.nvm/versions/node/v22.19.0/bin/claude',
      },
      updatedAt: '2026-10-26T00:00:00.000Z',
    })
  );

  // 未设环境变量 → 读配置文件；omp 未配置 → 回退默认名。
  const codex = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001', '--json']);
  assert.equal(JSON.parse(codex.stdout).bin, '/home/u/.nvm/versions/node/v22.19.0/bin/codex');

  const claude = runCli(home, ['sessions', 'resume', '--platform', 'claude-code', '--id', 'aaaa1111-2222-4333-8444-555566667777', '--json']);
  assert.equal(JSON.parse(claude.stdout).bin, '/home/u/.nvm/versions/node/v22.19.0/bin/claude');

  const omp = runCli(home, ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--json']);
  assert.equal(JSON.parse(omp.stdout).bin, 'omp');

  // 环境变量仍优先于配置文件。
  const env = runCli(
    home,
    ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001', '--json'],
    { AGENTLRAY_CODEX_BIN: '/override/bin/codex' }
  );
  assert.equal(JSON.parse(env.stdout).bin, '/override/bin/codex');
});

test('sessions resume 自定义平台声明 resume 时生成续跑命令（bin=resume.bin，args 正确）', async () => {
  const home = await makeTmpHome();
  await addCustomPlatform(home);

  const res = runCli(home, ['sessions', 'resume', '--platform', 'my-copilot', '--id', 'mp-1234', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'resume');
  assert.equal(doc.platform, 'my-copilot');
  assert.equal(doc.executed, false);
  assert.equal(doc.bin, 'my-copilot-cli');
  assert.deepEqual(doc.args, ['--resume', 'mp-1234']);
  assert.equal(doc.cwd, '/fixtures/project-mp');
  assert.equal(doc.command, "cd '/fixtures/project-mp' && my-copilot-cli --resume mp-1234");
});

test('sessions resume 自定义平台 settings.json cliBins 的 <id> 键覆盖 resume.bin', async () => {
  const home = await makeTmpHome();
  await addCustomPlatform(home);
  await fsp.mkdir(path.join(home, '.agentlray'), { recursive: true });
  await fsp.writeFile(path.join(home, '.agentlray', 'settings.json'), JSON.stringify({ cliBins: { 'my-copilot': '/override/bin/mycopilot' } }));

  const res = runCli(home, ['sessions', 'resume', '--platform', 'my-copilot', '--id', 'mp-1234', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.bin, '/override/bin/mycopilot');
  assert.match(doc.command, /\/override\/bin\/mycopilot --resume mp-1234/);
});

test('sessions resume 自定义平台 AGENTLRAY_<ID>_BIN 环境变量 > settings.json cliBins > resume.bin', async () => {
  const home = await makeTmpHome();
  await addCustomPlatform(home);
  await fsp.mkdir(path.join(home, '.agentlray'), { recursive: true });
  await fsp.writeFile(path.join(home, '.agentlray', 'settings.json'), JSON.stringify({ cliBins: { 'my-copilot': '/file/bin/mycopilot' } }));

  // 仅文件覆盖 → 文件值（高于 resume.bin 默认）
  const fromFile = runCli(home, ['sessions', 'resume', '--platform', 'my-copilot', '--id', 'mp-1234', '--json']);
  assert.equal(JSON.parse(fromFile.stdout).bin, '/file/bin/mycopilot');

  // env + 文件同时存在 → env 优先
  const fromEnv = runCli(
    home,
    ['sessions', 'resume', '--platform', 'my-copilot', '--id', 'mp-1234', '--json'],
    { AGENTLRAY_MY_COPILOT_BIN: '/env/bin/mycopilot' }
  );
  assert.equal(JSON.parse(fromEnv.stdout).bin, '/env/bin/mycopilot');
});

test('sessions resume 自定义平台 --run 真实 spawn resume.bin 与 args', async () => {
  const home = await makeTmpHome();
  await addCustomPlatform(home);
  const fakeLog = path.join(home, 'fake-custom.log');
  const bindir = await makeFakeBin(home, 'my-copilot-cli', 0, fakeLog);
  const workdir = path.join(home, 'work');
  await fsp.mkdir(workdir, { recursive: true });

  const res = runCli(
    home,
    ['sessions', 'resume', '--platform', 'my-copilot', '--id', 'mp-1234', '--run', '--cwd', workdir, '--message', 'go on', '--json'],
    { PATH: `${bindir}${path.delimiter}${process.env.PATH || ''}` }
  );
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.executed, true);
  assert.equal(doc.bin, 'my-copilot-cli');
  // 假平台 CLI 被真实调用：args 含 --resume <id> 与追加消息
  const log = await fsp.readFile(fakeLog, 'utf8');
  assert.match(log, /arg:--resume/);
  assert.match(log, /arg:mp-1234/);
  assert.match(log, /arg:go on/);
  assert.match(log, new RegExp(`cwd:${workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('sessions resume 自定义平台未声明 resume 报「无原生续跑」', async () => {
  const home = await makeTmpHome();
  await addCustomPlatform(home, { withResume: false });

  const res = runCli(home, ['sessions', 'resume', '--platform', 'my-copilot', '--id', 'mp-1234', '--json']);
  assert.equal(res.status, 1);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'error');
  assert.equal(doc.error.code, 'usage');
  assert.match(doc.error.message, /no native resume command/);
  assert.match(res.stderr, /no native resume command/);
});

test('sessions resume --run 真实 spawn 平台 CLI、透传退出码', async () => {
  const home = await makeTmpHome();
  const fakeLog = path.join(home, 'fake.log');
  const bindir = await makeFakeBin(home, 'codex', 0, fakeLog);
  const workdir = path.join(home, 'work');
  await fsp.mkdir(workdir, { recursive: true });
  const extraPath = `${bindir}${path.delimiter}${process.env.PATH || ''}`;

  const res = runCli(
    home,
    ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001', '--run', '--cwd', workdir, '--message', 'go on'],
    { PATH: extraPath }
  );
  assert.equal(res.status, 0);
  const log = await fsp.readFile(fakeLog, 'utf8');
  assert.match(log, /arg:resume/);
  assert.match(log, /arg:01900000-0000-7000-8000-000000000001/);
  assert.match(log, /arg:--yolo/);
  assert.match(log, /arg:go on/);
  assert.match(log, new RegExp(`cwd:${workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('sessions resume --run 传递平台退出码（非零）', async () => {
  const home = await makeTmpHome();
  const fakeLog = path.join(home, 'fake3.log');
  const bindir = await makeFakeBin(home, 'omp', 3, fakeLog);
  const workdir = path.join(home, 'work');
  await fsp.mkdir(workdir, { recursive: true });

  const res = runCli(
    home,
    ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--run', '--cwd', workdir],
    { PATH: `${bindir}${path.delimiter}${process.env.PATH || ''}` }
  );
  assert.equal(res.status, 3);
});

test('sessions resume --run 平台 CLI 不存在时报错退出', async () => {
  const home = await makeTmpHome();
  // 有效 cwd（避免先命中"会话 cwd 不存在"校验），但 HOME 外 PATH 不含 codex →
  // spawn 报 ENOENT → 明确报错
  const workdir = path.join(home, 'nocli');
  await fsp.mkdir(workdir, { recursive: true });
  const res = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001', '--run', '--cwd', workdir]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Failed to run/);
});

test('sessions resume 对未被持有的 omp 会话放行（livePid=null，非派生）', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.livePid, null);
  assert.equal(doc.note, null);
  assert.doesNotMatch(res.stderr, /持有|派生/);
});

test('sessions resume --run 自动终止持有实例后同 id 续跑（不接受派生）', { skip: process.platform === 'win32' }, async () => {
  const home = await makeTmpHome();
  const log = path.join(home, 'fake-kill.log');
  const bindir = await makeFakeBin(home, 'omp', 0, log);
  // 伪造一个"正在以 --resume 持有该会话"的运行中 omp 实例：cmdline 含
  // `omp --resume <途经含目标会话 id 的路径>`（路径不含 agentlray 字样）
  const fakePath = path.join(os.tmpdir(), `holder-${Date.now()}`, '019a0000-0000-7000-8000-00000000aaaa.jsonl');
  const holder = spawn('bash', ['-c', `exec -a "omp --resume ${fakePath} fakeholder" sleep 300; exit 0`], {
    detached: true,
    stdio: 'ignore',
  });
  holder.unref();
  await new Promise((r) => setTimeout(r, 400));
  const workdir = path.join(home, 'work');
  await fsp.mkdir(workdir, { recursive: true });
  try {
    const res = await runCliAsync(
      home,
      ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--run', '--cwd', workdir, '--json'],
      { PATH: `${bindir}${path.delimiter}${process.env.PATH || ''}` }
    );
    assert.equal(res.status, 0);
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.kind, 'resume');
    assert.equal(doc.executed, true);
    assert.equal(doc.livePid, holder.pid);
    assert.equal(doc.terminated, true);
    assert.match(doc.note, /已自动终止/);
    // 持有实例已被自动终止（消失或成僵尸）
    assert.equal(isAlive(holder.pid), false);
    // 随后确以原 id 续跑（假平台 CLI 被真实调用）
    const logText = await fsp.readFile(log, 'utf8');
    assert.match(logText, /arg:--resume=019a0000-0000-7000-8000-00000000aaaa/);
  } finally {
    try {
      process.kill(holder.pid, 'SIGKILL');
    } catch {}
  }
});

test('sessions resume --run 持有实例忽略 SIGTERM 时 SIGKILL 兜底后续跑', { skip: process.platform === 'win32' }, async () => {
  const home = await makeTmpHome();
  const log = path.join(home, 'fake-kill2.log');
  const bindir = await makeFakeBin(home, 'omp', 0, log);
  const fakePath = path.join(os.tmpdir(), `holder2-${Date.now()}`, '019a0000-0000-7000-8000-00000000aaaa.jsonl');
  // 该持有实例忽略 SIGTERM，只能靠 SIGKILL 兜底终止（线程在 termWait 后仍存活）
  const holder = spawn('bash', ['-c', `trap "" TERM; exec -a "omp --resume ${fakePath} fakeholder" sleep 300; exit 0`], {
    detached: true,
    stdio: 'ignore',
  });
  holder.unref();
  await new Promise((r) => setTimeout(r, 400));
  const workdir = path.join(home, 'work2');
  await fsp.mkdir(workdir, { recursive: true });
  try {
    const res = await runCliAsync(
      home,
      ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--run', '--cwd', workdir, '--json'],
      { PATH: `${bindir}${path.delimiter}${process.env.PATH || ''}` }
    );
    assert.equal(res.status, 0);
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.terminated, true);
    assert.equal(doc.livePid, holder.pid);
    assert.match(doc.note, /已自动终止/);
    assert.equal(isAlive(holder.pid), false);
  } finally {
    try {
      process.kill(holder.pid, 'SIGKILL');
    } catch {}
  }
});

test('sessions resume 打印模式检出持有实例仅提示、不自动终止', { skip: process.platform === 'win32' }, async () => {
  const home = await makeTmpHome();
  const fakePath = path.join(os.tmpdir(), `holder3-${Date.now()}`, '019a0000-0000-7000-8000-00000000aaaa.jsonl');
  const holder = spawn('bash', ['-c', `exec -a "omp --resume ${fakePath} fakeholder" sleep 300; exit 0`], {
    detached: true,
    stdio: 'ignore',
  });
  holder.unref();
  await new Promise((r) => setTimeout(r, 400));
  try {
    const res = runCli(home, [
      'sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--json',
    ]);
    assert.equal(res.status, 0);
    const doc = JSON.parse(res.stdout);
    assert.equal(doc.executed, false);
    assert.equal(doc.terminated, false);
    assert.equal(doc.livePid, holder.pid);
    assert.match(doc.note, /--run 将自动终止/);
    // 打印模式不改动持有实例
    assert.equal(isAlive(holder.pid), true);
  } finally {
    try {
      process.kill(holder.pid, 'SIGKILL');
    } catch {}
  }
});

test('sessions 未知子命令报错且退出 1', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'frobnicate']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown subcommand/);
});

// 页面持久化的平台选择（看板 /api/settings 落盘的 ~/.agentlray/settings.json 的
// ui section）——CLI 未传 --platform 时的缺省来源。
async function writeUiSettings(home, data) {
  const dir = path.join(home, '.agentlray');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'settings.json');
  let settings = {};
  try {
    settings = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    /* 首次写入 */
  }
  settings.ui = data;
  await fsp.writeFile(file, JSON.stringify(settings, null, 2));
}

test('sessions list 缺省无持久化平台数据时 = all（全部平台）', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'list', '--json']);
  assert.equal(res.status, 0);
  const json = JSON.parse(res.stdout);
  assert.equal(json.all, true);
  assert.equal(json.platformIds.length, 7);
});

test('sessions list 缺省用页面持久化的多选平台集合', async () => {
  const home = await makeTmpHome();
  await writeUiSettings(home, { platform: 'omp', selectedPlatforms: ['omp', 'codex'] });
  const res = runCli(home, ['sessions', 'list', '--json']);
  assert.equal(res.status, 0);
  const json = JSON.parse(res.stdout);
  assert.equal(json.platform, 'omp,codex');
  assert.deepEqual(json.platformIds, ['omp', 'codex']);
  assert.equal(json.platforms.length, 2);
});

test('sessions list 缺省持久化全选 = all；单平台模式（空多选）用持久化 platform', async () => {
  const home = await makeTmpHome();
  await writeUiSettings(home, {
    platform: 'omp',
    selectedPlatforms: ['openclaw', 'codex', 'claude-code', 'hermes', 'omp', 'dsh', 'gemini'],
  });
  const all = runCli(home, ['sessions', 'list', '--json']);
  assert.equal(JSON.parse(all.stdout).all, true);

  await writeUiSettings(home, { platform: 'omp', selectedPlatforms: [] });
  const single = runCli(home, ['sessions', 'list', '--json']);
  assert.equal(single.status, 0);
  const singleJson = JSON.parse(single.stdout);
  assert.equal(singleJson.platform, 'omp');
  // 单平台输出不带 all 字段（仅多平台/ all 有）
  assert.equal(singleJson.all, undefined);
});

test('sessions list 缺省多选模式下 --dir 仍不可用', async () => {
  const home = await makeTmpHome();
  await writeUiSettings(home, { platform: 'omp', selectedPlatforms: ['omp', 'codex'] });
  const res = runCli(home, ['sessions', 'list', '--dir', '/tmp', '--json']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /仅支持单平台模式/);
});

test('sessions show 缺省无持久化数据时报错要求 --platform', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'show', '--id', 'x', '--json']);
  assert.equal(res.status, 1);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'error');
  assert.match(doc.error.message, /--platform/);
});

test('sessions show 缺省用页面持久化的单平台', async () => {
  const home = await makeTmpHome();
  await writeUiSettings(home, { platform: 'codex', selectedPlatforms: [] });
  const res = runCli(home, ['sessions', 'show', '--id', '01900000-0000-7000-8000-000000000001', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'session');
  assert.equal(doc.platform, 'codex');
});

test('sessions resume 缺省用页面持久化的单平台；不支持续跑的平台报错', async () => {
  const home = await makeTmpHome();
  await writeUiSettings(home, { platform: 'codex', selectedPlatforms: [] });
  const res = runCli(home, ['sessions', 'resume', '--id', '01900000-0000-7000-8000-000000000001', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'resume');
  assert.equal(doc.platform, 'codex');

  await writeUiSettings(home, { platform: 'openclaw', selectedPlatforms: [] });
  const nope = runCli(home, ['sessions', 'resume', '--id', 'oc-1111', '--json']);
  assert.equal(nope.status, 1);
  assert.match(nope.stderr, /no native resume command/);
});

// --- new（新建会话）---

test('sessions new 生成 create 命令串（打印模式，不 spawn）', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'new', '做个任务', '--platform', 'codex', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.schemaVersion, 1);
  assert.equal(doc.kind, 'new');
  assert.equal(doc.platform, 'codex');
  assert.equal(doc.message, '做个任务');
  assert.equal(doc.executed, false);
  // 前置参数 exec --full-auto + 提示词末位裸参
  assert.deepEqual(doc.args, ['exec', '--full-auto', '做个任务']);
  assert.match(doc.command, /exec --full-auto/);
  assert.match(doc.command, /'做个任务'$/);
});

test('sessions new 非 json 直接打印命令串', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'new', '修 bug', '--platform', 'codex', '--dir', '/tmp/x']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "cd '/tmp/x' && codex exec --full-auto '修 bug'");
});

test('sessions new 空提示词 = 无 message 参数（开交互式/裸启）', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'new', '--platform', 'codex', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.message, '');
  assert.deepEqual(doc.args, ['exec', '--full-auto']);
});

test('sessions new 平台无 create 契约（dsh）报「不支持新建」退出 1', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'new', '--platform', 'dsh', '--json']);
  assert.equal(res.status, 1);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'error');
  assert.equal(doc.error.code, 'usage');
  assert.match(doc.error.message, /no native create command/);
  assert.match(res.stderr, /no native create command/);
});

test('sessions new --run 真实 fire-and-forget spawn 假 codex bin（参数与 cwd）', async () => {
  const home = await makeTmpHome();
  const fakeLog = path.join(home, 'fake-new.log');
  const bindir = await makeFakeBin(home, 'codex', 0, fakeLog);
  const workdir = path.join(home, 'work');
  await fsp.mkdir(workdir, { recursive: true });

  const res = runCli(
    home,
    ['sessions', 'new', '建个会话', '--platform', 'codex', '--dir', workdir, '--run', '--json'],
    { AGENTLRAY_CODEX_BIN: path.join(bindir, 'codex') }
  );
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.executed, true);
  assert.equal(doc.bin, path.join(bindir, 'codex'));
  assert.deepEqual(doc.args, ['exec', '--full-auto', '建个会话']);
  assert.equal(doc.exitCode, null); // fire-and-forget：不跟踪退出码
  // fire-and-forget（detached+unref）：CLI 触发后即退出，detach 的子进程异步写入
  // 日志——轮询等待文件落盘（最长 ~2s），不与 resume --run（阻塞等 close）同等待方式。
  await waitForFile(fakeLog);
  const log = await fsp.readFile(fakeLog, 'utf8');
  assert.match(log, /arg:exec/);
  assert.match(log, /arg:--full-auto/);
  assert.match(log, /arg:建个会话/);
  assert.match(log, new RegExp(`cwd:${workdir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('sessions new 缺省用页面持久化的单平台（未传 --platform）', async () => {
  const home = await makeTmpHome();
  await writeUiSettings(home, { platform: 'codex', selectedPlatforms: [] });
  const res = runCli(home, ['sessions', 'new', '默认平台', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'new');
  assert.equal(doc.platform, 'codex');

  // 缺省平台无可建契约（openclaw）→ 报错
  await writeUiSettings(home, { platform: 'openclaw', selectedPlatforms: [] });
  const nope = runCli(home, ['sessions', 'new', 'x', '--json']);
  assert.equal(nope.status, 1);
  assert.match(nope.stderr, /no native create command/);
});

test('sessions new 自定义平台声明 create 时生成 create 命令（bin=create.bin）', async () => {
  const home = await makeTmpHome();
  const dir = path.join(home, '.agentlray', 'platforms');
  await fsp.mkdir(dir, { recursive: true });
  const source = `module.exports = {
  id: 'my-copilot',
  label: 'My Copilot',
  defaultDir: () => '/fixtures/my-copilot',
  list: async () => [],
  parse: async () => null,
  getSession: async () => null,
  create: {
    bin: 'my-copilot-cli',
    args: (o) => ['--new', o.cwd || ''],
  },
};
`;
  await fsp.writeFile(path.join(dir, 'my-copilot.js'), source);

  const res = runCli(home, ['sessions', 'new', 'go', '--platform', 'my-copilot', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.kind, 'new');
  assert.equal(doc.bin, 'my-copilot-cli');
  assert.deepEqual(doc.args, ['--new', '/fixtures/my-copilot', 'go']);
  assert.equal(doc.command, "cd '/fixtures/my-copilot' && my-copilot-cli --new /fixtures/my-copilot go");
});
