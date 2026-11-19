// 已登录态视图（design-dsh-login-methods D12/D24/D25）：
// - 只读配置摘要（角色/服务器/设备名/端口）+ 当前登录角色 + 退出按钮。
// - 退出清所有 scope token；若当前选中主机是 dsh 类型则切回本地主机（父级处理）。
import { DshConfig } from '@/api/client';
import { Button } from '@/components/ui/button';

export function DshLoggedInView({
  cfg,
  loggingOut,
  onLogout,
}: {
  cfg: DshConfig;
  loggingOut: boolean;
  onLogout: () => void;
}) {
  const roleLabel: Record<DshConfig['role'], string> = {
    host: 'host（只被连）',
    client: 'client（只去连）',
    both: 'both（既被连也去连）',
  };
  return (
    <div className="space-y-3">
      <div className="space-y-1 rounded-md border p-3 text-sm">
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">本机角色</span>
          <span className="text-right">{roleLabel[cfg.role]}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">中继服务器</span>
          <span className="max-w-[60%] truncate text-right">{cfg.serverUrl}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">本机设备名</span>
          <span className="text-right">{cfg.deviceName}</span>
        </div>
        <div className="flex justify-between gap-2">
          <span className="text-muted-foreground">放行端口</span>
          <span className="text-right">{cfg.allowedPorts.join(', ')}</span>
        </div>
      </div>

      <div className="rounded-md border bg-muted/40 p-3">
        <p className="text-xs text-muted-foreground">当前登录角色</p>
        <p className="text-sm font-medium">
          {cfg.authStatus.roles.length > 0 ? cfg.authStatus.roles.join(' + ') : '—'}
        </p>
      </div>

      <div className="flex flex-col gap-2 pt-2">
        <Button variant="destructive" disabled={loggingOut} onClick={onLogout}>
          {loggingOut ? '退出中…' : '退出'}
        </Button>
      </div>
    </div>
  );
}
