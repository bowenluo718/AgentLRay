// OMP adapter tests: user-prompt extraction（标题/首消息口径）。
//
// 回归目标：omp 的 worker 分派会话（Orca dispatched）首条 user 消息是
// <attachment> 模板——内含 worker CLI 说明与真实任务描述（# Task: / # Target
// 段）。这类消息被旧的 `text.startsWith('<')` 规则整条丢弃 → 首消息/标题为 null。
// 应提取附件内任务描述作为标题/首消息；其余 < 开头注入（<system-notice> 等）仍过滤。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { extractOmpUserPromptText } = require(path.join(__dirname, '..', 'lib', 'platforms', 'builtin', 'omp', 'parse'));

const ATTACHMENT_WORKER = `<attachment>
You are working inside Orca, a multi-agent IDE. You are a dispatched worker.
Your coordinator's terminal handle is: term_92c504f5-57e0-440d-886f-a26bb5bd0b2c
Your task ID is: task_0e2a4e808cc6

=== CLI COMMANDS ===

\`\`\`sh
  orca orchestration send --type worker_done ...
  orca orchestration send --type heartbeat ...
\`\`\`

# Target（只改这些文件）
- 新建 lib/platforms/loader.js
- 修改 lib/platforms/index.js
- 新增 test/platforms-loader.test.js

# Constraints
- 不改其它 lib 模块。

# 完成判据
- 新增单测全绿。
</attachment>`;

function userMsg(text) {
  return { role: 'user', attribution: 'user', content: [{ type: 'text', text }] };
}

test('extractOmpUserPromptText 从 <attachment> worker 模板提取 # Target 任务', () => {
  assert.equal(extractOmpUserPromptText(userMsg(ATTACHMENT_WORKER)), '新建 lib/platforms/loader.js');
});

test('extractOmpUserPromptText 优先取 # Task: 标题', () => {
  const text = `<attachment>
You are a dispatched worker.

# Task: AgentLRay 任务看板——前端 React 看板视图
## Target
- frontend/src/views/kanban/KanbanView.tsx（新）
</attachment>`;
  assert.equal(extractOmpUserPromptText(userMsg(text)), 'AgentLRay 任务看板——前端 React 看板视图');
});

test('extractOmpUserPromptText 仍过滤无任务描述的 < 开头注入', () => {
  assert.equal(extractOmpUserPromptText(userMsg('<system-notice>这是一条注入噪音</system-notice>')), null);
});

test('extractOmpUserPromptText 普通用户输入原样返回', () => {
  assert.equal(extractOmpUserPromptText(userMsg('帮我查一下天气')), '帮我查一下天气');
});

// --- childrenCount：同名目录内子会话计数（fixtures 含真实 aaaa/Scout.jsonl） ---

test('listOmpSessions 统计同名目录内子会话数', async (t) => {
  const { FIXTURE_HOME } = require(path.join(__dirname, 'helpers.js'));
  const { listOmpSessions } = require(path.join(__dirname, '..', 'lib', 'platforms', 'builtin', 'omp', 'parse'));
  const baseDir = path.join(FIXTURE_HOME, '.omp', 'agent', 'sessions');
  const sessions = await listOmpSessions(baseDir);
  // 有子会话：2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl + aaaa/Scout.jsonl
  const withChild = sessions.find((x) => x.id === '019a0000-0000-7000-8000-00000000aaaa');
  assert.ok(withChild, 'aaa… 会话应被列出');
  assert.equal(withChild.childrenCount, 1);
  // 无子会话目录 → 0
  const withoutChild = sessions.find((x) => x.id === '019a0000-0000-7000-8000-00000000bbbb');
  assert.ok(withoutChild, 'bbb… 会话应被列出');
  assert.equal(withoutChild.childrenCount, 0);
});
