// 主机「新建 / 编辑」弹框：从主机设置弹框独立出来，默认隐藏。
// - 添加（editing=null）或编辑（editing=某 HostInfo）时打开。
// - 底部三按钮：取消（直接关）、测试连接（用当前表单信息建隧道探测）、保存（持久化）。
// - 必填校验：host 恒必填；新建时 id 必填。测试连接与保存都先校验必填，未填不放行。
// - 主机 CRUD 是独立资源（/api/hosts），与 settings 的单一 draft 解耦——每个操作立即落盘/生效。
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  createHost as apiCreateHost,
  updateHost as apiUpdateHost,
  testHostSpec as apiTestHostSpec,
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
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { settleHostSwitch } from '@/components/HostsDialog';

interface FormState {
  id: string;
  label: string;
  host: string;
  user: string;
  port: string;
  remoteAgentLrayPort: string;
  identityFile: string;
  useAgent: boolean;
}

const EMPTY_FORM: FormState = {
  id: '',
  label: '',
  host: '',
  user: '',
  port: '',
  remoteAgentLrayPort: '3800',
  identityFile: '',
  useAgent: false,
};

function formToBody(f: FormState) {
  const port = f.port.trim() ? Number(f.port) : null;
  return {
    label: f.label.trim() || f.id.trim(),
    type: 'ssh' as const,
    ssh: {
      host: f.host.trim(),
      user: f.user.trim() || '',
      port,
      remoteAgentLrayPort: f.remoteAgentLrayPort.trim() ? Number(f.remoteAgentLrayPort) : 3800,
      identityFile: f.identityFile.trim() || '',
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
  // 必填缺失标记：host / id（新建时）。校验失败置 true 以红框提示。
  const [missing, setMissing] = useState<{ host?: boolean; id?: boolean }>({});

  // 打开时按 editing 初始化表单；关闭后清空。
  useEffect(() => {
    if (!open) return;
    if (editing) {
      setForm({
        id: editing.id,
        label: editing.label,
        host: editing.ssh?.host ?? '',
        user: editing.ssh?.user ?? '',
        port: editing.ssh?.port ? String(editing.ssh.port) : '',
        remoteAgentLrayPort: editing.ssh?.remoteAgentLrayPort ? String(editing.ssh.remoteAgentLrayPort) : '3800',
        identityFile: editing.ssh?.identityFile ?? '',
        useAgent: editing.ssh?.useAgent ?? false,
      });
    } else {
      setForm(EMPTY_FORM);
    }
    setMissing({});
  }, [open, editing]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hosts'] });

  const isAdd = editing === null;

  // 必填校验：host 恒必填；新建时 id 必填。返回是否通过。
  const validateRequired = (): boolean => {
    const miss: { host?: boolean; id?: boolean } = {};
    if (!form.host.trim()) miss.host = true;
    if (isAdd && !form.id.trim()) miss.id = true;
    setMissing(miss);
    return !miss.host && !miss.id;
  };

  const createMut = useMutation({
    mutationFn: () => apiCreateHost({ ...formToBody(form), id: form.id.trim() }),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      toast.success('主机已添加');
    },
    onError: (e) => toast.error(`添加失败：${(e as Error).message}`),
  });
  const updateMut = useMutation({
    mutationFn: () => apiUpdateHost(editing!.id, formToBody(form)),
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
    mutationFn: () => apiTestHostSpec({ ...formToBody(form), id: form.id.trim() || 'test' }),
    onSuccess: (res) => {
      if (res.ok) toast.success(`「${form.label.trim() || form.id.trim()}」连接成功`);
      else toast.error(`「${form.label.trim() || form.id.trim()}」连接失败：${res.error ?? '未知错误'}`);
    },
    onError: (e) => toast.error(`测试失败：${(e as Error).message}`),
  });

  const isWorking = createMut.isPending || updateMut.isPending || testMut.isPending;

  const onSave = () => {
    if (!validateRequired()) return;
    if (editing) updateMut.mutate();
    else createMut.mutate();
  };
  const onTest = () => {
    if (!validateRequired()) return;
    testMut.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !isWorking && onOpenChange(o)}>
      <DialogContent className="max-w-lg overflow-y-auto top-[6%] translate-y-0 md:max-h-[85vh]">
        <DialogHeader>
          <DialogTitle>{editing ? `编辑主机 ${editing.id}` : '添加主机'}</DialogTitle>
        </DialogHeader>

        <div className="grid gap-2 md:grid-cols-2">
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
          <label className="space-y-1 md:col-span-2">
            <span className="text-xs text-muted-foreground">私钥文件（identityFile，可空走 ssh-agent）</span>
            <Input value={form.identityFile} placeholder="如：~/.ssh/id_ed25519" onChange={(e) => setForm({ ...form, identityFile: e.target.value })} />
          </label>
          <label className="flex items-center gap-2 md:col-span-2">
            <input
              type="checkbox"
              checked={form.useAgent}
              onChange={(e) => setForm({ ...form, useAgent: e.target.checked })}
              className="h-3.5 w-3.5"
            />
            <span className="text-xs text-muted-foreground">使用 ssh-agent 转发（ForwardAgent）</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" disabled={isWorking} onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="outline" disabled={isWorking} onClick={onTest}>
            {testMut.isPending ? '测试中…' : '测试连接'}
          </Button>
          <Button disabled={isWorking} onClick={onSave}>
            {isWorking ? '保存中…' : '保存'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
