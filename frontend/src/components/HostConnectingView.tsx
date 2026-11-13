// 首帧连接占位（multi-host「先连后加载」）：记忆的远端尚未就绪时不渲染任何数据面，
// 只显示主机名 + 连接中徽标 + 可回本机。本机（hostReady 初始 true）不命中此组件。
import { HOST_STATUS_DOT, HOST_STATUS_LABEL } from '@/lib/host-status';
import { REMEMBERED_HOST_KEY, useAppStore } from '@/store';
import { cn } from '@/lib/utils';

export function HostConnectingView({ hostId }: { hostId: string }) {
  const hosts = useAppStore((s) => s.hosts);
  const hostError = useAppStore((s) => s.hostReadyError);
  const setSelectedHostId = useAppStore((s) => s.setSelectedHostId);
  const label = hosts.find((h) => h.id === hostId)?.label ?? hostId;

  const backToLocal = () => {
    // 回本机：清记忆键 + 切回 local（setSelectedHostId 内部会置 hostReady）。
    try {
      localStorage.removeItem(REMEMBERED_HOST_KEY);
    } catch {
      /* non-fatal */
    }
    setSelectedHostId('local');
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="flex items-center gap-2">
        <span className={cn('h-3 w-3 rounded-full', HOST_STATUS_DOT.connecting)} aria-hidden />
        <span className="text-sm text-foreground">
          正在连接 {label}…（{HOST_STATUS_LABEL.connecting}）
        </span>
      </div>
      {hostError ? <p className="max-w-md text-center text-xs text-destructive">{hostError}</p> : null}
      <p className="max-w-md text-center text-xs text-muted-foreground">
        正在建立 ssh 隧道并探测远端 AgentLRay，请稍候…
      </p>
      <button
        type="button"
        onClick={backToLocal}
        className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
      >
        回本机
      </button>
    </div>
  );
}
