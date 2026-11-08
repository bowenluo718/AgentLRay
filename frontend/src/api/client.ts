// Typed fetchers for every AgentLRay backend endpoint.
// Mirrors public/js/app.js fetch behavior: non-2xx → throw Error(body.error || statusText).

import type {
  ChildAgentSummary,
  HiddenPromptsData,
  HidePromptsResult,
  Insights,
  OtlpExport,
  Platform,
  PlatformInfo,
  PromptAnalysis,
  PromptsData,
  RewriteResult,
  SearchResult,
  SessionDetail,
  SessionSummary,
  SessionsListResponse,
  SpawnLink,
  SpawnTreeResult,
  ToolsAudit,
  VersionInfo,
} from './types';
import { DEMO } from '@/demo/flag';
import { demoJson } from '@/demo/router';

/**
 * Per-platform log-directory overrides (settings dialog). Empty string = default.
 * 键为 PlatformInfo.dirSettingKey（如 openclawDir / codexDir …），宽度为 string
 * 以容纳运行时新增/移除平台与自定义平台的目录键。
 */
export type DirSettings = Record<string, string>;

type ParamValue = string | number | boolean | undefined | null;

function withParams(path: string, params: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  if (DEMO) return demoJson<T>(url, init);
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

function requestJson<T>(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// ---------- Platforms ----------

/** GET /api/platforms — 内置 + 自定义 + broken 一体列表（服务端驱动单一真源）。 */
export function fetchPlatforms(): Promise<PlatformInfo[]> {
  return fetchJson('/api/platforms');
}

/** PUT /api/platforms/:id/mount — 启用平台挂载（settings.platforms.disabled 移除该 id）。
 *  成功响应为与 GET /api/platforms 同形状的完整列表（可直接复用，无需再查）。 */
export function setPlatformMounted(id: string, mounted: boolean): Promise<PlatformInfo[]> {
  return requestJson(`/api/platforms/${encodeURIComponent(id)}/mount`, mounted ? 'PUT' : 'DELETE');
}

/** PUT /api/platforms/:id/replace — 声明/撤销包内置换（包内置被项目/用户适配器覆盖）。 */
export function setPlatformReplaced(id: string, replaced: boolean): Promise<PlatformInfo[]> {
  return requestJson(`/api/platforms/${encodeURIComponent(id)}/replace`, replaced ? 'PUT' : 'DELETE');
}

// ---------- Sessions ----------

/** GET /api/:platform/agents — 枚举平台 agent（needsAgent 平台，如 openclaw）。 */
export function getAgents(platform: Platform, dir?: string): Promise<string[]> {
  return fetchJson(withParams(`/api/${encodeURIComponent(platform)}/agents`, { dir }));
}

/**
 * List sessions. 统一走通用路由 `/api/:platform/sessions`。
 * needsAgent 平台（openclaw）传 agent 查单 agent；缺省（agent 为空）查该平台全部
 * agents 的合并会话（后端通用路由按需处理，每条带来源 agent 字段）。
 */
export function getSessions(
  platform: Platform,
  opts: { agent?: string; dir?: string } = {}
): Promise<SessionSummary[]> {
  return fetchJson(withParams(`/api/${encodeURIComponent(platform)}/sessions`, { dir: opts.dir, agent: opts.agent }));
}

/**
 * Multi-platform session list (GET /api/sessions?platform=a,b|all…). Returns one
 * block per platform (needsAgent platform without `agent` → one block per agent).
 * `platforms` 缺省 = all（全部平台）。
 * 目录覆盖用 per-platform `dirParam`（PlatformInfo.dirParam，如 dirOpenclaw），
 * 由调用方把各可查询平台的目录值按 dirParam 组装成 dirsByPlatform 传入。
 */
export function getSessionsAll(
  opts: {
    platforms?: Platform[];
    agent?: string;
    /** 各平台的目录覆盖：[dirParam] → 目录值（如 { dirCodex: '…' }）。 */
    dirsByPlatform?: Record<string, string>;
    status?: string;
    match?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<SessionsListResponse> {
  // platforms 缺省/空数组 = 全部平台（`platform=all`）；非空子集用逗号拼接。
  const allPlatforms = !opts.platforms || opts.platforms.length === 0;
  const params: Record<string, ParamValue> = {
    platform: allPlatforms ? 'all' : (opts.platforms ?? []).join(','),
    agent: opts.agent || undefined,
    status: opts.status,
    match: opts.match,
    limit: opts.limit,
    offset: opts.offset,
  };
  for (const [param, dir] of Object.entries(opts.dirsByPlatform ?? {})) {
    if (dir) params[param] = dir;
  }
  return fetchJson<SessionsListResponse>(withParams('/api/sessions', params));
}

export function getSessionDetail(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string } = {}
): Promise<SessionDetail> {
  // 统一走通用路由 `/api/:platform/sessions/:id`；needsAgent 平台（openclaw）
  // 传 agent 时后端按 agent 定位，缺省跨全部 agents 查找。
  return fetchJson(
    withParams(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}`, {
      dir: opts.dir,
      agent: opts.agent,
    })
  );
}

/** GET /api/:platform/sessions/:id/resume-command — 会话详情「复制恢复命令」。
 * 命令串与 CLI（bin/sessions.js resume）同源（后端 lib/resume.js 单一真源），
 * 自定义平台（适配器 resume opt-in）的 args 是后端 JS，前端无法本地拼，必须走后端。
 * supported=false（平台无原生续跑契约）时无 command。 */
export interface ResumeCommandResult {
  supported: boolean;
  bin?: string;
  args?: string[];
  command?: string;
  error?: string;
}

/** 复制在终端恢复指定会话的命令；cwd 缺省时命令不含 cd 前缀。 */
export function getResumeCommand(
  platform: Platform,
  sessionId: string,
  cwd?: string | null
): Promise<ResumeCommandResult> {
  return fetchJson(
    withParams(
      `/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/resume-command`,
      { cwd: cwd || undefined }
    )
  );
}

/** POST /api/:platform/sessions/new — 看板「新建任务」触发新建会话。
 * 命令串与 spawn 逻辑与 CLI（bin/sessions.js new）同源（后端 lib/new.js 单一真源），
 * 前端不本地拼命令，只消费后端返回（供展示/手动复制）。 */
export interface CreateSessionResult {
  triggered: boolean;
  platform: string;
  bin: string;
  args: string[];
  command: string;
}

/** 触发平台新建会话（fire-and-forget）；message/cwd 均可空。 */
export function createSession(
  platform: Platform,
  body: { message?: string; cwd?: string } = {}
): Promise<CreateSessionResult> {
  return requestJson(`/api/${encodeURIComponent(platform)}/sessions/new`, 'POST', body);
}

/** Spawned sub-agents of a session (capabilities.children 平台，如 omp / claude-code）。 */
export function getSessionChildren(
  platform: Platform,
  sessionId: string,
  dir?: string
): Promise<ChildAgentSummary[]> {
  return fetchJson(
    withParams(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/children`, { dir })
  );
}

export function getSessionChild(
  platform: Platform,
  sessionId: string,
  childName: string,
  dir?: string
): Promise<SessionDetail> {
  return fetchJson(
    withParams(
      `/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childName)}`,
      { dir }
    )
  );
}

// ---------- Spawn map / tree ----------

export function getSpawnMap(platform: Platform, dir?: string): Promise<SpawnLink[]> {
  return fetchJson(withParams(`/api/${encodeURIComponent(platform)}/spawn-map`, { dir }));
}

export function getSpawnTree(platform: Platform, sessionId: string, dir?: string): Promise<SpawnTreeResult> {
  return fetchJson(
    withParams(`/api/${encodeURIComponent(platform)}/spawn-tree/${encodeURIComponent(sessionId)}`, { dir })
  );
}

// ---------- Insights ----------

export function getInsights(opts: { platform: Platform; agent?: string; dir?: string }): Promise<Insights> {
  // Note: legacy app.js passes dirParam() ("?dir=…") as the dir value here — a bug.
  // We pass the raw directory.
  return fetchJson(
    withParams('/api/insights', { platform: opts.platform, agent: opts.agent, dir: opts.dir })
  );
}

// ---------- Prompts ----------

export function getPrompts(opts: { platform: Platform; agent?: string; dir?: string }): Promise<PromptsData> {
  return fetchJson(
    withParams('/api/prompts', { platform: opts.platform, agent: opts.agent, dir: opts.dir })
  );
}

/**
 * Template clustering + attribution + LLM suggestions.
 * `cached: true` probes the persisted analysis only — resolves null on 204/anything but 200.
 * `refresh: true` forces recompute; `skipLlm: true` clusters without Claude suggestions.
 */
export async function getPromptAnalysis(opts: {
  platform: Platform;
  agent?: string;
  dir?: string;
  cached?: boolean;
  refresh?: boolean;
  skipLlm?: boolean;
}): Promise<PromptAnalysis | null> {
  const url = withParams('/api/prompts/analyze', {
    platform: opts.platform,
    agent: opts.agent,
    dir: opts.dir,
    cached: opts.cached,
    refresh: opts.refresh,
    skipLlm: opts.skipLlm,
  });
  if (opts.cached) {
    if (DEMO) return null; // nothing persisted in demo mode
    const resp = await fetch(url);
    if (resp.status !== 200) return null;
    return (await resp.json()) as PromptAnalysis;
  }
  return fetchJson(url);
}

export function rewritePrompt(text: string): Promise<RewriteResult> {
  return requestJson('/api/prompts/rewrite', 'POST', { text });
}

export function getHiddenPrompts(): Promise<HiddenPromptsData> {
  return fetchJson('/api/prompts/hidden');
}

/** Hide one prompt ({text}) or a batch ({texts}, ≤500 per call). */
export function hidePrompts(body: { text: string } | { texts: string[] }): Promise<HidePromptsResult> {
  return requestJson('/api/prompts/hidden', 'POST', body);
}

export function unhidePrompt(hash: string): Promise<{ hidden: number }> {
  return requestJson(`/api/prompts/hidden/${encodeURIComponent(hash)}`, 'DELETE');
}

// ---------- Tools audit ----------

/** Cross-platform tool health check. Resolves null on 204 (cached probe, nothing persisted yet).
 *  per-platform 目录覆盖以 dirsByParam 字典传入（键 = PlatformInfo.dirParam，运行时平台列表驱动）。 */
export async function getToolsAudit(opts: {
  dirs?: Record<string, string>;
  refresh?: boolean;
}): Promise<ToolsAudit | null> {
  const url = withParams('/api/tools/audit', {
    platform: 'all',
    ...(opts.dirs ?? {}),
    [opts.refresh ? 'refresh' : 'cached']: true,
  });
  if (DEMO) return null; // no persisted audit in demo mode
  const resp = await fetch(url);
  if (resp.status === 204) return null;
  if (!resp.ok) {
    const body = (await resp.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || resp.statusText);
  }
  return (await resp.json()) as ToolsAudit;
}

// ---------- Search ----------

/** Full-text search across every platform (multi-keyword AND), with per-platform dir
 *  overrides passed as dirParam-keyed map (from dirsByParam, 运行时平台列表驱动)。 */
export function searchSessions(q: string, dirs?: Record<string, string>): Promise<SearchResult[]> {
  return fetchJson(
    withParams('/api/search', {
      q,
      platform: 'all',
      ...(dirs ?? {}),
    })
  );
}


export function getOtlp(platform: Platform, sessionId: string, dir?: string): Promise<OtlpExport> {
  return fetchJson(
    withParams(
      `/api/otlp/${encodeURIComponent(platform)}/${encodeURIComponent(sessionId)}`,
      { dir }
    )
  );
}

export function getVersion(): Promise<VersionInfo> {
  return fetchJson('/api/version');
}

// ---------- 统一设置端点 ----------
// 所有服务端设置聚合到单一 GET/PUT /api/settings（落盘 ~/.agentlray/settings.json，
// 各 section 白名单/校验在对应 lib 模块）。GET 全量返回；PUT 只保存请求体提供的
// section（ui / cliBins / status / kanban / llm），原子写入。LLM 密钥永不明文回传。
export interface LlmSettings {
  baseUrl: string;
  model: string;
  /** true when an API key is stored (the key itself never leaves the server) */
  hasApiKey: boolean;
  /** 提示词画像分析单次 LLM 请求的实际生效超时（毫秒，未配置时回默认 900s） */
  analysisTimeoutMs: number;
  /** which backend prompt tooling would use right now */
  backend: 'openai' | 'claude-cli' | null;
}

/** 平台 CLI 命令配置（key = 平台 id）。GET 目前只回传内置六平台
 *  （codex / claude-code / omp / dsh / gemini / hermes）；自定义平台 id 的 bin 由后端 resolveCliBin 从
 *  `~/.agentlray/settings.json` 的 cliBins section 手工配置键读取。 */
export type CliBins = Partial<Record<string, CliBinSetting>>;

export interface CliBinSetting {
  /** 当前生效的可执行命令（配置值或默认名） */
  bin: string;
  /** 是否已在设置面板显式配置（false = 回退默认命令名） */
  configured: boolean;
  /** 默认命令名（未配置时的回退） */
  default: string;
}

export interface StatusConfigSetting {
  /** 当前生效的时间窗口（毫秒，配置值或默认值） */
  value: number;
  /** 是否已在设置面板显式配置（false = 回退默认） */
  configured: boolean;
  /** 默认值（毫秒） */
  default: number;
}

export type StatusConfig = Partial<Record<'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', StatusConfigSetting>>;

export interface KanbanSetting {
  /** 当前生效的每列最多条数（配置值或默认值） */
  value: number;
  /** 是否已在设置面板显式配置（false = 回退默认） */
  configured: boolean;
  /** 默认值（20） */
  default: number;
}

export type KanbanConfig = Partial<{ maxPerStatus: KanbanSetting }>;

export interface UiSettings {
  platform: Platform | null;
  selectedPlatforms: Platform[];
}

/** GET /api/settings 全量响应（web 设置面板一次读齐所有 section）。 */
export interface AllSettings {
  ui: UiSettings;
  cliBins: CliBins;
  status: StatusConfig;
  kanban: KanbanConfig;
  llm: LlmSettings;
}

export function getSettings(): Promise<AllSettings> {
  return fetchJson('/api/settings');
}

/** PUT /api/settings 可选项：只含已编辑的 section，未提供者原样保留。 */
export type SettingsPatch = {
  ui?: { platform: Platform; selectedPlatforms: Platform[] };
  cliBins?: Partial<Record<string, string>>;
  status?: Partial<Record<'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', number>>;
  kanban?: { maxPerStatus?: number };
  llm?: { baseUrl: string; model: string; apiKey?: string; analysisTimeoutMs?: number };
};

/** 空串 = 清除该平台配置（回退默认命令名）。 */
export function saveSettings(body: SettingsPatch): Promise<AllSettings> {
  return requestJson('/api/settings', 'PUT', body);
}

/** 平台 CLI 命令配置（视图/复制恢复命令用）：从统一设置端点切片。 */
export async function getCliBins(): Promise<CliBins> {
  return (await getSettings()).cliBins;
}

/** 任务看板每列条数（视图截断用）：从统一设置端点切片。 */
export async function getKanbanConfig(): Promise<KanbanConfig> {
  return (await getSettings()).kanban;
}

/** 平台选择同步（store 在平台选择变化时调用）：写服务端 ui section，
 *  CLI（bin/sessions.js）未传 --platform 时读同一 section 作为默认。 */
export function saveUiSettings(body: { platform: Platform; selectedPlatforms: Platform[] }): Promise<AllSettings> {
  return requestJson('/api/settings', 'PUT', { ui: body });
}

/** URL for the server-side session export (Markdown / standalone HTML download). */
export function exportUrl(
  platform: Platform,
  sessionId: string,
  format: 'md' | 'html',
  opts: { agent?: string; dir?: string } = {}
): string {
  return withParams(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/export`, {
    format,
    agent: opts.agent,
    dir: opts.dir,
  });
}

/** URL for the real-time tail EventSource (GET /api/watch, SSE — consumed via new EventSource()). */
export function watchUrl(opts: {
  platform: Platform;
  sessionId: string;
  agent?: string;
  dir?: string;
}): string {
  return withParams('/api/watch', {
    platform: opts.platform,
    sessionId: opts.sessionId,
    agent: opts.agent,
    dir: opts.dir,
  });
}
