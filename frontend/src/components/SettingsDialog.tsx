import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  getBackupStatus,
  getSettings,
  runBackup,
  saveSettings as apiSaveSettings,
} from '@/api/client';
import type { DirSettings, SettingsPatch } from '@/api/client';
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
import { EMPTY_SETTINGS, selectablePlatforms, useAppStore } from '@/store';

// 统一字段范式：每个配置项一行 label（htmlFor 关联）+ 输入框 + 小字 hint。
// 避免 label 与 hint 同排拥挤、placeholder 承担说明导致的对应关系混淆。
// 数据目录 tab 遍历运行时平台列表：内置平台映射上面的既有字段；自定义平台无每
// 平台目录配置（目录由适配器 defaultDir 决定），只展示说明行。
const DIR_FIELD_BY_ID: Partial<Record<string, { key: keyof DirSettings; label: string; placeholder: string; hint: string }>> = {
  openclaw: { key: 'openclawDir', label: 'OpenClaw 会话目录', placeholder: '~/.openclaw/agents', hint: 'OpenClaw agent 的会话日志位置；留空用默认目录' },
  codex: { key: 'codexDir', label: 'Codex 会话目录', placeholder: '~/.codex/sessions', hint: 'Codex 会话日志目录' },
  'claude-code': { key: 'claudeCodeDir', label: 'Claude Code 会话目录', placeholder: '~/.claude/projects', hint: 'Claude Code 项目会话目录' },
  hermes: { key: 'hermesDir', label: 'Hermes 数据目录', placeholder: '~/.hermes', hint: 'Hermes 数据目录' },
  omp: { key: 'ompDir', label: 'OMP 会话目录', placeholder: '~/.omp/agent/sessions', hint: 'OMP（oh-my-pi）会话目录' },
  dsh: { key: 'dshDir', label: 'DeepSeek Harness 会话目录', placeholder: '~/.dsh/sessions', hint: 'DeepSeek Harness 会话目录（同时识别 DSH_HOME）' },
  gemini: { key: 'geminiDir', label: 'Gemini CLI 临时目录', placeholder: '~/.gemini/tmp', hint: 'Gemini CLI 项目临时目录' },
};

/** resume 续跑配套的内置平台（其余内置无 resume 流程，不展示命令输入）。 */
const RESUME_BUILTIN_IDS: Record<string, true> = { codex: true, 'claude-code': true, omp: true };

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
  llm: { baseUrl: string; model: string; apiKey: string };
  cliBins: Partial<Record<string, string>>;
  status: Partial<Record<StatusKey, string>>;
  kanban: string;
}

function emptyDraft(): Draft {
  return {
    dirs: { ...EMPTY_SETTINGS },
    llm: { baseUrl: '', model: '', apiKey: '' },
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

  // 数据目录 tab 行：遍历运行时平台列表；内置映射既有字段，自定义平台只展示说明行。
  const dirRows = useMemo(
    () =>
      selectablePlatforms(platforms).map((info) => {
        const f = DIR_FIELD_BY_ID[info.id];
        return f
          ? { custom: false as const, key: f.key, label: f.label, placeholder: f.placeholder, hint: f.hint }
          : { custom: true as const, key: info.id, label: info.label ?? info.id };
      }),
    [platforms]
  );
  // resume 续跑配套行：内置三平台 + 声明了 resume 契约的自定义平台。
  const binsRows = useMemo(
    () =>
      selectablePlatforms(platforms)
        .filter((p) => (p.builtin ? RESUME_BUILTIN_IDS[p.id] === true : p.resume))
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
      llm: { baseUrl: all.data?.llm.baseUrl ?? '', model: all.data?.llm.model ?? '', apiKey: '' },
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
      patch.llm = {
        baseUrl,
        model: draft.llm.model.trim(),
        // apiKey 语义：非空 = 替换；空时 baseUrl 非空 = 保留服务器密钥，baseUrl 空 = 清除。
        apiKey: draft.llm.apiKey !== '' ? draft.llm.apiKey : baseUrl ? undefined : '',
      };
    }
    return patch;
  }

  const save = () => {
    const d = draft.dirs;
    saveDirSettings({
      openclawDir: d.openclawDir.trim(),
      codexDir: d.codexDir.trim(),
      claudeCodeDir: d.claudeCodeDir.trim(),
      hermesDir: d.hermesDir.trim(),
      ompDir: d.ompDir.trim(),
      dshDir: d.dshDir.trim(),
      geminiDir: d.geminiDir.trim(),
    });
    saveMutation.mutate(buildPatch());
  };

  // 恢复默认到表单（须再点 Save 才落盘）：数据目录清空、服务器字段留空 = 回默认。
  const reset = () => {
    setDraft({
      dirs: { ...EMPTY_SETTINGS },
      llm: { baseUrl: '', model: '', apiKey: '' },
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
            <TabsTrigger className="shrink-0" value="llm">LLM 接口</TabsTrigger>
            <TabsTrigger className="shrink-0" value="clibins">平台 CLI 命令</TabsTrigger>
            <TabsTrigger className="shrink-0" value="status">状态时间配置</TabsTrigger>
            <TabsTrigger className="shrink-0" value="kanban">任务看板</TabsTrigger>
            <TabsTrigger className="shrink-0" value="backup">会话备份</TabsTrigger>
          </TabsList>

          <TabsContent value="dirs" className="space-y-3">
            <p className="text-xs text-muted-foreground">
              各平台会话日志的存储位置；留空使用默认目录。保存到 localStorage，无需重启。自定义平台目录由适配器 defaultDir() 决定。
            </p>
            {dirRows.map((row) =>
              row.custom ? (
                <div key={row.key} className="space-y-0.5 rounded border border-dashed border-border px-2 py-1.5">
                  <label className="text-xs font-medium text-muted-foreground">{row.label}</label>
                  <p className="text-[11px] text-muted-foreground">
                    自定义平台：会话目录由适配器 defaultDir() 决定，查询参数 ?dir= 可覆盖，无此页面配置。
                  </p>
                </div>
              ) : (
                <div key={row.key} className="space-y-1">
                  <label className="text-xs font-medium" htmlFor={`setting-${row.key}`}>
                    {row.label}
                  </label>
                  <Input
                    id={`setting-${row.key}`}
                    value={draft.dirs[row.key]}
                    placeholder={row.placeholder}
                    onChange={(e) => setDraft((d) => ({ ...d, dirs: { ...d.dirs, [row.key]: e.target.value } }))}
                  />
                  <p className="text-[11px] text-muted-foreground">{row.hint}</p>
                </div>
              )
            )}
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
              把 codex / claude-code / omp 会话日志增量归档到 ~/.agentlray/archive。
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
