// 主机「新建 / 编辑」弹框：从主机设置弹框独立出来，默认隐藏。
// - 添加（editing=null）或编辑（editing=某 HostInfo）时打开。
// - 传输方式二选一：ssh 隧道 / dsh 远程通道（ds-harness-remote 加密通道 + 中继服务器）。
// - 底部三按钮：取消（直接关）、测试连接（用当前表单信息建隧道探测）、保存（持久化）。
// - 必填校验：ssh 需 host、dsh 需 deviceId；新建时 id 必填。测试连接与保存都先校验必填。
// - 主机 CRUD 是独立资源（/api/hosts），与 settings 的单一 draft 解耦——每个操作立即落盘/生效。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  createHost as apiCreateHost,
  updateHost as apiUpdateHost,
  testHostSpec as apiTestHostSpec,
  getDshDevices,
} from '@/api/client';
import type { HostInfo } from '@/api/types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { settleHostSwitch } from '@/components/HostsDialog';

/** 传输方式：ssh 隧道 / dsh 远程通道。 */
type Transport = 'ssh' | 'dsh';

interface FormState {
  id: string;
  label: string;
  transport: Transport;
  // ssh
  host: string;
  user: string;
  port: string;
  remoteAgentLrayPort: string;
  identityFile: string;
  /** 私钥内容（PEM 原文）：编辑态空串=保留原密钥（不清除）。 */
  identityKey: string;
  /** 编辑态：是否显式清空已保存的私钥内容。 */
  clearIdentityKey: boolean;
  useAgent: boolean;
  // dsh
  deviceId: string;
  dshRemotePort: string;
}

const EMPTY_FORM: FormState = {
  id: '',
  label: '',
  transport: 'ssh',
  host: '',
  user: '',
  port: '',
  remoteAgentLrayPort: '3800',
  identityFile: '',
  identityKey: '',
  clearIdentityKey: false,
  useAgent: false,
  deviceId: '',
  dshRemotePort: '3800',
};

/** 组装提交 body。identityKey 语义：空串 + 编辑态保留 → 不传（后端保留原密钥）；
 *  编辑态勾选「清除」→ 传显式 ''（后端删除密文）。 */
function formToBody(f: FormState, editing: boolean) {
  if (f.transport === 'dsh') {
    return {
      label: f.label.trim() || f.id.trim(),
      type: 'dsh' as const,
      dsh: {
        deviceId: f.deviceId.trim(),
        remoteAgentLrayPort: f.dshRemotePort.trim() ? Number(f.dshRemotePort) : 3800,
      },
    };
  }
  const port = f.port.trim() ? Number(f.port) : null;
  const hasNewKey = f.identityKey.trim() !== '';
  return {
    label: f.label.trim() || f.id.trim(),
    type: 'ssh' as const,
    ssh: {
      host: f.host.trim(),
      user: f.user.trim() || '',
      port,
      remoteAgentLrayPort: f.remoteAgentLrayPort.trim() ? Number(f.remoteAgentLrayPort) : 3800,
      identityFile: f.identityFile.trim() || '',
      // 私钥内容原样透传（不 trim，保留 PEM 结构）。仅当输入了新内容或显式清除时
      // 才携带 identityKey；否则不传（后端保留既有密文，避免编辑留空误清密钥）。
      ...(hasNewKey
        ? { identityKey: f.identityKey }
        : editing && f.clearIdentityKey
          ? { identityKey: '' }
          : {}),
      useAgent: f.useAgent,
    },
  };
}

export function HostFormDialog({
  open,
  onOpenChange,
  editing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 非 null = 编辑该主机；null = 新建。 */
  editing: HostInfo | null;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  // 必填缺失标记：ssh→host / dsh→deviceId / 新建时 id。校验失败置 true 以红框提示。
  const [missing, setMissing] = useState<{ host?: boolean; deviceId?: boolean; id?: boolean }>({});

  // dsh 设备候选（中继服务器上当前账号可见的设备；本机已排除）。
  const devices = useQuery({
    queryKey: ['dsh-devices'],
    queryFn: getDshDevices,
    enabled: open && form.transport === 'dsh',
    retry: false,
  });

  // 打开时按 editing 初始化表单；关闭后清空。
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        id: editing.id,
        label: editing.label,
        transport: editing.type === 'dsh' ? 'dsh' : 'ssh',
        host: editing.ssh?.host ?? '',
        user: editing.ssh?.user ?? '',
        port: editing.ssh?.port ? String(editing.ssh.port) : '',
        remoteAgentLrayPort: editing.ssh?.remoteAgentLrayPort ? String(editing.ssh.remoteAgentLrayPort) : '3800',
        identityFile: editing.ssh?.identityFile ?? '',
        // 私钥内容只写不读：编辑态不预填（不可回显明文），空串=保留原密钥。
        identityKey: '',
        clearIdentityKey: false,
        useAgent: editing.ssh?.useAgent ?? false,
        deviceId: editing.dsh?.deviceId ?? '',
        dshRemotePort: editing.dsh?.remoteAgentLrayPort ? String(editing.dsh.remoteAgentLrayPort) : '3800',
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setMissing({});
  }, [open, editing]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hosts'] });

  const isAdd = editing === null;

  // 必填校验：ssh 需 host、dsh 需 deviceId；新建时 id 必填。返回是否通过。
  const validateRequired = (): boolean => {
    const miss: { host?: boolean; deviceId?: boolean; id?: boolean } = {};
    if (form.transport === 'dsh') {
      if (!form.deviceId.trim()) miss.deviceId = true;
    } else if (!form.host.trim()) {
      miss.host = true;
    }
    if (isAdd && !form.id.trim()) miss.id = true;
    setMissing(miss);
    return !miss.host && !miss.deviceId && !miss.id;
  };

  const createMut = useMutation({
    mutationFn: () => apiCreateHost({ ...formToBody(form, false), id: form.id.trim() }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      toast.success('主机已添加');
    },
    onError: (e) => toast.error(`添加失败：${(e as Error).message}`),
  });
  const updateMut = useMutation({
    mutationFn: () => apiUpdateHost(editing!.id, formToBody(form, true)),
    onSuccess: async (res) => {
      invalidate();
      onOpenChange(false);
      // 编辑的是当前查看的远端：后端 updateHost 已 closeHost 断隧道，但服务端
      // 配置已更新，store 记忆仍指向它 → 按新配置重连，再统一收尾（清 URL、回主页、
      // 整页刷新）。否则隧道已断而 UI 仍标 connected，数据面 502/503（评审问题 2）。
      if (res.id === useAppStore.getState().selectedHostId) {
        await useAppStore.getState().setSelectedHostId(res.id);
      }
      toast.success('主机已更新');
      settleHostSwitch();
    },
    onError: (e) => toast.error(`更新失败：${(e as Error).message}`),
  });
  // 测试连接：用当前表单未保存的配置建隧道→探测→关，不持久化、不影响当前选中主机。
  const testMut = useMutation({
    mutationFn: () => apiTestHostSpec({ ...formToBody(form, true), id: form.id.trim() || 'test' }),
    onSuccess: (res) => {
      if (res.ok) toast.success(`「${form.label.trim() || form.id.trim()}」连接成功`);
      else toast.error(`「${form.label.trim() || form.id.trim()}」连接失败：${res.error ?? '未知错误'}`);
    },
    onError: (e) => toast.error(`测试失败：${(e as Error).message}`),
  });

  const isWorking = createMut.isPending || updateMut.isPending || testMut.isPending;

  // 「选择文件导入私钥内容」：读取所选私钥文件内容填入 identityKey。
  // 失败 toast 提示，不阻塞表单。
  const onImportKeyFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => setForm({ ...form, identityKey: String(reader.result ?? '') });
    reader.onerror = () => toast.error('读取私钥文件失败');
    reader.readAsText(file);
  };

  const onSave = () => {
    if (!validateRequired()) return;
    if (editing) updateMut.mutate();
    else createMut.mutate();
  };
  const onTest = () => {
    if (!validateRequired()) return;
    testMut.mutate();
  };

  const deviceOptions = devices.data ?? [];

  return (
    <Dialog open={open} onOpenChange={(o) => !isWorking && onOpenChange(o)}>
      <DialogContent className="max-w-lg overflow-y-auto top-[6%] translate-y-0 max-h-[85vh] max-sm:w-[calc(100%-1.5rem)] max-sm:max-w-[calc(100%-1.5rem)] max-sm:p-4">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑主机 ${editing.id}` : '添加主机'}</DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <label className="space-y-1">
            <span className="text-xs text-muted-foreground">
              名称（label）<span className="text-destructive">*</span>
            </span>
            <Input value={form.label} placeholder="如：开发机 A" onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </label>
          {isAdd ? (
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">
                ID（唯一，字母/数字/连字符）<span className="text-destructive">*</span>
              </span>
              <Input
                value={form.id}
                className={cn(missing.id && 'border-destructive focus-visible:ring-destructive/50')}
                placeholder="如：devbox"
                onChange={(e) => setForm({ ...form, id: e.target.value })}
              />
              {missing.id ? <span className="text-[10px] text-destructive">ID 必填</span> : null}
            </label>
          ) : null}
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs text-muted-foreground">连接方式</span>
            <select
              value={form.transport}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
              onChange={(e) => setForm({ ...form, transport: e.target.value as Transport })}
            >
              <option value="ssh">ssh 隧道（ssh -L 端口转发）</option>
              <option value="dsh">dsh 远程通道（加密通道 + 中继服务器，免 ssh/免公网端口）</option>
            </select>
          </label>
          {form.transport === 'ssh' ? (
            <>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">
                  SSH 主机（host 别名或 hostname）<span className="text-destructive">*</span>
                </span>
                <Input
                  value={form.host}
                  className={cn(missing.host && 'border-destructive focus-visible:ring-destructive/50')}
                  placeholder="如：devbox 或 user@…"
                  onChange={(e) => setForm({ ...form, host: e.target.value })}
                />
                {missing.host ? <span className="text-[10px] text-destructive">SSH 主机必填</span> : null}
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">SSH 用户（可空，走 ssh 配置）</span>
                <Input value={form.user} placeholder="如：luobo" onChange={(e) => setForm({ ...form, user: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">SSH 端口（可空）</span>
                <Input type="number" min="1" max="65535" value={form.port} placeholder="22" onChange={(e) => setForm({ ...form, port: e.target.value })} />
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">远端 AgentLRay 端口</span>
                <Input type="number" min="1" max="65535" value={form.remoteAgentLrayPort} placeholder="3800" onChange={(e) => setForm({ ...form, remoteAgentLrayPort: e.target.value })} />
              </label>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-xs text-muted-foreground">私钥文件（identityFile，可空走 ssh-agent）</span>
                <Input value={form.identityFile} placeholder="如：~/.ssh/id_ed25519" onChange={(e) => setForm({ ...form, identityFile: e.target.value })} />
              </label>
              <div className="space-y-1 sm:col-span-2">
                <span className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    私钥内容（identityKey，非空则优先于上方文件；可留空）
                    {editing && editing.ssh?.hasIdentityKey && form.identityKey === '' && !form.clearIdentityKey ? (
                      <span className="ml-1 text-emerald-600">· 已保存，留空保持不变</span>
                    ) : null}
                  </span>
                  <label className="flex cursor-pointer items-center gap-1 text-xs text-primary hover:underline">
                    <input
                      type="file"
                      className="hidden"
                      accept=".pem,.key,id_rsa,id_ed25519"
                      onChange={(e) => onImportKeyFile(e.target.files?.[0])}
                    />
                    文件导入
                  </label>
                </span>
                <Textarea
                  value={form.identityKey}
                  rows={5}
                  placeholder={
                    editing?.ssh?.hasIdentityKey && !form.identityKey
                      ? '已保存私钥；粘贴新内容可替换，或勾选下方「清除私钥」移除'
                      : '粘贴私钥内容（-----BEGIN … PRIVATE KEY-----）…'
                  }
                  className="font-mono text-xs"
                  onChange={(e) => setForm({ ...form, identityKey: e.target.value })}
                />
                {editing && editing.ssh?.hasIdentityKey ? (
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={form.clearIdentityKey}
                      onChange={(e) => setForm({ ...form, clearIdentityKey: e.target.checked })}
                      className="h-3.5 w-3.5"
                    />
                    清除已保存的私钥内容（改用 ssh-agent / 文件）
                  </label>
                ) : null}
              </div>
              <label className="flex items-center gap-2 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={form.useAgent}
                  onChange={(e) => setForm({ ...form, useAgent: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                <span className="text-xs text-muted-foreground">使用 ssh-agent 转发（ForwardAgent）</span>
              </label>
            </>
          ) : (
            <>
              <label className="space-y-1 sm:col-span-2">
                <span className="text-xs text-muted-foreground">
                  目标设备（dsh）<span className="text-destructive">*</span>
                </span>
                {deviceOptions.length > 0 ? (
                  <select
                    value={form.deviceId}
                    className={cn(
                      'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs',
                      missing.deviceId && 'border-destructive'
                    )}
                    onChange={(e) => setForm({ ...form, deviceId: e.target.value })}
                  >
                    <option value="">选择设备…</option>
                    {deviceOptions.map((d) => (
                      <option key={d.deviceId} value={d.deviceId}>
                        {d.name}（{d.online ? '在线' : '离线'}）· {d.deviceId.slice(0, 8)}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    value={form.deviceId}
                    className={cn(missing.deviceId && 'border-destructive focus-visible:ring-destructive/50')}
                    placeholder="设备 id（中继服务器上的设备标识）"
                    onChange={(e) => setForm({ ...form, deviceId: e.target.value })}
                  />
                )}
                {missing.deviceId ? <span className="text-[10px] text-destructive">目标设备必填</span> : null}
                {devices.isError ? (
                  <span className="text-[10px] text-destructive">
                    设备列表拉取失败（{(devices.error as Error)?.message}）——可直接手填设备 id
                  </span>
                ) : null}
                {deviceOptions.length === 0 && !devices.isError ? (
                  <span className="text-[10px] text-muted-foreground">
                    暂无设备可选（需先在设置面板配置 dsh 账号，且目标机角色为 host）
                  </span>
                ) : null}
              </label>
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">远端 AgentLRay 端口</span>
                <Input type="number" min="1" max="65535" value={form.dshRemotePort} placeholder="3800" onChange={(e) => setForm({ ...form, dshRemotePort: e.target.value })} />
              </label>
              <div className="space-y-1 text-[10px] text-muted-foreground sm:col-span-2">
                dsh 目标经中继服务器转发，不填网络地址；远端端口需在目标机的 dsh 放行列表内
                （默认 3800）。
              </div>
            </>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:justify-end">
          <Button variant="outline" disabled={isWorking} onClick={() => onOpenChange(false)} className="sm:w-auto">
            取消
          </Button>
          <Button variant="outline" disabled={isWorking} onClick={onTest} className="sm:w-auto">
            {testMut.isPending ? '测试中…' : '测试连接'}
          </Button>
          <Button disabled={isWorking} onClick={onSave} className="sm:w-auto">
            {isWorking ? '保存中…' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
