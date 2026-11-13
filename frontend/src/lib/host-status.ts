// 主机连接状态机的展示映射（multi-host）：状态徽标配色与中文标签。
// HostSelector（顶栏）与 HostsTab（设置面板）共用，避免两处重复定义。
import type { HostStatus } from '@/api/types';

/** 状态徽标圆点配色（Tailwind bg class）。 */
export const HOST_STATUS_DOT: Record<HostStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400 animate-pulse',
  error: 'bg-red-500',
  disconnected: 'bg-muted-foreground/40',
};

/** 状态中文标签。 */
export const HOST_STATUS_LABEL: Record<HostStatus, string> = {
  connected: '已连接',
  connecting: '连接中',
  error: '错误',
  disconnected: '未连接',
};
