// 顶栏主机选择器（multi-host）：列出 local + 各已保存主机，切换当前选中主机。
// 切换走 store.setSelectedHostId（非 local 先 connectHost 探测，失败停留原主机并 toast）。
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useAppStore } from '@/store';
import type { HostInfo } from '@/api/types';
import { HOST_STATUS_DOT } from '@/lib/host-status';
import { cn } from '@/lib/utils';

function hostLabel(h: HostInfo): string {
  return h.id === 'local' ? '本机' : (h.label || h.id);
}

export function HostSelector() {
  const hosts = useAppStore((s) => s.hosts);
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const hostStatus = useAppStore((s) => s.hostStatus);
  const hostError = useAppStore((s) => s.hostError);
  const setSelectedHostId = useAppStore((s) => s.setSelectedHostId);

  if (hosts.length === 0 && selectedHostId === 'local') {
    // hosts 尚未拉取（首帧）：只显示本机，不渲染触发条（避免空下拉）。
    return null;
  }

  const current = hosts.find((h) => h.id === selectedHostId) ?? {
    id: 'local',
    label: '本机',
    type: 'ssh' as const,
    ssh: null,
    status: 'connected' as const,
    error: null,
    version: null,
  };
  const curStatus = hostStatus[selectedHostId] ?? current.status ?? 'disconnected';

  const onSelect = (id: string) => {
    if (id === selectedHostId) return;
    setSelectedHostId(id).then((ok) => {
      if (!ok) {
        toast.error(`切换主机失败：${hostError[id] ?? '连接失败'}`);
        return;
      }
      // 切换成功：清掉 URL 会话/详情参数、回到会话首页，并整页刷新重建 query 缓存，
      // 强制以新主机（X-Host-Id）重拉远端数据；刷新后由 App 的 host 恢复流程重连回该远端。
      window.history.replaceState(null, '', window.location.pathname);
      useAppStore.getState().setView('sessions');
      window.location.reload();
    });
  };

  return (
    <div className="flex shrink-0 items-center gap-1" title="切换数据主机（远端经 ssh 隧道读取其 AgentLRay）">
      <Select value={selectedHostId} onValueChange={onSelect}>
        <SelectTrigger className="h-8 w-auto min-w-[8rem] gap-1.5 border px-2 text-xs">
          <span className={cn('h-2 w-2 rounded-full', HOST_STATUS_DOT[curStatus] ?? HOST_STATUS_DOT.disconnected)} />
          <SelectValue aria-label={hostLabel(current)}>
            {hostLabel(current)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {hosts.map((h) => {
            const st = hostStatus[h.id] ?? h.status ?? 'disconnected';
            return (
              <SelectItem key={h.id} value={h.id}>
                <span className="flex items-center gap-1.5">
                  <span className={cn('h-2 w-2 rounded-full', HOST_STATUS_DOT[st] ?? HOST_STATUS_DOT.disconnected)} />
                  {hostLabel(h)}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {curStatus === 'error' && hostError[selectedHostId] ? (
        <span className="max-w-[10rem] truncate text-[10px] text-red-500" title={hostError[selectedHostId]}>
          {hostError[selectedHostId]}
        </span>
      ) : null}
    </div>
  );
}
