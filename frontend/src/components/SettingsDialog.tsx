import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  getBackupStatus,
  getCliBins,
  getLlmSettings,
  getStatusConfig,
  runBackup,
  saveCliBins,
  saveLlmSettings,
  saveStatusConfig,
} from '@/api/client';
import type { DirSettings } from '@/api/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatBytes } from '@/lib/pure';
import { EMPTY_SETTINGS, useAppStore } from '@/store';

// 统一字段范式：每个配置项一行 label（htmlFor 关联）+ 输入框 + 小字 hint。
// 避免 label 与 hint 同排拥挤、placeholder 承担说明导致的对应关系混淆。
const DIR_FIELDS: { key: keyof DirSettings; label: string; placeholder: string; hint: string }[] = [
  { key: 'openclawDir', label: 'OpenClaw 会话目录', placeholder: '~/.openclaw/agents', hint: 'OpenClaw agent 的会话日志位置；留空用默认目录' },
  { key: 'codexDir', label: 'Codex 会话目录', placeholder: '~/.codex/sessions', hint: 'Codex 会话日志目录' },
  { key: 'claudeCodeDir', label: 'Claude Code 会话目录', placeholder: '~/.claude/projects', hint: 'Claude Code 项目会话目录' },
  { key: 'hermesDir', label: 'Hermes 数据目录', placeholder: '~/.hermes', hint: 'Hermes 数据目录' },
  { key: 'ompDir', label: 'OMP 会话目录', placeholder: '~/.omp/agent/sessions', hint: 'OMP（oh-my-pi）会话目录' },
  { key: 'dshDir', label: 'DeepSeek Harness 会话目录', placeholder: '~/.dsh/sessions', hint: 'DeepSeek Harness 会话目录（同时识别 DSH_HOME）' },
  { key: 'geminiDir', label: 'Gemini CLI 临时目录', placeholder: '~/.gemini/tmp', hint: 'Gemini CLI 项目临时目录' },
];

function BackupSection() {
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: ['backup-status'], queryFn: getBackupStatus });
  const backup = useMutation({
    mutationFn: runBackup,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['backup-status'] }),
  });

  const statusLine = status.data
    ? `归档目录 ${status.data.archiveDir} · 文件数 ${status.data.files} · 占用 ${formatBytes(status.data.bytes)} · 上次备份 ${
        status.data.lastBackup ? new Date(status.data.lastBackup).toLocaleString() : '从未'
      }`
    : '';
  const error = backup.error
    ? `备份失败: ${(backup.error as Error).message}`
    : status.error
      ? `备份状态获取失败: ${(status.error as Error).message}`
      : null;

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">
        会话备份（codex / claude-code / omp 增量归档）
      </label>
      <div className="flex items-center gap-2.5">
        <Button
          variant="outline"
          size="sm"
          disabled={backup.isPending}
          onClick={() => backup.mutate()}
        >
          {backup.isPending ? '备份中…' : '立即备份'}
        </Button>
        {backup.data && (
          <span className="text-xs text-muted-foreground">
            完成：新增 {backup.data.copied}，跳过 {backup.data.skipped}
          </span>
        )}
      </div>
      {statusLine && <div className="text-xs text-muted-foreground">{statusLine}</div>}
      {error && <div className="text-xs text-danger">{error}</div>}
    </div>
  );
}

// LLM 后端配置 (#14): OpenAI 兼容端点,存服务端 ~/.agentlray/llm.json。
// 显式配置优先于本机 claude CLI;两者都没有时 prompt 优化按钮会给出指引。
function LlmSection() {
  const queryClient = useQueryClient();
  const llm = useQuery({ queryKey: ['llm-settings'], queryFn: getLlmSettings });
  const [draft, setDraft] = useState<{ baseUrl: string; model: string; apiKey: string } | null>(null);
  const current = draft ?? {
    baseUrl: llm.data?.baseUrl ?? '',
    model: llm.data?.model ?? '',
    apiKey: '',
  };

  const save = useMutation({
    mutationFn: () =>
      saveLlmSettings({
        baseUrl: current.baseUrl.trim(),
        model: current.model.trim(),
        // Untouched key field keeps the stored key (undefined = keep)
        apiKey: draft && draft.apiKey !== '' ? draft.apiKey : current.baseUrl.trim() ? undefined : '',
      }),
    onSuccess: () => {
      setDraft(null);
      queryClient.invalidateQueries({ queryKey: ['llm-settings'] });
    },
  });

  return (
    <div className="space-y-2">
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="llm-baseurl">
          Base URL（OpenAI 兼容端点）
        </label>
        <Input
          id="llm-baseurl"
          placeholder="https://api.openai.com/v1 或 http://localhost:11434/v1"
          value={current.baseUrl}
          onChange={(e) => setDraft({ ...current, baseUrl: e.target.value })}
        />
        <p className="text-[11px] text-muted-foreground">留空 = 回退本机 claude CLI 探测；配置 OpenAI 兼容端点时必填</p>
      </div>
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="llm-model">
          模型名
        </label>
        <Input
          id="llm-model"
          placeholder="gpt-4o-mini / qwen2.5"
          value={current.model}
          onChange={(e) => setDraft({ ...current, model: e.target.value })}
        />
        <p className="text-[11px] text-muted-foreground">Base URL 已配置时模型名必填</p>
      </div>
      <div>
        <label className="text-xs text-muted-foreground" htmlFor="llm-apikey">
          API Key
        </label>
        <Input
          id="llm-apikey"
          type="password"
          placeholder={llm.data?.hasApiKey ? '已保存，留空保持不变' : '本地端点可留空'}
          value={current.apiKey}
          onChange={(e) => setDraft({ ...current, apiKey: e.target.value })}
        />
        <p className="text-[11px] text-muted-foreground">本地服务可留空；密钥只在服务端保存、不回显</p>
      </div>
      <div className="flex items-center gap-2.5 pt-1">
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? '保存中…' : '保存 LLM 配置'}
        </Button>
        {save.error && (
          <span className="text-xs text-danger">保存失败: {(save.error as Error).message}</span>
        )}
      </div>
    </div>
  );
}

// 平台 CLI 命令配置：resume 续跑时 spawn 的可执行命令，存服务端
// ~/.agentlray/cli-bins.json。解析优先级：环境变量 → 配置文件 → 默认命令名。
// 空串保存 = 清除该平台配置（回退默认命令名，如 nvm 安装的 claude 需填绝对路径）。
const CLI_BIN_FIELDS: { id: 'codex' | 'claude-code' | 'omp'; label: string; placeholder: string }[] = [
  { id: 'codex', label: 'Codex CLI 命令', placeholder: 'codex（默认）' },
  { id: 'claude-code', label: 'Claude Code CLI 命令', placeholder: 'claude（默认）' },
  { id: 'omp', label: 'OMP CLI 命令', placeholder: 'omp（默认）' },
];

function CliBinsSection() {
  const queryClient = useQueryClient();
  const cliBins = useQuery({ queryKey: ['cli-bins'], queryFn: getCliBins });
  // draft 为空串 = 未编辑；未编辑的字段在保存时跳过（保留原配置）。
  const [draft, setDraft] = useState<Partial<Record<'codex' | 'claude-code' | 'omp', string>>>({});
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => saveCliBins({ ...draft }),
    onSuccess: () => {
      setDraft({});
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ['cli-bins'] });
    },
  });

  const currentValue = (id: 'codex' | 'claude-code' | 'omp') =>
    draft[id] !== undefined ? draft[id]! : (cliBins.data?.[id]?.bin ?? '');

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">
        空 = 默认命令名；存服务端，终端与「复制恢复命令」按钮立即生效
      </label>
      {CLI_BIN_FIELDS.map((field) => (
        <div key={field.id} className="space-y-1">
          <label className="text-xs text-muted-foreground" htmlFor={`setting-clibin-${field.id}`}>
            {field.label}
            {cliBins.data?.[field.id]?.configured ? (
              <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
            ) : (
              <span className="ml-1 text-[10px] text-muted-foreground">
                默认：{cliBins.data?.[field.id]?.default ?? ''}
              </span>
            )}
          </label>
          <Input
            id={`setting-clibin-${field.id}`}
            value={currentValue(field.id)}
            placeholder={field.placeholder}
            onChange={(e) => setDraft({ ...draft, [field.id]: e.target.value })}
          />
        </div>
      ))}
      <div className="flex items-center gap-2.5">
        <Button
          variant="outline"
          size="sm"
          disabled={save.isPending || Object.keys(draft).length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中…' : '保存 CLI 命令'}
        </Button>
        {saved && <span className="text-xs text-muted-foreground">已保存</span>}
        {save.error && <span className="text-xs text-danger">保存失败: {(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

// 会话状态时间配置：存服务端 ~/.agentlray/status-config.json，保存即注入
// lib/status.js setStatusConfig，使各平台状态判定（awaiting-input / working /
// waiting / stopped）立即使用页面配置的时间窗口。UI 以分钟/小时输入，换算毫秒存储。
const STATUS_FIELDS: {
  key: 'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs';
  label: string;
  unit: 'min' | 'hour';
  placeholder: string;
  hint: string;
}[] = [
  {
    key: 'recentActivityMs',
    label: '最近活动新鲜度',
    unit: 'min',
    placeholder: '2',
    hint: '回合完成 / 无进行中证据的短鲜度内判 working；建议 1–10 分钟',
  },
  {
    key: 'activeWorkCeilMs',
    label: '进行中工作上界',
    unit: 'min',
    placeholder: '30',
    hint: '长工具执行 / 深思考在界内一律 working，超过才降级；覆盖常见长任务',
  },
  {
    key: 'historyCeilMs',
    label: '取证闭口窗口',
    unit: 'hour',
    placeholder: '12',
    hint: '无结束标记会话证据超过此界判 stopped；awaiting-input / waiting 的上界',
  },
];

const UNIT_MS = { min: 60_000, hour: 3_600_000 };

function StatusConfigSection() {
  const queryClient = useQueryClient();
  const statusCfg = useQuery({ queryKey: ['status-config'], queryFn: getStatusConfig });
  // draft 为 null = 未编辑；编辑时存各 key 输入值（字符串，便于清空）。
  const [draft, setDraft] = useState<Partial<Record<'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', string>>>({});
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const body: Partial<Record<'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', number>> = {};
      for (const field of STATUS_FIELDS) {
        const raw = draft[field.key];
        if (raw !== undefined && raw.trim() !== '') {
          const n = Number(raw.trim());
          if (Number.isFinite(n) && n > 0) body[field.key] = Math.round(n * UNIT_MS[field.unit]);
          // 非法输入忽略该 key（保留原值）
        }
      }
      return saveStatusConfig(body);
    },
    onSuccess: () => {
      setDraft({});
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ['status-config'] });
    },
  });

  // 当前展示值：draft 优先，否则从已配置/默认的毫秒换算回输入单位。
  const displayValue = (key: 'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', unit: 'min' | 'hour') => {
    if (draft[key] !== undefined) return draft[key]!;
    const ms = statusCfg.data?.[key]?.value;
    return ms ? String(Math.round(ms / UNIT_MS[unit])) : '';
  };

  return (
    <div className="space-y-1.5">
      <label className="text-xs text-muted-foreground">
        状态判定时间窗口（单位：分钟 / 小时；保存即对后续状态判定生效）
      </label>
      {STATUS_FIELDS.map((field) => (
        <div key={field.key} className="space-y-1">
          <div className="flex items-baseline justify-between gap-2">
            <label className="text-xs text-muted-foreground" htmlFor={`setting-status-${field.key}`}>
              {field.label}（{field.unit === 'min' ? '分钟' : '小时'}）
              {statusCfg.data?.[field.key]?.configured ? (
                <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
              ) : (
                <span className="ml-1 text-[10px] text-muted-foreground">
                  默认：{statusCfg.data?.[field.key]?.default ? Math.round(statusCfg.data[field.key]!.default / UNIT_MS[field.unit]) : ''}
                  {field.unit === 'min' ? ' 分钟' : ' 小时'}
                </span>
              )}
            </label>
          </div>
          <Input
            id={`setting-status-${field.key}`}
            type="number"
            min="1"
            value={displayValue(field.key, field.unit)}
            placeholder={field.placeholder}
            onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">{field.hint}</p>
        </div>
      ))}
      <div className="flex items-center gap-2.5 pt-1">
        <Button
          variant="outline"
          size="sm"
          disabled={save.isPending || Object.keys(draft).length === 0}
          onClick={() => save.mutate()}
        >
          {save.isPending ? '保存中…' : '保存状态配置'}
        </Button>
        {saved && <span className="text-xs text-muted-foreground">已保存</span>}
        {save.error && <span className="text-xs text-danger">保存失败: {(save.error as Error).message}</span>}
      </div>
    </div>
  );
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<DirSettings>(settings);
  // 复用 ['llm-settings'] 缓存（LlmSection 同 key），不重复请求。
  const llm = useQuery({ queryKey: ['llm-settings'], queryFn: getLlmSettings });
  const llmBackendText = () =>
    llm.data?.backend === 'openai'
      ? `OpenAI 兼容端点（${llm.data.model}）`
      : llm.data?.backend === 'claude-cli'
        ? '本机 claude CLI'
        : '未配置';

  // Re-seed the draft from the store every time the dialog opens (legacy openSettings()).
  const handleOpenChange = (next: boolean) => {
    if (next) setDraft(useAppStore.getState().settings);
    onOpenChange(next);
  };

  const save = () => {
    saveSettings({
      openclawDir: draft.openclawDir.trim(),
      codexDir: draft.codexDir.trim(),
      claudeCodeDir: draft.claudeCodeDir.trim(),
      hermesDir: draft.hermesDir.trim(),
      ompDir: draft.ompDir.trim(),
      dshDir: draft.dshDir.trim(),
      geminiDir: draft.geminiDir.trim(),
    });
    onOpenChange(false);
    // Legacy refreshAll(false): every dir-dependent query must refetch.
    queryClient.invalidateQueries();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="dirs">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="dirs">数据目录</TabsTrigger>
            <TabsTrigger value="llm">LLM 接口</TabsTrigger>
            <TabsTrigger value="clibins">平台 CLI 命令</TabsTrigger>
            <TabsTrigger value="status">状态时间配置</TabsTrigger>
            <TabsTrigger value="backup">会话备份</TabsTrigger>
          </TabsList>

          <TabsContent value="dirs" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              各平台会话日志的存储位置；留空使用默认目录。保存到 localStorage，无需重启。
            </p>
            {DIR_FIELDS.map((field) => (
              <div key={field.key} className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`setting-${field.key}`}>
                  {field.label}
                </label>
                <Input
                  id={`setting-${field.key}`}
                  value={draft[field.key]}
                  placeholder={field.placeholder}
                  onChange={(e) => setDraft({ ...draft, [field.key]: e.target.value })}
                />
                <p className="text-[11px] text-muted-foreground">{field.hint}</p>
              </div>
            ))}
          </TabsContent>

          <TabsContent value="llm" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              prompt 优化 / 聚类建议 / 命名建议的后端；留空 Base URL = 回退本机 claude CLI 探测。
              当前后端：{llmBackendText()}
            </p>
            <LlmSection />
          </TabsContent>

          <TabsContent value="clibins" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              resume 续跑 spawn 的可执行命令；留空 = 默认命令名。解析优先级：环境变量 &gt; 此处 &gt; 默认名。
            </p>
            <CliBinsSection />
          </TabsContent>

          <TabsContent value="status" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              会话四态（awaiting-input / working / waiting / stopped）的判定时间窗口；保存即对后续状态判定生效。
            </p>
            <StatusConfigSection />
          </TabsContent>

          <TabsContent value="backup" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              把 codex / claude-code / omp 会话日志增量归档到 ~/.agentlray/archive。
            </p>
            <BackupSection />
          </TabsContent>
        </Tabs>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={() => setDraft({ ...EMPTY_SETTINGS })}>
            Reset to Defaults
          </Button>
          <Button onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
