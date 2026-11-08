import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getBackupStatus,
  getSettings,
  runBackup,
  saveSettings as apiSaveSettings,
  setPlatformMounted,
  setPlatformReplaced,
} from '@/api/client';
import type { DirSettings, SettingsPatch } from '@/api/client';
import type { PlatformInfo } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { toast } from 'sonner';
import { formatBytes } from '@/lib/pure';
import { EMPTY_SETTINGS, selectablePlatforms, useAppStore } from '@/store';

// 统一字段范式：每个配置项一行 label（htmlFor 关联）+ 输入框 + 小字 hint。
// 避免 label 与 hint 同排拥挤、placeholder 承担说明导致的对应关系混淆。
// 数据目录 tab 遍历运行时平台列表：只渲染「已挂载且 dirSettingKey 非空」的平台
// （dirSettingLabel/Hint 由服务端 PlatformInfo 下发，自定义平台若声明 dirSettingKey
// 同样可配；未声明的平台目录由适配器 defaultDir 决定，不展示输入行）。

// 会话状态时间配置：存服务端 ~/.agentlray/settings.json 的 status section，
// 保存即注入 lib/status.js setStatusConfig，使各平台状态判定立即使用新窗口。
// UI 以分钟/小时输入，换算毫秒存储。
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

type StatusKey = 'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs';
type SectionKey = 'llm' | 'cliBins' | 'status' | 'kanban';

// 全对话框单一 draft：所有 tab 的待保存输入。服务器 section 的「空串 = 回默认」。
interface Draft {
  dirs: DirSettings;
  llm: { baseUrl: string; model: string; apiKey: string; analysisTimeoutMs: string };
  cliBins: Partial<Record<string, string>>;
  status: Partial<Record<StatusKey, string>>;
  kanban: string;
}

function emptyDraft(): Draft {
  return {
    dirs: { ...EMPTY_SETTINGS },
    llm: { baseUrl: '', model: '', apiKey: '', analysisTimeoutMs: '' },
    cliBins: {},
    status: {},
    kanban: '',
  };
}

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
        会话备份（codex / claude-code / omp / dsh / gemini 增量归档）
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

/** 平台管理 tab：遍历 /api/platforms（含未挂载/broken），展示来源、创建来源、挂载态、
 *  启停 toggle（写服务端 platforms 配置并失效 ['platforms']），重启生效标注。不参与统一 draft。 */
function PlatformSection() {
  const platforms = useAppStore((s) => s.platforms);
  const queryClient = useQueryClient();
  const applyPlatformMutation = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['platforms'] });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (e: Error) => toast.error(`平台配置失败: ${e.message}`),
  });

  const toggleMounted = (id: string, target: boolean) =>
    applyPlatformMutation.mutate(() => setPlatformMounted(id, target));
  const toggleReplaced = (id: string, target: boolean) =>
    applyPlatformMutation.mutate(() => setPlatformReplaced(id, target));

  const mountStatus = (p: PlatformInfo) => {
    if (p.replacementPending)
      return <span className="ml-1 text-[10px] text-amber-500">替代待生效</span>;
    if (p.restartRequired)
      return <span className="ml-1 text-[10px] text-amber-500">重启生效</span>;
    return null;
  };

  return (
    <div className="space-y-1.5">
      <p className="text-xs text-muted-foreground">
        平台注册表（服务端 GET /api/platforms 单一真源）。可停用平台以从查询/分析面隐藏；
        broken 平台需修复适配器或移除声明。包内置换需目标适配器可用。
      </p>
      {platforms.map((p) => {
        const originLabel = p.origin === 'project' ? '项目' : p.origin === 'user' ? '用户' : '内置';
        const canMount = p.id != null && !p.broken;
        return (
          <div
            key={p.id ?? 'unknown'}
            className="flex items-center justify-between gap-2 rounded border border-border px-3 py-2"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm">{p.label ?? p.id}</span>
                {p.id != null ? (
                  <span
                    className="rounded px-1 text-[10px]"
                    style={{
                      color: p.color ?? 'var(--muted-foreground)',
                      border: `1px solid ${p.color ?? 'var(--border)'}55`,
                    }}
                  >
                    {p.id}
                  </span>
                ) : null}
                <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{originLabel}</span>
                {p.builtin ? (
                  <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">包内置</span>
                ) : null}
                {mountStatus(p)}
              </div>
              {p.broken && p.error ? (
                <p className="mt-0.5 break-all text-[11px] text-destructive">{p.error}</p>
              ) : null}
              {!p.broken ? (
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                  {p.dirSettingHint ??
                    `已挂载${p.capabilities.spawn ? ' · 支持 spawn' : ''}`}
                </p>
              ) : null}
            </div>
            {canMount ? (
              <div className="flex shrink-0 items-center gap-2">
                {p.builtin ? (
                  <Button
                    variant="outline"
                    size="sm"
                    title="包内置与其他来源同 id 适配器间的启用/停用（替代）"
                    onClick={() => toggleReplaced(p.id as string, true)}
                  >
                    置换
                  </Button>
                ) : null}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={applyPlatformMutation.isPending}
                  onClick={() => toggleMounted(p.id as string, !p.mounted)}
                >
                  {p.mounted ? '停用' : '启用'}
                </Button>
              </div>
            ) : (
              <span className="shrink-0 text-[10px] text-muted-foreground">不可配置</span>
            )}
          </div>
        );
      })}
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
  const saveDirSettings = useAppStore((s) => s.saveSettings);
  const platforms = useAppStore((s) => s.platforms);
  const queryClient = useQueryClient();
  // 单一 GET /api/settings：一次读齐 cliBins / status / kanban / llm。
  const all = useQuery({ queryKey: ['settings'], queryFn: getSettings });

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // 服务器 section 的脏标记：保存时只提交已编辑的 section，未触碰的保持服务器原值。
  const [touched, setTouched] = useState<Record<SectionKey, boolean>>({
    llm: false,
    cliBins: false,
    status: false,
    kanban: false,
  });
  // 打开后仅在 settings 数据首次就绪时种 draft（此后编辑不被打断）。
  const seeded = useRef(false);

  // 数据目录 tab 行：遍历已挂载且声明了目录键（dirSettingKey）的可查询平台。
  const dirRows = useMemo(
    () =>
      selectablePlatforms(platforms)
        .filter((p) => p.dirSettingKey)
        .map((p) => ({ key: p.dirSettingKey as string, label: p.dirSettingLabel ?? p.label ?? p.id, hint: p.dirSettingHint })),
    [platforms]
  );
  // resume 续跑配套行：服务端已置位 resume 的平台（含内置与自定义适配器 resume opt-in）。
  const binsRows = useMemo(
    () =>
      selectablePlatforms(platforms)
        .filter((p) => p.resume)
        .map((p) => ({ id: p.id, label: p.label ?? p.id, custom: !p.builtin })),
    [platforms]
  );

  const llmBackendText = () => {
    const llm = all.data?.llm;
    return llm?.backend === 'openai'
      ? `OpenAI 兼容端点（${llm.model}）`
      : llm?.backend === 'claude-cli'
        ? '本机 claude CLI'
        : '未配置';
  };

  function seedDraft() {
    const settings = useAppStore.getState().settings;
    setDraft({
      dirs: { ...settings },
      llm: {
        baseUrl: all.data?.llm.baseUrl ?? '',
        model: all.data?.llm.model ?? '',
        apiKey: '',
        analysisTimeoutMs: all.data?.llm.analysisTimeoutMs
          ? String(Math.round(all.data.llm.analysisTimeoutMs / 60_000))
          : '',
      },
      cliBins: {},
      status: {},
      kanban: '',
    });
    setTouched({ llm: false, cliBins: false, status: false, kanban: false });
  }

  function handleOpenChange(next: boolean) {
    if (next) {
      seeded.current = false;
      if (all.data) seedDraft();
    }
    onOpenChange(next);
  }

  // 对话框打开但 settings 数据未就绪时，数据到达后补种一次（防表单闪现空值）。
  useEffect(() => {
    if (open && all.data && !seeded.current) {
      seeded.current = true;
      seedDraft();
    }
  }, [open, all.data]);

  const touch = (section: SectionKey) => setTouched((t) => ({ ...t, [section]: true }));

  // ---- 展示值：draft 优先，否则回退服务端当前值 ----
  const cliBinValue = (id: string) =>
    draft.cliBins[id] !== undefined ? draft.cliBins[id]! : (all.data?.cliBins?.[id]?.bin ?? '');

  const statusDisplay = (key: StatusKey, unit: 'min' | 'hour') => {
    if (draft.status[key] !== undefined) return draft.status[key]!;
    const ms = all.data?.status[key]?.value;
    return ms ? String(Math.round(ms / UNIT_MS[unit])) : '';
  };

  const kanbanDisplay = () =>
    draft.kanban !== '' ? draft.kanban : String(all.data?.kanban?.maxPerStatus?.value ?? 20);

  // ---- 保存：数据目录始终写 localStorage；服务器 section 只提交已编辑项 ----
  const saveMutation = useMutation({
    mutationFn: apiSaveSettings,
    onSuccess: () => {
      onOpenChange(false);
      // 与旧行为一致：目录依赖 + 设置相关查询全部失效重拉。
      queryClient.invalidateQueries();
    },
  });

  function buildPatch(): SettingsPatch {
    const patch: SettingsPatch = {};
    if (touched.cliBins) patch.cliBins = { ...draft.cliBins };
    if (touched.status) {
      const status: NonNullable<SettingsPatch['status']> = {};
      for (const field of STATUS_FIELDS) {
        const raw = draft.status[field.key];
        let ms: number | undefined;
        if (raw !== undefined) {
          const n = Number(raw.trim());
          if (Number.isFinite(n) && n > 0) ms = Math.round(n * UNIT_MS[field.unit]);
          // 空/非法输入 = 清除该 key（回退默认）
        } else {
          // 未编辑的字段沿用当前已配置值，避免保存时被误清。
          ms = all.data?.status[field.key]?.value;
        }
        if (ms !== undefined) status[field.key] = ms;
      }
      patch.status = status;
    }
    if (touched.kanban) {
      const raw = draft.kanban.trim();
      const n = Number(raw);
      patch.kanban = Number.isInteger(n) && n > 0 ? { maxPerStatus: n } : {};
    }
    if (touched.llm) {
      const baseUrl = draft.llm.baseUrl.trim();
      const timeoutRaw = draft.llm.analysisTimeoutMs.trim();
      // 分钟→毫秒；空/非法 = 0 → 服务端清除该键回默认。
      let analysisTimeoutMs = 0;
      if (timeoutRaw !== '') {
        const n = Number(timeoutRaw);
        if (Number.isFinite(n) && n > 0) analysisTimeoutMs = Math.round(n * 60_000);
      }
      patch.llm = {
        baseUrl,
        model: draft.llm.model.trim(),
        // apiKey 语义：非空 = 替换；空时 baseUrl 非空 = 保留服务器密钥，baseUrl 空 = 清除。
        apiKey: draft.llm.apiKey !== '' ? draft.llm.apiKey : baseUrl ? undefined : '',
        analysisTimeoutMs,
      };
    }
    return patch;
  }

  const save = () => {
    // 目录设置宽度为 Record<string, string>：把草稿里非空值全量写入（trim）。
    const d: DirSettings = {};
    for (const [key, value] of Object.entries(draft.dirs)) {
      if (typeof value === 'string' && value.trim() !== '') d[key] = value.trim();
    }
    saveDirSettings(d);
    saveMutation.mutate(buildPatch());
  };

  // 恢复默认到表单（须再点 Save 才落盘）：数据目录清空、服务器字段留空 = 回默认。
  const reset = () => {
    setDraft({
      dirs: { ...EMPTY_SETTINGS },
      llm: { baseUrl: '', model: '', apiKey: '', analysisTimeoutMs: '' },
      cliBins: Object.fromEntries(binsRows.map((r) => [r.id, ''])),
      status: Object.fromEntries(STATUS_FIELDS.map((f) => [f.key, ''])),
      kanban: '',
    });
    setTouched({ llm: true, cliBins: true, status: true, kanban: true });
  };

  const statusFieldBadge = (field: (typeof STATUS_FIELDS)[number]) =>
    all.data?.status[field.key]?.configured ? (
      <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
    ) : (
      <span className="ml-1 text-[10px] text-muted-foreground">
        默认：{all.data?.status[field.key]?.default ? Math.round(all.data.status[field.key]!.default / UNIT_MS[field.unit]) : ''}
        {field.unit === 'min' ? ' 分钟' : ' 小时'}
      </span>
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl overflow-y-auto md:max-h-[85vh] max-md:max-w-none max-md:w-[calc(100vw-2rem)] max-md:max-h-[calc(100dvh-2rem)] max-md:rounded-2xl max-md:p-4 max-md:gap-3 max-md:grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="dirs">
          <TabsList className="w-full min-w-0 justify-start overflow-x-auto">
            <TabsTrigger className="shrink-0" value="dirs">数据目录</TabsTrigger>
            <TabsTrigger className="shrink-0" value="platforms">平台</TabsTrigger>
            <TabsTrigger className="shrink-0" value="llm">LLM 接口</TabsTrigger>
            <TabsTrigger className="shrink-0" value="clibins">平台 CLI 命令</TabsTrigger>
            <TabsTrigger className="shrink-0" value="status">状态时间配置</TabsTrigger>
            <TabsTrigger className="shrink-0" value="kanban">任务看板</TabsTrigger>
            <TabsTrigger className="shrink-0" value="backup">会话备份</TabsTrigger>
          </TabsList>

          <TabsContent value="platforms" className="space-y-3">
            <PlatformSection />
          </TabsContent>

          <TabsContent value="dirs" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              各平台会话日志的存储位置；留空使用默认目录。保存到 localStorage，无需重启。未在此展示
              （未声明目录键）的平台目录由适配器 defaultDir() 决定，查询参数 ?dir= 可覆盖。
            </p>
            {dirRows.map((row) => (
              <div key={row.key} className="space-y-1">
                <label className="text-xs font-medium" htmlFor={`setting-${row.key}`}>
                  {row.label}
                </label>
                <Input
                  id={`setting-${row.key}`}
                  value={draft.dirs[row.key] ?? ''}
                  placeholder={row.label}
                  onChange={(e) => setDraft((d) => ({ ...d, dirs: { ...d.dirs, [row.key]: e.target.value } }))}
                />
                {row.hint ? <p className="text-[11px] text-muted-foreground">{row.hint}</p> : null}
              </div>
            ))}
          </TabsContent>

          <TabsContent value="llm" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              prompt 优化 / 聚类建议 / 命名建议的后端；留空 Base URL = 回退本机 claude CLI 探测。
              当前后端：{llmBackendText()}
            </p>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-muted-foreground" htmlFor="llm-baseurl">
                  Base URL（OpenAI 兼容端点）
                </label>
                <Input
                  id="llm-baseurl"
                  placeholder="https://api.openai.com/v1 或 http://localhost:11434/v1"
                  value={draft.llm.baseUrl}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, llm: { ...d.llm, baseUrl: e.target.value } }));
                    touch('llm');
                  }}
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
                  value={draft.llm.model}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, llm: { ...d.llm, model: e.target.value } }));
                    touch('llm');
                  }}
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
                  placeholder={all.data?.llm.hasApiKey ? '已保存，留空保持不变' : '本地端点可留空'}
                  value={draft.llm.apiKey}
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, llm: { ...d.llm, apiKey: e.target.value } }));
                    touch('llm');
                  }}
                />
                <p className="text-[11px] text-muted-foreground">本地服务可留空；密钥只在服务端保存、不回显</p>
              </div>
              <div>
                <label className="text-xs text-muted-foreground" htmlFor="llm-analysis-timeout">
                  提示词分析超时（分钟）
                </label>
                <Input
                  id="llm-analysis-timeout"
                  type="number"
                  min="1"
                  value={draft.llm.analysisTimeoutMs}
                  placeholder="15"
                  onChange={(e) => {
                    setDraft((d) => ({ ...d, llm: { ...d.llm, analysisTimeoutMs: e.target.value } }));
                    touch('llm');
                  }}
                />
                <p className="text-[11px] text-muted-foreground">
                  「提示词画像」分析的单次 LLM 请求上限，默认 15 分钟；留空 = 默认。超过时限自动中止并提示，遇慢端点可调大
                </p>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="clibins" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              resume 续跑 spawn 的可执行命令；留空 = 默认命令名。解析优先级：环境变量 &gt; 此处 &gt; 默认名。
            </p>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                空 = 默认命令名；存服务端 ~/.agentlray/settings.json，终端与「复制恢复命令」按钮立即生效。
              </label>
              {binsRows.map((row) => (
                <div key={row.id} className="space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor={`setting-clibin-${row.id}`}>
                    {row.label}
                    {row.custom ? (
                      <span className="ml-1 text-[10px] text-sky-500">自定义（适配器 resume.bin 声明）</span>
                    ) : all.data?.cliBins?.[row.id]?.configured ? (
                      <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
                    ) : (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        默认：{all.data?.cliBins?.[row.id]?.default ?? ''}
                      </span>
                    )}
                  </label>
                  <Input
                    id={`setting-clibin-${row.id}`}
                    value={cliBinValue(row.id)}
                    placeholder={row.label}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, cliBins: { ...d.cliBins, [row.id]: e.target.value } }));
                      touch('cliBins');
                    }}
                  />
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="status" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              会话四态（awaiting-input / working / waiting / stopped）的判定时间窗口；保存即对后续状态判定生效。
            </p>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                状态判定时间窗口（单位：分钟 / 小时；保存即对后续状态判定生效）
              </label>
              {STATUS_FIELDS.map((field) => (
                <div key={field.key} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <label className="text-xs text-muted-foreground" htmlFor={`setting-status-${field.key}`}>
                      {field.label}（{field.unit === 'min' ? '分钟' : '小时'}）
                      {statusFieldBadge(field)}
                    </label>
                  </div>
                  <Input
                    id={`setting-status-${field.key}`}
                    type="number"
                    min="1"
                    value={statusDisplay(field.key, field.unit)}
                    placeholder={field.placeholder}
                    onChange={(e) => {
                      setDraft((d) => ({ ...d, status: { ...d.status, [field.key]: e.target.value } }));
                      touch('status');
                    }}
                  />
                  <p className="text-[11px] text-muted-foreground">{field.hint}</p>
                </div>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="kanban" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              任务看板每列（待用户输入 / 工作中 / 等待中 / 已停止）最多显示的会话条数；截断在前端客户端完成，保存即生效。
            </p>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="setting-kanban-max">
                每列最多会话条数
                {all.data?.kanban?.maxPerStatus?.configured ? (
                  <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
                ) : (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    默认：{all.data?.kanban?.maxPerStatus?.default ?? 20}
                  </span>
                )}
              </label>
              <Input
                id="setting-kanban-max"
                type="number"
                min="1"
                value={kanbanDisplay()}
                placeholder="20"
                onChange={(e) => {
                  setDraft((d) => ({ ...d, kanban: e.target.value }));
                  touch('kanban');
                }}
              />
              <p className="text-[11px] text-muted-foreground">每列最多显示的会话条数，默认 20；正整数</p>
            </div>
          </TabsContent>

          <TabsContent value="backup" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              把 codex / claude-code / omp / dsh / gemini 会话日志增量归档到 ~/.agentlray/archive。
            </p>
            <BackupSection />
          </TabsContent>
        </Tabs>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="destructive" onClick={reset}>
            Reset to Defaults
          </Button>
          <Button onClick={save}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
