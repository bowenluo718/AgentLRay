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
- **design-openclaw-all-agents.zh-CN.md** — openclaw 会话查询默认合并全部 agent 的方案设计（web 看板 + `agentlray sessions list/show` 缺省即全部 agents、每条标注来源 `agent`）

## 代码库现状提示

工作区当前含**未提交**的"会话状态功能"改动（`lib/status.js`、`lib/platforms/tail-state.js`、`test/status.test.js`、`test/watch-tail.test.js` 及 `lib/platforms/*`、`lib/routes/*`、`lib/watch.js`、前端若干文件的修改），与 [session-status-design.zh-CN.md](docs/.local/session-status-design.zh-CN.md) 对应。另有本轮新增的 **openclaw 全 agent 查询**改动（`lib/platforms/openclaw.js`、`lib/session-list.js`、`lib/routes/sessions.js`、`bin/sessions.js`、前端 `client.ts`/`Sidebar.tsx`/`queries.ts`、`public/js/app.js`、`test/session-cli.test.js`/`test/api.test.js`），对应 [design-openclaw-all-agents.zh-CN.md](docs/.local/design-openclaw-all-agents.zh-CN.md)。另有 **平台 CLI 命令可配置**改动（`lib/config.js` 新增 `CODEX_BIN`/`CLAUDE_CODE_BIN`/`OMP_BIN` 常量，可用 `AGENTLRAY_*_BIN` 环境变量覆盖 `resume --run` spawn 的平台可执行名，未设置回退默认名；`bin/sessions.js` 的 `RESUME_BINS` 引用这些常量；`test/session-cli.test.js` 新增覆盖用例；`docs/usage.md`/`usage.zh-CN.md` 新增"平台 CLI 命令"小节）。已扩展到 **web 设置面板可配置**（新增 `lib/cli-bins.js` + `lib/routes/cli-bins.js` + `GET/PUT /api/settings/cli-bins`，存 `~/.agentlray/cli-bins.json`；`bin/sessions.js` 改经 `resolveCliBin()` 运行时解析：环境变量 > 配置文件 > 默认名；前端 `SettingsDialog.tsx` 新增 `CliBinsSection`、`client.ts` 新增 `getCliBins`/`saveCliBins`、demo router 加兜底），**且复制恢复命令同步使用配置命令**（`frontend/src/views/sessions/lib.ts` 的 `resumeCommand` 新增可选 `bin` 参数、`SessionSummary.tsx` `ResumeButton` 经 `getCliBins()` 读配置 bin、legacy `public/js/app.js` `resumeCmdBtn` 点击时 fetch cli-bins），对应 [design-cli-bin-config.zh-CN.md](docs/.local/design-cli-bin-config.zh-CN.md)。另有 **状态时间配置可配置 + 设置面板页签化**改动（新增 `lib/status-config.js` + `lib/routes/status-config.js` + `GET/PUT /api/settings/status`，存 `~/.agentlray/status-config.json`；`lib/status.js` 三时间常量改为 `DEFAULT_*` + 运行时 `setStatusConfig` 注入，`deriveStatus` 支持 opts 覆盖；`server.js`/`bin/sessions.js` 启动注入；前端 `SettingsDialog` 重构为按模块页签切换（数据目录/LLM 接口/平台 CLI 命令/状态时间配置/会话备份，用 `Tabs`/`TabsContent`，`SettingsSection` 折叠组件已删除）、弹框 `max-w-2xl max-h-[85vh] overflow-y-auto` 加宽加高滚动、每项 label+hint 清晰区分（LLM 接口补字段 label）；`test/status-config.test.js` 新增），对应 [design-status-config.zh-CN.md](docs/.local/design-status-config.zh-CN.md)。另有本轮新增的 **终端命令平台非必填、缺省用页面持久化平台数据**改动（`lib/ui-settings.js`、`lib/routes/ui-settings.js`、`server.js`、`bin/sessions.js`、前端 `client.ts`/`store.ts`、`test/api.test.js`/`test/session-cli.test.js`、`docs/.local/cli-usage.md`），对应 [design-cli-platform-default.zh-CN.md](docs/.local/design-cli-platform-default.zh-CN.md)。`architecture.md`/`implementation.md` 基于 v1.24.0 快照撰写，均未并入以上改动——阅读时留意差异。

另有**本轮评审优化**（相对 `0e4f89c`）：`GLOSSARY.md` 归位至 `docs/.local/glossary.zh-CN.md` 并登记索引；前端移除 `includeArchived` 配置（开关/状态/查询传递，后端 `include_archived` API 能力保留）；openclaw 全 agent 枚举收敛至 `lib/session-list.js`（新增 `listOpenclawSessionsFlat`、删除 `lib/platforms/openclaw.js::listSessionsForAllAgents`），`bin/sessions.js` 单平台缺省与 `GET /api/openclaw/sessions` 统一走共享层。
