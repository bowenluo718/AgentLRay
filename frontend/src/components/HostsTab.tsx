// 设置面板「主机」tab（multi-host）：列出已保存主机（含 local 内建）、添加/编辑/删除、
// 「测试连接」按钮。主机 CRUD 是独立资源（/api/hosts），与 settings 的单一 draft 解耦
// ——每个操作立即落盘/生效，不随底部 Save 提交。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import {
  getHosts,
  createHost as apiCreateHost,
  updateHost as apiUpdateHost,
  deleteHost as apiDeleteHost,
  testHost as apiTestHost,
} from '@/api/client';
import type { HostInfo, HostStatus } from '@/api/types';
import { HOST_STATUS_DOT, HOST_STATUS_LABEL } from '@/lib/host-status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

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

function StatusBadge({ status, error }: { status: HostStatus; error: string | null }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={cn('h-2 w-2 rounded-full', HOST_STATUS_DOT[status] ?? HOST_STATUS_DOT.disconnected)} />
      <span className="text-[11px] text-muted-foreground">{HOST_STATUS_LABEL[status] ?? status}</span>
      {status === 'error' && error ? (
        <span className="max-w-[12rem] truncate text-[10px] text-destructive" title={error}>
          {error}
        </span>
      ) : null}
    </span>
  );
}

export function HostsTab() {
  const queryClient = useQueryClient();
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: getHosts });
  // 编辑态：editing 非 null 时表单填充该主机的 ssh 配置。
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['hosts'] });

  const createMut = useMutation({
    mutationFn: () => apiCreateHost({ ...formToBody(form), id: form.id.trim() }),
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_FORM);
      setEditing(null);
      toast.success('主机已添加');
    },
    onError: (e) => toast.error(`添加失败：${(e as Error).message}`),
  });
  const updateMut = useMutation({
    mutationFn: () => apiUpdateHost(editing!, formToBody(form)),
    onSuccess: () => {
      invalidate();
      setForm(EMPTY_FORM);
      setEditing(null);
      toast.success('主机已更新');
    },
    onError: (e) => toast.error(`更新失败：${(e as Error).message}`),
  });
  const deleteMut = useMutation({
    mutationFn: (id: string) => apiDeleteHost(id),
    onSuccess: () => {
      invalidate();
      toast.success('主机已删除');
    },
    onError: (e) => toast.error(`删除失败：${(e as Error).message}`),
  });
  // 测试连接缓存 key：test 中的主机 spinner。
  const testMut = useMutation({
    mutationFn: (id: string) => apiTestHost(id),
    onSuccess: (res, id) => {
      invalidate();
      if (res.ok) toast.success(`「${id}」连接成功`);
      else toast.error(`「${id}」连接失败：${res.error ?? '未知错误'}`);
    },
    onError: (e) => toast.error(`测试失败：${(e as Error).message}`),
  });

  const startEdit = (h: HostInfo) => {
    setEditing(h.id);
    setForm({
      id: h.id,
      label: h.label,
      host: h.ssh?.host ?? '',
      user: h.ssh?.user ?? '',
      port: h.ssh?.port ? String(h.ssh.port) : '',
      remoteAgentLrayPort: h.ssh?.remoteAgentLrayPort ? String(h.ssh.remoteAgentLrayPort) : '3800',
      identityFile: h.ssh?.identityFile ?? '',
      useAgent: h.ssh?.useAgent ?? false,
    });
  };

  const cancelEdit = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
  };

  const data = hosts.data ?? [];
  const isWorking = createMut.isPending || updateMut.isPending;

  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">主机</h3>
        <p className="text-xs text-muted-foreground">
          连接其他主机上运行的 AgentLRay 服务（远端读取其会话数据，解析在远端；设置除外）。
          <span className="font-medium">本机（local）</span>恒在内建列表。远端经系统 ssh
          本地端口转发触达，凭据/指纹全走你的 ssh 配置，本服务零存密。
        </p>
      </div>

      <div className="space-y-2">
        {data.map((h) => (
          <div key={h.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{h.id === 'local' ? '本机' : (h.label || h.id)}</span>
                <span className="rounded px-1 text-[10px] text-muted-foreground">{h.id}</span>
                <StatusBadge status={h.status} error={h.error} />
              </div>
              {h.ssh ? (
                <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
                  {h.ssh.user ? `${h.ssh.user}@` : ''}
                  {h.ssh.host}
                  {h.ssh.port ? `:${h.ssh.port}` : ''} → 127.0.0.1:{h.ssh.remoteAgentLrayPort}
                </div>
              ) : (
                <div className="mt-0.5 text-[11px] text-muted-foreground">直连本机 3800（不建隧道）</div>
              )}
            </div>
            {h.id !== 'local' ? (
              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={testMut.isPending && testMut.variables === h.id}
                  onClick={() => testMut.mutate(h.id)}
                  title="立即建隧道并探测远端 /api/version"
                >
                  {testMut.isPending && testMut.variables === h.id ? '测试中…' : '测试连接'}
                </Button>
                <Button variant="outline" size="sm" onClick={() => startEdit(h)}>
                  编辑
                </Button>
                <Button variant="destructive" size="sm" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate(h.id)}>
                  删除
                </Button>
              </div>
            ) : (
              <span className="shrink-0 text-[11px] text-muted-foreground">恒连接</span>
            )}
          </div>
        ))}
      </div>

      {/* 添加 / 编辑表单（缺省即「添加」；编辑某主机时切换到编辑态） */}
      <form
        className="space-y-2 rounded-md border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (editing !== null) updateMut.mutate();
            else createMut.mutate();
          }}
        >
          <h4 className="text-sm font-medium">{editing !== null ? `编辑主机 ${editing}` : '添加主机'}</h4>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">名称（label）</span>
              <Input value={form.label} placeholder="如：开发机 A" onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </label>
            {editing === null ? (
              <label className="space-y-1">
                <span className="text-xs text-muted-foreground">ID（唯一，字母/数字/连字符）</span>
                <Input value={form.id} placeholder="如：devbox" onChange={(e) => setForm({ ...form, id: e.target.value })} />
              </label>
            ) : null}
            <label className="space-y-1">
              <span className="text-xs text-muted-foreground">SSH 主机（host 别名或 hostname）</span>
              <Input value={form.host} required placeholder="如：devbox 或 user@…" onChange={(e) => setForm({ ...form, host: e.target.value })} />
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
          <div className="flex justify-end gap-2 pt-1">
            {editing !== null ? (
              <Button type="button" variant="outline" onClick={cancelEdit}>
                取消
              </Button>
            ) : null}
            <Button type="submit" disabled={isWorking}>
              {isWorking ? '保存中…' : editing !== null ? '保存修改' : '添加主机'}
            </Button>
          </div>
      </form>
    </section>
  );
}
