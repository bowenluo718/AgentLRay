// 顶栏主机选择器（multi-host）：列出 local + 各已保存主机，切换当前选中主机。
// 切换走 store.setSelectedHostId（非 local 先 connectHost 探测，失败停留原主机并 toast）。
// 另含「被连接主机」徽标（inbound peers）：本机被哪些其他主机连接（仅本机视角展示）。
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useAppStore } from '@/store';
import type { HostInfo, InboundPeer } from '@/api/types';
import { HOST_STATUS_DOT } from '@/lib/host-status';
import { cn } from '@/lib/utils';

function hostLabel(h: HostInfo): string {
  return h.id === 'local' ? '本机' : (h.label || h.id);
}

// 连接时长文案：connectedAt → 当前。
function connectedDuration(connectedAt: string): string {
  const sec = Math.max(0, Math.floor((Date.now() - Date.parse(connectedAt)) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时`;
  return `${Math.floor(hr / 24)} 天`;
}

function InboundBadge({ count, peers }: { count: number; peers: InboundPeer[] }) {
  if (count <= 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={`${count} 台其他主机正在连接本机`}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 text-xs font-medium text-sky-600 transition-colors hover:bg-sky-500/20 dark:text-sky-400"
        >
          <span className="h-2 w-2 rounded-full bg-sky-500" />
          被 {count} 连
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3">
        <div className="mb-2 text-xs font-semibold text-foreground">正在连接本机的主机</div>
        <div className="flex flex-col gap-2">
          {peers.map((p) => (
            <div key={p.peerId} className="flex items-center justify-between gap-2 text-xs">
              <div className="min-w-0">
                <div className="truncate font-medium text-foreground">{p.label}</div>
                <div className="truncate text-muted-foreground">
                  {p.peerId}
                  {p.version ? ` · v${p.version}` : ''}
                </div>
              </div>
              <div className="shrink-0 text-right text-muted-foreground">{connectedDuration(p.connectedAt)}</div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function HostSelector() {
  const hosts = useAppStore((s) => s.hosts);
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const hostStatus = useAppStore((s) => s.hostStatus);
  const hostError = useAppStore((s) => s.hostError);
  const inbound = useAppStore((s) => s.inbound);
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
      {selectedHostId === 'local' && inbound && inbound.count > 0 ? (
        <InboundBadge count={inbound.count} peers={inbound.peers} />
      ) : null}
      {curStatus === 'error' && hostError[selectedHostId] ? (
        <span className="max-w-[10rem] truncate text-[10px] text-red-500" title={hostError[selectedHostId]}>
          {hostError[selectedHostId]}
        </span>
      ) : null}
    </div>
  );
}
