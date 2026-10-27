import { create } from 'zustand';
import { saveUiSettings } from '@/api/client';
import type { DirSettings } from '@/api/client';
import type { Platform } from '@/api/types';
import { PLATFORMS } from '@/api/types';
import { DEMO } from '@/demo/flag';

// Settings persist to the SAME localStorage key/shape as the legacy app
// (public/js/app.js SETTINGS_KEY) so both UIs share settings:
//   { openclawDir, codexDir, claudeCodeDir, hermesDir, ompDir, platform }
export const SETTINGS_KEY = 'agent-xray-settings';

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
  } = {
    settings: { ...EMPTY_SETTINGS },
    platform: defaultPlatform,
    hasStoredPlatform: false,
    // 无持久化选择时默认「全部平台」（聚合视图）。
    selectedPlatforms: [...PLATFORMS],
    groupBy: 'none',
    projectFilter: [],
    collapsedGroups: { platform: [], project: [], none: [] },
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
      if (PLATFORMS.includes(parsed.platform as Platform)) {
        result.platform = parsed.platform as Platform;
        result.hasStoredPlatform = true;
      }
      // 显式持久化的平台多选与 UI 偏好（旧存储无这些键 → 各自默认值）。
      if (Array.isArray(parsed.selectedPlatforms)) {
        const picked = parsed.selectedPlatforms.filter((p): p is Platform => PLATFORMS.includes(p as Platform));
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
    }
  } catch {
    /* corrupted storage — fall back to defaults */
  }
  return result;
}

export type MainView = 'sessions' | 'insights' | 'prompts' | 'library';
export type InsightsScope = 'global' | 'session';
export type SessionView = 'messages' | 'trace';
/** 侧栏会话列表分组模式：按平台 / 按项目 / 不分组。 */
export type GroupBy = 'platform' | 'project' | 'none';

// —— 路由持久化：会话详情 ↔ URL query（?session=&sid=&agent=）——
// 点击会话查看详情时把详情上下文写进 URL；刷新后从 URL 恢复「正在查看的会话详情」。
// 用 replaceState 不产生历史栈噪音；筛选/分组配置仍走 localStorage，两者独立。
const URL_PARAM_SESSION = 'session'; // 平台
const URL_PARAM_SID = 'sid'; // 会话 id（URLSearchParams 自动编解码）
const URL_PARAM_AGENT = 'agent'; // openclaw 归属 agent（可选）

/** 从当前 URL 解析详情上下文（无参数/平台非法 → 空）。 */
function parseDetailFromUrl(): { detailPlatform?: Platform; detailAgent?: string; selectedSessionId?: string } {
  if (DEMO) return {};
  try {
    const params = new URLSearchParams(window.location.search);
    const platform = params.get(URL_PARAM_SESSION);
    const sid = params.get(URL_PARAM_SID);
    if (!platform || !PLATFORMS.includes(platform as Platform) || !sid) return {};
    return {
      detailPlatform: platform as Platform,
      detailAgent: params.get(URL_PARAM_AGENT) || '',
      selectedSessionId: sid,
    };
  } catch {
    return {};
  }
}

let lastSessionUrlKey = '';
/** 把当前详情上下文写回（或清出）URL；带值缓存避免重复 replaceState。 */
function syncSessionUrl(): void {
  const st = useAppStore.getState();
  const { detailPlatform, detailAgent, selectedSessionId } = st;
  const key = selectedSessionId ? `${detailPlatform}|${detailAgent}|${selectedSessionId}` : '';
  if (key === lastSessionUrlKey) return;
  lastSessionUrlKey = key;
  try {
    const params = new URLSearchParams(window.location.search);
    if (!selectedSessionId) {
      params.delete(URL_PARAM_SESSION);
      params.delete(URL_PARAM_SID);
      params.delete(URL_PARAM_AGENT);
      const qs = params.toString();
      window.history.replaceState(null, '', qs ? `${window.location.pathname}?${qs}` : window.location.pathname);
    } else {
      params.set(URL_PARAM_SESSION, detailPlatform);
      params.set(URL_PARAM_SID, selectedSessionId);
      if (detailAgent) params.set(URL_PARAM_AGENT, detailAgent);
      else params.delete(URL_PARAM_AGENT);
      window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
    }
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

export const useAppStore = create<AppState>((set, get) => ({
  platform: initial.platform,
  selectedPlatforms: initial.selectedPlatforms,
  groupBy: initial.groupBy,
  projectFilter: initial.projectFilter,
  collapsedGroups: initial.collapsedGroups,
  hasStoredPlatform: initial.hasStoredPlatform,
  detailPlatform: urlDetail.detailPlatform ?? initial.platform,
  detailAgent: urlDetail.detailAgent ?? '',
  selectedAgent: '',
  // 刷新默认进入 URL 指定的会话详情；无则空（列表自动选首个）。
  selectedSessionId: urlDetail.selectedSessionId ?? '',
  settings: initial.settings,
  view: 'sessions',
  insightsScope: null,
  sessionView: 'messages',
  viewingChildAgent: null,
  libraryForm: { open: false, editingName: null, prefill: null, openSeq: 0 },
  pendingScrollMsgId: null,
  autoRefresh: true,
  autoScroll: false,

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
      selectedPlatforms: [...PLATFORMS],
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
  /** 设置会话详情上下文（来源平台/agent），不动筛选上下文。聚合视图点击/⌘K/分析跳转用。 */
  setDetailContext: (platform, agent) => set({ detailPlatform: platform, detailAgent: agent }),
  setSelectedAgent: (agent) =>
    set({ selectedAgent: agent, detailAgent: agent, selectedSessionId: '', viewingChildAgent: null }),
  setSelectedSessionId: (id) => set({ selectedSessionId: id, viewingChildAgent: null }),
  saveSettings: (settings) => {
    set({ settings });
    persistState();
  },
  setView: (view) => set({ view }),
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

// 详情上下文任一变化（选中会话/切详情平台/agent、或清空选中）→ 同步回 URL（路由持久化）。
useAppStore.subscribe(syncSessionUrl);
