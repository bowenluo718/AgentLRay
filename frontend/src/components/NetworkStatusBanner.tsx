// 系统网络阻断提示（D-1）：原生壳（Android）通过 `onBlockedStatusChanged`/网络回调上报
// 到 `POST /api/network/status`，此处轮询 `GET /api/network/status` 并在顶部给出横幅。
//
// 语义：`blocked === true` 表示系统层面限制了本应用的后台网络（Data Saver / 后台数据限制 /
// 省电策略），远程连接会反复断开且自动重连也可能失败。与「链路本身故障」区分开——后者由
// HostConnectingView / HostsDialog 展示稳定错误码。
//
// 仅在薄服务（thin）显示：桌面浏览器没有原生网络回调，永远不会有上报。
// 不提供「知道了」——阻断状态由系统决定，用户清除提示后会误以为已恢复。
import { useEffect, useState } from 'react';
import { getNetworkStatus } from '@/api/client';
import type { NetworkStatus } from '@/api/client';
import { useAppStore } from '@/store';

// 15s：阻断状态变化不频繁，轮询只为最终一致；与主机探活(15s)同量级。
const POLL_MS = 15_000;
// 与 /api/mode capabilities.networkBlocked 的过期阈值一致（10 分钟）。
const STALE_MS = 10 * 60 * 1000;

const TRANSPORT_LABEL: Record<string, string> = {
  wifi: 'Wi-Fi',
  cellular: '移动网络',
  ethernet: '有线网络',
  none: '无网络',
  other: '其他网络',
};

export function NetworkStatusBanner() {
  const isThin = useAppStore((s) => s.mode) === 'thin';
  const [status, setStatus] = useState<NetworkStatus | null>(null);

  useEffect(() => {
    if (!isThin) return;
    let disposed = false;
    const poll = async () => {
      try {
        const res = await getNetworkStatus();
        if (!disposed) setStatus(res.status);
      } catch {
        // 服务端短暂不可用：保持上次状态，下个周期重试（不误报「已恢复」）。
      }
    };
    void poll();
    const timer = setInterval(poll, POLL_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [isThin]);

  if (!isThin || !status || status.blocked !== true) return null;
  // 上报过期（原生壳退出/长时间无事件）：不呈现可能已过时的阻断提示。
  if (Date.now() - status.reportedAt > STALE_MS) return null;

  const transport = status.transport ? TRANSPORT_LABEL[status.transport] ?? status.transport : null;

  return (
    <div
      role="alert"
      className="flex shrink-0 items-center gap-2 border-b border-destructive/40 bg-destructive/10 px-3 py-1.5 text-xs text-destructive"
    >
      <span className="min-w-0 flex-1">
        系统已限制本应用的后台网络（数据节省 / 省电策略）{transport ? `，当前为${transport}` : ''}。
        远程连接可能反复中断；请在系统设置中允许 AgentLRay 后台联网。
      </span>
    </div>
  );
}
