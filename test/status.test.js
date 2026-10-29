'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS,
  STATUS_ORDER,
  STATUS_LABELS,
  RECENT_ACTIVITY_MS,
  ACTIVE_WORK_CEIL_MS,
  HISTORY_CEIL_MS,
  deriveStatus,
  sortSessionsByStatusGroups,
} = require('../lib/status');

// deriveStatus 的 time 基准：以 nowMs 为锚，方便构造"多久前"。
const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const minAgo = (min) => NOW - min * 60 * 1000;
const secAgo = (sec) => NOW - sec * 1000;

test('STATUS_ORDER 固定分组顺序：待用户输入→工作中→等待中→已停止', () => {
  assert.deepEqual(STATUS_ORDER, [
    STATUS.AWAITING_INPUT,
    STATUS.WORKING,
    STATUS.WAITING,
    STATUS.STOPPED,
  ]);
});

test('STATUS_LABELS 键集与 STATUS_ORDER 完全一致（前端单源 /api/status-labels 依赖此稳定性）', () => {
  assert.deepEqual(Object.keys(STATUS_LABELS), STATUS_ORDER);
  for (const s of STATUS_ORDER) {
    assert.equal(typeof STATUS_LABELS[s], 'string');
    assert.ok(STATUS_LABELS[s].length > 0);
  }
});

test('空证据：mtime 新鲜 → waiting(启动中)，否则 stopped', () => {
  assert.equal(deriveStatus({}, { mtimeMs: secAgo(10) }, NOW), STATUS.WAITING);
  assert.equal(deriveStatus({}, { mtimeMs: minAgo(60) }, NOW), STATUS.STOPPED);
  assert.equal(deriveStatus({}, {}, NOW), STATUS.STOPPED);
});

test('显式结束标记 endedAt → stopped（仅当无更晚活动）', () => {
  const stopped = deriveStatus(
    { endedAt: secAgo(1200) },
    { lastActivity: secAgo(1800) },
    NOW
  );
  assert.equal(stopped, STATUS.STOPPED);
});

test('endedAt 不压制 endedAt 之后的后续活动（守护：活动晚于结束标记则继续判断）', () => {
  const s = deriveStatus(
    { endedAt: minAgo(40), endTurnAt: minAgo(5), lastAssistantAt: minAgo(5) },
    { lastActivity: minAgo(5) },
    NOW
  );
  // 结束标记(40min前)早于最后活动(5min前) → 不落入 stopped 第1步；
  // 无 pending、有回合结束、无更新 prompt → 活跃待机 → waiting
  assert.equal(s, STATUS.WAITING);
});

test('pending 工具：新鲜 → working（执行中）', () => {
  assert.equal(
    deriveStatus({ pendingToolAt: secAgo(30) }, { lastActivity: secAgo(30) }, NOW),
    STATUS.WORKING
  );
});

test('pending 工具：超过进行中工作上界、仍在闭口窗口内 → awaiting-input（停等用户）', () => {
  assert.equal(
    deriveStatus({ pendingToolAt: minAgo(40) }, { lastActivity: minAgo(40) }, NOW),
    STATUS.AWAITING_INPUT
  );
});

test('pending 工具：超闭口窗口 → stopped（取证上界：中断会话不无限置顶）', () => {
  assert.equal(
    deriveStatus({ pendingToolAt: minAgo(800) }, { lastActivity: minAgo(800) }, NOW),
    STATUS.STOPPED
  );
});

test('pending 边界等号：==ACTIVE_WORK_CEIL/==RECENT → working；==HISTORY_CEIL → awaiting-input', () => {
  const atCeil = NOW - HISTORY_CEIL_MS;
  const atActiveWork = NOW - ACTIVE_WORK_CEIL_MS;
  const atRecent = NOW - RECENT_ACTIVITY_MS;
  assert.equal(
    deriveStatus({ pendingToolAt: atCeil }, { lastActivity: atCeil }, NOW),
    STATUS.AWAITING_INPUT
  );
  assert.equal(
    deriveStatus({ pendingToolAt: atActiveWork }, { lastActivity: atActiveWork }, NOW),
    STATUS.WORKING
  );
  assert.equal(
    deriveStatus({ pendingToolAt: atRecent }, { lastActivity: atRecent }, NOW),
    STATUS.WORKING
  );
});

test('长工具执行/等待输出：pending 超过 2min 仍在进行中工作上界内 → working（回归：原被误判 awaiting-input）', () => {
  // 6 分钟前发起、尚未返回的工具调用：>RECENT 但 <=ACTIVE_WORK_CEIL → 工作中
  assert.equal(
    deriveStatus({ pendingToolAt: minAgo(6) }, { lastActivity: minAgo(6) }, NOW),
    STATUS.WORKING
  );
  // 思考：真实 prompt 待答，10 分钟无新记录落盘 → 工作中
  assert.equal(
    deriveStatus(
      { lastPromptAt: minAgo(10), lastAssistantAt: minAgo(12) },
      { lastActivity: minAgo(10) },
      NOW
    ),
    STATUS.WORKING
  );
});

test('交互类工具（ask）等用户回复：超取证上界仍 awaiting-input（回归：原被误判 stopped）', () => {
  // 15 小时前发起的 ask，用户一直未答 → 若走普通上界(12h)早已 stopped；
  // 交互豁免应使其保持"待用户输入"，不得降级成 stopped
  assert.equal(
    deriveStatus(
      { pendingToolAt: minAgo(900), pendingNewestAt: minAgo(900), oldestPendingToolName: 'ask' },
      { lastActivity: minAgo(900) },
      NOW
    ),
    STATUS.AWAITING_INPUT
  );
});

test('交互类工具（ask）进行中工作上界内 → working（与普通工具一致）', () => {
  assert.equal(
    deriveStatus(
      { pendingToolAt: secAgo(30), oldestPendingToolName: 'ask' },
      { lastActivity: secAgo(30) },
      NOW
    ),
    STATUS.WORKING
  );
  assert.equal(
    deriveStatus(
      { pendingToolAt: minAgo(12), oldestPendingToolName: 'ask' },
      { lastActivity: minAgo(12) },
      NOW
    ),
    STATUS.WORKING
  );
});

test('发起即待输入工具（AskUserQuestion）未应答、刚刚发起(30s前) → awaiting-input（守护"发起即判"）', () => {
  assert.equal(
    deriveStatus(
      { pendingToolAt: secAgo(30), pendingNewestAt: secAgo(30), oldestPendingToolName: 'AskUserQuestion' },
      { lastActivity: secAgo(30) },
      NOW
    ),
    STATUS.AWAITING_INPUT
  );
});

test('发起即待输入工具（AskUserQuestion）未应答、8.7min前 → awaiting-input（回归 bug：原误判 working）', () => {
  assert.equal(
    deriveStatus(
      { pendingToolAt: minAgo(8.7), pendingNewestAt: minAgo(8.7), oldestPendingToolName: 'AskUserQuestion' },
      { lastActivity: minAgo(8.7) },
      NOW
    ),
    STATUS.AWAITING_INPUT
  );
});

test('非交互工具超取证上界不豁免 → stopped；无工具名信息时回退普通上界逻辑', () => {
  assert.equal(
    deriveStatus(
      { pendingToolAt: minAgo(800), pendingNewestAt: minAgo(800), oldestPendingToolName: 'bash' },
      { lastActivity: minAgo(800) },
      NOW
    ),
    STATUS.STOPPED
  );
  // 无 oldestPendingToolName（如 hermes 近似 pending）：仍按闭口上界
  assert.equal(
    deriveStatus({ pendingToolAt: minAgo(800), pendingNewestAt: minAgo(800) }, { lastActivity: minAgo(800) }, NOW),
    STATUS.STOPPED
  );
});

test('pendingNewestAt 新近 + 旧残留至超界 → working（防旧锚误判老化）', () => {
  assert.equal(
    deriveStatus(
      { pendingToolAt: minAgo(40), pendingNewestAt: secAgo(5) },
      { lastActivity: secAgo(5) },
      NOW
    ),
    STATUS.WORKING
  );
});

test('pending 全部超过进行中工作上界但都在闭口窗口内 → awaiting-input（最新锚也过期）', () => {
  assert.equal(
    deriveStatus(
      { pendingToolAt: minAgo(40), pendingNewestAt: minAgo(40) },
      { lastActivity: minAgo(40) },
      NOW
    ),
    STATUS.AWAITING_INPUT
  );
});

test('回合完成 endTurnAt 且无更新 prompt → 闭口窗口内 waiting，超界 stopped', () => {
  const within = deriveStatus(
    { endTurnAt: minAgo(10), lastAssistantAt: minAgo(10) },
    { lastActivity: minAgo(10) },
    NOW
  );
  assert.equal(within, STATUS.WAITING);

  const atCeil = deriveStatus(
    { endTurnAt: NOW - HISTORY_CEIL_MS, lastAssistantAt: NOW - HISTORY_CEIL_MS },
    { lastActivity: NOW - HISTORY_CEIL_MS },
    NOW
  );
  assert.equal(atCeil, STATUS.WAITING);

  const beyond = deriveStatus(
    { endTurnAt: minAgo(800), lastAssistantAt: minAgo(800) },
    { lastActivity: minAgo(800) },
    NOW
  );
  assert.equal(beyond, STATUS.STOPPED);
});

test('回合完成后有更新 prompt 且已应答 → 不视为待机；近期活动 → working', () => {
  const s = deriveStatus(
    {
      endTurnAt: minAgo(8),
      lastPromptAt: minAgo(1),
      lastAssistantAt: minAgo(1),
    },
    { lastActivity: minAgo(1) },
    NOW
  );
  assert.equal(s, STATUS.WORKING);
});

test('真实 prompt 待答（prompt 晚于 assistant 且新鲜）→ working(Processing)', () => {
  assert.equal(
    deriveStatus(
      { lastAssistantAt: minAgo(3), lastPromptAt: minAgo(1) },
      { lastActivity: minAgo(1) },
      NOW
    ),
    STATUS.WORKING
  );
});

test('无标记 idle：进行中工作上界内 → working（消息间隙）；超过上界闭口内 → waiting；超界 → stopped', () => {
  assert.equal(deriveStatus({}, { lastActivity: minAgo(8) }, NOW), STATUS.WORKING);
  assert.equal(deriveStatus({}, { lastActivity: minAgo(40) }, NOW), STATUS.WAITING);
  assert.equal(deriveStatus({}, { lastActivity: minAgo(800) }, NOW), STATUS.STOPPED);
});

test('中间带：lastActivity 30min~12h、无其它证据 → waiting（宽容口径）', () => {
  assert.equal(deriveStatus({}, { lastActivity: minAgo(40) }, NOW), STATUS.WAITING);
});

// ---- 分组排序 ----

function session(id, status, timestamp, lastActivity) {
  return { id, status, timestamp, lastActivity };
}

test('sortSessionsByStatusGroups 写回四态 status 并按状态分组、组内 timestamp 降序', () => {
  const sessions = [
    session('old-idle', null, '2026-10-22T00:00:00.000Z', minAgo(800)),
    session('pending-stale', null, '2026-10-23T01:00:00.000Z', minAgo(40)),
    session('working-a', null, '2026-10-23T03:00:00.000Z', secAgo(10)),
    session('waiting-1', null, '2026-10-23T02:00:00.000Z', minAgo(50)),
    session('waiting-2', null, '2026-10-23T02:30:00.000Z', minAgo(40)),
  ];
  // 注：状态由 tail/meta 推导，这里显式给出 tail 以确定结果
  const withTail = sessions.map((s) => {
    if (s.id === 'pending-stale') return { ...s, tail: { pendingToolAt: minAgo(40) } };
    if (s.id === 'working-a') return { ...s, tail: { pendingToolAt: secAgo(10) } };
    return { ...s, tail: {} };
  });

  sortSessionsByStatusGroups(withTail, { nowMs: NOW, sortBy: 'timestamp' });

  assert.deepEqual(withTail.map((s) => s.id), [
    'pending-stale', // awaiting-input
    'working-a', // working
    'waiting-2', // waiting（timestamp 更新的在前）
    'waiting-1',
    'old-idle', // stopped
  ]);
  assert.equal(withTail[0].status, STATUS.AWAITING_INPUT);
  assert.equal(withTail[4].status, STATUS.STOPPED);
});

test('组内排序可指定 lastActivity（hermes 语义）', () => {
  const sessions = [
    { id: 'a', tail: {}, timestamp: '2026-10-23T03:00:00.000Z', lastActivity: '2026-10-23T00:30:00.000Z' },
    { id: 'b', tail: {}, timestamp: '2026-10-23T01:00:00.000Z', lastActivity: '2026-10-23T00:40:00.000Z' },
  ];
  sortSessionsByStatusGroups(sessions, { nowMs: NOW, sortBy: 'lastActivity' });
  // 两组都会是 waiting（3h+ 前活动、仍在 12h 闭口内），组内按 lastActivity 降序 → b 在前
  assert.deepEqual(sessions.map((s) => s.id), ['b', 'a']);
});

test('脏 status 被 deriveStatus 覆盖（sort 写回真实推导值）', () => {
  const sessions = [
    { id: 'x', status: 'weird', tail: { pendingToolAt: minAgo(40) }, timestamp: 't', lastActivity: minAgo(40) },
  ];
  sortSessionsByStatusGroups(sessions, { nowMs: NOW });
  assert.equal(sessions[0].status, STATUS.AWAITING_INPUT);
});
