// 主机连接状态机的展示映射（multi-host）：状态徽标配色与中文标签。
// HostsDialog（主机设置弹框）与 Sidebar 主机入口共用，避免多处重复定义。
import type { HostErrorCode, HostInfo, HostStatus } from '@/api/types';

/** 状态徽标圆点配色（Tailwind bg class）。 */
export const HOST_STATUS_DOT: Record<HostStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400 animate-pulse',
  // 自动重连中：与「首次连接」区分（蓝 + 呼吸），避免用户误以为卡在连接。
  reconnecting: 'bg-sky-500 animate-pulse',
  failed: 'bg-red-500',
  error: 'bg-red-500',
  disconnected: 'bg-muted-foreground/40',
};

/** 状态中文标签。 */
export const HOST_STATUS_LABEL: Record<HostStatus, string> = {
  connected: '已连接',
  connecting: '连接中',
  reconnecting: '重连中',
  failed: '连接失败',
  error: '错误',
  disconnected: '未连接',
};

/** 稳定错误码 → 中文短语（弹框/占位页展示用；详细动作见 hostErrorHint）。 */
export const HOST_ERROR_LABEL: Record<HostErrorCode, string> = {
  HOST_OFFLINE: '目标主机离线',
  DSH_AUTH_REQUIRED: 'dsh 登录已失效',
  KEY_CHANGED: '主机身份密钥已变化',
  VERSION_INCOMPATIBLE: '远端版本不兼容',
  TUNNEL_TIMEOUT: '建链超时',
  TUNNEL_REFUSED: '端口拒绝连接',
  UNREACHABLE: '网络不可达',
  INVALID_TARGET: '目标主机无效',
  AUTH_REQUIRED: '认证被拒绝',
};

/** 该错误对应的可操作建议（null → 无针对性建议，靠统一文案）。 */
export function hostErrorHint(code: HostErrorCode | null | undefined): string | null {
  switch (code) {
    case 'HOST_OFFLINE':
      return '请确认目标主机上的 AgentLRay 已启动并在线，稍后会自动重试。';
    case 'DSH_AUTH_REQUIRED':
      return '请在「连接设置」中重新登录 dsh 账号后重试。';
    case 'KEY_CHANGED':
      return '目标主机可能重装或更换设备。请先在本机删除该设备的信任记录，再重新连接。';
    case 'VERSION_INCOMPATIBLE':
      return '远端 AgentLRay 版本过低，请升级远端后重试。';
    case 'TUNNEL_TIMEOUT':
    case 'TUNNEL_REFUSED':
      return '请检查目标主机地址/端口与网络连通性，稍后会自动重试。';
    case 'UNREACHABLE':
      return '请检查网络（断网/切网后可自动恢复），稍后会自动重试。';
    case 'INVALID_TARGET':
      return '该主机配置无效（如连到本机自身或设备不可用），请编辑或删除后重新添加。';
    case 'AUTH_REQUIRED':
      return '目标主机的认证被拒绝，请检查凭据配置。';
    default:
      return null;
  }
}

/** 是否可自动自愈（重连中，或失败但服务端标记可重试）：决定提示语是否说「会自动重连」。
 *  单一真源——HostConnectingView / HostsDialog 都调用它，避免两处阈值不一致。 */
export function isSelfHealing(status: HostStatus, retryable?: boolean | null): boolean {
  return status === 'reconnecting' || (status === 'failed' && retryable !== false);
}

/** 主机展示名：local 内建 → '本机'；其余用 label 回退 id。供「将在 <host> 上执行」
 *  提示与主机选择器等共用，避免各组件重复定义。 */
export function hostLabel(hosts: HostInfo[], hostId: string): string {
  if (hostId === 'local') return '本机';
  return hosts.find((h) => h.id === hostId)?.label || hostId;
}
