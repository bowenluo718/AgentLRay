import { create } from 'zustand';
import { saveUiSettings } from '@/api/client';
import type { DirSettings } from '@/api/client';
import type { Platform, PlatformCapabilities, PlatformInfo } from '@/api/types';
import { DEMO } from '@/demo/flag';

// —— 平台列表降级表 ——
// 平台列表以运行时 GET /api/platforms 为唯一真源（内置 → 自定义 → broken）。
// 仅当拉取失败（如后端不可达）时降级到下面的内置 7 平台表，与 legacy
// public/js/app.js 的内置表一致，避免页面在端点故障下完全不可用。

const BUILTIN_CAPS: PlatformCapabilities = {
  list: true,
  find: true,
  parse: true,
  getSession: true,
  collectFiles: true,
  watchParse: true,
  needsAgent: false,
};

export const FALLBACK_PLATFORM_INFOS: PlatformInfo[] = [
  { id: 'openclaw', label: 'OpenClaw', builtin: true, capabilities: { ...BUILTIN_CAPS, list: false, needsAgent: true }, resume: false, broken: false },
  { id: 'codex', label: 'Codex', builtin: true, capabilities: { ...BUILTIN_CAPS }, resume: true, broken: false },
  { id: 'claude-code', label: 'Claude Code', builtin: true, capabilities: { ...BUILTIN_CAPS }, resume: true, broken: false },
  { id: 'hermes', label: 'Hermes', builtin: true, capabilities: { list: true, find: false, parse: false, getSession: true, collectFiles: false, watchParse: false, needsAgent: false }, resume: false, broken: false },
  { id: 'omp', label: 'OMP', builtin: true, capabilities: { ...BUILTIN_CAPS }, resume: true, broken: false },
  { id: 'dsh', label: 'DeepSeek Harness', builtin: true, capabilities: { ...BUILTIN_CAPS }, resume: false, broken: false },
  { id: 'gemini', label: 'Gemini CLI', builtin: true, capabilities: { ...BUILTIN_CAPS }, resume: false, broken: false },
];

const EMPTY_CAPABILITIES: PlatformCapabilities = {
  list: false, find: false, parse: false, getSession: false, collectFiles: false, watchParse: false, needsAgent: false,
};

// —— 平台列表派生 ——
// 入参为 store.platforms 的运行时列表；组件经 useAppStore((s) => s.platforms) 取数后调用。

/** 可查询平台 id（非 broken 且有 id），保留服务端顺序。 */
export function selectablePlatformIds(infos: PlatformInfo[]): string[] {
  return infos.filter((p): p is PlatformInfo & { id: string } => !p.broken && p.id != null).map((p) => p.id);
}

/** 可查询平台条目（非 broken 且有 id），保留服务端顺序。 */
export function selectablePlatforms(infos: PlatformInfo[]): Array<PlatformInfo & { id: string }> {
  return infos.filter((p): p is PlatformInfo & { id: string } => !p.broken && p.id != null);
}

/** 自定义平台（非内置、非 broken），按服务端顺序。 */
export function customPlatforms(infos: PlatformInfo[]): PlatformInfo[] {
  return selectablePlatforms(infos).filter((p) => !p.builtin);
}

/** broken 平台（适配器加载/校验失败），按服务端顺序。 */
export function brokenPlatforms(infos: PlatformInfo[]): PlatformInfo[] {
  return infos.filter((p) => p.broken);
}

/** 平台 id → 展示名；未知 id 回退 id 本身。 */
export function platformLabel(infos: PlatformInfo[], id: string): string {
  return selectablePlatforms(infos).find((p) => p.id === id)?.label ?? id;
}

/** 平台能力位；未知 id → 全 false。 */
export function capabilitiesOf(infos: PlatformInfo[], id: string): PlatformCapabilities {
  return selectablePlatforms(infos).find((p) => p.id === id)?.capabilities ?? EMPTY_CAPABILITIES;
}

// Settings persist to the SAME localStorage key/shape as the legacy app
// (public/js/app.js SETTINGS_KEY) so both UIs share settings:
//   { openclawDir, codexDir, claudeCodeDir, hermesDir, ompDir, platform }
export const SETTINGS_KEY = 'agent-xray-settings';

// 左侧菜单（会话导航）宽度与折叠：桌面端可拖拽调宽（最小 200 / 最大 480），
// 折叠后主内容占满；两者都随 agent-xray-settings 持久化（移动端抽屉逻辑不受影响）。
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

function clampSidebarWidth(value: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, value));
}

// Legacy per-view flags, reused as-is ('1'/'0' strings, default true when absent).
export const SUMMARY_COLLAPSED_KEY = 'axr-summary-collapsed';
export const HIDE_TRIVIAL_KEY = 'axr-hide-trivial';
export const LIB_SORT_KEY = 'axr-lib-sort';

export function loadStoredFlag(key: string, fallback = true): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw !== '0';
  } catch {
    return fallback;
  }
}

export function saveStoredFlag(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* private mode etc. — non-fatal */
  }
}

export const EMPTY_SETTINGS: DirSettings = {
  openclawDir: '',
  codexDir: '',
  claudeCodeDir: '',
  hermesDir: '',
  ompDir: '',
  dshDir: '',
  geminiDir: '',
};

export function dirForPlatform(settings: DirSettings, platform: Platform): string {
  switch (platform) {
    case 'openclaw':
      return settings.openclawDir;
    case 'codex':
      return settings.codexDir;
    case 'claude-code':
      return settings.claudeCodeDir;
    case 'hermes':
      return settings.hermesDir;
    case 'omp':
      return settings.ompDir;
    case 'dsh':
      return settings.dshDir;
    case 'gemini':
      return settings.geminiDir;
    default:
      // 自定义平台无每平台目录配置（目录由适配器 defaultDir 决定）。
      return '';
  }
}

function loadPersisted(): {
  settings: DirSettings;
  platform: Platform;
  hasStoredPlatform: boolean;
  selectedPlatforms: Platform[];
  groupBy: GroupBy;
  projectFilter: string[];
  collapsedGroups: Record<GroupBy, string[]>;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  view: MainView;
} {
  // Demo build ships claude-code/codex fixtures only — land on a populated tab.
  const defaultPlatform: Platform = DEMO ? 'claude-code' : 'openclaw';
  const result: {
    settings: DirSettings;
    platform: Platform;
    hasStoredPlatform: boolean;
    selectedPlatforms: Platform[];
    groupBy: GroupBy;
    projectFilter: string[];
    collapsedGroups: Record<GroupBy, string[]>;
    sidebarCollapsed: boolean;
    sidebarWidth: number;
    view: MainView;
  } = {
    settings: { ...EMPTY_SETTINGS },
    platform: defaultPlatform,
    hasStoredPlatform: false,
    // 无持久化选择时默认「全部平台」（聚合视图）。平台列表加载成功后 setPlatforms
    // 会把选择收敛/扩展到运行时列表（含自定义平台）。
    selectedPlatforms: selectablePlatformIds(FALLBACK_PLATFORM_INFOS),
    groupBy: 'none',
    projectFilter: [],
    collapsedGroups: { platform: [], project: [], none: [] },
    sidebarCollapsed: false,
    sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
    view: 'sessions',
  };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      result.settings.openclawDir = typeof parsed.openclawDir === 'string' ? parsed.openclawDir : '';
      result.settings.codexDir = typeof parsed.codexDir === 'string' ? parsed.codexDir : '';
      result.settings.claudeCodeDir = typeof parsed.claudeCodeDir === 'string' ? parsed.claudeCodeDir : '';
      result.settings.hermesDir = typeof parsed.hermesDir === 'string' ? parsed.hermesDir : '';
      result.settings.ompDir = typeof parsed.ompDir === 'string' ? parsed.ompDir : '';
      result.settings.dshDir = typeof parsed.dshDir === 'string' ? parsed.dshDir : '';
      result.settings.geminiDir = typeof parsed.geminiDir === 'string' ? parsed.geminiDir : '';
      // 持久化的单平台接受任意非空字符串（可能是自定义平台 id，加载时无法对运行时
      // 列表校验；由 setPlatforms 在列表就绪后收敛）。旧存储无该键 → 默认平台。
      if (typeof parsed.platform === 'string' && parsed.platform.trim() !== '') {
        result.platform = parsed.platform.trim();
        result.hasStoredPlatform = true;
      }
      // 显式持久化的平台多选与 UI 偏好（旧存储无这些键 → 各自默认值）。
      if (Array.isArray(parsed.selectedPlatforms)) {
        const picked = parsed.selectedPlatforms.filter((x): x is string => typeof x === 'string');
        result.selectedPlatforms = picked;
      }
      if (parsed.groupBy === 'platform' || parsed.groupBy === 'project') {
        result.groupBy = parsed.groupBy;
      }
      if (Array.isArray(parsed.projectFilter)) {
        result.projectFilter = parsed.projectFilter.filter((x): x is string => typeof x === 'string');
      }
      if (parsed.collapsedGroups && typeof parsed.collapsedGroups === 'object') {
        const cg = parsed.collapsedGroups as Record<string, unknown>;
        for (const mode of ['platform', 'project', 'none'] as const) {
          if (Array.isArray(cg[mode])) {
            result.collapsedGroups[mode] = cg[mode].filter((x): x is string => typeof x === 'string');
          }
        }
      }
      // 桌面端侧栏折叠与宽度（旧存储无这些键 → 各自默认值）。宽度需为正数，越界收敛。
      if (typeof parsed.sidebarCollapsed === 'boolean') {
        result.sidebarCollapsed = parsed.sidebarCollapsed;
      }
      if (typeof parsed.sidebarWidth === 'number' && Number.isFinite(parsed.sidebarWidth)) {
        result.sidebarWidth = clampSidebarWidth(parsed.sidebarWidth);
      }
      // 右侧视图页签（旧存储无该键 → 默认 sessions）。非法值回退，避免脏数据卡死页面。
      if (isMainView(parsed.view)) {
        result.view = parsed.view;
      }
    }
  } catch {
    /* corrupted storage — fall back to defaults */
  }
  return result;
}

export type MainView = 'sessions' | 'insights' | 'prompts' | 'library' | 'kanban';
/** 右侧视图页签值校验（URL 参数 / localStorage 解析共用；非法值一律回退默认）。 */
export function isMainView(v: unknown): v is MainView {
  return v === 'sessions' || v === 'insights' || v === 'prompts' || v === 'library' || v === 'kanban';
}
export type InsightsScope = 'global' | 'session';
export type SessionView = 'messages' | 'trace';
/** 侧栏会话列表分组模式：按平台 / 按项目 / 不分组。 */
export type GroupBy = 'platform' | 'project' | 'none';

// —— 路由持久化：会话详情 + 右侧视图页签 ↔ URL query ——
// 点击会话查看详情时把详情上下文（?session=&sid=&agent=）写进 URL；右侧视图页签
// （?view=）随切换一并反映。刷新后从 URL 恢复「正在查看的详情 + 所在页签」，再回退
// localStorage。用 replaceState 不产生历史栈噪音；筛选/分组配置仍走 localStorage，
// 两者独立。
const URL_PARAM_SESSION = 'session'; // 平台
const URL_PARAM_SID = 'sid'; // 会话 id（URLSearchParams 自动编解码）
const URL_PARAM_AGENT = 'agent'; // openclaw 归属 agent（可选）
const URL_PARAM_VIEW = 'view'; // 右侧视图页签（sessions/insights/prompts/library/kanban）

/** 从当前 URL 解析详情上下文（无参数/平台非法 → 空）。 */
function parseDetailFromUrl(): { detailPlatform?: Platform; detailAgent?: string; selectedSessionId?: string } {
  if (DEMO) return {};
  try {
    const params = new URLSearchParams(window.location.search);
    const platform = params.get(URL_PARAM_SESSION);
    const sid = params.get(URL_PARAM_SID);
    // 平台 id 遵循适配器契约正则（^[a-z0-9][a-z0-9-]*$）；加载时无法对运行时列表
    // 校验，只挡明显非法值（防路径注入），合法与否由列表就绪后的 setPlatforms 收敛。
    if (!platform || !/^[a-z0-9][a-z0-9-]*$/.test(platform) || !sid) return {};
    return {
      detailPlatform: platform as Platform,
      detailAgent: params.get(URL_PARAM_AGENT) || '',
      selectedSessionId: sid,
    };
  } catch {
    return {};
  }
}

/** 从当前 URL 解析右侧视图页签（无参数/非法值 → null，回退 localStorage/默认）。 */
function parseViewFromUrl(): MainView | null {
  if (DEMO) return null;
  try {
    const params = new URLSearchParams(window.location.search);
    const v = params.get(URL_PARAM_VIEW);
    return isMainView(v) ? v : null;
  } catch {
    return null;
  }
}

let lastTopUrlKey = '';
/** 把「当前详情上下文 + 右侧视图页签」写回（或清出）URL；带值缓存避免重复 replaceState。 */
function syncSessionUrl(): void {
  const st = useAppStore.getState();
  const { detailPlatform, detailAgent, selectedSessionId, view } = st;
  const detailKey = selectedSessionId ? `${detailPlatform}|${detailAgent}|${selectedSessionId}` : '';
  const key = `${view}|${detailKey}`;
  if (key === lastTopUrlKey) return;
  lastTopUrlKey = key;
  try {
    const params = new URLSearchParams(window.location.search);
    // 右侧视图页签始终反映在 URL；详情上下文仅在选中会话时写入。
    params.set(URL_PARAM_VIEW, view);
    if (selectedSessionId) {
      params.set(URL_PARAM_SESSION, detailPlatform);
      params.set(URL_PARAM_SID, selectedSessionId);
      if (detailAgent) params.set(URL_PARAM_AGENT, detailAgent);
      else params.delete(URL_PARAM_AGENT);
    } else {
      params.delete(URL_PARAM_SESSION);
      params.delete(URL_PARAM_SID);
      params.delete(URL_PARAM_AGENT);
    }
    const qs = params.toString();
    window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
  } catch {
    /* non-fatal */
  }
}

function persistState(): void {
  const st = useAppStore.getState();
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        ...st.settings,
        platform: st.platform,
        selectedPlatforms: st.selectedPlatforms,
        groupBy: st.groupBy,
        projectFilter: st.projectFilter,
        collapsedGroups: st.collapsedGroups,
        sidebarCollapsed: st.sidebarCollapsed,
        sidebarWidth: st.sidebarWidth,
        view: st.view,
      })
    );
  } catch {
    /* non-fatal */
  }
  // 把平台选择同步到服务端 ~/.agentlray/ui-settings.json（CLI 未传 --platform 时
  // 读取为默认，保证终端命令与页面视角一致）。DEMO 无真实后端，跳过。
  if (!DEMO) {
    saveUiSettings({ platform: st.platform, selectedPlatforms: st.selectedPlatforms }).catch(() => {
      /* non-fatal */
    });
  }
}

/** Prefill payload for the library create/edit form (LibraryFormDialog, views/library/). */
export interface LibraryFormPrefill {
  name?: string;
  description?: string;
  tags?: string[];
  content?: string;
  source?: string;
  /** Fired once after a successful non-edit save (legacy libraryFormOnSaved). */
  onSaved?: () => void;
}

export interface LibraryFormState {
  open: boolean;
  /** Original name when editing an existing prompt; null = create. */
  editingName: string | null;
  prefill: LibraryFormPrefill | null;
  /** Bumped on every open — invalidates in-flight suggest-name responses (legacy seq). */
  openSeq: number;
}

interface AppState {
  platform: Platform;
  /** 多平台选中集合（PlatformBar 可勾选多个）：非空 = 聚合视图
   *  → 列表用 GET /api/sessions?platform=<逗号平台> ，点击某会话时 setPlatform(来源) 聚焦单平台详情；
   *    空 = 单平台模式（用 platform）。[] 对应旧 viewAll=false，全选对应旧 viewAll=true。 */
  selectedPlatforms: Platform[];
  /** 分组模式：按平台 / 按项目 / 不分组（默认不分组）。 */
  groupBy: GroupBy;
  /** 项目筛选选中集合（cwd 推导显示值；空 = 全部项目）。 */
  projectFilter: string[];
  /** 折叠的组名集合，按分组模式分别记忆（名字带 kind: 前缀防键撞）。 */
  collapsedGroups: Record<GroupBy, string[]>;
  /** 桌面端左侧菜单折叠（true = 只显示主内容；移动端抽屉展开仍由局部 navigationOpen 控制）。 */
  sidebarCollapsed: boolean;
  /** 桌面端左侧菜单宽度（可拖拽，200–480px）。 */
  sidebarWidth: number;
  /** true when the persisted settings carried an explicit platform (skip auto-pick on boot) */
  hasStoredPlatform: boolean;
  /** 会话详情上下文（来源平台/agent）：聚合视图点击会话时只更新它，不扰动筛选
   *  （platform/selectedPlatforms/groupBy/projectFilter）。单平台模式下与筛选同步。 */
  detailPlatform: Platform;
  detailAgent: string;
  selectedAgent: string; // openclaw only
  selectedSessionId: string;
  settings: DirSettings;
  view: MainView;
  /** null = not entered 分析 yet; auto-picked on first entry, then sticky */
  insightsScope: InsightsScope | null;
  sessionView: SessionView;
  /** Child-agent transcript being viewed (omp/claude-code spawned subagent name), null = parent session. */
  viewingChildAgent: string | null;
  /** Library create/edit form dialog — opened cross-view via openLibraryForm (⭐收藏 / 入库). */
  libraryForm: LibraryFormState;
  /** One-shot cross-view jump target: SessionsView consumes it (expand pagination, clear filter, flash). */
  pendingScrollMsgId: string | null;
  /** Sidebar toggles (sessions view): 5s list polling + SSE tail / scroll-to-top on new messages. */
  autoRefresh: boolean;
  autoScroll: boolean;
  /** 运行时平台列表（GET /api/platforms，含 broken）；拉取失败保持内置降级表。 */
  platforms: PlatformInfo[];
  /** /api/platforms 拉取失败的错误信息（有则展示降级提示）。 */
  platformsError: string | null;

  /** 写入运行时平台列表，并把当前平台选择收敛到可查询集合（见实现注释）。 */
  setPlatforms: (infos: PlatformInfo[], error?: string | null) => void;
  setPlatform: (platform: Platform) => void;
  /** 切换某个平台是否被选入聚合视图；保持至少一个平台（取消最后一个会退回单平台模式）。
   *  返回新的选中集合。 */
  togglePlatform: (platform: Platform) => void;
  /** 全部平台一次选中（聚合视图）。 */
  selectAllPlatforms: () => void;
  /** 切换分组模式。 */
  setGroupBy: (groupBy: GroupBy) => void;
  /** 切换某项目是否被项目筛选选中。 */
  toggleProjectFilter: (project: string) => void;
  /** 重置项目筛选为「全部项目」。 */
  clearProjectFilter: () => void;
  /** 切换分组模式下某个组名的折叠状态（name 已带 kind: 前缀）。 */
  toggleGroupCollapsed: (mode: GroupBy, name: string) => void;
  /** 设置桌面端左侧菜单折叠（持久化）。 */
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** 拖拽侧栏宽度（持久化，自动收敛到 200–480）。 */
  setSidebarWidth: (width: number) => void;
  /** 设置会话详情上下文（来源平台/agent），不动筛选上下文。聚合视图点击/⌘K/分析跳转用。 */
  setDetailContext: (platform: Platform, agent: string) => void;
  setSelectedAgent: (agent: string) => void;
  setSelectedSessionId: (id: string) => void;
  saveSettings: (settings: DirSettings) => void;
  setView: (view: MainView) => void;
  setInsightsScope: (scope: InsightsScope) => void;
  setSessionView: (view: SessionView) => void;
  setViewingChildAgent: (name: string | null) => void;
  openLibraryForm: (prefill?: LibraryFormPrefill | null, isEdit?: boolean) => void;
  closeLibraryForm: () => void;
  /** Cross-view jump-to-message: lands on 会话 view, messages sub-view; SessionsView scrolls + clears. */
  requestScrollToMessage: (id: string) => void;
  clearPendingScrollMsgId: () => void;
  setAutoRefresh: (value: boolean) => void;
  setAutoScroll: (value: boolean) => void;
}

const initial = loadPersisted();
const urlDetail = parseDetailFromUrl();
// 右侧视图页签初始值：URL > localStorage > 默认 sessions。
const urlView = parseViewFromUrl();

export const useAppStore = create<AppState>((set, get) => ({
  platform: initial.platform,
  selectedPlatforms: initial.selectedPlatforms,
  groupBy: initial.groupBy,
  projectFilter: initial.projectFilter,
  collapsedGroups: initial.collapsedGroups,
  sidebarCollapsed: initial.sidebarCollapsed,
  sidebarWidth: initial.sidebarWidth,
  hasStoredPlatform: initial.hasStoredPlatform,
  detailPlatform: urlDetail.detailPlatform ?? initial.platform,
  detailAgent: urlDetail.detailAgent ?? '',
  selectedAgent: '',
  // 刷新默认进入 URL 指定的会话详情；无则空（列表自动选首个）。
  selectedSessionId: urlDetail.selectedSessionId ?? '',
  settings: initial.settings,
  view: urlView ?? initial.view,
  insightsScope: null,
  sessionView: 'messages',
  viewingChildAgent: null,
  libraryForm: { open: false, editingName: null, prefill: null, openSeq: 0 },
  pendingScrollMsgId: null,
  autoRefresh: true,
  autoScroll: false,
  platforms: FALLBACK_PLATFORM_INFOS,
  platformsError: null,

  setPlatforms: (infos, error = null) => {
    const state = get();
    const ids = new Set(selectablePlatformIds(infos));
    // 单平台：当前平台失效（如自定义平台文件被删/broken）→ 回退默认平台。
    let platform = state.platform;
    if (!ids.has(platform)) {
      platform = ids.has('openclaw') ? 'openclaw' : (DEMO ? 'claude-code' : selectablePlatformIds(infos)[0] ?? 'openclaw');
    }
    // 多选：显式子集只剔除失效项；默认「全部」（选择数与加载前可查询数一致）扩展到
    // 运行时列表（含新增自定义平台）；单平台模式（[]）保持，除非当前平台失效。
    let selectedPlatforms = state.selectedPlatforms;
    if (selectedPlatforms.length > 0) {
      const kept = selectedPlatforms.filter((p) => ids.has(p));
      const beforeCount = selectablePlatformIds(state.platforms).length;
      const wasAll = selectedPlatforms.length === beforeCount;
      selectedPlatforms = kept.length === 0 || wasAll ? selectablePlatformIds(infos) : kept;
    }
    const detailPlatform = ids.has(state.detailPlatform) ? state.detailPlatform : platform;
    const changed =
      platform !== state.platform ||
      selectedPlatforms.join('|') !== state.selectedPlatforms.join('|') ||
      detailPlatform !== state.detailPlatform;
    set({ platforms: infos, platformsError: error, platform, selectedPlatforms, detailPlatform });
    // 收敛导致选择变化时回写持久化（localStorage + 服务端 ui-settings），保持单选/多选一致。
    if (changed) persistState();
  },
  setPlatform: (platform) => {
    if (platform === get().platform && get().selectedPlatforms.length === 0) return;
    // Mirrors legacy platform switch: clear agent/session selection.
    set({
      platform,
      selectedPlatforms: [],
      hasStoredPlatform: true,
      detailPlatform: platform,
      detailAgent: '',
      selectedAgent: '',
      selectedSessionId: '',
      sessionView: 'messages',
      viewingChildAgent: null,
    });
    persistState();
  },
  togglePlatform: (p) => {
    const cur = get().selectedPlatforms;
    const currentPlatform = get().platform;
    if (cur.length === 0) {
      // 单平台模式：点当前平台无操作；点其他平台 → 保留主平台进入多选
      if (p === currentPlatform) return;
      set({
        selectedPlatforms: [currentPlatform, p],
        selectedAgent: '',
        selectedSessionId: '',
        sessionView: 'messages',
        viewingChildAgent: null,
      });
      persistState();
      return;
    }
    if (!cur.includes(p)) {
      // 加入平台
      set({ selectedPlatforms: [...cur, p], selectedAgent: '', selectedSessionId: '', sessionView: 'messages', viewingChildAgent: null });
      persistState();
      return;
    }
    // 取消一个：只剩一个时退回单平台该平台
    const rest = cur.filter((x) => x !== p);
    if (rest.length === 0) {
      set({
        platform: p,
        selectedPlatforms: [],
        hasStoredPlatform: true,
        detailPlatform: p,
        detailAgent: '',
        selectedAgent: '',
        selectedSessionId: '',
        sessionView: 'messages',
        viewingChildAgent: null,
      });
      persistState();
      return;
    }
    if (rest.length === 1) {
      set({
        platform: rest[0],
        selectedPlatforms: [],
        hasStoredPlatform: true,
        detailPlatform: rest[0],
        detailAgent: '',
        selectedAgent: '',
        selectedSessionId: '',
        sessionView: 'messages',
        viewingChildAgent: null,
      });
      persistState();
      return;
    }
    set({ selectedPlatforms: rest, selectedAgent: '', selectedSessionId: '', sessionView: 'messages', viewingChildAgent: null });
    persistState();
  },
  selectAllPlatforms: () => {
    set({
      selectedPlatforms: selectablePlatformIds(get().platforms),
      selectedAgent: '',
      selectedSessionId: '',
      sessionView: 'messages',
      viewingChildAgent: null,
    });
    persistState();
  },
  setGroupBy: (groupBy) => {
    if (get().groupBy === groupBy) return;
    set({ groupBy });
    persistState();
  },
  toggleProjectFilter: (project) => {
    const cur = get().projectFilter;
    const next = cur.includes(project) ? cur.filter((x) => x !== project) : [...cur, project];
    set({ projectFilter: next });
    persistState();
  },
  clearProjectFilter: () => {
    if (get().projectFilter.length === 0) return;
    set({ projectFilter: [] });
    persistState();
  },
  toggleGroupCollapsed: (mode, name) => {
    const cur = get().collapsedGroups[mode];
    const next = cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name];
    set({ collapsedGroups: { ...get().collapsedGroups, [mode]: next } });
    persistState();
  },
  setSidebarCollapsed: (collapsed) => {
    if (get().sidebarCollapsed === collapsed) return;
    set({ sidebarCollapsed: collapsed });
    persistState();
  },
  setSidebarWidth: (width) => {
    const next = clampSidebarWidth(Math.round(width));
    if (get().sidebarWidth === next) return;
    set({ sidebarWidth: next });
    persistState();
  },
  /** 设置会话详情上下文（来源平台/agent），不动筛选上下文。聚合视图点击/⌘K/分析跳转用。 */
  setDetailContext: (platform, agent) => set({ detailPlatform: platform, detailAgent: agent }),
  setSelectedAgent: (agent) =>
    set({ selectedAgent: agent, detailAgent: agent, selectedSessionId: '', viewingChildAgent: null }),
  setSelectedSessionId: (id) => set({ selectedSessionId: id, viewingChildAgent: null }),
  saveSettings: (settings) => {
    set({ settings });
    persistState();
  },
  setView: (view) => {
    // 右侧视图页签切换 → 持久化 localStorage + URL（URL 写入由订阅 syncSessionUrl 统一处理）。
    if (get().view === view) return;
    set({ view });
    persistState();
  },
  setInsightsScope: (scope) => set({ insightsScope: scope }),
  setSessionView: (view) => set({ sessionView: view }),
  // Opening a child transcript lands on messages (legacy viewChildAgent forces sessionView='messages')
  setViewingChildAgent: (name) =>
    set(name ? { viewingChildAgent: name, sessionView: 'messages' } : { viewingChildAgent: null }),
  openLibraryForm: (prefill = null, isEdit = false) =>
    set((s) => ({
      libraryForm: {
        open: true,
        editingName: isEdit && prefill?.name ? prefill.name : null,
        prefill,
        openSeq: s.libraryForm.openSeq + 1,
      },
    })),
  closeLibraryForm: () => set((s) => ({ libraryForm: { ...s.libraryForm, open: false } })),
  requestScrollToMessage: (id) =>
    set({ view: 'sessions', sessionView: 'messages', pendingScrollMsgId: id }),
  clearPendingScrollMsgId: () => set({ pendingScrollMsgId: null }),
  setAutoRefresh: (value) => set({ autoRefresh: value }),
  setAutoScroll: (value) => set({ autoScroll: value }),
}));

// 详情上下文 / 右侧视图页签任一变化 → 同步回 URL（路由持久化）。
useAppStore.subscribe(syncSessionUrl);
