// Typed fetchers for every AgentLRay backend endpoint.
// Mirrors public/js/app.js fetch behavior: non-2xx → throw Error(body.error || statusText).

import type {
  BackupResult,
  BackupStatus,
  ChildAgentSummary,
  FabricPatternsData,
  HiddenPromptsData,
  HidePromptsResult,
  ImportFabricResult,
  Insights,
  InstallTarget,
  LibraryData,
  LibraryHistoryData,
  LibraryHistoryEntry,
  LibraryUsageData,
  OtlpExport,
  Platform,
  PromptAnalysis,
  PromptsData,
  RewriteResult,
  SearchResult,
  SessionDetail,
  SessionSummary,
  SessionsListResponse,
  SpawnLink,
  SpawnTreeResult,
  SuggestNameResult,
  ToolsAudit,
  VersionInfo,
} from './types';
import { PLATFORMS } from './types';
import { DEMO } from '@/demo/flag';
import { demoJson } from '@/demo/router';

/** Per-platform log-directory overrides (settings dialog). Empty string = default. */
export interface DirSettings {
  openclawDir: string;
  codexDir: string;
  claudeCodeDir: string;
  hermesDir: string;
  ompDir: string;
  dshDir: string;
  geminiDir: string;
}

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

// ---------- Sessions ----------

export function getAgents(dir?: string): Promise<string[]> {
  return fetchJson(withParams('/api/agents', { dir }));
}

/**
 * List sessions. openclaw：传 agent 查单 agent；缺省（agent 为空）查该平台全部
 * agents 的合并会话（后端 /api/openclaw/sessions —— 每条带来源 agent，这里补
 * platform 标记以便按 agent 分组）。其他平台忽略 agent。
 */
export function getSessions(
  platform: Platform,
  opts: { agent?: string; dir?: string } = {}
): Promise<SessionSummary[]> {
  if (platform === 'openclaw') {
    const params = { dir: opts.dir };
    if (opts.agent) {
      return fetchJson(withParams(`/api/agents/${encodeURIComponent(opts.agent)}/sessions`, params));
    }
    return fetchJson<SessionSummary[]>(withParams('/api/openclaw/sessions', params)).then((sessions) =>
      sessions.map((s) => ({ ...s, platform: 'openclaw' as Platform }))
    );
  }
  return fetchJson(withParams(`/api/${platform}/sessions`, { dir: opts.dir }));
}

// SettingsDialog dir keys → multi-platform API per-platform dir params.
const ALL_DIR_PARAMS: Record<keyof DirSettings, string> = {
  openclawDir: 'dirOpenclaw',
  codexDir: 'dirCodex',
  claudeCodeDir: 'dirClaude',
  hermesDir: 'dirHermes',
  ompDir: 'dirOmp',
  dshDir: 'dirDsh',
  geminiDir: 'dirGemini',
};

/**
 * Multi-platform session list (GET /api/sessions?platform=a,b|all…). Returns one
 * block per platform (openclaw without `agent` → one block per agent).
 * `platforms` 缺省 = all（全部平台）。
 */
export function getSessionsAll(
  opts: {
    platforms?: Platform[];
    agent?: string;
    dirs?: Partial<DirSettings>;
    status?: string;
    match?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<SessionsListResponse> {
  const allPlatforms = !opts.platforms || opts.platforms.length === PLATFORMS.length;
  const params: Record<string, ParamValue> = {
    platform: allPlatforms ? 'all' : opts.platforms!.join(','),
    agent: opts.agent || undefined,
    status: opts.status,
    match: opts.match,
    limit: opts.limit,
    offset: opts.offset,
  };
  for (const [key, param] of Object.entries(ALL_DIR_PARAMS)) {
    const dir = opts.dirs?.[key as keyof DirSettings];
    if (dir) params[param] = dir;
  }
  return fetchJson<SessionsListResponse>(withParams('/api/sessions', params));
}

export function getSessionDetail(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string; dir?: string } = {}
): Promise<SessionDetail> {
  // openclaw：传 agent 走 per-agent 端点；缺省跨全部 agents 查找（/api/openclaw/sessions/:id）。
  const base =
    platform === 'openclaw' && !opts.agent
      ? '/api/openclaw/sessions'
      : platform === 'openclaw'
        ? `/api/agents/${encodeURIComponent(opts.agent || '')}/sessions`
        : `/api/${platform}/sessions`;
  return fetchJson(withParams(`${base}/${encodeURIComponent(sessionId)}`, { dir: opts.dir }));
}

/** Spawned sub-agents of a session (omp / claude-code only). */
export function getSessionChildren(
  platform: 'omp' | 'claude-code',
  sessionId: string,
  dir?: string
): Promise<ChildAgentSummary[]> {
  return fetchJson(
    withParams(`/api/${platform}/sessions/${encodeURIComponent(sessionId)}/children`, { dir })
  );
}

export function getSessionChild(
  platform: 'omp' | 'claude-code',
  sessionId: string,
  childName: string,
  dir?: string
): Promise<SessionDetail> {
  return fetchJson(
    withParams(
      `/api/${platform}/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childName)}`,
      { dir }
    )
  );
}

// ---------- Spawn map / tree ----------

export function getSpawnMap(dir?: string): Promise<SpawnLink[]> {
  return fetchJson(withParams('/api/spawn-map', { dir }));
}

export function getSpawnTree(sessionId: string, dir?: string): Promise<SpawnTreeResult> {
  return fetchJson(withParams(`/api/spawn-tree/${encodeURIComponent(sessionId)}`, { dir }));
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

/** Cross-platform tool health check. Resolves null on 204 (cached probe, nothing persisted yet). */
export async function getToolsAudit(opts: {
  dirs?: Partial<DirSettings>;
  refresh?: boolean;
}): Promise<ToolsAudit | null> {
  const url = withParams('/api/tools/audit', {
    platform: 'all',
    dirOpenclaw: opts.dirs?.openclawDir,
    dirCodex: opts.dirs?.codexDir,
    dirClaude: opts.dirs?.claudeCodeDir,
    dirOmp: opts.dirs?.ompDir,
    dirDsh: opts.dirs?.dshDir,
    dirGemini: opts.dirs?.geminiDir,
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

/** Full-text search across every platform (multi-keyword AND), with per-platform dir overrides. */
export function searchSessions(q: string, dirs?: Partial<DirSettings>): Promise<SearchResult[]> {
  return fetchJson(
    withParams('/api/search', {
      q,
      platform: 'all',
      dirOpenclaw: dirs?.openclawDir,
      dirCodex: dirs?.codexDir,
      dirClaude: dirs?.claudeCodeDir,
      dirHermes: dirs?.hermesDir,
      dirOmp: dirs?.ompDir,
      dirDsh: dirs?.dshDir,
      dirGemini: dirs?.geminiDir,
    })
  );
}

// ---------- Library ----------

export function getLibrary(): Promise<LibraryData> {
  return fetchJson('/api/library');
}

export function getLibraryUsage(): Promise<LibraryUsageData> {
  return fetchJson('/api/library/usage');
}

export function createLibraryPrompt(body: {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
  source?: string;
}): Promise<Record<string, unknown>> {
  return requestJson('/api/library', 'POST', body);
}

export function updateLibraryPrompt(
  name: string,
  body: { newName?: string; content?: string; description?: string; tags?: string[] }
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}`, 'PUT', body);
}

export function deleteLibraryPrompt(name: string): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}`, 'DELETE');
}

export function installLibraryPrompt(
  name: string,
  targets: InstallTarget[]
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}/install`, 'POST', { targets });
}

export function uninstallLibraryPrompt(
  name: string,
  targets: InstallTarget[]
): Promise<Record<string, unknown>> {
  return requestJson(`/api/library/${encodeURIComponent(name)}/uninstall`, 'POST', { targets });
}

/** Claude-CLI name suggestion; `{ name: null }` when the CLI is unavailable. */
export function suggestLibraryName(text: string): Promise<SuggestNameResult> {
  return requestJson('/api/library/suggest-name', 'POST', { text });
}

export function getFabricPatterns(): Promise<FabricPatternsData> {
  return fetchJson('/api/library/fabric-patterns');
}

export function importFabricPatterns(names: string[]): Promise<ImportFabricResult> {
  return requestJson('/api/library/import-fabric', 'POST', { names });
}

export function getLibraryHistory(name: string): Promise<LibraryHistoryData> {
  return fetchJson(`/api/library/${encodeURIComponent(name)}/history`);
}

export function getLibraryHistoryEntry(name: string, hash: string): Promise<LibraryHistoryEntry> {
  return fetchJson(
    `/api/library/${encodeURIComponent(name)}/history/${encodeURIComponent(hash)}`
  );
}

// ---------- Backup / misc ----------

export function runBackup(): Promise<BackupResult> {
  return requestJson('/api/backup', 'POST');
}

export function getBackupStatus(): Promise<BackupStatus> {
  return fetchJson('/api/backup/status');
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

// ---------- LLM backend settings (#14) ----------

/** GET/PUT /api/settings/llm — OpenAI-compatible endpoint config, persisted server-side. */
export interface LlmSettings {
  baseUrl: string;
  model: string;
  /** true when an API key is stored (the key itself never leaves the server) */
  hasApiKey: boolean;
  /** which backend prompt tooling would use right now */
  backend: 'openai' | 'claude-cli' | null;
}

export function getLlmSettings(): Promise<LlmSettings> {
  return fetchJson('/api/settings/llm');
}

/** apiKey semantics: undefined = keep the stored key, '' = clear it, else replace. */
export function saveLlmSettings(body: {
  baseUrl: string;
  model: string;
  apiKey?: string;
}): Promise<LlmSettings> {
  return requestJson('/api/settings/llm', 'PUT', body);
}

// ---------- 平台 CLI 命令配置（resume 续跑 spawn 的目标） ----------
// GET/PUT /api/settings/cli-bins — 存服务端 ~/.agentlray/cli-bins.json。CLI
// （bin/sessions.js resume --run）与 web 后端都按「环境变量 → 配置文件 → 默认名」
// 解析，页面保存后终端续跑即生效。空串 = 清除（回退默认命令名）。

export interface CliBinSetting {
  /** 当前生效的可执行命令（配置值或默认名） */
  bin: string;
  /** 是否已在设置面板显式配置（false = 回退默认命令名） */
  configured: boolean;
  /** 默认命令名（未配置时的回退） */
  default: string;
}

/** 仅 resume 平台（codex / claude-code / omp）可配置。 */
export type CliBins = Partial<Record<'codex' | 'claude-code' | 'omp', CliBinSetting>>;

export function getCliBins(): Promise<CliBins> {
  return fetchJson('/api/settings/cli-bins');
}

/** 空串 = 清除该平台配置（回退默认命令名）。 */
export function saveCliBins(body: Partial<Record<'codex' | 'claude-code' | 'omp', string>>): Promise<CliBins> {
  return requestJson('/api/settings/cli-bins', 'PUT', body);
}

// ---------- 会话状态时间配置 ----------
// GET/PUT /api/settings/status — 存服务端 ~/.agentlray/status-config.json，并在
// 保存时经 lib/status.js setStatusConfig 注入，使各平台状态判定（awaiting-input /
// working / waiting / stopped）使用页面配置的时间窗口。单位为毫秒。

export interface StatusConfigSetting {
  /** 当前生效的时间窗口（毫秒，配置值或默认值） */
  value: number;
  /** 是否已在设置面板显式配置（false = 回退默认） */
  configured: boolean;
  /** 默认值（毫秒） */
  default: number;
}

export type StatusConfig = Partial<Record<'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', StatusConfigSetting>>;

export function getStatusConfig(): Promise<StatusConfig> {
  return fetchJson('/api/settings/status');
}

/** 传入毫秒；空/非正数 = 清除该 key（回退默认）。 */
export function saveStatusConfig(body: Partial<Record<'recentActivityMs' | 'activeWorkCeilMs' | 'historyCeilMs', number>>): Promise<StatusConfig> {
  return requestJson('/api/settings/status', 'PUT', body);
}

// ---------- 页面持久化 UI 偏好（平台选择） ----------
// GET/PUT /api/settings/ui — 前端把 localStorage「agent-xray-settings」里的平台
// 选择（单平台 platform / 多平台集合 selectedPlatforms）同步到服务端
// ~/.agentlray/ui-settings.json；CLI（bin/sessions.js）未传 --platform 时读同一
// 文件作为默认，保证终端命令与页面视角一致。

export interface UiSettings {
  platform: Platform | null;
  selectedPlatforms: Platform[];
}

export function saveUiSettings(body: { platform: Platform; selectedPlatforms: Platform[] }): Promise<UiSettings> {
  return requestJson('/api/settings/ui', 'PUT', body);
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
