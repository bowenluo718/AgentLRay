# AgentLRay 架构设计

> 本文档基于当前实际实现（仓库 `9755ec0`）撰写，是本目录功能/主题文档
> （[使用说明](usage.zh-CN.md)、[执行证据](diagnostics.zh-CN.md)、
> [离线 inspect](offline-inspect.zh-CN.md)、[单会话取证](session-forensics.zh-CN.md)）
> 的架构补充。英文版见 [architecture.md](architecture.md)。

AgentLRay 是一个本机 Web 看板，用于检查你已在使用的编码 Agent 记录下来的执行证据。
它读取 OpenClaw、Codex、Claude Code、Hermes、OMP、DeepSeek Harness 与 Gemini CLI
的原生日志，归一化为统一的会话模型后渲染成统一浏览器。一切都在本机、针对你自己的
日志文件运行；核心检查路径不调用模型、不上传任何内容。

## 1. 设计目标

- **本地执行证据优先。** 产品关注的是"实际运行了什么"以及哪些结果支撑某个结论——
  自动事实先于人工标注。诊断**刻意不**判定任务是否成功。
- **基于归一化模型的只读。** 每个平台都解析为同一个 `{ session, messages }`
  载荷；所有通用表面（路由、搜索、watch、insights、prompts、工具审计、导出、
  OTLP、CLI）都只针对该模型写一次。
- **平台注册表是唯一真源。** 新增平台 = 一个适配器文件 + 一次注册，其余不动。
  自定义平台运行时接入，无需改源码。
- **前端逻辑单点编写、处处共享。** `pure.ts` 与 `markdown.ts` 是格式化/瀑布图/
  markdown 的唯一来源；它们被烘焙进冻结的 legacy UI，并被 Node 测试复用。
- **诊断规则单点编写。** `diagnostics.ts` 是规则唯一来源，被编译进
  `lib/generated/diagnostics.cjs`，使离线 CLI 与 React UI 应用完全相同的判定。

## 2. 高层分层

```
                 ┌────────────────────────────────────────────┐
                 │  React 19 SPA (frontend/)   —— 默认 UI      │
                 │  zustand store + react-query + SSE cache   │
                 └───────────────┬────────────────────────────┘
                                 │ HTTP (fetch) + SSE (EventSource)
                 ┌───────────────▼────────────────────────────┐
                 │  Express 后端 (server.js + lib/routes/*)    │
                 │  CSRF 防护 · JSON · no-store                │
                 └───────┬──────────────────────┬─────────────┘
                         │                      │
              ┌──────────▼──────────┐   ┌───────▼──────────────┐
              │  lib/* 业务逻辑     │   │  lib/platforms/*     │
              │  status · settings  │   │  注册表 + 适配器     │
              │  llm · resume ·     │   │  codex/claude/omp/   │
              │  search · inspect   │   │  dsh/gemini/hermes/  │
              │  export · otlp ·    │   │  openclaw · loader   │
              │  backup · insights  │   │  tail-state · shared │
              └──────────┬──────────┘   └──────────┬──────────┘
                         │                         │
              ┌──────────▼─────────────────────────▼──────────┐
              │  磁盘上的平台会话日志（JSONL/SQLite/zstd JSONL）│
              │  + ~/.agentlray/* 配置与归档                    │
              └───────────────────────────────────────────────┘
```

## 3. 仓库布局

| 路径 | 职责 |
|---|---|
| `server.js` | Express 启动：静态服务、CSRF、no-store、路由挂载、设置迁移 + 状态注入、监听。 |
| `bin/` | CLI 入口：`agentlray.js`（分派）、`sessions.js`（list/show/resume）、`inspect.js`（inspect/evidence）、`platform.js`（list/validate）。 |
| `lib/config.js` | HOME 解析、平台默认目录、会话 id/agent 净化器、共享元数据缓存 Map、文件辅助。 |
| `lib/platforms/` | 平台注册表与每个平台一个适配器；`shared.js`（骨架辅助）、`tail-state.js`（尾部证据状态机）、`loader.js`（自定义适配器加载）。 |
| `lib/` | 平台无关业务：`status.js`、`session-list.js`、`settings.js` 及各 section 模块、`llm.js`/`llm-json.js`、`resume.js`、`cli-bins.js`、`ui-settings.js`、`search.js`、`inspect.js`/`inspect-detail.js`、`export.js`、`otlp.js`、`backup.js`、`insights.js`、`tool-audit.js`、`prompts.js`、`library.js`、`watch.js`、`csrf.js`。 |
| `lib/routes/` | 路由模块：只做参数校验与响应塑造；业务逻辑在 `lib/`。 |
| `lib/generated/diagnostics.cjs` | 编译出的诊断规则（生成物，勿手改）。 |
| `frontend/` | React 19 + Vite + TypeScript SPA（唯一的功能开发面）。 |
| `public/` | 冻结的 legacy 原生 UI，挂在 `/legacy`；只接受安全修复。 |
| `scripts/` | 构建/demo 管线（见 §11）。 |
| `test/` | Node 内置测试运行器，隔离在 `test/fixtures/home` 上。 |

## 4. 平台注册表与归一化模型

`lib/platforms/index.js` 持有 `PLATFORMS` 表——平台真值的唯一来源。每个通用表面
都通过该表解析平台。

**注册表条目形状：**

| 字段 | 含义 |
|---|---|
| `id` | 注册表键，用于 URL（`/api/<id>/sessions`）与 CLI `--platform`。 |
| `label` | 人类可读名（启动日志、UI）。 |
| `defaultDir()` | 平台会话根目录（可通过 `lib/config` 的环境变量覆盖）。 |
| `list(dir)` | 会话摘要，最新在前。 |
| `find(dir, id, opts?)` | 会话文件路径 \| `null`（`null` 条目：非文件型，如 Hermes）。 |
| `parse(file)` | `{ session, messages }`（已归一化）。 |
| `getSession(dir, id, opts?)` | `{ session, messages } \| null`。 |
| `collectFiles(dir, opts?)` | `[{ path, file, sessionId, agent? }]`，供批量扫描（search/prompts/tool-audit）。 |
| `watchParse(rec, line?)` | `{ messages?, session? } \| null`，供 SSE tail。 |
| `needsAgent` | 为真时 `find`/`getSession` 需要 `opts.agent`（openclaw）。 |

**归一化消息形状**是定义在 `lib/platforms/shared.js`（`makeMessage`）中的一个
11 字段字面量：

```
id, timestamp, role, content[], usage, model, provider,
toolCallId, toolName, details, isError
```

适配器只覆盖其原始记录实际携带的字段。需要列出元数据（标题、首/末消息、计数）的
会话由各适配器的 `list*` 函数产出；`shared.js` 的 `withMetadataCache` 用 mtime 键的
内存缓存（`lib/config.js` 的 `sessionMetaCache`）包裹原始元数据解析器，未变化的文件
不会在每次列出时重新解析。

### 4.1 文件型 vs 非文件型平台

- **文件型：** OpenClaw、Codex、Claude Code、OMP、DeepSeek Harness、Gemini。
  实现 `find`/`parse`/`collectFiles`/`watchParse`。
- **SQLite 型：** Hermes。无可 find/collect/tail 的文件；`find`/`parse`/
  `collectFiles`/`watchParse` 为 `null`，`getSession`/`list` 读 `~/.hermes/state.db`。
  watch 路由有专门的 WAL-watch 分支。
- **OpenClaw** 按 agent 组织：`needsAgent: true`、`list: null`（按 agent 列出），
  通用路由对它做特判以枚举全部 agents。

### 4.2 适配器处理的格式细节

- **dsh** 日志可能是多个独立 Zstandard 帧的拼接（`.jsonl.zstd`）。
  `lib/platforms/dsh.js` 扫描帧边界并逐帧解压，容忍崩溃后留下的撕裂尾帧。持久化
  日志带版本：会话目录在旧 `session.jsonl[.zstd]`（格式 0）旁保留冻结的
  `session.v3/.v4.jsonl.zstd`；适配器读当前存在的最高版本。读取压缩 dsh 日志需要
  Node ≥ 22.15（内置 zstd）。
- **Gemini** 的 `$rewindTo`/`$set` 检查点被折叠（`foldGeminiRecords`），回卷历史不会
  渲染两次；元数据行与折叠不向 watcher 产生新消息。
- **Claude Code** 读 `~/.claude/projects/<project-slug>/*.jsonl` 及其
  `subagents/agent-*.jsonl`；子代理旁的 `.meta.json` 携带 `agentType`/`description`。

### 4.3 自定义平台适配器

`lib/platforms/loader.js` 在模块加载期**同步**读取 `~/.agentlray/platforms/*.js`
（按字母序）并把校验通过的适配器并入注册表。同步是硬要求：下游派生点
（`lib/export.js`、`lib/otlp.js`、`lib/session-list.js`、路由、CLI）都在 `require`
期同步读 `PLATFORMS`，任何异步都会让这些派生点看不到自定义平台。

校验（与 CLI `platform validate` 共用）：模块必须导出含 `id`
（`^[a-z0-9][a-z0-9-]*$`）、`label`（字符串）以及必需函数 `defaultDir`、
`parse`、`getSession` 的对象（`list` 可为 `null`，如同 OpenClaw）。id 与内置或先前
已加载的自定义冲突 → 标记该文件为 **broken**（绝不覆盖）。单个失败文件被
try/catch 隔离，绝不打断启动。`AGENTLRAY_NO_PLUGINS=1` 完全跳过加载。能力位按函数
存在性推导（`lib/platforms/index.js` 的 `capabilityBits`）。

`listPlatformInfo()` 同时是 `GET /api/platforms` 与 CLI `platform list` 的唯一来源：
内置（注册表插入序）→ 自定义（文件名装载字母序）→ broken（字母序），各带
`capabilities` 与 `resume` 标志。

## 5. 会话状态模型

`lib/status.js` 实现一个**仅由记录证据**推导的统一四态模型——绝不查询活进程
（与 csm 参考实现的刻意差异；见 `docs/.local/session-status-design.zh-CN.md`）。

**四态（按分组序）：**

| 状态 | 含义 |
|---|---|
| `awaiting-input` | Agent 正在等用户（唯一不靠用户就不会动的状态）。 |
| `working` | 活跃工作的证据 + 新鲜度（记录推导，非进程）。 |
| `waiting` | 未显式关闭，仍在取证闭口窗口内。 |
| `stopped` | 显式结束标记，或超过取证闭口窗口。 |

**证据尾**（平台中立，来自 `lib/platforms/tail-state.js` 的 `finishTail`）：
`lastAssistantAt`、`lastPromptAt`、`endTurnAt`、`endedAt`、`pendingToolAt`、
`pendingNewestAt`、`oldestPendingToolName`。关键语义：`endedAt` 只能来自*会话级*
关闭标记；`endTurnAt` 只能来自*回合级*结束——把回合结束喂给 `endedAt` 会把每个
正常结束的活跃会话误判为 stopped。

**`deriveStatus(tail, meta, nowMs, opts)` 判定链**（`lib/status.js`）：

1. 显式关闭 → `stopped`（会话级结束标记胜过任何后续证据）。
2. 无消息证据 → 回退 `mtime` 新鲜度：新 → `waiting`，否则 `stopped`（覆盖刚启动/
   空文件）。
3. **pending** 工具调用（唯一的 `awaiting-input` 生产者，先于任何老化检查）：
   即时等待工具（`AskUserQuestion`）→ 直接 `awaiting-input`；最新 pending 在
   `activeWorkCeilMs` 内 → `working`；用户交互工具（`ask`）超过工作上界 →
   `awaiting-input`（不受闭口上界约束——用户可能很久才回复）；最旧 pending 在
   `historyCeilMs` 内 → `awaiting-input`；否则 → `stopped`（崩溃/中断且无结束标记
   不无限置顶）。
4. 回合结束且其后无更新的真实 prompt → `waiting`（`historyCeilMs` 内），否则
   `stopped`。
5–6. 否则回合仍在推进：`activeWorkCeilMs` 内 → `working`。
7. 活跃但安静超过工作上界 → `waiting`。
8. 超过闭口窗口 → `stopped`。

三个时间窗口（默认 2min / 30min / 12h）可通过 `setStatusConfig()` 运行时注入
（由 `lib/status-config.js` 从 `~/.agentlray/settings.json` 的 `status` section 读取）。
`sortSessionsByStatusGroups` 按状态优先级分组，组内再按各平台默认键排序。

`GET /api/status-labels` 透出 `{ order, labels }`，作为 React 与 legacy 前端状态
词汇的唯一来源，徽标/组头不会漂移。

## 6. 设置：统一单文件

所有服务端设置聚合到单一 `~/.agentlray/settings.json`，含五个 section：
`ui`、`cliBins`、`status`、`kanban`、`llm`。`lib/settings.js` 负责整文件读、原子写
（tmp + rename）以及旧 5 个独立文件（`ui-settings.json`/`cli-bins.json`/
`status-config.json`/`kanban-config.json`/`llm.json`）的一次性幂等迁移——server 与
CLI 入口各调一次，保证纯 CLI 用户升级后也读到旧配置。每个 section 有专门模块
（`ui-settings.js`、`cli-bins.js`、`status-config.js`、`kanban-config.js`、
`lib/llm.js`）做白名单与校验。

单一 `GET/PUT /api/settings`（`lib/routes/settings.js`）是唯一 Web 入口。GET 全量
返回（`llm` 密钥永不明文回传，只回 `hasApiKey`）；PUT 仅保存请求体提供的 section。
`cliBins` 返回 `bin`/`configured`/`default` 反映实际生效命令；`status`/`kanban`
返回 `value`/`configured`/`default`。

## 7. LLM 抽象

`lib/llm.js` 的 `runLlm()` 是所有 LLM 后端功能（prompt 改写、模板聚类建议、资产库
命名建议）的单一后端。后端优先级：

1. `llm` section 中显式的 OpenAI 兼容端点（`baseUrl` + `model` 必填，本地服务器
   `apiKey` 可选）。
2. PATH 上的 `claude` CLI（原始行为）。

两者都不可用时 `runLlm` 抛 `err.code = 'NO_LLM_BACKEND'`，其 message 携带配置指引；
路由把它表面化而不是灰按钮。

**OpenAI 路径的双传输**（慢 MaaS 网关修复）：`proxyRequiredFor(url)` 判断目标主机
是否必须走环境代理（Node env-proxy 语义的保守子集，边界偏向代理）。外部端点走
`runOpenAiViaFetch`（Node 环境代理经默认 fetch dispatcher）；直连/内网/本地端点走
`runOpenAiDirect`（node `http(s)` 自有墙钟超时），从而 undici 隐藏的 5 分钟
`headersTimeout` 不再把真正慢的生成响应误杀成一句 "fetch failed"。单次分析超时默认
15 分钟，钳制 `[2s, 1h]`，可通过 `llm.analysisTimeoutMs` 配置。错误码：
`NO_LLM_BACKEND` / `LLM_TIMEOUT` / `LLM_NETWORK`。`lib/llm-json.js` 解析/修复
LLM 返回的 JSON（围栏、括号、引号）。

## 8. 会话续跑

`lib/resume.js` 是续跑命令串的单一来源——CLI `sessions resume` 与 Web「复制恢复
命令」按钮都生成终端实际 spawn 的完全一致命令。

**原生续跑契约**（`RESUME_BINS`）：

| 平台 | 参数 |
|---|---|
| codex | `resume <id> --yolo` |
| claude-code | `--dangerously-skip-permissions --resume <id>` |
| omp | `--auto-approve --resume=<id>` |
| dsh | `--profile pi-tui --preset standard --resume <id>`（交互式 TUI；`--session-id` 不认 web 创建的会话） |
| gemini | `-r <id> --approval-mode=yolo` |
| hermes | `--resume <id> --yolo` |

`hasResumeContract(platform)` 对这六个平台为真，或自定义适配器声明完整
`resume: { bin, args(id, opts) }` 时也为真。`buildResumeCommand` 通过
`resolveCliBin()` 解析可执行文件（环境变量 `AGENTLRAY_<PLATFORM_ID>_BIN` →
`~/.agentlray/settings.json` 的 `cliBins` section → 默认命令名），并按 shell 引号
包裹（win32 用 PowerShell `Set-Location` + `&`；POSIX 用 `cd 'cwd' &&`）。OMP 续跑
额外通过 `/proc` 扫描检测持锁进程并在重新 spawn 前终止它（SIGTERM → SIGKILL 兜底）。

## 9. 会话列表：CLI 与 API 共享一层数据

`lib/session-list.js` 是 `bin/sessions.js list` 与聚合端点 `GET /api/sessions` 共用
的数据层。`parsePlatformSelection` 解析单 id、逗号多值或 `all`。`filterAndPage`
应用 `status`/`match`（id/title/firstUserMessage/lastMessage）/`since`/`until`
（lastActivity，回退 timestamp）过滤加 `offset`/`limit` 分页。`listPlatformSessions`
处理单平台（openclaw 按 agent）；`listOpenclawSessionsFlat` 枚举全部 agents
（`readAgents` → 逐 agent → 跳过缺失目录）并展平，为每条会话标注来源 `agent`——
这支撑 web 看板与 CLI 的 openclaw 缺省「全部 agents」。`listSessionsBySelection`
返回统一形状 `{ all, platformIds, total, offset, limit, platforms:[{platform, agent, ...}] }`。

## 10. HTTP API

`server.js` 挂载路由模块；业务逻辑在 `lib/`。CSRF 防护（`lib/csrf.js`）在解析 body
前拒绝跨站的状态变更请求（浏览器总会带 `Origin`/`Sec-Fetch-Site`；边界是同源或无
`Origin` 的非浏览器客户端）。所有响应设 `Cache-Control: no-store`。JSON body 上限
256 KB。

| 方法与路径 | 用途 |
|---|---|
| `GET /api/version` | `{ bootId }`——前端陈旧检测（轮询；变化提示刷新）。 |
| `GET /api/status-labels` | 统一状态词汇 `{ order, labels }`。 |
| `GET /api/sessions` | 聚合多平台列表（见 §9）。 |
| `GET /api/agents` · `GET /api/agents/:name/sessions[/:id]` | OpenClaw agent/会话列表（legacy 兼容）。 |
| `GET /api/spawn-map` · `GET /api/spawn-tree[/:sessionId]` | Agent 派生关系图 / 树。 |
| `GET /api/:platform/sessions` · `/…/:sessionId` | 注册表驱动的通用列表 / 详情。 |
| `GET /api/:platform/sessions/:id/resume-command` | 续跑命令串（单一来源 §8）。 |
| `GET /api/omp/sessions/:id/children[/:name]` | OMP 子代理。 |
| `GET /api/claude-code/sessions/:id/children[/:name]` | Claude Code 子代理。 |
| `GET /api/settings` · `PUT /api/settings` | 统一设置（§6）。 |
| `GET /api/settings/cli-bins` | 冻结 legacy UI 的只读兼容端点。 |
| `GET /api/platforms` | 平台列表（含自定义 + broken，§4.3）。 |
| `GET /api/insights` | 聚合分析（工具、错误聚类、趋势）。 |
| `GET /api/tools/audit` | 跨平台工具健康。 |
| `GET /api/prompts` · `/analyze` · `POST /api/prompts/rewrite` · `/hidden…` | prompt 提取/聚类/改写/隐藏。 |
| `GET /api/library` … `POST /api/library/:name/install` 等 | prompt 资产库 + 安装为 slash 命令。 |
| `GET /api/search` | 全平台多关键词 AND 全文搜索。 |
| `GET /api/:platform/sessions/:id/export` | Markdown/HTML 导出（`format=md\|html`）。 |
| `GET /api/:platform/sessions/:id/otlp` | OTLP/JSON 链路导出。 |
| `GET /api/watch` | SSE 实时 tail + 状态推送。 |
| `POST /api/backup` · `GET /api/backup/status` | 增量备份。 |

完整的带参数/每平台目录覆盖的端点表见 [usage.zh-CN.md](usage.zh-CN.md)。

## 11. 构建管线与双前端

`npm run build:ui` 执行三步：

1. `scripts/build-diagnostics.mjs` — 用 esbuild（bundle + minify + CJS）把
   `frontend/src/views/sessions/diagnostics.ts` 编译为 `lib/generated/diagnostics.cjs`，
   追加 `module.exports.rulesSha256`（TS 源码哈希）。`--check` 检测漂移。
   `lib/inspect.js` `require` 该产物，因此 CLI 与 UI 应用相同诊断规则（§12）。
2. `scripts/build-legacy-pure.mjs` — 用 esbuild 把 `frontend/src/lib/legacy-pure.ts`
   （re-export `pure.ts` + `markdown.ts`）编译为 `public/js/pure.js`（IIFE
   `__axrPure`）：浏览器挂 `window.*`、Node 走 `module.exports`。这就是冻结 legacy
   UI 与 React 前端共享单一来源的格式化器/markdown/瀑布图构建器的方式。
3. `cd frontend && npm run build` — `tsc -b && vite build` → `frontend/dist`。

运行时，`server.js` 在 `frontend/dist/index.html` 存在时于 `/` 提供构建后的 React UI，
并在 `/legacy` 提供 legacy 原生 UI（冻结快照：只接受安全修复）。无构建产物时 legacy
兜底挂 `/`。React 是唯一功能开发面。

## 12. 诊断与证据

`frontend/src/views/sessions/diagnostics.ts` 是**唯一规则来源**。它导出四个分析器：

- `diagnoseSession` → 失败事件（`events`）：按 `userTurn + tool + 完整参数` 聚合
  未解决失败、重复操作优先、同参后续成功切断分组并报告恢复。
- `summarizeSessionHealth` → 健康统计（`summary`）：调用/结果状态、孤立/未分配/
  歧义调用、`gaps`（调用-结果缺口：running/unknown/no-result）、失败/待定/恢复/
  重复/候选计数。
- `analyzeCodexProcesses` → `processes`：把 `exec_command` 进程 id 关联到后续
  `write_stdin` 结果，带启动/轮询/退出证据与歧义码（`ambiguous-launch`/
  `reused-process-id`/`overlapping-polls`/…）。
- `analyzeVerificationChronology` → `chronology`：区分修改前的检查、与修改重叠的
  检查及后续最新结果；最新顺序歧义保持未知。

离线 CLI（`lib/inspect.js` + `bin/inspect.js`）读取恰好一个稳定 JSONL 文件
（≤ 64 MiB，平台 omp/codex/claude-code），归一化后通过生成包应用同一套四个分析器，
产出带版本报告（`schemaVersion: 1`），字段含 `complete`、`engine{rulesSha256,
adapterSha256}`、`source{platform, bytes, sha256}`、`coverage`、`summary`、`events`、
`gaps`、`processes`、`chronology`、`limits`。引用为 `{ line, messageIndex }`
（1-based 物理 JSONL 行）。分层 CLI 增加 `inspect --summary --json`（抽样引用，
`REFERENCE_LIMIT=5`）与显式 `evidence` 命令（带哈希/行校验与 UTF-8 字节翻页的原文
返回，`MAX_EVIDENCE_BYTES=16384`）。退出码：0 = 报告已生成（非任务成功），
1 = 输入/覆盖/运行错误，2 = `--fail-on pending-failures` 发现未闭合待定失败。
见 [offline-inspect.zh-CN.md](offline-inspect.zh-CN.md)。

本机复核队列**纯前端**（`diagnostic-reviews.ts`），存 `localStorage` 的
`axr-diagnostic-review-v1:*` 前缀，带证据指纹使证据变化令旧复核失效；迁移面板可
导出/导入（仅精确匹配、绝不覆盖）。

## 13. 前端架构

**入口与状态。** `frontend/index.html → src/main.tsx` 挂载 React 19 SPA
（`ReactDOM.createRoot` + `StrictMode` + `QueryClientProvider` + sonner
`<Toaster>`）。**没有 react-router**：视图/详情路由用 URL query 参数 + 单一全局
zustand store（`src/store.ts`，`useAppStore`）。服务端数据经 `@tanstack/react-query`
（queryKey 契约 + SSE 缓存合并 + 5s 轮询）。`src/api/client.ts` 是类型化 fetcher
层（`fetchJson`/`requestJson` 非 2xx 抛 `Error(body.error)`；`withParams` 过滤空参数；
DEMO 模式经 `demoJson` 走合成 fixture）。

**路由持久化。** 会话详情上下文（`?session=&sid=&agent=`）与右侧视图页签（`?view=`）
经 `replaceState` 写入/恢复（`syncSessionUrl`/`parseDetailFromUrl`/
`parseViewFromUrl`）；筛选/分组配置走 `localStorage`。React 与 legacy UI 共享同一个
`localStorage` 键 `agent-xray-settings`。

**视图**（`App.tsx` 中五个 Tabs）：`sessions`、`insights`、`prompts`、`library`、
`kanban`。

- **sessions** —— 最复杂。`SessionsView` 渲染摘要 + 消息/瀑布图；
  `useSessionDetail`/`useActiveSessionDetail`（`childAgents.ts` 在
  `viewingChildAgent` 时切子转录本）、`useSessionSse`（EventSource `/api/watch`；
  新消息 append 到同 query cache，推送的 status 合并进 `['sessions',…]` 列表缓存）、
  `usePlatformProbe`（空态）。`SessionList` 是侧栏：分组（`platform`/`project`/
  `none`）+ 四态子组头、虚拟滚动（>200 行，`@tanstack/react-virtual`）、方向键导航。
  `queries.ts` 定义 queryKey/options；`CmdkDialog` 经 `queryClient.fetchQuery` 复用
  同缓存。状态标签来自 `/api/status-labels`（`statusMeta.ts`）。
- **trace** —— `TraceView` 从 `buildTraceTurns`（`pure.ts`）渲染 Langfuse 风格
  瀑布图；紫色条加载被派生子代理的转录本（`childAgents.ts`）。
- **insights** —— `GlobalInsights`（服务端 `/api/insights`，工具统计/错误聚类/趋势
  + `ToolsAuditSection`）对 `SessionInsights`（客户端从已加载的会话详情缓存用
  `computeSessionInsights` 计算）。
- **prompts** —— 按 cwd 分组的提取、搜索、隐藏琐碎、批量隐藏、JSON 导出、
  `分析优化`（聚类 + 归因 + LLM 建议，经 `getPromptAnalysis`）与单条 `优化` 改写。
- **library** —— 精选 prompt，按目标（claude/codex/omp）安装开关、编辑/历史、
  Fabric 导入、LLM 命名建议。
- **kanban** —— 复用 `useSessionsList`（同缓存/5s 轮询/SSE 合并）与
  `buildKanbanColumns`（`kanbanLib.ts`）按四态分桶；`maxPerStatus`（默认 20）截断
  来自 `/api/settings` 的 `kanban`；<768px 响应式堆叠。

**共享库。** `src/lib/pure.ts` —— 无 DOM 纯函数（格式化器、瀑布图构建器、回合账本）；
`src/lib/markdown.ts` —— escape-then-transform markdown；`src/lib/legacy-pure.ts` ——
被烘焙到 `public/js/pure.js` 的聚合出口（§11）。`src/lib/utils.ts` 提供 `cn()`
（clsx + tailwind-merge）。

**主题与 UI。** `useTheme` 把 `store.theme`（`light`/`dark`）同步到 `<html>` 的
`.dark` 类；调色板在 `index.css` 的 CSS 变量（`:root` 亮 / `.dark` 暗，映射到
Tailwind 颜色）。初始主题跟随系统一次，之后由手动切换固定并持久化到
`agent-xray-settings`。UI 组件库是 shadcn/ui 风格，基于 Radix + Tailwind，位于
`src/components/ui/`（button/badge/card/dialog/select/tabs/command/…）。

## 14. 实时 watch（SSE）

`lib/watch.js` + `lib/routes/watch.js` 实现 `GET /api/watch`（EventSource）。
`readNewLines` 从字节偏移 tail 文件（普通 JSONL 只推进到最后一个完整行；dsh zstd
解压每个完整新帧并留撕裂帧给下次）。`parseWatchLines` 经平台 `watchParse` 归一化
追加行。`accumulateWatchTail`/`watchTail` 喂给尾部证据状态机，使路由每次推送都能
推导状态而无需重新解析整个日志。OMP watcher 额外处理会话级 `session_exit` 记录
（→ `noteEnded` + `resolveAllPending`，使 `ask` 交互闭环）。Hermes 有专门 SQLite
WAL-watch 分支（时间戳增量查询）。

## 15. 备份、导出、OTLP

- **备份**（`lib/backup.js`）：增量——把各平台会话日志复制到
  `~/.agentlray/archive/<platform>/<相对路径>`；归档副本存在且 size 相同、mtime 不
  早于源时跳过。覆盖 codex/claude-code/omp/dsh/gemini；排除 Hermes（活 SQLite）与
  openclaw。按需运行并在启动后不久自动运行一次、之后每日；失败只记录、绝不致命。
- **导出**（`lib/export.js`）：把归一化会话渲染为可分享的 Markdown 或自包含 HTML
  （内联 CSS，无外部请求）。工具调用渲染为折叠 `<details>`。最佳努力的
  `redactSecrets` 脱敏（Bearer token、`sk-` 键、`Authorization`/`x-api-key` 头、
  `gh_`/`xox_`/`AKIA`）。`fenceFor` 防止内嵌反引号围栏逃逸。
- **OTLP**（`lib/otlp.js`）：把会话链路序列化为 OTLP/JSON——每会话一个 trace，每个
  用户轮次一个 `invoke_agent` 根 span，子 span 为 `chat {model}` 与
  `execute_tool {toolName}`，镜像前端 `buildTraceTurns`。确定性 sha256 派生 id。
  排除 openclaw（需要 agent）与 hermes（无文件）。

## 16. 安全与信任模型

- **无认证，默认 localhost。** 看板零认证暴露完整会话历史；默认绑定 `127.0.0.1`
  （`HOST=0.0.0.0` 选择 LAN）。
- **CSRF：** 无 cookie → CSRF token 无意义。防护用 `Origin`/`Sec-Fetch-Site`/
  `Referer` 对比请求的 `Host` 拒绝跨站不安全请求（相对来源，LAN 部署在任何主机名
  下仍可用）。
- **路径净化：** `resolveDir` 只接受绝对、无 `..` 的覆盖；`sanitizeAgentName`/
  `sanitizeSessionId` 白名单字符。
- **自定义平台是你信任的代码。** 适配器以你的完整用户权限执行；只放可信文件
  （`AGENTLRAY_NO_PLUGINS=1` 作为逃生舱）。这是
  `docs/.local/adr-0001-custom-platform-adapter.zh-CN.md` 记录的取舍。
- **导出/证据是可分享工件。** `redactSecrets` 是尽力而为；`evidence` 命令显式返回
  原文。两者都不是净化器、授权或真实性证明。

## 17. 测试

测试用 Node 内置运行器（`node --test test/*.test.js`，无额外依赖）。它们在自己的
随机端口启动服务，`HOME` 与所有平台目录指向 `test/fixtures/home` 的一次性副本，
绝不读写真实日志。CI 在 Node 22 上运行：`npm ci`（prepare 构建 UI + 重新生成
`pure.js`/`diagnostics.cjs`）、漂移检查（`git diff --exit-code public/js/pure.js
lib/generated/diagnostics.cjs`）、`npx biome check .`、然后 `npm test`。诊断规则在
TS 源码与生成 CJS 包之间交叉校验，保证 CLI 与 UI 一致。

## 18. 关键架构决策（小结）

| 决策 | 理由 |
|---|---|
| 平台注册表单一真源 | 一个适配器 + 一次注册即新增平台；每个通用表面都经它解析。 |
| 运行时自定义适配器 | 不改源码即可扩展；可信代码取舍（ADR-0001）。 |
| 自定义平台同步加载 | 派生点都在 `require` 期读 `PLATFORMS`。 |
| 记录证据推导统一四态 | 不查进程；列表 + watch + CLI 一致。 |
| 单一 `settings.json` + 单一 `/api/settings` | 一次迁移、一个 Web 入口；各 section 白名单。 |
| 单一 `lib/resume.js` | CLI 与 Web 复制产出完全一致命令。 |
| `pure.ts`/`markdown.ts` 单一来源 | 烘焙进 legacy UI；被测试复用。 |
| `diagnostics.ts` 编译为 CJS | CLI 与 UI 应用相同规则。 |
| 双前端（React 新、legacy 冻结） | 不破坏冻结快照的前提下获得功能速度。 |
| 基于 Origin/Host 对比的 CSRF | 无 cookie/认证可用；LAN 主机名下仍工作。 |
