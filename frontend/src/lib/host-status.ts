// 主机连接状态机的展示映射（multi-host）：状态徽标配色与中文标签。
// HostSelector（顶栏）与 HostsTab（设置面板）共用，避免两处重复定义。
import type { HostStatus } from '@/api/types';
import type { HostInfo } from '@/api/types';

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

/** 主机展示名：local 内建 → '本机'；其余用 label 回退 id。供「将在 <host> 上执行」
 *  提示与主机选择器等共用，避免各组件重复定义。 */
export function hostLabel(hosts: HostInfo[], hostId: string): string {
  if (hostId === 'local') return '本机';
  return hosts.find((h) => h.id === hostId)?.label || hostId;
}
