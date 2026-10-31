# AgentLRay 项目约定（项目记忆）

> 本文件是项目级记忆，随仓库分发，供后续每轮会话加载。全局环境约定见 `~/.omp/agent/AGENTS.md`。

## 文档与语言约定

- **中间过程文档默认输出到 `docs/.local/`**：方案设计、需求/规格、任务计划、任务执行进度、审查文档、测试举证等，未指定路径时一律写入 `docs/.local/`，并按 [docs/.local/README.md](docs/.local/README.md) 的命名规范命名、登记进该索引。
- **默认使用简体中文**：文档内容、思考过程与对用户的回复默认用简体中文；代码标识符、命令、配置键、错误信息保持原文不翻译。

## 文档索引

`docs/.local/README.md` 是本目录唯一索引，新增中间文档时须同步更新。已产出文档：

- **architecture.md** — AgentLRay 总体架构设计方案（分层、模块、注册表、数据模型、前后端契约、构建管线、缓存/安全/测试）
- **implementation.md** — 核心模块详细实现逻辑设计（平台归一化、诊断规则、离线 inspect、搜索、prompts/资产库、SSE、导出/OTLP、备份、LLM）
- **csm-analysis.zh-CN.md** — csm（claude-sessions-monitor）三种机制分析：会话状态判断、实时监听、Agent 区分
- **session-status-design.zh-CN.md** — 会话状态信息/监控更新/分组排序的方案设计（含 P0–P4 各阶段审查结论与采纳）
- **design-session-cli.md** — 终端会话查询与续跑 CLI 设计（`agentlray sessions list/show/resume`）
- **cli-usage.md** — bin 命令使用说明（`agentlray` 主入口与各子命令参数/语义/退出码）
- **design-openclaw-all-agents.zh-CN.md** — openclaw 会话查询默认合并全部 agent 的方案设计（web 看板 + `agentlray sessions list/show` 缺省即全部 agents、每条标注来源 `agent`）
- **design-sidebar-filters.zh-CN.md** — 侧栏会话列表筛选迁移（平台多选、项目筛选、分组模式与两级组头、折叠持久化）
- **design-cli-platform-default.zh-CN.md** — 终端会话命令平台非必填、缺省用页面持久化平台数据（`~/.agentlray/ui-settings.json`）
- **design-cli-bin-config.zh-CN.md** — 平台 CLI 命令可配置（环境变量 > `~/.agentlray/cli-bins.json` > 默认名）
- **design-status-config.zh-CN.md** — 状态时间配置可配置 + 设置面板页签化（`~/.agentlray/status-config.json`）
- **design-settings-merge.zh-CN.md** — 统一设置文件 + 公用保存/重置（`~/.agentlray/settings.json`、单一 `GET/PUT /api/settings`、旧文件首启幂等迁移、`SettingsDialog` 单 draft + 统一 Save/Reset；grill 决策 R1-Q1~Q5、R2-Q-A/Q-B）
- **glossary.zh-CN.md** — AgentLRay 术语约定（平台/会话摘要/项目/会话状态/分组模式/Agent 等）

## 代码库现状提示

工作区**干净**，以下能力均已合入主干（`72dee90` 及更早的 `9db47d9`/`0e4f89c`），不再是"未提交改动"。阅读代码时以仓库实际文件为准，下表仅作定位索引：

| 能力 | 主要代码位置 | 对应设计文档 |
| --- | --- | --- |
| 会话状态四态（`awaiting-input`/`working`/`waiting`/`stopped`）、判定窗口、`tail` 证据契约 | `lib/status.js`、`lib/platforms/tail-state.js`、`lib/routes/sessions.js`（`GET /api/status-labels` 单源透出标签与配色）、`test/status.test.js`、`test/watch-tail.test.js` | [session-status-design.zh-CN.md](docs/.local/session-status-design.zh-CN.md) |
| openclaw 会话查询缺省合并全部 agent（每条标注来源 `agent`，`--agent` 转可选；新增聚合端点 `GET /api/sessions`） | `lib/session-list.js`（`listOpenclawSessionsFlat`）、`lib/routes/sessions.js`、`bin/sessions.js`、前端 `client.ts`/`queries.ts`/`Sidebar.tsx` | [design-openclaw-all-agents.zh-CN.md](docs/.local/design-openclaw-all-agents.zh-CN.md) |
| 终端会话查询与续跑 CLI（`agentlray sessions list/show/resume`） | `bin/sessions.js`、`docs/usage.md`、`docs/usage.zh-CN.md` | [design-session-cli.md](design-session-cli.md)、[cli-usage.md](cli-usage.md) |
| 终端命令平台非必填、缺省用页面持久化平台数据 | `lib/ui-settings.js`（`settings.json` 的 `ui` section）、前端 `client.ts`/`store.ts`（`saveUiSettings` → `PUT /api/settings {ui}`） | [design-cli-platform-default.zh-CN.md](design-cli-platform-default.zh-CN.md) |
| 平台 CLI 命令可配置（`resume --run` spawn 的可执行名；解析优先级：环境变量 `AGENTLRAY_*_BIN` > `settings.json` 的 `cliBins` section > 默认名；内置覆盖 codex/claude-code/omp/dsh/gemini/hermes 六平台） | `lib/cli-bins.js`（`CLI_BIN_DEFAULTS`/`CLI_BIN_ENV`/`envVarFor`，不含 lib/config.js 常量——环境变量名通用推导在 `envVarFor`）、`lib/routes/cli-bins.js`（**只读兼容** `GET /api/settings/cli-bins`）、`bin/sessions.js`（`resolveCliBin()`）、前端 `SettingsDialog.tsx`、`frontend/src/views/sessions/lib.ts`（`resumeCommand` 的 `bin` 参数）、`public/js/app.js`（`resumeCmdBtn`） | [design-cli-bin-config.zh-CN.md](design-cli-bin-config.zh-CN.md) |
| 状态时间窗口可配置（2min/30min/12h）并运行时注入 `deriveStatus`；设置面板按模块页签化 | `lib/status-config.js`（`settings.json` 的 `status` section）、单一 `GET/PUT /api/settings`（保存即 `setStatusConfig` 注入）、`lib/status.js`（`DEFAULT_*` + `setStatusConfig`）、前端 `SettingsDialog.tsx` | [design-status-config.zh-CN.md](design-status-config.zh-CN.md) |
| 服务端设置聚合单文件 + 公用保存/重置（**本工作区未提交**） | `lib/settings.js`（聚合读写/原子写/`migrateLegacySettings`）、`lib/routes/settings.js`（单一 `GET/PUT /api/settings`）、各 section lib 模块（`ui`/`cliBins`/`status`/`kanban`/`llm`）、`server.js`（启动迁移）、`bin/sessions.js`（入口迁移）、前端 `client.ts`/`SettingsDialog.tsx`（单 draft + 统一 Save/Reset，Reset 警告色）/`demo/router.ts` | [design-settings-merge.zh-CN.md](docs/.local/design-settings-merge.zh-CN.md) |
| 侧栏会话筛选迁移（平台多选、项目筛选、分组模式与两级组头、折叠持久化；详情上下文与筛选上下文解耦） | 前端 `SessionFiltersDialog.tsx`、`Sidebar.tsx`（`PlatformBar.tsx` 已删除）、`SessionList.tsx`、`store.ts` | [design-sidebar-filters.zh-CN.md](design-sidebar-filters.zh-CN.md) |

补充说明：

- **修复批：提示词分析失败 + 各平台标题/首消息口径（todo 第 1 项，本工作区未提交）**：`lib/llm.js` 分析请求改造为「NO_PROXY/直连走 node http(s) 自有超时，需代理走 fetch」双路径（绕开 undici 默认 300s headers 超时误杀慢网关），单次分析超时默认 600s→900s；claude/codex/openclaw/omp 会话 `title` 回退 `firstUserMessage`（否则前端显示 UUID）；openclaw 兼容字符串 content（user 消息纯文本落盘）+ `stripOpenClawNoise` 剥离注入前缀；omp 从 `<attachment>` worker 模板提取真实任务（`extractOmpAttachmentTask`）；`tail-state.js` 新增 `resolvedIds` 防 tool_result/tool_use 乱序残留 pending；前端 UI 微调（看板卡片激活态、Trace 折叠、SessionsView 滚动）；`test/registry.test.js` 用 `AGENTLRAY_NO_PLUGINS` 隔离本机自定义适配器泄漏。corresponding tests: `test/llm.test.js`、`test/omp.test.js`（新）、`test/openclaw.test.js`（新）、`test/watch-tail.test.js`、`test/claude.test.js`。
- **会话续跑扩至全内置平台（本工作区未提交）**：`RESUME_BINS` 覆盖 codex / claude-code / omp / dsh / gemini / hermes 六平台（dsh 走 `--profile pi-tui --preset standard --resume <id>`，2026-10-31 用户实测——交互式 TUI 续跑 web 创建的 `session-<uuid>` 会话；headless `--session-id` 不认这类会话，`--preset` 在 resume 路径不生效）；「复制恢复命令」/CLI `resume --run`/设置面板/cliBins 兼容端点同步；自定义平台维持适配器 resume opt-in（ADR-0001）。详见 [design-resume-more-platforms.zh-CN.md](docs/.local/design-resume-more-platforms.zh-CN.md)。
- **评审收敛（相对 `0e4f89c`）**：`GLOSSARY.md` 归位至 `docs/.local/glossary.zh-CN.md` 并登记索引；前端移除 `includeArchived` 配置（开关/状态/查询传递，后端 `include_archived` API 能力保留）；openclaw 全 agent 枚举收敛至 `lib/session-list.js`（删除 `lib/platforms/openclaw.js::listSessionsForAllAgents`），`bin/sessions.js` 单平台缺省与 `GET /api/openclaw/sessions` 统一走共享层。
- **双前端约定**：`frontend/`（React 19 + Vite）是**唯一的功能开发面**；`public/` 下的 vanilla UI 是**冻结快照**，服务在 `/legacy`，只接受安全修复，新功能不落 legacy。两套 UI 共享 `frontend/src/lib/pure.ts` + `markdown.ts` 单一真源（由 `scripts/build-legacy-pure.mjs` 烘焙出 `public/js/pure.js`）与同一 localStorage 键 `agent-xray-settings`。有 `frontend/dist` 时 React 挂根路径、legacy 挂 `/legacy`；无构建产物时 legacy 兜底挂根路径。
- **`architecture.md`/`implementation.md` 基于 v1.24.0 快照撰写**，未包含上表各次改动——阅读时留意差异。
