# ADR-0004：新建会话采用与 resume 对称的 create 契约

新建会话（spawn 平台 CLI 开启一个**全新**会话）走与续跑对称的机制：内置平台用 `NEW_BINS` 硬编码新建参数，自定义平台用适配器 `create: { bin, args(opts) }` 字段 opt-in；CLI `sessions new` 与 web「新建任务」共用单一命令串真源。

Status: accepted

## 背景（Context）

AgentLRay 现状只有「观察 + 续跑」能力：看板/CLI 能列会话、看详情、复制续跑命令；没有任何「新建会话」能力（代码里仅 library 有「新建 Prompt」）。需求要支持**新建会话任务**，且要作用于**自定义平台**（内置平台同样缺此能力）。

曾考虑：
- **web 仅复制命令不 spawn**：与既有「复制恢复命令」一致、最安全，但用户明确要「后台调用 CLI 能力实现」，即 web 真实触发。
- **dsh 也支持新建**：但 dsh 是交互式 TUI（`--profile pi-tui`），无法 headless 传提示词（scout 实证 headless `--session-id` 不认 web 会话），故 dsh 明确不支持新建，如实降级。
- **create 独立 bin 字段 / 适配器自己拼提示词**：都打破与 resume 的对称性，增加适配器负担与不一致风险，被否。

## 决策（Decision）

- 能力语义 = **spawn 全新会话命令**，与 resume 对称：resume 续旧会话、create 开新会话。
- 范围 = 全部平台。内置 `NEW_BINS` 硬编码（codex / claude-code / omp / gemini / hermes 可建，**dsh 不可建**——六平台唯一交互式无法 headless）；自定义平台适配器 `create: { bin, args(opts) }` opt-in，与 `resume` 契约同构。
- 参数模型：`create.args(opts)` 返回前置参数数组，**框架把提示词追加为末位裸参**（与 resume 的 `message` 语义一致）；opts = `{ cwd, message }`；cwd 空则平台默认目录，命令串用 `cd '<cwd>' &&` 前缀（POSIX）/ `Set-Location`（PowerShell），沿用 lib/resume.js 的 shell 引用。
- 可执行名解析：统一经 `resolveCliBin()`（环境变量 `AGENTLRAY_<ID>_BIN` > cliBins section > 默认名），与 resume 同源。
- 能力位暴露：`GET /api/platforms` 的 `PlatformInfo` 增加 `create` 标志；web「新建任务」弹窗的「支持的平台」下拉**只列 create=true** 的平台。
- 内置新建命令形态（codex `codex exec --full-auto --cd`、claude-code `claude --dangerously-skip-permissions -p`、gemini `gemini -p --approval-mode=yolo`、hermes `hermes --yolo`）为**推断形态**，实现时用各平台 `--help` 实测定格；omp `omp --auto-approve <prompt>` 已有用户权威锚点。
  - **实测结果（P4 收尾，2026-11-03）**：omp / claude-code / hermes 三家已按 `--help` 核定——hermes 的提示词须走 `-z/--oneshot`（裸位置参被判 `invalid choice`），故形态为 `hermes --yolo -z '<prompt>'`；claude 的 `-p/--print` 为布尔开关（提示词走位置参数），形态 `claude --dangerously-skip-permissions -p '<prompt>'` 成立；omp 与既有锚点一致。**codex / gemini 未实测**（本机未安装该 CLI），暂沿用上列推断形态，待有真实 CLI 时校正。无提示词时 claude-code / hermes 回落交互式形态（`claude --dangerously-skip-permissions` / `hermes --yolo`）。
- CLI `sessions new`：`new [message...] --platform <id> [--dir <cwd>] [--run]`，默认只打印命令串，`--run` 才 spawn（与 `resume --run` 对称）。
- web：任务看板头部「新建任务」按钮 → 弹窗（提示词、cwd 项目路径可手动输入、平台选择，**默认选中当前会话所属项目与平台**）→ 后端新增 POST 路由（如 `POST /api/:platform/sessions/new`）**复用 CLI spawn 逻辑**（抽取到 `lib/` 共享）→ fire-and-forget：输出丢弃/日志、不跟踪进程、不阻塞 HTTP → 触发成功后提示 + 刷新看板列表。
- dsh：六平台唯一**不支持新建**；CLI/web 对 dsh 报「该平台不支持新建会话」。
- 信任/安全：与 resume 一致，spawn 的是平台原生 CLI（用户信任的既有命令），不引入新进程治理。

## 后果（Consequences）

- 正向：全部内置 + 自定义平台获得统一「新建会话」能力；create 与 resume 完全对称，命令串单一真源、适配器最简；dsh 如实降级不误报。
- 负向/约束：web 真实 spawn 长驻 agent 且不展示输出——用户需在终端/平台侧自行观察结果（fire-and-forget 取舍）；内置新建命令需逐平台 `--help` 实测定格（codex/claude/gemini/hermes 当前为推断形态）；dsh 用户无法从 web/CLI 一键新建，只能在 TUI 手动开。
- 范围取舍：dsh 交互式、进程生命周期管理（查询/终止）、web 展示 spawn 输出，均明确不做，留待未来按需扩展。
