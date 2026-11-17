// dsh 配置弹框：从设置面板「远程主机 (dsh)」页签迁至主机连接弹框（HostsDialog）
// 内的「dsh 配置」按钮打开（design-dsh-config-in-hosts-dialog）。
// - 读写 GET/PUT /api/dsh/config（本机资源，恒 local；配置存 ~/.agentlray/hosts.json 顶层 dsh）。
// - 表单字段：本机角色 / 中继服务器地址 / 账号邮箱 / 账号密码 / 本机设备名 / 放行端口。
// - 密码只写不读：编辑态不预填（留空 = 保持已存密码），勾选「清除已保存的密码」→ 传 ''。
// - 保存即生效：服务端 saveDshSettings + applyDshRuntime 热切换（角色切换/放行端口刷新）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { getDshConfig, saveDshConfig as apiSaveDshConfig } from '@/api/client';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface Draft {
  role: 'host' | 'client' | 'both';
  serverUrl: string;
  email: string;
  password: string;
  /** 编辑态：是否显式清除已保存的密码（password 留空时生效）。 */
  clearPassword: boolean;
  deviceName: string;
  /** 放行端口（逗号/空格分隔文本，保存时解析为数字数组）。 */
  allowedPorts: string;
}

export function DshConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({
    role: 'both',
    serverUrl: '',
    email: '',
    password: '',
    clearPassword: false,
    deviceName: '',
    allowedPorts: '',
  });
  // 打开后仅在配置数据首次就绪时种 draft（此后编辑不被打断）。
  const seeded = useRef(false);

  const cfg = useQuery({ queryKey: ['dsh-config'], queryFn: getDshConfig, enabled: open });

  function seed() {
    setDraft({
      role: cfg.data?.role ?? 'both',
      serverUrl: cfg.data?.serverUrl ?? '',
      email: cfg.data?.email ?? '',
      // 密码只写不读：编辑态不预填（留空 = 保持不变）。
      password: '',
      clearPassword: false,
      deviceName: cfg.data?.deviceName ?? '',
      allowedPorts: (cfg.data?.allowedPorts ?? [3800]).join(', '),
    });
  }

  useEffect(() => {
    if (open && cfg.data && !seeded.current) {
      seeded.current = true;
      seed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cfg.data]);

  function handleOpenChange(next: boolean) {
    if (next) seeded.current = false;
    onOpenChange(next);
  }

  const saveMut = useMutation({
    mutationFn: () =>
      apiSaveDshConfig({
        role: draft.role,
        serverUrl: draft.serverUrl.trim(),
        email: draft.email.trim(),
        deviceName: draft.deviceName.trim(),
        // 放行端口：逗号/空格分隔的数字列表；解析不出合法端口时留空数组（服务端按默认处理）。
        allowedPorts: draft.allowedPorts
          .split(/[\s,]+/)
          .map((item) => Number(item.trim()))
          .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535),
        // 密码语义同 llm.apiKey：留空 = 保留已存密码（不回显，故无法用留空表达清除）；
        // 勾选「清除已保存密码」→ 显式传 ''（服务端删除密文）。
        password: draft.password !== '' ? draft.password : draft.clearPassword ? '' : undefined,
      }),
    onSuccess: () => {
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ['dsh-config'] });
      // 账号变化会影响 HostFormDialog 的设备候选下拉（中继服务器上可见设备）。
      queryClient.invalidateQueries({ queryKey: ['dsh-devices'] });
      toast.success('dsh 配置已保存');
    },
    onError: (e) => toast.error(`保存失败：${(e as Error).message}`),
  });

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg overflow-y-auto top-[6%] translate-y-0 max-h-[85vh] max-sm:w-[calc(100%-1.5rem)] max-sm:max-w-[calc(100%-1.5rem)] max-sm:p-4">
        <DialogHeader>
          <DialogTitle>dsh 配置</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="dshcfg-role">
              本机角色
            </label>
            <select
              id="dshcfg-role"
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
              value={draft.role}
              onChange={(e) => setDraft({ ...draft, role: e.target.value as Draft['role'] })}
            >
              <option value="both">both（既被连也去连，默认）</option>
              <option value="host">host（只被别的 AgentLRay 连接）</option>
              <option value="client">client（只去连别的 AgentLRay）</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="dshcfg-server-url">
              中继服务器地址
            </label>
            <Input
              id="dshcfg-server-url"
              placeholder="https://dsh.r2049.cn"
              value={draft.serverUrl}
              onChange={(e) => setDraft({ ...draft, serverUrl: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              默认官方公共服务器；内网强控场景可填自托管地址。AgentLRay 不内置中继服务器。
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="dshcfg-email">
              账号邮箱
            </label>
            <Input
              id="dshcfg-email"
              placeholder="user@example.com"
              value={draft.email}
              onChange={(e) => setDraft({ ...draft, email: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="dshcfg-password">
              账号密码
            </label>
            <Input
              id="dshcfg-password"
              type="password"
              placeholder={cfg.data?.hasPassword ? '已保存，留空保持不变' : '中继服务器账号密码'}
              value={draft.password}
              onChange={(e) => setDraft({ ...draft, password: e.target.value })}
            />
            {cfg.data?.hasPassword && draft.password === '' ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={draft.clearPassword}
                  onChange={(e) => setDraft({ ...draft, clearPassword: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                清除已保存的密码（重新填密码则覆盖）
              </label>
            ) : null}
            <p className="text-[11px] text-muted-foreground">密码加密落盘，不回显</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="dshcfg-device-name">
              本机设备名
            </label>
            <Input
              id="dshcfg-device-name"
              placeholder="如：devbox"
              value={draft.deviceName}
              onChange={(e) => setDraft({ ...draft, deviceName: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">在中继服务器上的设备标识（默认本机 hostname 短名）</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground" htmlFor="dshcfg-allowed-ports">
              放行端口（被连接方允许访问本机哪些端口，逗号分隔）
            </label>
            <Input
              id="dshcfg-allowed-ports"
              placeholder="3800"
              value={draft.allowedPorts}
              onChange={(e) => setDraft({ ...draft, allowedPorts: e.target.value })}
            />
            <p className="text-[11px] text-muted-foreground">
              默认 3800（AgentLRay 默认端口）。远端 AgentLRay 跑其它端口时，在此放行并在对端主机里填同一端口。
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={saveMut.isPending} onClick={() => onOpenChange(false)} className="sm:w-auto">
            取消
          </Button>
          <Button disabled={saveMut.isPending} onClick={() => saveMut.mutate()} className="sm:w-auto">
            {saveMut.isPending ? '保存中…' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
