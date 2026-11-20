// Typed fetchers for every AgentLRay backend endpoint.
// Mirrors public/js/app.js fetch behavior: non-2xx → throw Error(body.error || statusText).

import type {
  ChildAgentSummary,
  HiddenPromptsData,
  HidePromptsResult,
  HostInfo,
  HostsResponse,
  InboundInfo,
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

// —— 多主机（multi-host）当前选中主机 ——
// fetchJson/requestJson 统一注入 X-Host-Id 头；由 store 在切换主机时 setActiveHostId。
// 缺省 'local' = 本机直连。SSE（EventSource）不能带自定义头，改用 ?host= query（见 watchUrl）。
let activeHostId = 'local';

/** 当前主机数据面是否就绪（local 恒 true；远端=连接成功）。store 在连接状态变化时
 *  setHostReady 同步镜像，供 SSE（无法用 hook 订阅）与手动 fetch 读取。 */
let hostReady = true;

/** 设置当前选中主机 id（供 client 请求注入 X-Host-Id）。 */
export function setActiveHostId(id: string): void {
  activeHostId = id;
}

/** 当前选中主机 id（SSE watchUrl 等需带 ?host= 或读状态用）。 */
export function getActiveHostId(): string {
  return activeHostId;
}

/** 同步数据面就绪镜像（store 连接状态机调用；本地资源端点不受影响）。 */
export function setHostReady(v: boolean): void {
  hostReady = v;
}

/** 当前主机数据面是否就绪（SSE enabled 等同步判定用）。 */
export function getHostReady(): boolean {
  return hostReady;
}

function withParams(path: string, params: Record<string, ParamValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '' || value === false) continue;
    search.set(key, value === true ? '1' : String(value));
  }
  const qs = search.toString();
  return qs ? `${path}?${qs}` : path;
}

// fetchJson 的扩展 init：`local: true` 强制走本地网关（主机管理等本地资源端点）。
export type FetchInit = RequestInit & { local?: boolean };

async function fetchJson<T>(url: string, init?: FetchInit): Promise<T> {
  if (DEMO) return demoJson<T>(url, init);
  const headers = new Headers(init?.headers);
  // 默认注入当前选中主机；显式 opts.local 强制走本地网关（主机管理等本地资源，
  // 不随当前查看的远端变化）。SSE 走 watchUrl 的 ?host=，不走这里。
  if (init?.local !== true && activeHostId !== 'local') {
    headers.set('X-Host-Id', activeHostId);
  }
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error || response.statusText);
  }
  return response.json() as Promise<T>;
}

function requestJson<T>(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown, opts?: { local?: boolean }): Promise<T> {
  return fetchJson<T>(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...opts,
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
export function getAgents(platform: Platform): Promise<string[]> {
  return fetchJson(`/api/${encodeURIComponent(platform)}/agents`);
}

/**
 * List sessions. 统一走通用路由 `/api/:platform/sessions`。
 * needsAgent 平台（openclaw）传 agent 查单 agent；缺省（agent 为空）查该平台全部
 * agents 的合并会话（后端通用路由按需处理，每条带来源 agent 字段）。
 */
export function getSessions(
  platform: Platform,
  opts: { agent?: string } = {}
): Promise<SessionSummary[]> {
  return fetchJson(withParams(`/api/${encodeURIComponent(platform)}/sessions`, { agent: opts.agent }));
}

/**
 * Multi-platform session list (GET /api/sessions). Returns one block per platform
 * (needsAgent platform without `agent` → one block per agent). 后端配置驱动：不传
 * platform → 读服务端 ui.selectedPlatforms（空 → 全部平台），前端不再决定平台选择。
 */
export function getSessionsAll(
  opts: {
    agent?: string;
    status?: string;
    match?: string;
    limit?: number;
    offset?: number;
  } = {}
): Promise<SessionsListResponse> {
  const params: Record<string, ParamValue> = {
    agent: opts.agent || undefined,
    status: opts.status,
    match: opts.match,
    limit: opts.limit,
    offset: opts.offset,
  };
  return fetchJson<SessionsListResponse>(withParams('/api/sessions', params));
}

export function getSessionDetail(
  platform: Platform,
  sessionId: string,
  opts: { agent?: string } = {}
): Promise<SessionDetail> {
  // 统一走通用路由 `/api/:platform/sessions/:id`；needsAgent 平台（openclaw）
  // 传 agent 时后端按 agent 定位，缺省跨全部 agents 查找。
  return fetchJson(
    withParams(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}`, {
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
export function getSessionChildren(platform: Platform, sessionId: string): Promise<ChildAgentSummary[]> {
  return fetchJson(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/children`);
}

export function getSessionChild(
  platform: Platform,
  sessionId: string,
  childName: string
): Promise<SessionDetail> {
  return fetchJson(
    `/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/children/${encodeURIComponent(childName)}`
  );
}

// ---------- Spawn map / tree ----------

export function getSpawnMap(platform: Platform): Promise<SpawnLink[]> {
  return fetchJson(`/api/${encodeURIComponent(platform)}/spawn-map`);
}

export function getSpawnTree(platform: Platform, sessionId: string): Promise<SpawnTreeResult> {
  return fetchJson(`/api/${encodeURIComponent(platform)}/spawn-tree/${encodeURIComponent(sessionId)}`);
}

// ---------- Insights ----------

export function getInsights(opts: { platform: Platform; agent?: string }): Promise<Insights> {
  return fetchJson(withParams('/api/insights', { platform: opts.platform, agent: opts.agent }));
}

// ---------- Prompts ----------

export function getPrompts(opts: { platform: Platform; agent?: string }): Promise<PromptsData> {
  return fetchJson(withParams('/api/prompts', { platform: opts.platform, agent: opts.agent }));
}

/**
 * Template clustering + attribution + LLM suggestions.
 * `cached: true` probes the persisted analysis only — resolves null on 204/anything but 200.
 * `refresh: true` forces recompute; `skipLlm: true` clusters without Claude suggestions.
 */
export async function getPromptAnalysis(opts: {
  platform: Platform;
  agent?: string;
  cached?: boolean;
  refresh?: boolean;
  skipLlm?: boolean;
}): Promise<PromptAnalysis | null> {
  const url = withParams('/api/prompts/analyze', {
    platform: opts.platform,
    agent: opts.agent,
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
  refresh?: boolean;
}): Promise<ToolsAudit | null> {
  const url = withParams('/api/tools/audit', {
    platform: 'all',
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

/** Full-text search across every platform (multi-keyword AND). */
export function searchSessions(q: string): Promise<SearchResult[]> {
  return fetchJson(
    withParams('/api/search', {
      q,
      platform: 'all',
    })
  );
}


export function getOtlp(platform: Platform, sessionId: string): Promise<OtlpExport> {
  return fetchJson(`/api/otlp/${encodeURIComponent(platform)}/${encodeURIComponent(sessionId)}`);
}

export function getVersion(): Promise<VersionInfo> {
  // "AgentLRay 已更新" 指本机安装的 AgentLRay 服务有新版本（需刷新本地页面加载新
  // 前端构建），与当前查看的数据主机无关。强制走本地网关（local: true），避免
  // 连接远端主机时拿到远端 bootId 而误报更新。
  return fetchJson('/api/version', { local: true });
}

/** GET /api/mode — 运行时模式信号（design-thin-service Q13）。完整实例 → full，
 *  薄服务 → thin。与 /api/hosts、/api/version 同列本地资源（local: true），绝不透传远端。
 *  前端启动先取此值，thin 时一次性裁剪系统配置入口（单 dist，无构建期分叉）。 */
export interface ModeInfo {
  mode: 'full' | 'thin';
  /** 薄服务额外携带版本号（完整实例不带）。 */
  version?: string;
  /** 薄服务下发的客户端能力位（design-android-mobile-app §5.4/§5.5）：
   *  - transports：可用连接方式（Android 薄服务仅 ['dsh']；桌面 ['ssh','dsh']）。
   *  - nativeSave：WebView blob 下载不可用时启用原生保存桥接。
   *  完整实例不带（前端按全能力处理）。老客户端忽略未知字段。 */
  capabilities?: {
    transports?: string[];
    nativeSave?: boolean;
  };
}
export function getMode(): Promise<ModeInfo> {
  return fetchJson('/api/mode', { local: true });
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

/** 平台 CLI 命令配置（key = 平台 id）。GET 目前只回传内置五平台
 *  （codex / claude-code / omp / gemini / hermes）；自定义平台 id 的 bin 由后端 resolveCliBin 从
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

/** 平台数据目录配置（GET /api/settings 的 dirs section，key = 平台 id）。
 *  目录真源在服务端 settings.json `dirs` section；设置面板据此回显与编辑，查询
 *  不再传 dir query（服务端 dirFor 读配置）。 */
export interface DirSettingInfo {
  /** 平台目录设置的字段键（dirSettingKey，如 codexDir），写回时用此键 */
  key: string;
  /** 已配置的目录值（未配置 = ''） */
  value: string;
  /** 是否已在设置面板显式配置 */
  configured: boolean;
  /** 平台 env（如 CODEX_DIR）已生效 → 配置不生效（Q11-B，env 优先） */
  envActive: boolean;
  /** 默认目录（适配器 defaultDir 解析，env 未生效时的回退，空态展示用） */
  default: string | null;
}

export type DirsConfig = Partial<Record<string, DirSettingInfo>>;

/** 平台启停/替代镜像（GET /api/settings 的 platforms section 扩展）。 */
export interface PlatformsMirror {
  default: Platform | null;
  ids: string[];
  /** 已停用的平台 id（settings.platforms.disabled） */
  disabled: string[];
  /** 已声明替代的平台 id（settings.platforms.replaced） */
  replaced: string[];
}

/** dsh 传输配置（GET/PUT /api/dsh/config）：中继服务器与本机角色。 */
export interface DshConfig {
  /** 本机角色：host=只被连 / client=只去连 / both=两者皆可。 */
  role: 'host' | 'client' | 'both';
  /** 中继服务器地址（默认官方 https://dsh.r2049.cn，可改自托管）。 */
  serverUrl: string;
  /** 本机在中继服务器上的设备名。 */
  deviceName: string;
  /** 被连接方放行的本机端口（默认 [3800]）。 */
  allowedPorts: number[];
  /** 登录态（design-dsh-login-methods）：任一 scope 有有效 token 即已登录。 */
  authStatus: {
    loggedIn: boolean;
    /** 有有效 token 的 scope 集合（host / client）。 */
    roles: ('host' | 'client')[];
  };
}

/** 动态发现的 OAuth 扫码 provider（官方 / 自托管）。 */
export interface DshAuthProvider {
  id: string;
  displayName: string;
  qrStartUrl: string;
}

export interface DshQrSession {
  qrId: string;
  scanUrl: string;
  expiresIn: number;
  provider: string;
}

export type DshQrPollResult = { status: 'pending' } | { status: 'complete' } | { status: 'expired' };

/** GET /api/settings 全量响应（web 设置面板一次读齐所有 section）。 */
export interface AllSettings {
  ui: UiSettings;
  cliBins: CliBins;
  dirs: DirsConfig;
  status: StatusConfig;
  kanban: KanbanConfig;
  llm: LlmSettings;
  platforms: PlatformsMirror;
}

export function getSettings(): Promise<AllSettings> {
  return fetchJson('/api/settings');
}

/** GET /api/ui-selection — 当前主机（本机/远端）已选平台集合的专用只读接口。
 *  远端下经 X-Host-Id 头透传取远端配置；设置面整体随远端透传，此处只读是为前端
 *  初始化平台选中值提供一个窄接口（避免拉全量 settings）。 */
export interface UiSelection {
  selectedPlatforms: Platform[];
}
export function getSelectedPlatforms(): Promise<UiSelection> {
  return fetchJson('/api/ui-selection');
}

/** PUT /api/settings 可选项：只含已编辑的 section，未提供者原样保留。 */
export type SettingsPatch = {
  /** ui section 部分更新：platform（默认平台）/ selectedPlatforms（侧栏多选）独立，未传字段保留原值 */
  ui?: { platform?: Platform; selectedPlatforms?: Platform[] };
  cliBins?: Partial<Record<string, string>>;
  /** 平台目录：key = dirSettingKey（codexDir/openclawDir/…），空串 = 清除 */
  dirs?: Partial<Record<string, string>>;
  /** 平台启停/替代：随统一保存提交（复用 platform-config 守卫） */
  platforms?: { disabled?: string[]; replaced?: string[] };
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

/** ui section 部分更新（写服务端 ui，CLI 未传 --platform 时读同一 section 作为默认）：
 *  platform 由设置面板「默认平台」独占管理；selectedPlatforms 由侧栏 persistState 同步。
 *  未传字段保留服务端原值（两者互不覆盖）。 */
export function saveUiSettings(body: { platform?: Platform; selectedPlatforms?: Platform[] }): Promise<AllSettings> {
  return requestJson('/api/settings', 'PUT', { ui: body });
}

/** URL for the server-side session export (Markdown / standalone HTML download).
 *  `<a href>` 下载不能带自定义头，非 local 主机时用 ?host= query 指定路由目标
 *  （与 watchUrl 同款），否则远端下导出会打回本机。 */
export function exportUrl(
  platform: Platform,
  sessionId: string,
  format: 'md' | 'html',
  opts: { agent?: string } = {}
): string {
  return withParams(`/api/${encodeURIComponent(platform)}/sessions/${encodeURIComponent(sessionId)}/export`, {
    format,
    agent: opts.agent,
    host: activeHostId === 'local' ? undefined : activeHostId,
  });
}

/** URL for the real-time tail EventSource (GET /api/watch, SSE — consumed via new EventSource()).
 *  EventSource 不能带自定义头，非 local 主机时用 ?host= query 指定路由目标。 */
export function watchUrl(opts: {
  platform: Platform;
  sessionId: string;
  agent?: string;
}): string {
  return withParams('/api/watch', {
    platform: opts.platform,
    sessionId: opts.sessionId,
    agent: opts.agent,
    host: activeHostId === 'local' ? undefined : activeHostId,
  });
}

// ---------- Hosts（multi-host）----------

/** GET /api/hosts — 主机列表（[local, ...hosts]，含运行时 status/version）。
 *  主机列表是本地网关配置（~/.agentlray/hosts.json），不随当前查看的远端变化 → 强制 local。 */
export function getHosts(): Promise<HostsResponse> {
  return fetchJson('/api/hosts', { local: true });
}

/** GET /api/inbound — 本机当前被哪些其他主机连接（被连接方本地资源，inbound peers）。
 *  强制 local 语义，不随当前查看的远端变化，同 getHosts。 */
export function getInbound(): Promise<InboundInfo> {
  return fetchJson('/api/inbound', { local: true });
}

/** 主机连接目标：ssh 规格或 dsh 规格（type 决定用哪一组）。 */
export interface HostBody {
  label: string;
  type?: 'ssh' | 'dsh';
  ssh?: {
    host: string;
    user?: string;
    port?: number | null;
    remoteAgentLrayPort?: number;
    identityFile?: string;
    identityKey?: string;
    useAgent?: boolean;
  };
  dsh?: {
    deviceId: string;
    remoteAgentLrayPort?: number;
  };
}

/** POST /api/hosts — 新建主机。 */
export function createHost(body: HostBody & { id: string }): Promise<HostInfo> {
  return requestJson('/api/hosts', 'POST', body, { local: true });
}

/** PUT /api/hosts/:id — 编辑主机（全量替换字段；id 不可改）。 */
export function updateHost(id: string, body: HostBody): Promise<HostInfo> {
  return requestJson(`/api/hosts/${encodeURIComponent(id)}`, 'PUT', body, { local: true });
}

/** DELETE /api/hosts/:id — 删除主机（关隧道 + 移除）。 */
export function deleteHost(id: string): Promise<{ id: string }> {
  return requestJson(`/api/hosts/${encodeURIComponent(id)}`, 'DELETE', undefined, { local: true });
}

export interface HostTestResult {
  ok: boolean;
  status: string;
  bootId: string | null;
  error: string | null;
}

/** POST /api/hosts/test — 测试「未保存」的主机配置（表单「测试连接」）：
 *  按 body 的规格建隧道→探测→关，不持久化。 */
export function testHostSpec(body: HostBody & { id: string }): Promise<HostTestResult> {
  return requestJson('/api/hosts/test', 'POST', body, { local: true });
}

// ---------- dsh 传输（ds-harness-remote）----------

/** GET /api/dsh/status — 本机 dsh 状态（角色 / 服务器 / 是否在线 / 被连 peer）。 */
export interface DshStatus {
  role: 'host' | 'client' | 'both';
  serverUrl: string;
  deviceName: string;
  allowedPorts: number[];
  /** 被连接方服务是否在运行。 */
  running: boolean;
  /** 是否已连上中继服务器。 */
  connected: boolean;
  deviceId: string | null;
  /** 当前连入本机的 dsh 对端设备 id。 */
  peers: string[];
  lastError: string | null;
}

/** GET /api/dsh/config — 本机 dsh 配置（主机弹框「dsh 配置」表单读）。恒 local。 */
export function getDshConfig(): Promise<DshConfig> {
  return fetchJson('/api/dsh/config', { local: true });
}

/** PUT /api/dsh/config — 保存 dsh 配置（email/password 只用于本次登录触发，不落盘；恒 local）。 */
export function saveDshConfig(body: {
  role?: 'host' | 'client' | 'both';
  serverUrl?: string;
  email?: string;
  password?: string;
  deviceName?: string;
  allowedPorts?: number[];
}): Promise<DshConfig> {
  return requestJson('/api/dsh/config', 'PUT', body, { local: true });
}

/** GET /api/dsh/devices — 中继服务器上当前账号可见的设备（本机已排除）。 */
export interface DshDevice {
  deviceId: string;
  name: string;
  platform: string;
  membershipId: string;
  online: boolean;
  lastSeenAt: number | null;
}

export function getDshStatus(): Promise<DshStatus> {
  return fetchJson('/api/dsh/status', { local: true });
}

export function getDshDevices(): Promise<DshDevice[]> {
  return fetchJson('/api/dsh/devices', { local: true });
}

/** POST /api/dsh/test — 测试未保存的 dsh 目标（建隧道 → 探测 → 关）。 */
export function testDshSpec(body: {
  deviceId: string;
  remoteAgentLrayPort?: number;
}): Promise<HostTestResult> {
  return requestJson('/api/dsh/test', 'POST', body, { local: true });
}

/** GET /api/dsh/auth/providers — 动态发现扫码登录方式（both 禁扫码 → 空）。
 *  role 可选：覆盖配置 role（draft 未落盘时按当前角色判断可扫码性，评审 P1）。
 *  serverUrl 可选：覆盖目标服务器（draft.serverUrl，Q2），使发现针对用户当前编辑的地址。 */
export function discoverDshAuthProviders(
  role?: 'host' | 'client' | 'both',
  serverUrl?: string,
): Promise<{
  providers: DshAuthProvider[];
  devicePairing: boolean;
}> {
  const params = new URLSearchParams();
  if (role) params.set('role', role);
  if (serverUrl) params.set('serverUrl', serverUrl);
  const qs = params.toString() ? `?${params.toString()}` : '';
  return fetchJson(`/api/dsh/auth/providers${qs}`, { local: true });
}

/** POST /api/dsh/auth/qr/start — 发起扫码登录会话。
 *  serverUrl 可选：目标服务器（draft.serverUrl，Q3），须与 poll 传同一地址。 */
export function startDshQrLogin(body: {
  role: 'host' | 'client';
  provider: string;
  serverUrl?: string;
}): Promise<DshQrSession> {
  return requestJson('/api/dsh/auth/qr/start', 'POST', body, { local: true });
}

/** POST /api/dsh/auth/qr/poll — 轮询扫码结果。complete 时 token 已落对应 scope。
 *  serverUrl 须与 qr/start 传同一地址。 */
export function pollDshQrLogin(body: {
  role: 'host' | 'client';
  qrId: string;
  serverUrl?: string;
}): Promise<DshQrPollResult> {
  return requestJson('/api/dsh/auth/qr/poll', 'POST', body, { local: true });
}

/** POST /api/dsh/auth/logout — 清所有 scope 的 token，回未登录态。 */
export function logoutDsh(): Promise<{ ok: boolean }> {
  return requestJson('/api/dsh/auth/logout', 'POST', undefined, { local: true });
}

/** POST /api/hosts/:id/connect — 建立并保持隧道（前端切换当前选中主机用）。 */
export function connectHost(id: string): Promise<HostTestResult> {
  return requestJson(`/api/hosts/${encodeURIComponent(id)}/connect`, 'POST', undefined, { local: true });
}

/** POST /api/hosts/:id/disconnect — 手动断开连接（关隧道 + 停心跳；local 不可断）。 */
export function disconnectHost(id: string): Promise<{ id: string; status: string }> {
  return requestJson(`/api/hosts/${encodeURIComponent(id)}/disconnect`, 'POST', undefined, { local: true });
}
