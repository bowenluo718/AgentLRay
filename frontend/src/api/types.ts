// API response types for the AgentLRay backend (server.js on :3800).
// Typed from real responses sampled via curl + the legacy UI's field usage
// (public/js/app.js). Open/evolving shapes carry index signatures.

// 平台 id（openclaw / codex / claude-code / hermes / omp / dsh / gemini 等内置
// id，或自定义平台适配器声明的小写字母 id）。宽 string：允许运行时新增/移除
// 平台而不改类型；API 路径统一拼 `/api/${id}/...`。
export type Platform = string;

/** 平台能力位（与后端 lib/platforms/contracts.js capabilityBits 一致，包含映射 hook 的能力）。 */
export interface PlatformCapabilities {
  list: boolean;
  find: boolean;
  parse: boolean;
  getSession: boolean;
  collectFiles: boolean;
  watchParse: boolean;
  needsAgent: boolean;
  /** 提供 listForAgent(per-agent 列举) hook。 */
  listForAgent: boolean;
  /** 提供 listAllAgents(合并全部 agents) hook。 */
  listAllAgents: boolean;
  /** 提供 listAgents(枚举 agents) hook。 */
  listAgents: boolean;
  /** 会话可 spawn 子 agent（omp / claude-code）。 */
  children: boolean;
  /** 提供 spawnMap/spawnTree hook。 */
  spawn: boolean;
  /** 提供 watch hook。 */
  watch: boolean;
  /** 提供 search hook。 */
  search: boolean;
  /** 提供 computeInsights hook。 */
  insights: boolean;
  /** 提供 computePrompts hook。 */
  prompts: boolean;
  /** 提供 tool audit（computeToolAudit/scanToolAuditFile）hook。 */
  toolAudit: boolean;
  /** 提供 inspect hook。 */
  inspect: boolean;
  /** 可导出 OTLP（文件型 find+parse 且无需 agent，与后端 surfacePlatforms('otlp') 同口径）。 */
  otlp: boolean;
}

/** GET /api/platforms 单条：内置 → 项目 → 自定义 → broken。broken 条目 id 可能为 null。 */
export interface PlatformInfo {
  id: string | null;
  label: string | null;
  /** 来源：package（包内置）/ project（项目目录）/ user（~/.agentlray/platforms）。 */
  origin: string;
  builtin: boolean;
  /** 包内置被替代/停用时置空的相关信息。 */
  overrides: Record<string, unknown> | null;
  /** 声明了替代但同 id 适配器缺失/损坏 → 回退包内置。 */
  replacementPending: boolean;
  /** 替代声明（settings.platforms.replaced ∪ manifest.replaces）是否覆盖本 id。 */
  replaced?: boolean;
  /** 当前生效挂载态（包含 disabled 黑名单与替代回退之后的最终状态）。 */
  mounted: boolean;
  /** 用户配置的挂载态（settings.platforms.disabled 之外的原生意图）。 */
  configuredMounted: boolean;
  /** 启停/替代需要在进程重启后生效。 */
  restartRequired: boolean;
  capabilities: PlatformCapabilities;
  /** 是否声明原生续跑契约（内置五平台，或自定义适配器 resume: { bin, args }）。 */
  resume: boolean;
  /** 是否支持新建会话（与后端 hasCreateContract 一致：codex / claude-code / omp / gemini / hermes，或自定义适配器 create 契约）。 */
  create: boolean;
  /** 续跑/新建 spawn 的可执行命令名（无则 null）。 */
  bin: string | null;
  /** 本平台可作 openclaw exec 子命令目标（声明 execSpawn.commands 的命令名，小写）。 */
  execSpawnCommands: string[];
  /** 数据目录设置面板的字段键（settings.json ui section），无则缺省目录不可配。 */
  dirSettingKey: string | null;
  dirSettingLabel: string | null;
  dirSettingHint: string | null;
  /** 多平台/搜索/审计聚合时该平台目录的 query 参数名（如 dirOpenclaw）。 */
  dirParam: string | null;
  /** 默认数据目录绝对路径（服务端按平台目录声明解析），空态展示用。 */
  defaultDir: string | null;
  /** 平台品牌色（hex），前端缺省色兜底。 */
  color: string | null;
  broken: boolean;
  /** 仅 broken 条目：加载/校验失败原因。 */
  error?: string;
}

/** GET /api/platforms 响应（服务端顺序即展示顺序）。 */
export type PlatformsResponse = PlatformInfo[];

// ---------- Sessions ----------

export interface TopTool {
  name: string;
  count: number;
}

/** Item of GET /api/{codex,claude-code,hermes,omp}/sessions and /api/agents/:name/sessions */
export interface SessionSummary {
  id: string;
  timestamp: string;
  lastActivity: string;
  messageCount: number;
  userCount: number;
  assistantCount: number;
  toolCallCount: number;
  toolResultCount: number;
  topTools: TopTool[];
  firstUserMessage: string;
  file: string;
  title?: string | null;
  cwd?: string | null;
  slug?: string | null;
  /** openclaw extras (legacy sessionCardHtml): status badge, spawn chip, source chip, model chip */
  status?: string | null;
  model?: string | null;
  source?: string | null;
  spawnCount?: number | null;
  /** omp/claude-code 子会话数量（children 能力平台在 list 阶段注入） */
  childrenCount?: number | null;
  archived?: boolean | null;
  /** 聚合视图（/api/sessions platform=all）注入的来源平台与 openclaw agent，单平台列表不带 */
  platform?: Platform;
  agent?: string | null;
  [key: string]: unknown;
}

/** Block of GET /api/sessions?platform=a,b|all — one per platform (openclaw per agent). */
export interface PlatformSessionsBlock {
  platform: Platform;
  agent: string | null;
  total: number;
  offset: number;
  limit: number | null;
  sessions: SessionSummary[];
}

/** Response of GET /api/sessions?platform=a,b|all. */
export interface SessionsListResponse {
  all: boolean;
  platformIds: Platform[];
  total: number;
  offset: number;
  limit: number | null;
  platforms: PlatformSessionsBlock[];
}

/** One entry of a normalized message's `content` array. */
export interface MessageContentPart {
  type: string; // 'text' | 'toolCall' | 'tool_use' | 'tool_result' | …
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  /** toolCall parts carry parsed arguments (legacy renderToolCall reads item.arguments) */
  arguments?: unknown;
  tool_use_id?: string;
  is_error?: boolean;
  [key: string]: unknown;
}

export interface MessageUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  /** number on some platforms; omp emits an object with per-bucket dollars + total */
  cost?: number | { total?: number; [key: string]: unknown } | null;
  totalTokens?: number;
  [key: string]: unknown;
}

/** Normalized message (all platforms are normalized server-side to this shape). */
export interface OmpOutcome {
  state: 'success' | 'failure' | 'running' | 'cancelled' | 'unknown';
  evidence: string[];
  warnings: string[];
}

export interface SessionMessage {
  id: string;
  timestamp: string | null;
  role: string; // 'user' | 'assistant' | 'reasoning' | 'toolCall' | 'toolResult' | 'developer' | …
  content: MessageContentPart[] | null;
  usage: MessageUsage | null;
  model: string | null;
  provider: string | null;
  toolCallId: string | null;
  toolName: string | null;
  details: Record<string, unknown> | null;
  isError: boolean;
  ompOutcome?: OmpOutcome;
  /** some platforms attach reasoning text directly on the assistant record */
  reasoning?: string | null;
  [key: string]: unknown;
}

export interface SessionMeta {
  id: string;
  cwd?: string | null;
  timestamp?: string | null;
  version?: number;
  model?: string | null;
  source?: string | null;
  [key: string]: unknown;
}

/** GET /api/<platform>/sessions/:id (and children/:name) */
export interface SessionDetail {
  session: SessionMeta;
  messages: SessionMessage[];
}

/** Item of GET /api/{omp,claude-code}/sessions/:id/children */
export interface ChildAgentSummary {
  name: string;
  messageCount: number;
  toolCallCount: number;
  timestamp?: string | null;
  lastActivity?: string | null;
  file?: string | null;
  title?: string | null;
  agentType?: string | null;
  description?: string | null;
  [key: string]: unknown;
}

// ---------- Spawn map / tree ----------

/** Item of GET /api/spawn-map (openclaw spawn relationships) */
export interface SpawnLink {
  parentAgent: string;
  parentSession: string;
  toolCallId?: string;
  toolName: string;
  childAgent: string;
  childLabel: string | null;
  task: string;
  timestamp?: string;
  isExecSpawn?: boolean;
  [key: string]: unknown;
}

export interface SpawnTreeNode {
  id: string;
  children?: SpawnTreeNode[];
  [key: string]: unknown;
}

/** GET /api/spawn-tree/:sessionId */
export interface SpawnTreeResult {
  node: SpawnTreeNode | null;
  parent: SpawnTreeNode | null;
  totalSessions?: number;
  totalSpawnCalls?: number;
  matchedLinks?: number;
  [key: string]: unknown;
}

// ---------- Insights ----------

export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number | null;
}

export interface ErrorClusterExample {
  sessionId: string;
  toolName: string | null;
  snippet: string;
  messageId: string | null;
  timestamp: string | null;
}

export interface ErrorCluster {
  pattern: string;
  count: number;
  examples: ErrorClusterExample[];
}

export interface TrendPoint {
  date: string;
  sessions: number;
  errors: number;
  toolCalls: number;
  cost: number;
}

/** GET /api/insights */
export interface Insights {
  totalSessions: number;
  totalMessages: number;
  totalToolCalls: number;
  totalCost: number;
  errorRate: number;
  tokenUsage: { input?: number; output?: number; cacheRead?: number; [key: string]: number | undefined };
  toolStats: ToolStat[];
  errorClusters: ErrorCluster[];
  trend: TrendPoint[];
  [key: string]: unknown;
}

// ---------- Prompts ----------

export interface PromptEntry {
  text: string;
  timestamp: string | null;
}

export interface PromptSession {
  id: string;
  file: string;
  slug?: string | null;
  title?: string | null;
  timestamp: string;
  lastActivity: string;
  promptCount: number;
  prompts: PromptEntry[];
}

export interface PromptGroup {
  directory: string;
  promptCount: number;
  sessionCount: number;
  sessions: PromptSession[];
}

/** GET /api/prompts */
export interface PromptsData {
  platform: string;
  totalPrompts: number;
  totalSessions: number;
  groups: PromptGroup[];
}

export interface ClusterSuggestion {
  assessment?: string;
  issues?: string[];
  rationale?: string;
  rewrite?: string;
  [key: string]: unknown;
}

export interface PromptCluster {
  pattern: string;
  count: number;
  avgLength: number;
  topic?: string | null;
  directories: string[];
  sessionIds: string[];
  samples: string[];
  errorSamples?: string[];
  attribution?: {
    sampledSessions?: number;
    avgMessages?: number;
    avgToolCalls?: number;
    errorRate?: number;
    avgOutputTokens?: number;
    [key: string]: number | undefined;
  } | null;
  suggestion?: ClusterSuggestion | null;
  [key: string]: unknown;
}

export interface TopicStat {
  topic: string;
  clusters: number;
  prompts: number;
}

export interface WeeklyTrendPoint {
  week: string;
  total: number;
  topics: Record<string, number>;
}

/** GET /api/prompts/analyze */
export interface PromptAnalysis {
  platform: string;
  clusters: PromptCluster[];
  overall: string[];
  topics?: TopicStat[];
  weeklyTrend?: WeeklyTrendPoint[];
  totalClusters?: number;
  totalPrompts?: number;
  generatedAt?: string;
  persisted?: boolean;
  llmError?: string | null;
  [key: string]: unknown;
}

/** POST /api/prompts/rewrite */
export interface RewriteResult {
  rewrite: string;
  rationale: string | null;
  /** true when the CLI output could not be parsed as JSON and is passed through raw */
  raw?: boolean;
}

export interface HiddenPrompt {
  hash: string;
  preview: string;
  hiddenAt: string;
}

/** GET /api/prompts/hidden */
export interface HiddenPromptsData {
  hidden: HiddenPrompt[];
}

/** POST /api/prompts/hidden */
export interface HidePromptsResult {
  hash: string;
  hashes: string[];
  added: number;
  hidden: number;
}

// ---------- Tools audit ----------

export interface ToolAuditEntry {
  name: string;
  platforms: string[];
  calls: number;
  errors: number;
  errorRate: number;
  avgMs: number | null;
  lastUsed: string | null;
  sessions: number;
  [key: string]: unknown;
}

/** GET /api/tools/audit (204 → null: no persisted audit yet) */
export interface ToolsAudit {
  generatedAt: string;
  persisted: boolean;
  tools: ToolAuditEntry[];
  configuredUnused: { name: string; source?: string | null }[];
  [key: string]: unknown;
}

// ---------- Search ----------

export interface SearchMatch {
  role: string;
  snippet: string;
  timestamp: string | null;
}

/** Item of GET /api/search */
export interface SearchResult {
  sessionId: string;
  file: string;
  platform: string;
  matches: SearchMatch[];
  agent?: string;
  /** true → a Claude-cleaned history entry: display-only, not clickable */
  history?: boolean;
  project?: string;
  [key: string]: unknown;
}

/** GET /api/version */
export interface VersionInfo {
  bootId: string;
}

/** GET /api/otlp/:platform/:sessionId — OTLP/JSON export */
export interface OtlpExport {
  resourceSpans: unknown[];
}
