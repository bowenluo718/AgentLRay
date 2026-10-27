'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { watchTail, accumulateWatchTail, latestMessageTimestamp } = require('../lib/watch');
const {
  createTailState,
  noteAssistant,
  noteEndTurn,
  noteEnded,
  addPending,
  resolveAllPending,
  finishTail,
} = require('../lib/platforms/tail-state');
const { deriveStatus } = require('../lib/status');

const NOW = Date.parse('2026-10-23T04:00:00.000Z');

test('watchTail：累积 assistant 与未应答 toolCall（独立 role 约定，OMP/Codex），toolResult 按 toolCallId 解析', () => {
  const st = watchTail([
    { role: 'user', timestamp: '2026-10-23T03:50:00.000Z', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', timestamp: '2026-10-23T03:50:05.000Z', content: [] },
    { role: 'toolCall', timestamp: '2026-10-23T03:50:05.000Z', toolCallId: 't1', toolName: 'bash' },
  ]);
  let tail = finishTail(st);
  assert.equal(tail.lastPromptAt, '2026-10-23T03:50:00.000Z');
  assert.equal(tail.pendingToolAt, '2026-10-23T03:50:05.000Z'); // t1 未应答

  accumulateWatchTail(st, [
    {
      role: 'toolResult',
      timestamp: '2026-10-23T03:50:06.000Z',
      toolCallId: 't1',
      content: [{ type: 'text', text: 'ok' }],
    },
  ]);
  tail = finishTail(st);
  assert.equal(tail.pendingToolAt, null);
});

test('watchTail：assistant 内容块内嵌 toolCall（Claude 约定）同样入库', () => {
  const st = watchTail([
    {
      role: 'assistant',
      timestamp: '2026-10-23T03:50:05.000Z',
      content: [{ type: 'toolCall', id: 't2', name: 'bash' }],
    },
  ]);
  assert.equal(finishTail(st).pendingToolAt, '2026-10-23T03:50:05.000Z');
});

test('toolResult 角色消息不计入 prompt（归一化工具回执走 role=toolResult）', () => {
  const st = watchTail([
    {
      role: 'toolResult',
      timestamp: '2026-10-23T03:50:00.000Z',
      toolCallId: 't1',
      content: [{ type: 'text', text: '<result>ok</result>' }],
    },
  ]);
  assert.equal(finishTail(st).lastPromptAt, null);
});

test('实时状态：新鲜 pending → working', () => {
  const ts = '2026-10-23T03:59:50.000Z';
  const st = watchTail([
    { role: 'assistant', timestamp: ts, content: [{ type: 'toolCall', id: 't9', name: 'bash' }] },
  ]);
  assert.equal(deriveStatus(finishTail(st), { lastActivity: ts }, NOW), 'working');
});

test('实时状态：真实 prompt 早于 assistant、未应答 → working(Processing)', () => {
  const st = watchTail([
    { role: 'user', timestamp: '2026-10-23T03:59:50.000Z', content: [{ type: 'text', text: 'run' }] },
    { role: 'assistant', timestamp: '2026-10-23T03:58:00.000Z', content: [{ type: 'text', text: 'ok' }] },
  ]);
  // prompt(3:59:50) 晚于 lastAssistant(3:58)，距今 <2min → working
  assert.equal(deriveStatus(finishTail(st), { lastActivity: '2026-10-23T03:59:50.000Z' }, NOW), 'working');
});

test('latestMessageTimestamp：取批次最新时间', () => {
  assert.equal(
    latestMessageTimestamp([
      { timestamp: '2026-10-23T03:00:00.000Z' },
      { timestamp: '2026-10-23T04:00:00.000Z' },
      {},
    ]),
    '2026-10-23T04:00:00.000Z'
  );
  assert.equal(latestMessageTimestamp([]), null);
});

test('role reasoning 计入 assistant 活动（思考即活动）', () => {
  const st = watchTail([{ role: 'reasoning', timestamp: '2026-10-23T03:50:00.000Z', content: [] }]);
  assert.equal(finishTail(st).lastAssistantAt, '2026-10-23T03:50:00.000Z');
});

test('同批 addPending→resolvePending 净清零（gemini 内联结果序列）', () => {
  const st = watchTail([
    { role: 'assistant', timestamp: '2026-10-23T03:50:00.000Z', content: [] },
    { role: 'toolCall', timestamp: '2026-10-23T03:50:01.000Z', toolCallId: 'g1' },
    { role: 'toolResult', timestamp: '2026-10-23T03:50:02.000Z', toolCallId: 'g1' },
  ]);
  const tail = finishTail(st);
  assert.equal(tail.pendingToolAt, null);
  assert.equal(tail.pendingNewestAt, null);
});

test('resolveAllPending：清除全部未应答调用（omp session_exit 闭环，防 ask 残留误判待输入）', () => {
  const st = watchTail([
    { role: 'assistant', timestamp: '2026-10-23T01:00:00.000Z', content: [{ type: 'toolCall', id: 'ask1', name: 'ask' }] },
  ]);
  assert.equal(finishTail(st).oldestPendingToolName, 'ask');
  resolveAllPending(st);
  const tail = finishTail(st);
  assert.equal(tail.pendingToolAt, null);
  assert.equal(tail.pendingNewestAt, null);
  assert.equal(tail.oldestPendingToolName, null);
});

test('omp 场景：ask 结果闭环（session_exit 清 pending）+ 后续回合活动 → 不判待输入，正确按回合完成等待', () => {
  // 仿真真实 OMP 恢复会话：01:00 ask 挂起 → 01:30 session_exit（结果闭环）→ 03:30 user
  // 回来 → 03:50 一轮工具后 stop（endTurn）。ask 残留若不清会永久"待用户输入"。
  const st = createTailState();
  addPending(st, 'ask1', '2026-10-23T01:00:00.000Z', 'ask');
  noteAssistant(st, '2026-10-23T01:00:00.000Z');
  noteEnded(st, '2026-10-23T01:30:00.000Z'); // omp session_exit 闭环：与 resolveAllPending 配对使用
  resolveAllPending(st);
  noteAssistant(st, '2026-10-23T03:50:00.000Z');
  noteEndTurn(st, '2026-10-23T03:50:00.000Z');

  const tail = finishTail(st);
  assert.equal(tail.pendingToolAt, null);
  assert.equal(tail.oldestPendingToolName, null);
  // endedAt(01:30) 早于最新活动(03:50) → 不判 stopped；回合完成、无更新 prompt → waiting
  assert.equal(deriveStatus(tail, { lastActivity: '2026-10-23T03:50:00.000Z' }, NOW), 'waiting');
});

test('增量累积后 deriveStatus 反映会话推进（working → 决议后清新 → 回到正常口径）', () => {
  const st = watchTail([
    { role: 'user', timestamp: '2026-10-23T03:20:00.000Z', content: [{ type: 'text', text: 'start' }] },
    { role: 'assistant', timestamp: '2026-10-23T03:21:00.000Z', content: [{ type: 'toolCall', id: 'a', name: 'bash' }] },
  ]);
  // 3:21 发起调用，最新 pending 距今 ~39min → 仍在 1h 取证闭口窗口内 → awaiting-input（挂起边界按列表口径）
  assert.equal(
    deriveStatus(finishTail(st), { lastActivity: '2026-10-23T03:21:00.000Z' }, NOW),
    'awaiting-input'
  );
});
