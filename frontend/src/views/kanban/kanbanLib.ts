// 任务看板纯函数：按四态分桶 + 列内排序 + 截断。看板视图（KanbanView）唯一数据
// 整形来源；不放 React 依赖，便于单测与复用。

import type { SessionSummary } from '@/api/types';
import { parseTimestampMs } from '@/lib/pure';

// 固定列顺序：待用户输入 → 工作中 → 等待中 → 已停止（与服务端 STATUS_ORDER 一致）。
const STATUS_ORDER = ['awaiting-input', 'working', 'waiting', 'stopped'];

/** lastActivity（缺省回退 timestamp）毫秒，无法解析返回 0（排最后）。与 SessionList.lastActiveMs 同口径。 */
export function lastActivityMs(s: SessionSummary): number {
  return parseTimestampMs(s.lastActivity) ?? parseTimestampMs(s.timestamp) ?? 0;
}

/** 看板一列：status 为分桶键；total 为截断前完整数量（列头计数）；list 为实际展示列表。 */
export interface KanbanColumn {
  status: string;
  total: number;
  list: SessionSummary[];
}

/**
 * 把（已按平台/项目/文本筛选后的）会话列表按状态分桶构建看板列。
 * - 以 session.status ?? 'stopped' 分桶（缺失状态防御性归入 stopped 列）；
 * - 桶内按 lastActivity（缺失回退 timestamp）降序；
 * - 每桶切片（全局手风琴，同一时刻至多一列展开）：expandedStatus === status → 全量，
 *   否则前 collapsedLimit（非正整数防御性回退 1）；total 始终为截断前的完整量；
 * - collapsedLimit 按断点注入：桌面 = maxPerStatus（默认 20），移动端 = 恒 1；
 * - 返回固定 STATUS_ORDER 四列 + 任何未知状态桶（保序后置，避免会话静默丢失）。
 */
export function buildKanbanColumns(
  sessions: SessionSummary[],
  opts: { collapsedLimit: number; expandedStatus: string | null }
): KanbanColumn[] {
  const { collapsedLimit, expandedStatus } = opts;
  const limit = Number.isInteger(collapsedLimit) && collapsedLimit > 0 ? collapsedLimit : 1;
  const buckets = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const status = s.status || 'stopped';
    const bucket = buckets.get(status) ?? [];
    bucket.push(s);
    buckets.set(status, bucket);
  }
  const columnStatuses = [
    ...STATUS_ORDER,
    ...[...buckets.keys()].filter((k) => !STATUS_ORDER.includes(k)),
  ];
  return columnStatuses.map((status) => {
    const full = [...(buckets.get(status) ?? [])].sort((a, b) => lastActivityMs(b) - lastActivityMs(a));
    return { status, total: full.length, list: expandedStatus === status ? full : full.slice(0, limit) };
  });
}

export { STATUS_ORDER as KANBAN_STATUS_ORDER };
