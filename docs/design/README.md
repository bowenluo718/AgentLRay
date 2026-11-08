# docs/.local —— 项目本地文档索引

> 本目录存放 **AgentLRay 项目开发过程中的本地中间文档**：方案设计、审查、任务计划、任务执行进度、测试举证等，除非另有指定，一律输出到此处。
> 语言约定：本目录所有文档、思考过程与回复默认使用**简体中文**。

---

## 文档清单

| 文档 | 类型 | 说明 | 更新日期 |
| --- | --- | --- | --- |
| [architecture.md](architecture.md) | 方案设计 | **当前项目架构设计方案**：分层架构、模块职责、平台注册表、统一数据模型、前后端契约、构建管线、缓存/安全/测试体系 | 2026-10-23 |
| [implementation.md](implementation.md) | 方案设计 | **当前项目详细实现逻辑设计**：平台归一化、诊断规则四分析器、离线 inspect、搜索、prompts/资产库、SSE watch、导出/OTLP、备份、LLM、异常/退出策略 | 2026-10-23 |
| [csm-analysis.zh-CN.md](csm-analysis.zh-CN.md) | 参考分析 | **csm（claude-sessions-monitor 1.3.1）机制分析**：会话状态判断（三时间窗口/四态）、实时监听（2s 滚动+三级缓存）、Agent 区分（进程识别→日志归属→配对置信度） | 2026-10-23 |
| [session-status-design.zh-CN.md](session-status-design.zh-CN.md) | 方案设计 | **会话状态信息/监控更新/分组排序设计**：统一四态 `status` 跨 7 平台、证据契约 `tail`、`deriveStatus` 判定链、SSE 即时刷状态、分组排序；含 P0–P4 迭代审查结论与验收记录 | 2026-10-23 |
| [design-session-cli.md](design-session-cli.md) | 方案设计 | **终端会话查询与续跑 CLI 设计**：`agentlray sessions list/show/resume` 三个子命令、过滤条件、续跑执行语义（默认打印 / `--run` 执行）、复用平台注册表与统一四态、输出与退出码约定 | 2026-10-23 |
| [cli-usage.md](cli-usage.md) | 参考文档 | **bin 命令使用说明**：主入口 `agentlray`（port/host/version）与子命令 `inspect`/`evidence`/`sessions list|show|resume|new`、`platform list|validate|mount|unmount|replace|unreplace|export` 的完整参数、语义、输出与退出码约定（含 `sessions new` 各平台新建命令形态的 `--help` 实测来源） | 2026-11-08 |
| [design-openclaw-all-agents.zh-CN.md](design-openclaw-all-agents.zh-CN.md) | 方案设计 | **openclaw 会话查询默认合并全部 agent**：web 看板与 `agentlray sessions list/show` 缺省即全部 agents、每条标注来源 `agent`，`--agent` 转可选；含数据/路由/CLI/前端改动与验证 | 2026-10-26 |
| [design-sidebar-filters.zh-CN.md](design-sidebar-filters.zh-CN.md) | 方案设计 | **侧栏会话列表筛选迁移**：平台选择迁入侧栏（全部+多选）、项目筛选（cwd 推导、末段重复显完整 cwd）、分组模式（按平台/按项目/不分组，两级组头）、折叠与持久化；含后端 openclaw 补 cwd 与前端改动清单 | 2026-10-26 |
| [design-cli-platform-default.zh-CN.md](design-cli-platform-default.zh-CN.md) | 方案设计 | **终端会话命令平台非必填、缺省用页面持久化数据**：前端 localStorage → `PUT /api/settings/ui` → `~/.agentlray/ui-settings.json` → CLI 缺省 `--platform`；含 `list` 多选/all、`show`/`resume` 单平台缺省语义与验证 | 2026-10-26 |
| [design-cli-bin-config.zh-CN.md](design-cli-bin-config.zh-CN.md) | 方案设计 | **平台 CLI 命令可配置**：`resume --run` spawn 的可执行命令支持 web 设置面板配置，解析优先级「环境变量 > 服务端 `~/.agentlray/cli-bins.json` > 默认名」；含 `lib/cli-bins.js`、`/api/settings/cli-bins` 路由、设置面板 `CliBinsSection` 与验证 | 2026-10-26 |
| [design-status-config.zh-CN.md](design-status-config.zh-CN.md) | 方案设计 | **状态时间配置可配置 + 设置面板页签化**：四态判定窗口（2min/30min/12h）支持 web 设置面板配置并运行时注入；`SettingsDialog` 重构为按模块页签切换（数据目录/LLM 接口/平台 CLI 命令/状态时间配置/会话备份）、弹框加宽加高滚动、每项 label+hint 清晰区分；含 `lib/status-config.js`、`/api/settings/status`、`SettingsSection` 与验证 | 2026-10-27 |
| [design-settings-merge.zh-CN.md](design-settings-merge.zh-CN.md) | 方案设计 | **统一设置文件 + 公用保存/重置**：`~/.agentlray` 下 5 个服务端设置 JSON 聚合为单一 `settings.json`（`ui`/`cliBins`/`status`/`kanban`/`llm` 五 section）、单一 `GET/PUT /api/settings`、旧文件首启幂等迁移、legacy 仅保留只读 `GET /api/settings/cli-bins`、`SettingsDialog` 单 draft + 底部统一 Save/Reset（警告色）；含 grill 决策 R1-Q1~Q5、R2-Q-A/Q-B 与验证 | 2026-10-29 |
| [design-kanban.zh-CN.md](design-kanban.zh-CN.md) | 方案设计 | **任务看板页面设计**：会话的看板式四态视图（参考 dsh 看板视觉）、完全共享侧栏筛选（平台/项目，看板不放控件）、列内按最后更新时间降序、每列 `maxPerStatus`（默认 20）截断 +「展开全部」、`~/.agentlray/kanban-config.json` + `/api/settings/kanban` + 设置 tab；含状态元共享模块抽取、文件改动清单与验证 | 2026-10-28 |
| [design-kanban-mobile.zh-CN.md](design-kanban-mobile.zh-CN.md) | 方案设计 | **任务看板移动端适配**（`design-kanban` 增量）：宽度 <768 四列纵向堆叠、每列默认 1 卡（`lastActivity` 降序首条）、组头整块可点、「全局手风琴」单列展开（`expanded` 收敛为单值，桌面多列同开随之取消）、页面级滚动、空列灰卡占位「这个状态还没有任务」；含 `kanbanLib` 签名变化（`collapsedLimit` + `expandedStatus`）、文件改动清单与验证 | 2026-10-29 |
| [design-sticky-headers.zh-CN.md](design-sticky-headers.zh-CN.md) | 方案设计 | **吸顶设计**：任务看板移动端（<768）状态列组头吸顶（相对外层 TabsContent，`sticky top-0 z-10 bg-card/95`）+ 左侧任务列表外层分组折叠头吸顶（相对 SessionList，`sticky top-0 z-10 bg-panel-alt/95`，`-mr-1` 抵消 `pr-1`）；虚拟化路径与状态子组头不吸顶；含改动清单与验收 | 2026-10-29 |
| [design-custom-platforms.zh-CN.md](design-custom-platforms.zh-CN.md) | 方案设计 | **自定义平台扩展（custom platform adapters）**：运行时 JS 平台适配器（`~/.agentlray/platforms/` 启动并入注册表）、适配器契约与能力位→表面映射、加载器隔离/`AGENTLRAY_NO_PLUGINS`/id 冲突、`GET /api/platforms`、CLI `platform list/validate`、resume opt-in、React+legacy 前端改造、watch 守卫；含决策摘要（Q1–Q12）与 P0–P6 实现切分 | 2026-10-27 |
| [custom-platform-example.zh-CN.md](custom-platform-example.zh-CN.md) | 样例文档 | **自定义平台适配器完整样例（P6 收尾）**：契约速查（必需/可选字段、能力位→表面映射）、可运行的扁平 JSONL 适配器（含 find/collectFiles/watchParse/needsAgent 注释 + resume 示例块）、启用方式、验证命令（platform validate/list 实测输出）、信任边界与能力缺位语义 | 2026-10-27 |
| [adr-0001-custom-platform-adapter.zh-CN.md](adr-0001-custom-platform-adapter.zh-CN.md) | 决策记录 | **ADR-0001**：自定义平台采用运行时 JS 平台适配器（为何非 JSON 声明式/非随仓库分发）；信任边界、契约、能力位缺位语义与前端服务端驱动；Status: accepted | 2026-10-27 |
| [plan-custom-platforms.zh-CN.md](plan-custom-platforms.zh-CN.md) | 任务计划 | **自定义平台扩展实施计划**：P0 加载器 → P1 服务端表面/watch 守卫 → P2 CLI `platform list/validate` → P3 resume opt-in → P4 React 前端 → P5 legacy 前端 → P6 收尾；每阶段文件清单、验证方式与依赖关系 | 2026-10-27 |
| [design-platform-equivalence.zh-CN.md](design-platform-equivalence.zh-CN.md) | 方案设计 | **平台来源统一与全表面等价（v2，当前设计）**：三类来源 `package`（`lib/platforms/builtin/`）/`project`（`<repo>/platforms/`）/`user`（`~/.agentlray/platforms/`）、加载顺序与同 id 规则、`platforms.disabled`（id 级停用）与 `platforms.replaced`（包内置来源替换）、`catalog`/`PLATFORMS`/`listPlatformInfo`、守卫与 `defaultPlatformId()`、Adapter 契约 v2 + 全表面 hook 映射、`*-impl.js` 防 require 环、settings/API/CLI、`platform export` 薄适配器、前端动态目录/平台页签/能力驱动；含 D1–D10 与兼容性分析 | 2026-11-07 |
| [plan-platform-equivalence.zh-CN.md](plan-platform-equivalence.zh-CN.md) | 任务计划 | **平台来源统一与全表面等价实施计划（v2，当前计划）**：P0 来源模型/catalog/disabled+replaced/控制面/默认平台/测试隔离 → P1 builtin 文件化 + 契约声明化 + 模块边界 → P2 会话核心面泛化 → P3 分析与导出面泛化 → P4 项目来源与 `platform export` 迁移 → P5 前端全量等价 → P6 文档/ADR/回归；含每阶段文件清单、验证命令、测试矩阵与 10 条关键坑 | 2026-11-07 |
| [design-platform-mount.zh-CN.md](design-platform-mount.zh-CN.md) | 方案设计（已取代） | ~~**内置平台 mount/unmount 设计（v1）**~~：已被 [design-platform-equivalence.zh-CN.md](design-platform-equivalence.zh-CN.md) 取代，保留历史。内置平台与自定义平台统一注册模型 + mount/unmount 生命周期、`platforms.disabled` 黑名单、adapter 文件化、能力/目录参数声明化；D1–D8 与三大坑 | 2026-11-07 |
| [plan-platform-mount.zh-CN.md](plan-platform-mount.zh-CN.md) | 任务计划（已取代） | ~~**内置平台 mount/unmount 实施计划（v1）**~~：已被 [plan-platform-equivalence.zh-CN.md](plan-platform-equivalence.zh-CN.md) 取代，保留历史。P0 注册表 + 黑名单 + 控制面 → P1 解耦硬编码 → P2 前端与设置面板 | 2026-11-07 |
| [review-platform-mount.zh-CN.md](review-platform-mount.zh-CN.md) | 评审意见 | **内置平台 mount/unmount 设计评审（不通过/需修订）**：逐条核对“内置↔自定义双向等价”需求缺口（项目目录缺失、内置无法迁到用户目录、等价边界未定义），列出 `listPlatformInfo`/守卫数据源/require 环/dirParam 派生/needsAgent 假泛化/缺省平台回退/设置写路径冲突/测试隔离等 14 项设计缺陷与 8 项计划缺陷，附最小修订清单与测试矩阵；修订结论落到 v2 设计与计划 | 2026-11-07 |
| [guide-custom-platforms.zh-CN.md](guide-custom-platforms.zh-CN.md) | 参考文档 | **自定义平台开发指导说明**：上手流程（写适配器→放入启用→validate/list 验证→resume opt-in→前端观察）、契约要点、硬性边界、开发对照 checklist 与回归护栏 | 2026-10-27 |
| [guide-quickstart-zh-CN.md](guide-quickstart-zh-CN.md) | 参考文档 | **安装使用快速入手**：环境要求、三种安装方式（npx/全局/源码）、启动与首次访问、基本使用流程、离线 inspect、配置目录与常见问题；对应 `9755ec0` 本地实测服务启动并返回 HTTP 200 | 2026-11-01 |
| [image-dsh-kanban.zh-CN.json](image-dsh-kanban.zh-CN.json) | 图像提取数据 | **dsh 看板截图结构化提取**：来源 `/home/0668000603/图片/dsh-看板.png` 的视觉识别结果（应用元信息、侧栏导航/工作区、工具条、五列看板任务卡、派生统计），供后续文本模型消费 | 2026-10-28 |
| [glossary.zh-CN.md](glossary.zh-CN.md) | 参考文档 | **AgentLRay 术语约定**：平台/会话摘要/项目/未知项目/会话状态/详情上下文/分组模式/Agent 等词汇的精确定义与 Avoid 词（随设计会话逐步增补；2026-11-03 增补「新建会话（create 契约）」） | 2026-11-03 |
| [design-co-mind-platform.zh-CN.md](design-co-mind-platform.zh-CN.md) | 方案设计 | **co-mind 自定义平台接入**：Claude Code 二次开发 fork（命令 `co-mind`，数据目录 `~/.icodemate/cli/projects`，数据与 claude-code 同构）；自包含自定义适配器（`docs/.local/platforms/co-mind.js` + 安装副本 `~/.agentlray/platforms/co-mind.js`）、grill 决策（R1-Q1~Q5、R2-Q1/Q2）、内联 shared/tail-state/status 逻辑、resume 带 `--dangerously-skip-permissions`、真实验证证据、search/prompts 源码层限制 | 2026-10-29 |
| [adr-0002-co-mind-platform.zh-CN.md](adr-0002-co-mind-platform.zh-CN.md) | 决策记录 | **ADR-0002**：co-mind（与 claude-code 逐字段同构的 Claude fork）以**自包含自定义适配器**接入而非内置平台（薄适配器 require agentlray 内部模块不可行的原因、内联 shared/tail-state/status、运行时状态窗口对齐、镜像漂移风险）；Status: accepted | 2026-10-29 |
| [design-windows-compat.zh-CN.md](design-windows-compat.zh-CN.md) | 方案设计 | **AgentLRay Windows 兼容设计**：HOME 用 `os.homedir()` + `AGENTLRAY_HOME` 覆盖、平台默认目录不建 Windows 映射表（靠环境变量）、resume 命令串按 `process.platform` 单一真源（PowerShell/POSIX）、spawn 加 `shell: win32`、omp 进程管理 Windows 降级、测试三类拆分；P0–P4 实现切分与每阶段验证 | 2026-10-29 |
| [design-resume-more-platforms.zh-CN.md](design-resume-more-platforms.zh-CN.md) | 方案设计 | **会话续跑扩展到全内置平台 + 自定义平台**：内置 resume 从 codex/claude-code/omp 扩到 dsh/gemini/hermes（原生参数硬编码进 `RESUME_BINS`：dsh `--profile pi-tui --preset standard --resume <id>`（2026-10-31 用户实测，交互式 TUI；headless `--session-id` 不认 web 创建的会话）、gemini `-r <id> --approval-mode=yolo`、hermes `--resume <id> --yolo`）、可执行名解析/CLI `--run`/web「复制恢复命令」/设置面板全覆盖、自定义平台维持适配器 resume opt-in（ADR-0001）；openclaw 不做、「新建任务」另起；含 grill 决策（Q1–Q6 全按推荐）与验证；legacy 冻结快照不落新功能 | 2026-10-30 |
| [design-theme-light-dark.zh-CN.md](design-theme-light-dark.zh-CN.md) | 方案设计 | **web 界面白天/黑夜主题**：两态（亮/暗）手动切换、首启跟随系统一次后固定、仅 React 前端（legacy 冻结快照不动）、顶栏太阳/月亮图标入口、仅 localStorage 持久化；CSS 变量反相（`:root` 亮 / `.dark` 暗）+ `darkMode:['class']`、store 加 `theme` 字段、手写 `useTheme` hook（不引 next-themes）、sonner 跟随主题；含硬编码颜色核查与验证 | 2026-10-30 |
| [adr-0003-windows-compat.zh-CN.md](adr-0003-windows-compat.zh-CN.md) | 决策记录 | **ADR-0003**：AgentLRay Windows 兼容关键决策（D1–D6）：`os.homedir()`、默认目录不建映射表、命令串单一真源按 `process.platform`、`shell:win32`、omp 能力降级、测试 skip/改跨平台/新增；Status: accepted | 2026-10-29 |
| [design-new-session-create.zh-CN.md](design-new-session-create.zh-CN.md) | 方案设计 | **新建会话任务（create）**：spawn 平台 CLI 开启全新会话，与 resume 对称；自定义适配器 `create: { bin, args(opts) }` opt-in、内置 `NEW_BINS`（codex/claude-code/omp/gemini/hermes 可建，**dsh 不支持新建**）、CLI `sessions new [message...] --platform [--dir] [--run]` + web 任务看板「新建任务」弹窗（提示词/cwd 手动输入/平台选择、默认当前会话项目与平台、只列 create 平台）、后端 POST 路由 fire-and-forget、PlatformInfo 加 create 标志；含 grill 决策（R1–R5）与 P0–P4 切分 | 2026-11-03 |
| [adr-0004-new-session-create.zh-CN.md](adr-0004-new-session-create.zh-CN.md) | 决策记录 | **ADR-0004**：新建会话采用与 resume 对称的 create 契约（内置 `NEW_BINS` + 自定义 `create: { bin, args(opts) }`、提示词末位裸参、dsh 不支持新建、web fire-and-forget、命令串单一真源）；Status: accepted | 2026-11-03 |
| [adr-0005-platform-sources.zh-CN.md](adr-0005-platform-sources.zh-CN.md) | 决策记录 | **ADR-0005**：平台来源统一与全表面等价（D1–D10）——三类来源 package/project/user、加载顺序与同 id 规则、`disabled`/`replaced` 分离、catalog 与 `listPlatformInfo` 遍历、守卫与 `defaultPlatformId()`、Adapter v2 全表面 hook、模块边界、设置单一写入口、重启生效、`platform export` 薄适配器 + `AGENTLRAY_PKG_ROOT`；**取代 ADR-0001 Q11**，修订 ADR-0002 薄适配器结论；Status: accepted | 2026-11-07 |
| [progress-windows-compat-grill-2026-10-29.md](progress-windows-compat-grill-2026-10-29.md) | 任务执行进度 | **Windows 兼容 grill-with-docs 会话定稿**：已核实问题清单（含行号）、R1–R3 决策树全收敛（Q1–Q15）、P0–P4 实现切分、omp Windows 不兼容能力清单（供后续处理） | 2026-10-29 |
| [orca-worker-diagnosis.zh-CN.md](orca-worker-diagnosis.zh-CN.md) | 参考分析 | **Orca orchestration worker 创建诊断**：omp 可创建（`/hook/omp` 扩展上报）、hermes 无法创建（`agentCmdOverrides.hermes="co-mind"` 用无 Orca hook 的 Co-Mind 启动→60s agent_readiness 超时）、co-mind 非注册 agent（`agent_unconfigured`）；已修 `~/.hermes/config.yaml` YAML 重复键（hermes hooks error→installed），全局 override 未改（用户决定暂不改）；含实时复现与修复方案 | 2026-11-01 |

> 代码库现状：`architecture.md` / `implementation.md` 基于 v1.24.0 快照，未包含其后的各次改动——阅读时留意差异。其余设计文档对应的能力均已合入主干（`72dee90` 及更早）；自定义平台扩展的**实现（P0–P5）与本文档（P6 收尾）位于当前工作区（未提交）**——`agentlray platform list/validate`、`GET /api/platforms`、`~/.agentlray/platforms/` 加载器与 React/legacy 前端均已可用。定位索引见项目根 `AGENTS.md` 的"代码库现状提示"。

---

## 目录约定

后续新增中间文档请遵循以下命名与编号习惯：

| 内容类型 | 建议文件名前缀 | 示例 |
| --- | --- | --- |
| 方案/架构设计 | `architecture-*` 或 `design-*` | `design-spawn-tree.md` |
| 需求/规格 | `spec-*` | `spec-review-migration.md` |
| 任务计划 | `plan-*` | `plan-fed-8-misc.md` |
| 任务执行进度 | `progress-*` 或 `session-*` | `progress-2026-10-23.md` |
| 审查文档 | `review-*` | `review-code-quality.md` |
| 测试举证 | `test-evidence-*` | `test-evidence-inspect-drift.md` |
| 风险/决策 | `decision-*` 或 `adr-*` | `adr-csrf-boundary.md` |

原则：文档要可追溯（标注对应代码版本/commit/命令输出）、可执行（结论附验证方式）、中文为主（标识符、命令、错误信息保持原文）。

---

*本索引随 `docs/.local/` 内容维护。*
