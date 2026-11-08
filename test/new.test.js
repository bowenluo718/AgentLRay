'use strict';
// lib/new.js 单测：hasCreateContract / buildNewCommand / assembleShellCommand 共享装配
// 与 buildResumeCommand 的一致性验证。spawnNewSession 的 spawn 行为在
// session-cli.test.js 的 --run 集成用例覆盖。
//
// 传入对象一律为内置适配器实例（lib/platforms/builtin/*.js），与 lib/platforms
// 装配出的 PLATFORMS 同源；契约（create/resume/bin）随声明字段驱动，不再依赖
// NEW_BINS 常量（已随 P0 删除）。
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResumeCommand, assembleShellCommand } = require('../lib/resume');
const { hasCreateContract, buildNewCommand } = require('../lib/new');
const codex = require('../lib/platforms/builtin/codex');
const claude = require('../lib/platforms/builtin/claude-code');
const omp = require('../lib/platforms/builtin/omp');
const gemini = require('../platforms/gemini');
const hermes = require('../platforms/hermes');
const dsh = require('../platforms/dsh');
const openclaw = require('../lib/platforms/builtin/openclaw');

test('hasCreateContract：内置五平台 true，dsh/openclaw false', () => {
  for (const p of [codex, claude, omp, gemini, hermes]) {
    assert.equal(hasCreateContract(p), true, `${p.id} 应有 create 契约`);
  }
  assert.equal(hasCreateContract(dsh), false, 'dsh 不可新建');
  assert.equal(hasCreateContract(openclaw), false, 'openclaw 不可新建');
});

test('hasCreateContract：未声明 create 的普通平台对象 false', () => {
  assert.equal(hasCreateContract({ id: 'openclaw' }), false);
  assert.equal(hasCreateContract({ id: 'whatever' }), false);
});

test('hasCreateContract：声明 create:{bin,args} 的伪对象 true', () => {
  assert.equal(hasCreateContract({ id: 'mp', create: { bin: 'mp', args: () => [] } }), true);
});

test('hasCreateContract：bin 空串或 args 缺失 → false', () => {
  assert.equal(hasCreateContract({ id: 'mp', create: { bin: '', args: () => [] } }), false, 'bin 空串');
  assert.equal(hasCreateContract({ id: 'mp', create: { bin: 'mp' } }), false, 'args 缺失');
  assert.equal(hasCreateContract({ id: 'mp', create: { args: () => [] } }), false, 'bin 缺失');
  assert.equal(hasCreateContract({ id: 'mp', create: { bin: '  ', args: () => [] } }), false, 'bin 纯空白');
});

test('buildNewCommand：codex + message → args 前置 + message 末位', async () => {
  const r = await buildNewCommand(codex, { message: '做个任务' });
  assert.equal(r.bin, 'codex');
  assert.deepEqual(r.args, ['exec', '--full-auto', '做个任务']);
  // cwd 缺省无边 → 无 cd 前缀
  assert.equal(r.command, "codex exec --full-auto '做个任务'");
});

test('buildNewCommand：带 cwd → cd 前缀', async () => {
  const r = await buildNewCommand(codex, { message: 'x', cwd: '/tmp/x' });
  assert.equal(r.command, "cd '/tmp/x' && codex exec --full-auto x");
});

test('buildNewCommand：空 message → 无 message 参数', async () => {
  const r = await buildNewCommand(codex, { message: '' });
  assert.deepEqual(r.args, ['exec', '--full-auto']);
  assert.equal(r.command, 'codex exec --full-auto');
  // 未传 message（undefined/null）同样无 message 参数
  const r2 = await buildNewCommand(codex, {});
  assert.deepEqual(r2.args, ['exec', '--full-auto']);
});

test('buildNewCommand：内置各平台 args 形态', async () => {
  const cases = [
    [claude, ['--dangerously-skip-permissions', '-p']],
    [omp, ['--auto-approve']],
    [gemini, ['-p', '--approval-mode=yolo']],
    // hermes：提示词走 -z/--oneshot（hermes --help 实测：裸位置参会被 argparse
    // 判为非法子命令 "invalid choice"，headless 提示词必须用 -z/--oneshot PROMPT）
    [hermes, ['--yolo', '-z']],
  ];
  for (const [p, expected] of cases) {
    const r = await buildNewCommand(p, { message: 'm' });
    assert.deepEqual(r.args, [...expected, 'm'], p.id);
  }
});

test('buildNewCommand：无提示词 → claude / hermes 回落交互式形态', async () => {
  // 注意：bin 名可能来自 ~/.agentlray/settings.json 的 cliBins 配置（用户可配绝对
  // 路径），故此处只断言 args 与命令尾部形态，不断言 bin 名。
  // claude-code：-p/--print 是布尔开关（--help: "Print response and exit"），
  //   省略 -p 即 "starts an interactive session by default" → 交互式会话。
  const claudeCmd = await buildNewCommand(claude, {});
  assert.deepEqual(claudeCmd.args, ['--dangerously-skip-permissions']);
  assert.match(claudeCmd.command, /--dangerously-skip-permissions$/);

  // hermes：-z/--oneshot 必须带值（"--help: expected one argument"），
  //   无提示词时只能 `hermes --yolo`（交互式）。
  const hermesCmd = await buildNewCommand(hermes, {});
  assert.deepEqual(hermesCmd.args, ['--yolo']);
  assert.match(hermesCmd.command, /hermes --yolo$/);

  // omp：MESSAGES 位置参可省 → 交互式
  const ompCmd = await buildNewCommand(omp, {});
  assert.deepEqual(ompCmd.args, ['--auto-approve']);
});

test('buildNewCommand：自定义 create 平台 → create.bin fallback + create.args(opts) 且 message 末位', async () => {
  const platform = { id: 'mp', create: { bin: 'my-copilot', args: (o) => ['--new', o.cwd || ''] } };
  const r = await buildNewCommand(platform, { cwd: '/w', message: 'hi' });
  assert.equal(r.bin, 'my-copilot');
  assert.deepEqual(r.args, ['--new', '/w', 'hi']);
  assert.equal(r.command, "cd '/w' && my-copilot --new /w hi");
});

test('buildNewCommand：dsh / openclaw / 无契约 → await 抛错（含 no native create command）', async () => {
  await assert.rejects(buildNewCommand(dsh, {}), /no native create command/);
  await assert.rejects(buildNewCommand(openclaw, {}), /no native create command/);
  await assert.rejects(buildNewCommand({ id: 'mp', create: { bin: 'mp' } }, {}), /no native create command/);
});

test('assembleShellCommand 与 buildResumeCommand 共用（POSIX 命令串与引号一致）', async () => {
  // 直接调 assembleShellCommand（当前 POSIX 环境）生成，与 buildResumeCommand 对同一
  // bin/args/cwd 的输出逐字符一致——resume/create 共享同一装配真源。
  const bin = 'codex';
  const args = ['resume', 'abc-123', '--yolo'];
  const direct = assembleShellCommand(bin, args, { cwd: '/proj dir' });
  const viaResume = await buildResumeCommand(
    { id: 'codex', resume: { bin, args: () => args } },
    'abc-123',
    { cwd: '/proj dir' }
  );
  assert.equal(direct, viaResume.command);
  assert.equal(direct, "cd '/proj dir' && codex resume abc-123 --yolo");
  // 无 cwd
  assert.equal(assembleShellCommand(bin, args, {}), 'codex resume abc-123 --yolo');
  // 含特殊字符 token 被引号包裹
  assert.equal(
    assembleShellCommand('codex', ['--msg', 'a b'], {}),
    "codex --msg 'a b'"
  );
});
