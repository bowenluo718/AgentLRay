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

const claude = require(path.join(__dirname, '..', 'lib', 'platforms', 'claude'));
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

