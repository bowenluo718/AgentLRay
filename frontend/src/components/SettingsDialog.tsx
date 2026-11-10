import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { fetchPlatforms, getSettings, saveSettings as apiSaveSettings } from '@/api/client';
import type { SettingsPatch } from '@/api/client';
import type { PlatformInfo } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useAppStore } from '@/store';

// 平台设置全部内聚到「平台」面板：每个平台一张卡片，聚合启停 Switch、数据目录、
// CLI 命令。目录真源在服务端 settings.json `dirs` section（env > dirs > 默认）、
// CLI 命令在 `cliBins` section、启停/替代在 `platforms` section——三者都随底部
// Save 一次 `PUT /api/settings` 提交。设置面板目录回显自 GET /api/settings 的
// `dirs` section，前端不再维护 localStorage 目录，也不再传 dir query。

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
type SectionKey = 'platforms' | 'llm' | 'status' | 'kanban';

// 全对话框单一 draft：所有 panel 的待保存输入。服务器 section 的「空串 = 回默认」。
// 平台按 id 聚合 { mounted, replaced, dir, bin }：mounted/replaced 初始 =
// 服务端 platforms 镜像（configuredMounted / replaced），dir 初始 = 服务端 dirs 值，
// bin 初始 = 服务端 cliBins 生效值。
interface PlatformDraft {
  mounted: boolean;
  replaced: boolean;
  dir: string;
  bin: string;
}
interface Draft {
  platforms: Record<string, PlatformDraft>;
  /** 默认平台 id（ui.platform，单选）；null = 未设置（CLI show/resume 缺省需显式 --platform）。 */
  defaultPlatform: string | null;
  llm: { baseUrl: string; model: string; apiKey: string; analysisTimeoutMs: string };
  status: Partial<Record<StatusKey, string>>;
  kanban: string;
}

function emptyDraft(): Draft {
  return {
    platforms: {},
    defaultPlatform: null,
    llm: { baseUrl: '', model: '', apiKey: '', analysisTimeoutMs: '' },
    status: {},
    kanban: '',
  };
}

// 左侧导航项（桌面纵向 / 移动端横向滚动栏）。key 复用 SectionKey。
const MENU: { key: SectionKey; label: string }[] = [
  { key: 'platforms', label: '平台' },
  { key: 'llm', label: 'LLM 接口' },
  { key: 'status', label: '状态时间配置' },
  { key: 'kanban', label: '任务看板' },
];

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const platforms = useAppStore((s) => s.platforms);
  const queryClient = useQueryClient();
  // 单一 GET /api/settings：一次读齐 dirs / cliBins / platforms / status / kanban / llm。
  const all = useQuery({ queryKey: ['settings'], queryFn: getSettings });
  // 平台卡片必须看到含未挂载条目的完整 catalog（含 broken），否则「启用」无从出现。
  const full = useQuery({ queryKey: ['platforms-catalog'], queryFn: fetchPlatforms });

  const [draft, setDraft] = useState<Draft>(emptyDraft);
  // 服务器 section 的脏标记：保存时只提交已编辑的 section，未触碰的保持服务器原值。
  const [touched, setTouched] = useState<Record<SectionKey, boolean>>({
    platforms: false,
    llm: false,
    status: false,
    kanban: false,
  });
  // 当前激活的左侧导航面板。
  const [menu, setMenu] = useState<SectionKey>('platforms');
  // 打开后仅在 settings 数据首次就绪时种 draft（此后编辑不被打断）。
  const seeded = useRef(false);

  // 平台列表：优先完整 catalog（含未挂载/broken），否则回退 store 运行时列表。
  const platformInfos: PlatformInfo[] = full.data ?? platforms;

  const llmBackendText = () => {
    const llm = all.data?.llm;
    return llm?.backend === 'openai'
      ? `OpenAI 兼容端点（${llm.model}）`
      : llm?.backend === 'claude-cli'
        ? '本机 claude CLI'
        : '未配置';
  };

  function seedDraft() {
    const dirs = all.data?.dirs ?? {};
    const cliBins = all.data?.cliBins ?? {};
    const ps = all.data?.platforms;
    const repl: Record<string, true> = Object.fromEntries((ps?.replaced ?? []).map((x) => [x, true]));
    const disabled: Record<string, true> = Object.fromEntries((ps?.disabled ?? []).map((x) => [x, true]));
    const seed: Record<string, PlatformDraft> = {};
    for (const p of platformInfos) {
      if (!p || p.id == null) continue;
      const id = p.id;
      const dirInfo = dirs[id];
      const binInfo = cliBins[id];
      seed[id] = {
        mounted: !disabled[id],
        replaced: repl[id] === true,
        dir: dirInfo?.value ?? '',
        bin: binInfo?.bin ?? '',
      };
    }
    setDraft({
      platforms: seed,
      // 默认平台 = 服务端 ui.platform（设置面板独占管理，侧栏不再覆盖）。
      defaultPlatform: typeof all.data?.ui?.platform === 'string' ? all.data.ui.platform : null,
      llm: {
        baseUrl: all.data?.llm.baseUrl ?? '',
        model: all.data?.llm.model ?? '',
        apiKey: '',
        analysisTimeoutMs: all.data?.llm.analysisTimeoutMs
          ? String(Math.round(all.data.llm.analysisTimeoutMs / 60_000))
          : '',
      },
      status: {},
      kanban: '',
    });
    setTouched({ platforms: false, llm: false, status: false, kanban: false });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, all.data]);

  const touch = (section: SectionKey) => setTouched((t) => ({ ...t, [section]: true }));

  // ---- 展示值：draft 优先，否则回退服务端当前值 ----
  const platformDraft = (id: string): PlatformDraft =>
    draft.platforms[id] ?? { mounted: false, replaced: false, dir: '', bin: '' };
  const dirValue = (id: string) => {
    if (draft.platforms[id]?.dir !== undefined) return draft.platforms[id]!.dir;
    return all.data?.dirs?.[id]?.value ?? '';
  };
  const cliBinValue = (id: string) => {
    if (draft.platforms[id]?.bin !== undefined) return draft.platforms[id]!.bin;
    return all.data?.cliBins?.[id]?.bin ?? '';
  };

  const statusDisplay = (key: StatusKey, unit: 'min' | 'hour') => {
    if (draft.status[key] !== undefined) return draft.status[key]!;
    const ms = all.data?.status[key]?.value;
    return ms ? String(Math.round(ms / UNIT_MS[unit])) : '';
  };

  const kanbanDisplay = () =>
    draft.kanban !== '' ? draft.kanban : String(all.data?.kanban?.maxPerStatus?.value ?? 20);

  // ---- 保存：只提交已触碰的 section（dirs/platforms/cliBins 随 platforms 一并提交）----
  const saveMutation = useMutation({
    mutationFn: apiSaveSettings,
    onSuccess: () => {
      onOpenChange(false);
      queryClient.invalidateQueries();
    },
  });

  function buildPatch(): SettingsPatch {
    const patch: SettingsPatch = {};
    if (touched.platforms) {
      // 默认平台（ui.platform）变化 → 只写 platform，不动 selectedPlatforms
      // （服务端部分更新，两者互不覆盖）。
      if (draft.defaultPlatform !== (all.data?.ui?.platform ?? null)) {
        patch.ui = { platform: draft.defaultPlatform ?? undefined };
      }
      const setMount = Object.entries(draft.platforms).filter(([, pf]) => pf.mounted !== undefined);
      const disabled: string[] = [];
      const replaced: string[] = [];
      for (const [id, pf] of setMount) {
        if (!pf.mounted) disabled.push(id);
        if (pf.replaced) replaced.push(id);
      }
      patch.platforms = { disabled, replaced };
    }
    if (touched.platforms && draft.platforms) {
      const dirsPatch: NonNullable<SettingsPatch['dirs']> = {};
      let any = false;
      for (const [id, pf] of Object.entries(draft.platforms)) {
        const info = platformInfos.find((p) => p.id === id);
        const key = info?.dirSettingKey;
        if (!key) continue;
        const val = pf.dir.trim();
        const server = all.data?.dirs?.[id]?.value ?? '';
        if (val !== server) {
          dirsPatch[key] = val;
          any = true;
        }
      }
      if (any) patch.dirs = dirsPatch;
    }
    if (touched.platforms && draft.platforms) {
      const binsPatch: NonNullable<SettingsPatch['cliBins']> = {};
      let any = false;
      for (const [id, pf] of Object.entries(draft.platforms)) {
        const val = pf.bin.trim();
        const server = all.data?.cliBins?.[id]?.bin ?? '';
        if (val !== server) {
          binsPatch[id] = val;
          any = true;
        }
      }
      if (any) patch.cliBins = binsPatch;
    }
    if (touched.status) {
      const status: NonNullable<SettingsPatch['status']> = {};
      for (const field of STATUS_FIELDS) {
        const raw = draft.status[field.key];
        let ms: number | undefined;
        if (raw !== undefined) {
          const n = Number(raw.trim());
          if (Number.isFinite(n) && n > 0) ms = Math.round(n * UNIT_MS[field.unit]);
        } else {
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
      let analysisTimeoutMs = 0;
      if (timeoutRaw !== '') {
        const n = Number(timeoutRaw);
        if (Number.isFinite(n) && n > 0) analysisTimeoutMs = Math.round(n * 60_000);
      }
      patch.llm = {
        baseUrl,
        model: draft.llm.model.trim(),
        apiKey: draft.llm.apiKey !== '' ? draft.llm.apiKey : baseUrl ? undefined : '',
        analysisTimeoutMs,
      };
    }
    return patch;
  }

  const save = () => {
    saveMutation.mutate(buildPatch());
  };

  // 恢复默认到表单（须再点 Save 才落盘）：目录/CLI 留空 = 回默认；
  // 启停/替代不重置（防误伤——平台挂载态改动需重启才能生效，不应被 Reset 顺带清掉）。
  const reset = () => {
    setDraft((d) => {
      const platforms: Record<string, PlatformDraft> = {};
      for (const [id, pf] of Object.entries(d.platforms)) {
        platforms[id] = { ...pf, dir: '', bin: '' };
      }
      return {
        platforms,
        // 默认平台重置回服务端当前值（须再点 Save 才落盘）。
        defaultPlatform: typeof all.data?.ui?.platform === 'string' ? all.data.ui.platform : null,
        llm: { baseUrl: '', model: '', apiKey: '', analysisTimeoutMs: '' },
        status: Object.fromEntries(STATUS_FIELDS.map((f) => [f.key, ''])),
        kanban: '',
      };
    });
    setTouched({ platforms: true, llm: true, status: true, kanban: true });
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

  // ---- 各导航面板内容 ----
  // 默认平台可选项：已挂载 + 非 broken（与 CLI resolveDefaultPlatform 的
  // PLATFORMS[ui.platform] 判定口径一致，保证默认平台对 CLI 有效）。
  const defaultPlatformOptions = platformInfos.filter(
    (p): p is PlatformInfo & { id: string } => !p.broken && p.id != null && p.mounted
  );

  const renderPlatforms = () => (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">平台</h3>
        <p className="text-xs text-muted-foreground">
          各平台的启用、会话数据目录与 CLI 命令集中在此。默认平台（勾选）供 CLI
          （sessions list/show/resume）未指定 --platform 时使用，必且只能一个；关停
          当前默认平台时自动转移到第一个已挂载平台。目录留空 = 用默认目录（env 优先）；
          命令留空 = 默认命令名。随底部 Save 一次提交，目录/命令立即生效，启停与替代在重启后生效。
        </p>
      </div>

      <div className="space-y-2">
        {platformInfos.map((p) => {
          if (!p || p.id == null) return null;
          const id = p.id;
          const pf = platformDraft(id);
          const originLabel = p.origin === 'project' ? '项目' : p.origin === 'user' ? '用户' : '内置';
          const canMount = !p.broken;
          const dirKey = p.dirSettingKey;
          const binConfigurable = p.bin != null || p.resume;
          const envActive = all.data?.dirs?.[id]?.envActive === true;
          const broken = p.broken === true;
          const disabled = broken || !pf.mounted;
          return (
            <div key={id} className="rounded-md border border-border px-3 py-2.5">
              {/* 头部: label/来源/挂载态/启停 Switch/撤销替代 */}
              <div className="flex items-center justify-between gap-2">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="text-sm font-medium">{p.label ?? id}</span>
                  <span
                    className="rounded px-1 text-[10px]"
                    style={{
                      color: p.color ?? 'var(--muted-foreground)',
                      border: `1px solid ${p.color ?? 'var(--border)'}55`,
                    }}
                  >
                    {id}
                  </span>
                  <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">{originLabel}</span>
                  {p.builtin ? (
                    <span className="rounded bg-muted px-1.5 text-[10px] text-muted-foreground">包内置</span>
                  ) : null}
                  {p.replacementPending ? (
                    <span className="text-[10px] text-amber-500">替代待生效</span>
                  ) : p.restartRequired ? (
                    <span className="text-[10px] text-amber-500">重启生效</span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {pf.replaced ? (
                    <Button
                      variant="outline"
                      size="sm"
                      title="撤销对包内置平台的替代声明"
                      onClick={() => {
                        setDraft((d) => ({
                          ...d,
                          platforms: { ...d.platforms, [id]: { ...pf, replaced: false } },
                        }));
                        touch('platforms');
                      }}
                    >
                      撤销替代
                    </Button>
                  ) : null}
                  {canMount ? (
                    <div className="flex items-center gap-2">
                      {/* 默认平台勾选（互斥单选）：已挂载 + 非 broken 平台可设；关闭停用
                          时随下方 Switch 联动转移。 */}
                      <label
                        className="flex cursor-pointer items-center gap-1"
                        title={broken ? '平台不可用，无法设为默认' : '设为默认平台（CLI 缺省使用，必且只能一个）'}
                      >
                        <Checkbox
                          checked={draft.defaultPlatform === id}
                          disabled={broken}
                          onCheckedChange={() => {
                            setDraft((d) => ({ ...d, defaultPlatform: d.defaultPlatform === id ? null : id }));
                            touch('platforms');
                          }}
                          className="h-3.5 w-3.5"
                        />
                        <span className="text-xs text-muted-foreground">默认</span>
                      </label>
                      <div
                        className="flex items-center gap-1.5"
                        title={`切换启用状态（${pf.mounted ? '停用' : '启用'}，重启后生效）`}
                      >
                        <span className="text-xs text-muted-foreground">{pf.mounted ? '已启用' : '已停用'}</span>
                        <Switch
                          checked={pf.mounted}
                          disabled={broken}
                          onClick={() => {
                            const nextMounted = !pf.mounted;
                            // 停用当前默认平台 → 自动转移默认到第一个已挂载非 broken 平台
                            // （与后端 defaultPlatformId 的 catalog 序语义一致）。
                            let defaultPlatform = draft.defaultPlatform;
                            if (nextMounted === false && draft.defaultPlatform === id) {
                              const next = defaultPlatformOptions.find((x) => x.id !== id);
                              defaultPlatform = next?.id ?? null;
                            }
                            setDraft((d) => ({
                              ...d,
                              platforms: { ...d.platforms, [id]: { ...pf, mounted: nextMounted } },
                              defaultPlatform,
                            }));
                            touch('platforms');
                          }}
                        />
                      </div>
                    </div>
                  ) : (
                    <span className="shrink-0 text-[10px] text-muted-foreground">不可配置</span>
                  )}
                </div>
              </div>

              {broken && p.error ? (
                <p className="mt-1 break-all text-[11px] text-destructive">{p.error}</p>
              ) : null}

              {/* 数据目录行：停用（mounted=false）时隐藏，启用后显示 */}
              {dirKey && pf.mounted ? (
                <div className="mt-2 space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor={`setting-dir-${id}`}>
                    {p.dirSettingLabel ?? `${p.label ?? id} 会话目录`}
                    {envActive ? (
                      <span className="ml-1 text-[10px] text-amber-500">
                        由 {all.data?.dirs?.[id]?.envActive ? '环境变量' : '环境'} 决定，此配置不生效
                      </span>
                    ) : all.data?.dirs?.[id]?.configured ? (
                      <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
                    ) : (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        默认：{all.data?.dirs?.[id]?.default ?? p.defaultDir}
                      </span>
                    )}
                  </label>
                  <Input
                    id={`setting-dir-${id}`}
                    value={dirValue(id)}
                    placeholder={all.data?.dirs?.[id]?.default ?? p.defaultDir ?? ''}
                    disabled={disabled || envActive}
                    onChange={(e) => {
                      setDraft((d) => ({
                        ...d,
                        platforms: { ...d.platforms, [id]: { ...pf, dir: e.target.value } },
                      }));
                      touch('platforms');
                    }}
                  />
                  {p.dirSettingHint ? (
                    <p className="text-[11px] text-muted-foreground">{p.dirSettingHint}</p>
                  ) : null}
                </div>
              ) : null}

              {/* CLI 命令行：平台不支持配置命令（bin 为 null 且无 resume）或已停用 → 整行隐藏 */}
              {binConfigurable && pf.mounted ? (
                <div className="mt-2 space-y-1">
                  <label className="text-xs text-muted-foreground" htmlFor={`setting-bin-${id}`}>
                    CLI 命令
                    {all.data?.cliBins?.[id]?.configured ? (
                      <span className="ml-1 text-[10px] text-emerald-600">已配置</span>
                    ) : (
                      <span className="ml-1 text-[10px] text-muted-foreground">
                        默认：{all.data?.cliBins?.[id]?.default ?? p.bin ?? ''}
                      </span>
                    )}
                  </label>
                  <Input
                    id={`setting-bin-${id}`}
                    value={cliBinValue(id)}
                    placeholder={all.data?.cliBins?.[id]?.default ?? p.bin ?? ''}
                    disabled={disabled}
                    onChange={(e) => {
                      setDraft((d) => ({
                        ...d,
                        platforms: { ...d.platforms, [id]: { ...pf, bin: e.target.value } },
                      }));
                      touch('platforms');
                    }}
                  />
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );

  const renderLlm = () => (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">LLM 接口</h3>
        <p className="text-xs text-muted-foreground">
          prompt 优化 / 聚类建议 / 命名建议的后端；留空 Base URL = 回退本机 claude CLI 探测。
          当前后端：{llmBackendText()}
        </p>
      </div>
      <div className="space-y-3">
        <div className="space-y-1">
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
        <div className="space-y-1">
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
        <div className="space-y-1">
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
        <div className="space-y-1">
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
    </section>
  );

  const renderStatus = () => (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">状态时间配置</h3>
        <p className="text-xs text-muted-foreground">
          会话四态（awaiting-input / working / waiting / stopped）的判定时间窗口；保存即对后续状态判定生效。
        </p>
      </div>
      <div className="space-y-3">
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
    </section>
  );

  const renderKanban = () => (
    <section className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">任务看板</h3>
        <p className="text-xs text-muted-foreground">
          任务看板每列（待用户输入 / 工作中 / 等待中 / 已停止）最多显示的会话条数；截断在前端客户端完成，保存即生效。
        </p>
      </div>
      <div className="space-y-1">
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
    </section>
  );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      {/* 桌面（≥768px）：两栏 12rem 左 Nav + 内容；移动端全宽，左 Nav 折叠为顶部横向滚动栏 */}
      <DialogContent
        className="max-w-3xl overflow-y-auto top-[6%] translate-y-0 md:max-h-[85vh] md:min-h-[50vh] max-md:max-w-none max-md:w-[calc(100vw-2rem)] max-md:max-h-[calc(100dvh-2rem)] max-md:rounded-2xl max-md:p-4 max-md:gap-3 max-md:grid-cols-[minmax(0,1fr)]"
        style={{ gridTemplateRows: 'auto 1fr auto' }}
      >
        <DialogHeader>
          <DialogTitle>设置</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)]">
          {/* 左导航：桌面纵向 / 移动端顶部横向可滚动栏 */}
          <nav className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible md:border-r md:border-border md:pr-2">
            {MENU.map((item) => {
              const active = menu === item.key;
              const base =
                'shrink-0 rounded-md px-3 py-1.5 text-left text-sm font-medium whitespace-nowrap transition-colors md:whitespace-normal ';
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setMenu(item.key)}
                  className={
                    base +
                    (active
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground')
                  }
                >
                  {item.label}
                </button>
              );
            })}
          </nav>

          {/* 右内容区 */}
          <div className="min-w-0 border-t border-border pt-3 md:border-t-0 md:pt-0">
            {menu === 'platforms' && renderPlatforms()}
            {menu === 'llm' && renderLlm()}
            {menu === 'status' && renderStatus()}
            {menu === 'kanban' && renderKanban()}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="destructive" onClick={reset}>
            全部恢复默认值
          </Button>
          <Button onClick={save}>保存</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
