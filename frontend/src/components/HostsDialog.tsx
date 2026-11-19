// 主机设置弹框：从系统设置弹框迁移到侧栏底部入口打开。列出已保存主机（含 local 内建）。
// - local 行：说明展示本机上报的主机名；右侧以 inbound 徽标（被哪些主机连接）替换原「恒连接」，
//   保留悬浮连接详情 + 点击查看明细逻辑（从顶栏迁移至此）。
// - 远程行：未连接（非当前选中）显示「连接」，已连接（当前选中）显示「断开」，二者互斥；
//   不再有「测试连接」按钮（测试收进新建/编辑弹框）。连接 = setSelectedHostId（同顶栏切换逻辑）。
// - 「添加主机」按钮 + 每行「编辑」打开独立 HostFormDialog（默认隐藏）。
// 主机 CRUD 是独立资源（/api/hosts），与 settings 的单一 draft 解耦。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Plus, Settings2 } from 'lucide-react';
import { getHosts, getDshDevices, deleteHost as apiDeleteHost } from '@/api/client';
import type { HostInfo, HostStatus, InboundPeer } from '@/api/types';
import { HOST_STATUS_DOT, HOST_STATUS_LABEL } from '@/lib/host-status';
import { useAppStore, REMEMBERED_HOST_KEY } from '@/store';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { HostFormDialog } from '@/components/HostFormDialog';
import { DshConfigDialog } from '@/components/DshConfigDialog';

// 行内文字按钮（轻按钮：无边框背景，仅文字）：连接/断开/编辑/删除统一走此样式。
function TextAction({
  children,
  className,
  disabled,
  title,
  onClick,
}: {
  children: React.ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'inline-flex h-8 shrink-0 items-center rounded-md px-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

// 主机「当前选中」真实变更后统一收尾（design-host-settings-redesign 追加）：
// 记忆的当前主机缓存（localStorage）已由 store 的 setSelectedHostId/disconnectHost 更新，
// 这里清 URL 详情/页签参数 → 回「会话」主页 → 整页刷新重拉本机数据面。
// 否则停留在断开/切换前的视图与 URL，远端缓存数据继续渲染，表现为「没刷新回主页」。
export function settleHostSwitch(): void {
  window.history.replaceState(null, '', window.location.pathname);
  useAppStore.getState().setView('sessions');
  window.location.reload();
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

// inbound 徽标（本机被哪些主机连接）。从顶栏 HostSelector 迁至 local 行，替换「恒连接」。
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
                <div className="truncate font-medium text-foreground">
                  {p.label}
                  <span className="ml-1 rounded bg-muted px-1 text-[10px] font-normal text-muted-foreground">
                    {p.via === 'dsh' ? 'dsh' : 'ssh'}
                  </span>
                </div>
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

function StatusBadge({ status }: { status: HostStatus }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-full', HOST_STATUS_DOT[status] ?? HOST_STATUS_DOT.disconnected)} />
      <span className="text-[11px] text-muted-foreground">{HOST_STATUS_LABEL[status] ?? status}</span>
    </span>
  );
}

export function HostsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: getHosts, enabled: open });
  // dsh 设备列表（中继服务器上当前账号可见的设备）：用于把主机的 deviceId 渲染成设备名/在线态。
  const devices = useQuery({ queryKey: ['dsh-devices'], queryFn: getDshDevices, enabled: open, retry: false });
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const hostStatus = useAppStore((s) => s.hostStatus);
  const hostError = useAppStore((s) => s.hostError);
  const inbound = useAppStore((s) => s.inbound);
  const setSelectedHostId = useAppStore((s) => s.setSelectedHostId);
  const disconnectHost = useAppStore((s) => s.disconnectHost);
  // 新建/编辑表单弹框（默认隐藏）。editing 非 null 时编辑该主机。
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<HostInfo | null>(null);
  // dsh 配置弹框（默认隐藏）：本机 dsh 账号/角色配置（存 hosts.json 顶层 dsh）。
  const [dshConfigOpen, setDshConfigOpen] = useState(false);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hosts'] });

  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDeleteHost(id),
    onSuccess: (_res, id) => {
      invalidate();
      // 删除的是当前查看的远端：后端 closeHost 已断隧道，store 记忆仍指向它 →
      // 更新记忆缓存为 local、切回本机，再走统一收尾（清 URL、回主页、整页刷新）。
      if (id === useAppStore.getState().selectedHostId) {
        try {
          localStorage.setItem(REMEMBERED_HOST_KEY, 'local');
        } catch {
          /* non-fatal */
        }
        useAppStore.getState().setSelectedHostId('local');
      }
      toast.success('主机已删除');
      settleHostSwitch();
    },
    onError: (e) => toast.error(`删除失败：${(e as Error).message}`),
  });
  // 断开连接：只关隧道 + 停心跳（不删主机）。走 store 的 disconnectHost（同顶栏逻辑）。
  const disconnectMut = useMutation({
    mutationFn: (id: string) => disconnectHost(id),
    onMutate: (id) => ({
      // 记录断开前选中的主机：store 内部对当前远端会切回 local，onSuccess 时
      // selectedHostId 已变，需据此判断「断开的是否为当前查看的远端」。
      wasCurrent: id === useAppStore.getState().selectedHostId,
    }),
    onSuccess: (ok, id, ctx) => {
      invalidate();
      if (!ok) {
        toast.error(`「${id}」断开失败`);
        return;
      }
      toast.success(`「${id}」已断开`);
      // 断开的是当前查看的远端 → 统一收尾：清 URL 查询参数、回「会话」主页、整页刷新
      // 重拉本机数据（否则停留在断开前的视图/URL，远端缓存数据继续渲染，表现为「没刷新回主页」）。
      if (ctx?.wasCurrent) settleHostSwitch();
    },
    onError: (e) => toast.error(`断开失败：${(e as Error).message}`),
  });

  // 「连接」= 切换当前选中主机（同顶栏下拉逻辑）：非 local 先 connectHost 探测，
  // 成功才提交 + 整页刷新重拉远端数据；失败 toast 报错、停留原主机。
  const onConnect = (id: string) => {
    if (id === selectedHostId) return;
    setSelectedHostId(id).then((ok) => {
      if (!ok) {
        toast.error(`连接失败：${hostError[id] ?? '连接失败'}`);
        return;
      }
      settleHostSwitch();
    });
  };

  const onAdd = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const onEdit = (h: HostInfo) => {
    setEditing(h);
    setFormOpen(true);
  };

  const data = hosts.data ?? [];
  const selfLabel = inbound?.self?.label;

  // dsh 主机行说明：匹配设备列表渲染为「设备名（在线/离线）· deviceId 前 8 位」。
  // 匹配不到（设备离线/已移除/账号未配）回退显示原始 deviceId。
  const dshLabel = (deviceId: string): string => {
    const d = (devices.data ?? []).find((it) => it.deviceId === deviceId);
    if (!d) return deviceId;
    return `${d.name}（${d.online ? '在线' : '离线'}）· ${deviceId.slice(0, 8)}`;
  };

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-xl overflow-y-auto top-[6%] translate-y-0 max-h-[85vh] max-sm:w-[calc(100%-1.5rem)] max-sm:max-w-[calc(100%-1.5rem)] max-sm:p-4">
          <DialogHeader>
            <DialogTitle>主机</DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-2">
            {/* 空态：无已保存主机时显示提示，仍可通过底部「添加主机」新建 */}
            {data.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
                还没有已保存的主机，点击下方「添加主机」创建。
              </div>
            ) : null}

            {data.map((h) => {
              const isLocal = h.id === 'local';
              const st = hostStatus[h.id] ?? h.status ?? 'disconnected';
              const isCurrent = h.id === selectedHostId;
              const error = h.error ?? hostError[h.id] ?? null
              return (
                <div
                  key={h.id}
                  className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between sm:gap-2"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{isLocal ? '本机' : (h.label || h.id)}</span>
                      {!isLocal ? <span className="rounded px-1 text-[10px] text-muted-foreground">{h.id}</span> : (selfLabel ?? 'local')}
                      {!isLocal ? <StatusBadge status={st} />  : null}                      
                    </div>
                    {st === 'error' && error ? (
                      <span className="max-w-[12rem] truncate text-[10px] text-destructive" title={error}>
                        {error}
                      </span>
                    ) : null}
                    {h.ssh ? (
                      <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                        {h.ssh.user ? `${h.ssh.user}@` : ''}
                        {h.ssh.host}
                        {h.ssh.port ? `:${h.ssh.port}` : ''} → 127.0.0.1:{h.ssh.remoteAgentLrayPort}
                      </div>
                    ) : h.dsh ? (
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {dshLabel(h.dsh.deviceId)}
                      </div>
                    ) : null }
                  </div>
                  {isLocal ? (
                    <InboundBadge count={inbound?.count ?? 0} peers={inbound?.peers ?? []} />
                  ) : (
                    <div className="flex shrink-0 items-center gap-0.5 self-start sm:self-center">
                      {isCurrent ? (
                        <TextAction
                          className="text-amber-600 hover:bg-amber-500/10 dark:text-amber-500"
                          disabled={disconnectMut.isPending && disconnectMut.variables === h.id}
                          onClick={() => disconnectMut.mutate(h.id)}
                          title="关闭隧道并断开连接"
                        >
                          {disconnectMut.isPending && disconnectMut.variables === h.id ? '断开中…' : '断开'}
                        </TextAction>
                      ) : (
                        <TextAction onClick={() => onConnect(h.id)} title="连接该主机（自动断开其他已连接远程主机）">
                          连接
                        </TextAction>
                      )}
                      <TextAction onClick={() => onEdit(h)}>编辑</TextAction>
                      <TextAction
                        className="text-destructive hover:bg-destructive/10"
                        disabled={deleteMut.isPending}
                        onClick={() => deleteMut.mutate(h.id)}
                      >
                        删除
                      </TextAction>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-1 flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" className="flex-1 justify-center gap-1.5 text-primary" onClick={onAdd}>
              <Plus className="h-4 w-4" />
              添加主机
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="flex-1 justify-center gap-1.5 text-primary"
              onClick={() => setDshConfigOpen(true)}
              title="本机 dsh 账号/角色配置（中继服务器、放行端口）"
            >
              <Settings2 className="h-4 w-4" />
              dsh 配置
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <HostFormDialog open={formOpen} onOpenChange={setFormOpen} editing={editing} />
      <DshConfigDialog open={dshConfigOpen} onOpenChange={setDshConfigOpen} />
    </>
  );
}
