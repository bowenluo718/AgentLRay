const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
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
async function addOpenClawSession(home, agent) {
  const sessionsDir = path.join(home, '.openclaw', 'agents', agent, 'sessions');
  await fsp.mkdir(sessionsDir, { recursive: true });
  const records = [
    { type: 'session', id: 'oc-1111', timestamp: '2026-01-10T09:00:00.000Z', cwd: '/fixtures/project-oc' },
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
  await fsp.writeFile(path.join(sessionsDir, 'oc-1111.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function runCli(home, args, extraEnv = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, ...extraEnv },
  });
}

// 构造一个可执行假平台 CLI（spawn 用，验证 --run 传递的参数/工作目录/退出码）。
async function makeFakeBin(home, bin, exitCode = 0, outFile) {
  const bindir = path.join(home, '.fakebin');
  await fsp.mkdir(bindir, { recursive: true });
  const script = `#!/bin/sh\nprintf 'arg:%s\\n' "$@" > "${outFile}"\nprintf 'cwd:%s\\n' "$PWD" >> "${outFile}"\nexit ${exitCode}\n`;
  await fsp.writeFile(path.join(bindir, bin), script, { mode: 0o755 });
  return bindir;
}

test('sessions --help 输出 list/show/resume 用法', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', '--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /sessions list/);
  assert.match(res.stdout, /sessions show/);
  assert.match(res.stdout, /sessions resume/);
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

test('sessions list openclaw 需 --agent；未知平台报错', async () => {
  const home = await makeTmpHome();
  await addOpenClawSession(home, 'my-agent');

  const withAgent = runCli(home, ['sessions', 'list', '--platform', 'openclaw', '--agent', 'my-agent', '--json']);
  assert.equal(withAgent.status, 0);
  const json = JSON.parse(withAgent.stdout);
  assert.equal(json.agent, 'my-agent');
  assert.equal(json.total, 1);
  assert.equal(json.sessions[0].id, 'oc-1111');

  const noAgent = runCli(home, ['sessions', 'list', '--platform', 'openclaw', '--json']);
  assert.equal(noAgent.status, 1);
  assert.match(noAgent.stderr, /--agent/);

  const unknown = runCli(home, ['sessions', 'list', '--platform', 'nope', '--json']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown platform/);

  const unknownJson = JSON.parse(unknown.stdout);
  assert.equal(unknownJson.kind, 'error');
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
  // 夹具 omp 会话尾部无 session_exit（仍打开）：统一语义为同 id 续跑，--run 时才收尾
  assert.equal(ompDoc.willFork, false);
  assert.equal(ompDoc.finalized, false);
  assert.match(ompDoc.note, /收尾|原地/);
  assert.match(ompJson.stderr, /收尾|原地/);

  // 无原生续跑的平台明确报错
  const unsupported = runCli(home, ['sessions', 'resume', '--platform', 'hermes', '--id', 'x']);
  assert.equal(unsupported.status, 1);
  assert.match(unsupported.stderr, /no native resume/);

  const missing = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', 'missing-session']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /not found/);
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
  // HOME 外的 PATH 不包含 codex，且夹具 cwd 目录不存在 → spawn error → 明确报错
  const res = runCli(home, ['sessions', 'resume', '--platform', 'codex', '--id', '01900000-0000-7000-8000-000000000001', '--run']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Failed to run/);
});

test('sessions resume 对已结束的 omp 会话预检为原地续写(willFork=false)', async () => {
  const home = await makeTmpHome();
  const file = path.join(
    home, '.omp', 'agent', 'sessions', '-fixtures-project-gamma',
    '2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl'
  );
  await fsp.appendFile(file, '\n' + JSON.stringify({
    type: 'custom', customType: 'session_exit', id: 'sx-1',
    timestamp: '2026-01-20T09:00:00.000Z', data: { reason: 'dispose', kind: 'normal' },
  }) + '\n');

  const res = runCli(home, ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--json']);
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.willFork, false);
  assert.equal(doc.note, null);
  assert.doesNotMatch(res.stderr, /派生/);
});

test('sessions resume --run 对未结束 omp 会话先收尾再同 id 续跑（不派生）', async () => {
  const home = await makeTmpHome();
  const fakeLog = path.join(home, 'finalize.log');
  const bindir = await makeFakeBin(home, 'omp', 0, fakeLog);
  const workdir = path.join(home, 'work');
  await fsp.mkdir(workdir, { recursive: true });
  const res = runCli(
    home,
    ['sessions', 'resume', '--platform', 'omp', '--id', '019a0000-0000-7000-8000-00000000aaaa', '--run', '--cwd', workdir, '--json'],
    { PATH: `${bindir}${path.delimiter}${process.env.PATH || ''}` }
  );
  assert.equal(res.status, 0);
  const doc = JSON.parse(res.stdout);
  assert.equal(doc.finalized, true);
  assert.equal(doc.willFork, false);
  assert.equal(doc.forked, null);

  // 会话文件尾部已被追加 session_exit（先结束），随后同 id 续跑
  const file = path.join(
    home, '.omp', 'agent', 'sessions', '-fixtures-project-gamma',
    '2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl'
  );
  const lines = (await fsp.readFile(file, 'utf8')).trimEnd().split('\n').filter(Boolean);
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.customType, 'session_exit');
  assert.equal(last.data.reason, 'agentlray-resume-finalize');
  assert.match(res.stderr, /收尾|session_exit/);

  // fake omp 确实被执行（仍在原 id 上）
  const log = await fsp.readFile(fakeLog, 'utf8');
  assert.match(log, /arg:--resume=019a0000-0000-7000-8000-00000000aaaa/);
});

test('sessions 未知子命令报错且退出 1', async () => {
  const home = await makeTmpHome();
  const res = runCli(home, ['sessions', 'frobnicate']);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Unknown subcommand/);
});
