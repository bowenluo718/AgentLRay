// 首帧连接占位（multi-host「先连后加载」）：记忆的远端尚未就绪时不渲染任何数据面，
// 只显示主机名 + 链路状态 + 可回本机/重试。本机（hostReady 初始 true）不命中此组件。
import { toast } from 'sonner';
import {
  HOST_ERROR_LABEL,
  HOST_STATUS_DOT,
  HOST_STATUS_LABEL,
  hostErrorHint,
  isSelfHealing,
} from '@/lib/host-status';
import { REMEMBERED_HOST_KEY, useAppStore } from '@/store';
import { cn } from '@/lib/utils';

export function HostConnectingView({ hostId }: { hostId: string }) {
  const hosts = useAppStore((s) => s.hosts);
  const hostStatus = useAppStore((s) => s.hostStatus[hostId]);
  const hostReadyError = useAppStore((s) => s.hostReadyError);
  const snapshotErrorCode = useAppStore((s) => s.hostReadyErrorCode);
  const snapshotRetryable = useAppStore((s) => s.hostReadyErrorRetryable);
  const stateChangedAt = useAppStore((s) => s.hostStateChangedAt[hostId] ?? 0);
  const setSelectedHostId = useAppStore((s) => s.setSelectedHostId);
  // 薄服务无 local 可回落（design-thin-service）：不显示「回本机」，改为「重试连接」。
  const isThin = useAppStore((s) => s.mode) === 'thin';
  const host = hosts.find((h) => h.id === hostId);
  const label = host?.label ?? hostId;
  // 错误码/可重试性优先取**每主机实时值**（服务端轮询会持续更新，例如可重试超时 →
  // KEY_CHANGED 后已放弃重连）；快照（setHostLinkFailed 写入）仅在实时值缺失时兜底，
  // 否则占位页会用旧码承诺「会自动重连」，与服务端实际状态矛盾。
  const errorCode = host?.errorCode ?? snapshotErrorCode;
  const retryable = host?.errorRetryable ?? snapshotRetryable;

  // 服务端状态与本地错误共同决定展示：重连中/可重试失败 → 自动恢复，无需用户操作。
  const status = hostStatus ?? host?.status ?? 'connecting';
  const statusLabel = HOST_STATUS_LABEL[status] ?? status;
  const selfHealing = isSelfHealing(status, retryable);
  // 稳定失败：同一失败状态持续 > 20s 才提示人工动作（重新登录/删信任），避免一次抖动就吓用户。
  const stableFailure =
    status === 'failed' && stateChangedAt > 0 && Date.now() - stateChangedAt > 20_000;
  const codeLabel = errorCode ? HOST_ERROR_LABEL[errorCode] : null;
  const hint = stableFailure ? hostErrorHint(errorCode) : null;
  const message = host?.error || hostReadyError;

  const backToLocal = () => {
    // 回本机：清记忆键 + 切回 local（setSelectedHostId 内部会置 hostReady）。
    try {
      localStorage.removeItem(REMEMBERED_HOST_KEY);
    } catch {
      /* non-fatal */
    }
    setSelectedHostId('local');
  };

  // 重连：无 local 可回落时重新探测目标主机（setSelectedHostId 内部 connectHost）。
  const retry = () => {
    setSelectedHostId(hostId).then((ok) => {
      if (!ok) toast.error(`连接 ${label} 失败`);
    });
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6">
      <div className="flex items-center gap-2">
        <span
          className={cn('h-3 w-3 rounded-full', HOST_STATUS_DOT[status] ?? HOST_STATUS_DOT.connecting)}
          aria-hidden
        />
        <span className="text-sm text-foreground">
          {status === 'reconnecting'
            ? `${label} 连接已断开，正在自动重连…`
            : `正在连接 ${label}…`}
          <span className="ml-1 text-muted-foreground">（{statusLabel}）</span>
        </span>
      </div>
      {codeLabel ? <p className="text-xs font-medium text-destructive">{codeLabel}</p> : null}
      {message ? <p className="max-w-md text-center text-xs text-destructive">{message}</p> : null}
      {hint ? <p className="max-w-md text-center text-xs text-muted-foreground">{hint}</p> : null}
      <p className="max-w-md text-center text-xs text-muted-foreground">
        {selfHealing
          ? '链路断开后会自动按指数退避重连，期间无需重复操作。'
          : '正在建立隧道并探测远端 AgentLRay，请稍候…'}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={retry}
          className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
        >
          重试连接
        </button>
        {isThin ? null : (
          <button
            type="button"
            onClick={backToLocal}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/40 hover:text-foreground"
          >
            回本机
          </button>
        )}
      </div>
    </div>
  );
}
