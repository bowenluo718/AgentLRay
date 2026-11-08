// Claude Code adapter tests: user-prompt extraction (标题/首消息/preview 口径)
// 与 metadata 解析。
//
// 回归目标：真实用户通过 slash 命令发起会话时（<command-message>/<command-name>/
// <command-args> 承载用户真实意图），首条用户消息不能被当噪音丢弃——否则会话
// 标题与首消息显示"无消息"。同时纯工具回执（tool_result）与 isMeta 注入（技能
// 展开、系统提醒）仍必须过滤。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const claude = require(path.join(__dirname, '..', 'lib', 'platforms', 'builtin', 'claude-code', 'parse'));
const { extractClaudeCodeUserPromptText } = claude;

// --- extractClaudeCodeUserPromptText ---

test('extractClaudeCodeUserPromptText 把 slash 命令当作真实用户 prompt（含 args）', () => {
  const rec = {
    type: 'user',
    message: {
      role: 'user',
      content:
        '<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>\n<command-args>分析当前项目的架构实现</command-args>',
    },
  };
  assert.equal(extractClaudeCodeUserPromptText(rec), '分析当前项目的架构实现');
});

test('extractClaudeCodeUserPromptText 无 args 的 slash 命令回退到命令名', () => {
  const rec = {
    type: 'user',
    message: { role: 'user', content: '<command-message>model</command-message>\n<command-name>/model</command-name>' },
  };
  assert.equal(extractClaudeCodeUserPromptText(rec), '/model');
});

test('extractClaudeCodeUserPromptText 仍过滤纯 tool_result 回执', () => {
  const rec = {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
  };
  assert.equal(extractClaudeCodeUserPromptText(rec), null);
});

test('extractClaudeCodeUserPromptText 仍过滤 isMeta 注入', () => {
  const rec = {
    type: 'user',
    isMeta: true,
    message: {
      role: 'user',
      content: [{ type: 'text', text: 'Base directory for this skill: …\n\nARGUMENTS: 分析' }],
    },
  };
  assert.equal(extractClaudeCodeUserPromptText(rec), null);
});

test('extractClaudeCodeUserPromptText 普通文本原样返回并剔除 system-reminder', () => {
  const rec = {
    type: 'user',
    message: {
      role: 'user',
      content: '做一件事\n<system-reminder>系统提醒</system-reminder>',
    },
  };
  assert.equal(extractClaudeCodeUserPromptText(rec), '做一件事');
});

// --- metadata 解析（真实数据形态回归） ---

test('parseClaudeCodeSessionMetadata 以 slash 命令为 firstUserMessage', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-claude-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cccc1111-2222-4333-8444-555566667779.jsonl');
  const recs = [
    {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/fixtures/project-beta',
      sessionId: 'cccc1111-2222-4333-8444-555566667779',
      version: '2.1.282',
      gitBranch: 'main',
      type: 'user',
      message: {
        role: 'user',
        content:
          '<command-message>grill-me</command-message>\n<command-name>/grill-me</command-name>\n<command-args>分析当前项目的架构实现</command-args>',
      },
      uuid: 'ua-1',
      timestamp: '2026-01-18T10:00:00.000Z',
    },
    {
      parentUuid: 'ua-1',
      isSidechain: false,
      userType: 'external',
      cwd: '/fixtures/project-beta',
      sessionId: 'cccc1111-2222-4333-8444-555566667779',
      version: '2.1.282',
      gitBranch: 'main',
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Base directory for this skill: /fixtures/skills/grill-me\n\nARGUMENTS: 分析' }],
      },
      isMeta: true,
      uuid: 'ua-2',
      timestamp: '2026-01-18T10:00:00.000Z',
    },
    {
      parentUuid: 'ua-2',
      isSidechain: false,
      userType: 'external',
      cwd: '/fixtures/project-beta',
      sessionId: 'cccc1111-2222-4333-8444-555566667779',
      version: '2.1.282',
      gitBranch: 'main',
      type: 'assistant',
      message: { model: 'claude-fixture-1', id: 'msg-fx-1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '开始审查' }] },
      uuid: 'ua-3',
      timestamp: '2026-01-18T10:00:05.000Z',
    },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const meta = await claude.parseClaudeCodeSessionMetadata(file, 'cccc1111-2222-4333-8444-555566667779.jsonl');
  assert.equal(meta.firstUserMessage, '分析当前项目的架构实现');
});

test('parseClaudeCodeSessionMetadata 的 title 回退到 firstUserMessage（不显示 UUID）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-claude-title-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'dddd1111-2222-4333-8444-555566667770.jsonl');
  const recs = [
    {
      parentUuid: null,
      isSidechain: false,
      userType: 'external',
      cwd: '/fixtures/project-beta',
      sessionId: 'dddd1111-2222-4333-8444-555566667770',
      version: '2.1.282',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: '做一件普通的事' },
      uuid: 'ua-1',
      timestamp: '2026-01-18T11:00:00.000Z',
    },
    {
      parentUuid: 'ua-1',
      isSidechain: false,
      userType: 'external',
      cwd: '/fixtures/project-beta',
      sessionId: 'dddd1111-2222-4333-8444-555566667770',
      version: '2.1.282',
      gitBranch: 'main',
      type: 'assistant',
      message: { model: 'claude-fixture-1', id: 'msg-1', type: 'message', role: 'assistant', content: [{ type: 'text', text: '好的' }] },
      uuid: 'ua-2',
      timestamp: '2026-01-18T11:00:05.000Z',
    },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const meta = await claude.parseClaudeCodeSessionMetadata(file, 'dddd1111-2222-4333-8444-555566667770.jsonl');
  assert.equal(meta.firstUserMessage, '做一件普通的事');
  // claude 无独立 title 记录时，title 回退到首条用户消息，前端据此显示而非 UUID
  assert.equal(meta.title, '做一件普通的事');
});

test('parseClaudeCodeSessionMetadata 中断的工具调用视作回合结束（不误判 working）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-claude-interrupt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'eeee1111-2222-4333-8444-555566667771.jsonl');
  const base = {
    parentUuid: 'p-0',
    isSidechain: false,
    userType: 'external',
    cwd: '/fixtures/project-beta',
    sessionId: 'eeee1111-2222-4333-8444-555566667771',
    version: '2.1.282',
    gitBranch: 'main',
  };
  const recs = [
    // 真实用户 prompt
    { ...base, type: 'user', message: { role: 'user', content: '分析架构' }, uuid: 'u-1', timestamp: '2026-01-18T12:00:00.000Z' },
    // assistant 发起 AskUserQuestion（交互工具）
    {
      ...base,
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'call_interrupt_1', name: 'AskUserQuestion', input: { questions: [] } },
        ],
        stop_reason: 'tool_use',
      },
      uuid: 'a-1',
      timestamp: '2026-01-18T12:00:05.000Z',
    },
    // 该工具被中断（会话结束前未应答）——claude-code 落 toolDenialKind:"interrupted"
    {
      ...base,
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call_interrupt_1',
            is_error: true,
            content: '[Tool call interrupted: the session ended before this call\'s result was recorded]',
          },
        ],
      },
      toolUseResult: '[Tool call interrupted: the session ended before this call\'s result was recorded]',
      toolDenialKind: 'interrupted',
      uuid: 'u-2',
      timestamp: '2026-01-18T12:00:13.000Z',
    },
    // 中断后的合成 assistant 消息（stop_sequence）
    {
      ...base,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '' }], stop_reason: 'stop_sequence' },
      uuid: 'a-2',
      timestamp: '2026-01-18T12:00:14.000Z',
    },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const meta = await claude.parseClaudeCodeSessionMetadata(file, 'eeee1111-2222-4333-8444-555566667771.jsonl');
  // 中断视作回合结束：endTurnAt 被设置，pending 已被清除，不残留 awaiting-input
  assert.equal(meta.tail.endTurnAt, '2026-01-18T12:00:13.000Z');
  assert.equal(meta.tail.pendingToolAt, null);
  // 距上次活动很短时也应判 waiting（回合已结束、无更新的真实 prompt），而非 working
  const { deriveStatus } = require(path.join(__dirname, '..', 'lib', 'status'));
  const st = deriveStatus(meta.tail, meta, Date.parse('2026-01-18T12:02:00.000Z'));
  assert.equal(st, 'waiting');
});

test('parseClaudeCodeSessionMetadata 中断后 resume 但无新内容 → 会话已停止（stopped）', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-claude-resume-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'ffff1111-2222-4333-8444-555566667772.jsonl');
  const base = {
    parentUuid: 'p-0',
    isSidechain: false,
    userType: 'external',
    cwd: '/fixtures/project-beta',
    sessionId: 'ffff1111-2222-4333-8444-555566667772',
    version: '2.1.282',
    gitBranch: 'main',
  };
  const recs = [
    { ...base, type: 'user', message: { role: 'user', content: '分析架构' }, uuid: 'u-1', timestamp: '2026-01-18T12:00:00.000Z' },
    {
      ...base,
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: 'call_r_1', name: 'AskUserQuestion', input: { questions: [] } }], stop_reason: 'tool_use' },
      uuid: 'a-1',
      timestamp: '2026-01-18T12:00:05.000Z',
    },
    {
      ...base,
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_r_1', is_error: true, content: '[Tool call interrupted]' }] },
      toolUseResult: '[Tool call interrupted]',
      toolDenialKind: 'interrupted',
      uuid: 'u-2',
      timestamp: '2026-01-18T12:00:13.000Z',
    },
    // 会话被 resume（SessionStart:resume 钩子），但之后没有新的真实内容
    {
      ...base,
      type: 'attachment',
      attachment: { type: 'hook_success', hookName: 'SessionStart:resume', content: '' },
      uuid: 'at-1',
      timestamp: '2026-01-18T12:03:00.000Z',
    },
    {
      ...base,
      type: 'system',
      subtype: 'informational',
      content: 'agents-md: AGENTS.md loaded',
      uuid: 'sy-1',
      timestamp: '2026-01-18T12:03:01.000Z',
    },
  ];
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const meta = await claude.parseClaudeCodeSessionMetadata(file, 'ffff1111-2222-4333-8444-555566667772.jsonl');
  // resume 钩子是纯元数据，不应虚增 lastActivity；真实内容止于中断时刻
  assert.equal(meta.lastActivity, '2026-01-18T12:00:13.000Z');
  // 回合已结束 + resume 后无新内容 → 标记会话已停止
  assert.equal(meta.tail.endedAt, '2026-01-18T12:00:13.000Z');
  const { deriveStatus } = require(path.join(__dirname, '..', 'lib', 'status'));
  const st = deriveStatus(meta.tail, meta, Date.parse('2026-01-18T12:05:00.000Z'));
  assert.equal(st, 'stopped');
});

