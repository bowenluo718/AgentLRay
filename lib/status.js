'use strict';

// =====================================================================
// 会话统一四态状态（取证口径，不查活进程）+ 按状态分组排序。
//
// 参考 csm（docs/.local/csm-analysis.zh-CN.md）的四态模型与判定顺序，
// 但去掉进程表依赖：
//   - awaiting-input  ≙ csm Needs Input（唯一不靠用户就不会动的状态，排最上）
//   - working         ≙ csm Working（记录证据 + 新鲜度，非进程）
//   - waiting         ≙ csm Waiting（未显式关闭、仍在取证闭口窗口内）
//   - stopped         ≙ csm Inactive（显式结束标记，或超取证闭口窗口）
//
// 关键点（P0 设计审查结论）：
//   - pending / 结束标记的判定必须先于任何老化检查（csm session.go:1178 注释）。
//   - awaiting-input / waiting 有取证上界 HISTORY_CEIL_MS，替代 csm 的
//     isRunning 门控——崩溃且未写结束标记的会话不会无限置顶。
//   - status 依赖墙钟 now，必须在缓存命中之后、列表返回之前动态计算，
//     绝不写进 withMetadataCache 缓存载荷。
// =====================================================================

// --- 四态枚举与顺序 ---
const STATUS = {
  AWAITING_INPUT: 'awaiting-input',
  WORKING: 'working',
  WAITING: 'waiting',
  STOPPED: 'stopped',
};

/** 分组顺序（组内再按各平台既有默认排序）。 */
const STATUS_ORDER = [STATUS.AWAITING_INPUT, STATUS.WORKING, STATUS.WAITING, STATUS.STOPPED];

/** 状态 → 组优先级（越小越靠前）。 */
const STATUS_PRIORITY = Object.fromEntries(STATUS_ORDER.map((s, i) => [s, i]));

/** UI 中文标签（前端可 import 经 API 透出，或直接使用 STATUS 键）。 */
const STATUS_LABELS = {
  [STATUS.AWAITING_INPUT]: '待用户输入',
  [STATUS.WORKING]: '工作中',
  [STATUS.WAITING]: '等待中',
  [STATUS.STOPPED]: '已停止',
};

// --- 共享时间窗口（唯一锚点） ---
/**
 * 通用"最近活动"新鲜度：回合已完成 / 无进行中证据时的短鲜度 → working。
 * 默认 2 分钟，可在 web 设置面板（/api/settings/status，存 ~/.agentlray/
 * status-config.json）运行时调整，见 setStatusConfig()。
 */
const DEFAULT_RECENT_ACTIVITY_MS = 2 * 60 * 1000;
/**
 * "进行中回合"工作的判定上界：工具执行、等待工具输出、真实 prompt 待处理、消息间隙的
 * 思考都可能远超 RECENT_ACTIVITY_MS 仍无新记录；此界内一律 working，超过才降级
 * （待用户输入 / 等待中）。取值要比 csm 的 staleWindow(5min) 宽松，覆盖常见长工具与深思考。
 * 默认 30 分钟，可在 web 设置面板运行时调整。
 */
const DEFAULT_ACTIVE_WORK_CEIL_MS = 30 * 60 * 1000;
/** 取证闭口窗口：无结束标记的会话证据超过此界 → stopped；awaiting-input/waiting 的上界。
 *  默认 12 小时，可在 web 设置面板运行时调整。 */
const DEFAULT_HISTORY_CEIL_MS = 12 * 60 * 60 * 1000;

// 兼容旧引用名（测试等直接 import 默认值）。
const RECENT_ACTIVITY_MS = DEFAULT_RECENT_ACTIVITY_MS;
const ACTIVE_WORK_CEIL_MS = DEFAULT_ACTIVE_WORK_CEIL_MS;
const HISTORY_CEIL_MS = DEFAULT_HISTORY_CEIL_MS;

// 运行时状态配置缓存：由 setStatusConfig() 注入（web 设置面板 / CLI 启动时读取
// ~/.agentlray/status-config.json）。deriveStatus / sortSessionsByStatusGroups
// 读取它，使各平台 list 与 SSE watch 的状态判定共享同一套运行时窗口。
// opts 显式参数 > statusConfig > 默认值。
let statusConfig = {
  recentActivityMs: DEFAULT_RECENT_ACTIVITY_MS,
  activeWorkCeilMs: DEFAULT_ACTIVE_WORK_CEIL_MS,
  historyCeilMs: DEFAULT_HISTORY_CEIL_MS,
};

/** 运行时注入状态时间配置；缺失字段回退当前值（不重置）。 */
function setStatusConfig(partial = {}) {
  if (typeof partial.recentActivityMs === 'number' && partial.recentActivityMs > 0) {
    statusConfig.recentActivityMs = partial.recentActivityMs;
  }
  if (typeof partial.activeWorkCeilMs === 'number' && partial.activeWorkCeilMs > 0) {
    statusConfig.activeWorkCeilMs = partial.activeWorkCeilMs;
  }
  if (typeof partial.historyCeilMs === 'number' && partial.historyCeilMs > 0) {
    statusConfig.historyCeilMs = partial.historyCeilMs;
  }
  return { ...statusConfig };
}

function getStatusConfig() {
  return { ...statusConfig };
}

/** 还原默认窗口（测试隔离用）。 */
function resetStatusConfig() {
  statusConfig = {
    recentActivityMs: DEFAULT_RECENT_ACTIVITY_MS,
    activeWorkCeilMs: DEFAULT_ACTIVE_WORK_CEIL_MS,
    historyCeilMs: DEFAULT_HISTORY_CEIL_MS,
  };
}

/**
 * 用户交互类工具集合：发起即表明 agent 正在等用户输入/授权（如 AgentLRay 的 `ask`）。
 * 这类工具的未应答调用**不受** HISTORY_CEIL_MS 取证上界约束——用户可能很久才回复，
 * 降级成 stopped 会让"明明在等用户"的会话被误读为已结束（等同 csm Needs Input 无时间上界；
 * P0 阻断项的上界只针对自动工具崩溃/中断挂起，交互工具不适用）。
 */
const USER_AWAIT_TOOLS = new Set(['ask']);

function isUserAwaitTool(name) {
  return typeof name === 'string' && USER_AWAIT_TOOLS.has(name);
}

function tsToMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 由平台产出的 tail 证据（文件派生、可安全进缓存）推导四态状态。
 *
 * @param {object}   tail  平台中立尾部证据，见 lib/platforms/tail-state.js 的 finishTail 输出：
 *                          { lastAssistantAt, lastPromptAt, endTurnAt, endedAt,
 *                            pendingToolAt, pendingNewestAt, oldestPendingToolName }
 * @param {object}   meta  会话摘要：lastActivity / mtimeMs
 * @param {number}   nowMs 当前墙钟（毫秒），便于测试注时
 * @param {object}   opts  可选时间窗口覆盖：recentActivityMs / activeWorkCeilMs /
 *                         historyCeilMs（缺省回退 setStatusConfig 注入值 → 默认值）
 */
function deriveStatus(tail = {}, meta = {}, nowMs = Date.now(), opts = {}) {
  // 时间窗口：opts 显式 > statusConfig（运行时注入）> 默认值。
  const recentActivityMs = opts.recentActivityMs ?? statusConfig.recentActivityMs;
  const activeWorkCeilMs = opts.activeWorkCeilMs ?? statusConfig.activeWorkCeilMs;
  const historyCeilMs = opts.historyCeilMs ?? statusConfig.historyCeilMs;
  const lastActivityMs = tsToMs(meta.lastActivity);
  const mtimeMs = tsToMs(meta.mtimeMs);
  const pendingMs = tsToMs(tail.pendingToolAt);
  const endedMs = tsToMs(tail.endedAt);
  const endTurnMs = tsToMs(tail.endTurnAt);
  const lastPromptMs = tsToMs(tail.lastPromptAt);
  const lastAssistantMs = tsToMs(tail.lastAssistantAt);

  // 1. 显式关闭（记录级 Inactive）：会话级结束标记，任何后续证据都不应推翻。
  if (endedMs !== null && (lastActivityMs === null || lastActivityMs <= endedMs)) {
    return STATUS.STOPPED;
  }

  // 2. 无消息证据兜底：仅有启动记录/空文件时以 mtime 新鲜度判断是否"启动中"。
  if (lastActivityMs === null) {
    const recent = mtimeMs !== null && nowMs - mtimeMs <= recentActivityMs;
    return recent ? STATUS.WAITING : STATUS.STOPPED;
  }
  const activityAge = nowMs - lastActivityMs;

  // 3. pending 工具（唯一 awaiting-input 生产者，先于任何老化检查，csm 同）。
  if (pendingMs !== null) {
    // 以"最新未应答调用"判"正在执行"：任一调用在 ACTIVE_WORK_CEIL 内 → working。
    // 工具执行 / 等待工具输出常远超 RECENT_ACTIVITY_MS(2min)，用"进行中工作上界"判
    // 工作，避免把长工具（5~15min）误判成 awaiting-input/waiting（csm 靠 isRunning
    // 兜底，这里没有进程信号）。同时旧残留 pending 也不会把正在推进的新活动误判老化。
    // 兼容只给 pendingToolAt 的旧结构/测试：以最旧锚作为新鲜度回退。
    const newestPendingMs = tsToMs(tail.pendingNewestAt);
    const freshAnchorMs = newestPendingMs !== null ? newestPendingMs : pendingMs;
    const freshAnchorAge = nowMs - freshAnchorMs;
    if (freshAnchorAge <= activeWorkCeilMs) return STATUS.WORKING;
    // 用户交互类工具（如 ask）在等用户回复：超过 working 上界即 awaiting-input，
    // 且不受取证闭口上界约束（用户可能很久才答，不应被误读为已停止）。
    if (isUserAwaitTool(tail.oldestPendingToolName)) return STATUS.AWAITING_INPUT;
    const pendingAge = nowMs - pendingMs; // 最旧未应答（awaiting-input 锚）
    if (pendingAge <= historyCeilMs) return STATUS.AWAITING_INPUT; // 停等用户
    return STATUS.STOPPED; // 取证上界：崩溃/中断且无结束标记，不无限置顶（P0 阻断，限自动工具）
  }

  // 4. 回合完成（endTurnAt，非会话关闭）：其后无更新的真实 prompt → 待机。
  if (endTurnMs !== null) {
    const newerPrompt = lastPromptMs !== null && lastPromptMs > endTurnMs;
    if (!newerPrompt) {
      return activityAge <= historyCeilMs ? STATUS.WAITING : STATUS.STOPPED;
    }
  }

  // 5+6. 走到这里说明"回合仍在推进"（endTurn 缺失，或其后又来了新的真实 prompt）：
  // 真实 prompt 待答（Processing）、工具结果后的思考、多步任务的消息间隙——都是
  // 工作阶段，但可能长时间无新记录落盘。统一用"进行中工作上界"判 working（而非
  // 2min 短鲜度），只有超过 ACTIVE_WORK_CEIL_MS 才降级。
  if (activityAge <= activeWorkCeilMs) return STATUS.WORKING;

  // 7. 活跃待机：进行中但安静超过上界 → waiting（配合宽容证据口径）。
  if (activityAge <= historyCeilMs) return STATUS.WAITING;

  // 8. 兜底：超闭口窗口 → 取证关闭。
  return STATUS.STOPPED;
}

/**
 * 组内默认比较：按各平台既有默认排序键降序（timestamp 为多数平台，hermes 传 lastActivity）。
 * 与 shared.js sortSessionsByTimestampDesc 语义一致（timestamp 降序）。
 */
function defaultTiebreak(sortBy) {
  const key = sortBy === 'lastActivity' ? 'lastActivity' : 'timestamp';
  return (a, b) => (tsToMs(b[key]) || 0) - (tsToMs(a[key]) || 0);
}

/**
 * 按状态分组排序（服务端，两个 UI 与 API 一致）：
 * awaiting-input(0) < working(1) < waiting(2) < stopped(3)，组内按各平台默认排序降序。
 * 副作用：为每个会话写回 session.status（一次校准，避免排序内反复推导）。
 *
 * @param {object[]} sessions      会话摘要数组（含 tail 字段）
 * @param {number}   opts.nowMs    统一墙钟，保证一次拉取内各会话使用同一时间基准
 * @param {string}   opts.sortBy   'timestamp'（多数平台）| 'lastActivity'（hermes）
 */
function sortSessionsByStatusGroups(sessions, { nowMs = Date.now(), sortBy = 'timestamp' } = {}) {
  if (!Array.isArray(sessions)) return sessions;
  const tiebreak = defaultTiebreak(sortBy);
  for (const s of sessions) {
    s.status = deriveStatus(s.tail, s, nowMs);
  }
  sessions.sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status] ?? STATUS_PRIORITY[STATUS.STOPPED];
    const pb = STATUS_PRIORITY[b.status] ?? STATUS_PRIORITY[STATUS.STOPPED];
    if (pa !== pb) return pa - pb;
    return tiebreak(a, b);
  });
  return sessions;
}

module.exports = {
  STATUS,
  STATUS_ORDER,
  STATUS_PRIORITY,
  STATUS_LABELS,
  RECENT_ACTIVITY_MS,
  ACTIVE_WORK_CEIL_MS,
  HISTORY_CEIL_MS,
  DEFAULT_RECENT_ACTIVITY_MS,
  DEFAULT_ACTIVE_WORK_CEIL_MS,
  DEFAULT_HISTORY_CEIL_MS,
  deriveStatus,
  sortSessionsByStatusGroups,
  setStatusConfig,
  getStatusConfig,
  resetStatusConfig,
};
