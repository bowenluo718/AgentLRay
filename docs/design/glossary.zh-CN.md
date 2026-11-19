# AgentLRay

AgentLRay 聚合多平台（openclaw / codex / claude-code / hermes / omp / dsh / gemini）的 agent 会话，提供统一的取证回放视图与 CLI 查询。

## Language

**平台（Platform）**：
会话的一种来源。AgentLRay 归一化全部平台（**内置平台**与**自定义平台**）到一个统一数据模型。
_Avoid_: source（仅 hermes 内部使用）、数据源

**内置平台（Built-in platform）**：
AgentLRay 仓库自带的平台：openclaw / codex / claude-code / hermes / omp / dsh / gemini。
_Avoid_: 官方平台（不存在"非官方"对照物）

**自定义平台（Custom platform）**：
用户以**平台适配器**形式投递、未随仓库分发的平台。与内置平台同等接入注册表与全部 generic 表面。
_Avoid_: 第三方平台（歧义：外部实体）

**平台适配器（Platform adapter）**：
实现平台归一化契约的可插拔代码单元，是「支持自定义平台」的载体。内置平台与自定义平台都以适配器形态注册进**注册表**。
_Avoid_: 平台插件（口语）

**注册表（Platform registry）**：
AgentLRay 的平台唯一事实来源（`lib/platforms`）。内置与自定义适配器在此合并；所有 generic 表面（路由 / watch / search / prompts / tool-audit / export / CLI）统一经它解析。
_Avoid_: 平台列表（歧义：可指展示给用户的列表）

**能力位（Capability bit）**：
平台适配器上可选函数/标志的存在性，决定该平台接入哪些 generic 表面；缺谁谁缺位、不报错（如无 `collectFiles` → search/prompts/tool-audit 缺位；无 `watchParse` → 无实时尾随且 `/api/watch` 返回 400）。基础位：list / find / parse / getSession / collectFiles / watchParse / needsAgent；v2 全表面扩展位：listForAgent / listAllAgents / listAgents / children（listChildren+getChild）/ spawn（spawnMap+spawnTree）/ watch / search / insights / prompts / toolAudit / otlp / backup / inspect。`platform list --json` 与 `GET /api/platforms` 透出 `capabilities`，前端只读能力位、不猜平台 id。`list` 可为 `null`；`needsAgent` 是真值标志而非函数。
_Avoid_: 插件能力（口语）

**平台来源（Platform origin）**：
适配器所在目录/来源，`package`（`lib/platforms/builtin/` 包内置）/ `project`（`<repo>/platforms/` 随包分发）/ `user`（`~/.agentlray/platforms/`）。同一 id 的覆盖规则：user 可覆盖 project；project/user 覆盖 package 仅当该 id 已声明 replaced。`platform list` 与 `/api/platforms` 标注 origin，且记录 `overrides` / `replacementPending`。

**项目平台（Project platform）**：
投递在仓库根 `platforms/` 目录、随 npm 包分发的适配器；默认挂载、可禁用、可被用户目录覆盖。推荐配 `platforms/manifest.json` 的 `{ "replaces": [...] }` 表达「本项目有意替换包内置」。`AGENTLRAY_NO_PLUGINS=1` 可跳过项目+用户来源。

**替代（replaced）**：
`settings.platforms.replaced` 与 `manifest.replaces` 的并集（生效集合）。声明了某包内置 id 的替代且存在同 id 项目/用户适配器 → 该适配器挂载并覆盖包内置（origin 为 project/user）；声明替代但无适配器/损坏 → 回退包内置并标记 `replacementPending`。未声明替代的同 id 项目/用户文件一律 broken，绝不静默顶包。

**薄适配器（Thin adapter）**：
`platform export <id>` 生成的极简适配器，仅 `module.exports = require(path.join(process.env.AGENTLRAY_PKG_ROOT, 'lib/platforms/builtin/<id>.js'))`，包升级自动跟随。内置平台可借此「导出为自定义平台继续使用」（双向等价的用户侧）。

**co-mind**：
一个会话来源平台：Claude Code 的二次开发 agent。以命令 `co-mind` 替代 `claude`，其余能力与 claude-code 基本一致；会话数据与 claude-code 同构（会话根目录为其自有数据目录下的 `projects/`）。在 AgentLRay 中以**自定义平台**接入，解析与续跑语义等同 claude-code。
_Avoid_: icodemate（数据目录名，非平台名）、comind（拼写）

**会话摘要（SessionSummary）**：
一条会话的元数据聚合视图（id、时间、消息计数、工作目录、状态等），由各平台解析产出、前端与 CLI 消费。
_Avoid_: 会话记录、summary 原文

**项目（Project）**：
会话列表的显示/分组/筛选值，直接由会话的工作目录（cwd）推导：默认取 cwd 末段；当同一末段出现在多个不同 cwd 下（末段重复）时，这些会话显式显示完整 cwd 以消歧。cwd 缺失的会话归为「未知项目」。后端无独立 project 字段。
_Avoid_: workspace、项目目录、所属项目（口语）

**未知项目（Unknown project）**：
会话无 cwd 信息时的项目显式值（hermes 恒为未知项目）。

**会话状态（Status）**：由日志证据与时间窗口推导的统一四态：待用户输入 / 工作中 / 等待中 / 已停止。
_Avoid_: 活跃、归档（旧的二值文件标记）

**最后更新时间（Last activity）**：
会话最近一次活动的时间，列表排序的次键（先状态后时间）。区别于会话开始时间。
_Avoid_: 最近更新（与 lastUpdated 混淆）

**会话详情上下文（Detail context）**：
当前正在查看的会话详情所属的（平台, agent）来源。与筛选上下文（平台多选/分组/项目筛选）解耦：列表点击查看详情只更新详情上下文，不改动筛选配置。
_Avoid_: 当前平台（歧义：既指筛选又指详情）

**分组模式（Grouping）**：
会话列表的呈现分组方式：按平台 / 按项目 / 不分组。三种模式都保留会话状态组头——按平台、按项目时状态组头作为外层组内的子组头；「不分组」则为扁平的状态组头。组内按状态与最后更新时间排序。
_Avoid_: 按 agent 分组（agent 仅 openclaw 有，非分组维度）

**任务看板（Kanban）**：
会话的看板式主视图，按会话状态四列分栏展示（待用户输入 / 工作中 / 等待中 / 已停止），用于直观查看各状态下的会话；列内按最后更新时间排序并截断显示。此处「任务」即指会话（`任务看板` 的卡片 = 会话），并不表示独立的任务实体。
_Avoid_: deepseek 任务实体概念（新建/归档/结算于/执行次数——那些属于另一个产品模型）

**Agent**：
openclaw 平台内会话的归属者。仅 openclaw 有该概念，其余平台无 per-session agent。

**家目录（Homedir）**：
用户主目录，AgentLRay 所有默认路径（`~/.agentlray/` 配置、平台默认目录、`~/.claude/*` 散点）的基准。跨平台用 `os.homedir()` 解析（Win 取 `USERPROFILE`、macOS/Linux 取 `HOME`），支持 `AGENTLRAY_HOME` 覆盖。
_Avoid_: `process.env.HOME`（Windows 无此变量，须用 `os.homedir()`）

**平台默认目录（Platform default dir）**：
平台适配器的会话根目录缺省值（如 openclaw 的 `~/.openclaw/agents`）。跨平台统一为 `~/.xxx` 约定（不建 Windows 映射表），不一致时用 `XXX_DIR` 环境变量覆盖。
_Avoid_: Windows 专属目录硬编码（不写死，依赖环境变量）

**原生续跑（resume 契约）**：
平台声明其原生 CLI 可恢复会话续跑的能力，`hasResumeContract()` 统一判断。内置平台经适配器的 `resume: { bin, args(id, opts) }` 字段内联声明（codex / claude-code / omp / gemini / hermes 出厂提供；openclaw 与 dsh 不声明，dsh 为交互式 TUI 不可续跑）；自定义平台同字段 opt-in。`contracts.js` 统一从 adapter 声明解析，命令串与旧 `RESUME_BINS` 硬编码逐字一致。无契约的平台 `sessions resume` 与 web「复制恢复命令」均报「无原生续跑」。
_Avoid_: 续跑（动词，口语）、resume 支持（歧义：可指命令按钮）

**新建会话（create 契约）**：
平台声明其原生 CLI 可开启一个**全新**会话（非续跑既有会话）的能力，与 resume 契约对称。内置平台经适配器的 `create: { bin, args(opts) }` 字段内联声明（codex / claude-code / omp / gemini / hermes 可建；**dsh 不支持新建**——它是交互式 TUI，无法 headless 传提示词）；自定义平台同字段 opt-in（opts 含 `cwd`/`message`，框架把提示词追加为末位裸参）。未声明 create 的平台 `sessions new` 与 web「新建任务」均报「该平台不支持新建会话」。
_Avoid_: 新建任务（口语，看板语境下「任务」即会话）、创建会话（动词，口语）

**Shell 语法（Shell dialect）**：
resume 命令串的终端语法：**posix**（`cd 'cwd' && bin args`，bash/zsh）与 **powershell**（`Set-Location 'cwd'; & bin args`）。命令串按服务端 `process.platform === 'win32'` 判定输出，单一真源在 `lib/resume.js`。
_Avoid_: cmd 语法（Windows 11 默认终端是 PowerShell，Q9 定 PowerShell）

**主机（Host）**：
多主机模式下会话数据的一种远端来源。`local`（本机，内建，走直连）或 ssh 远端（`~/.agentlray/hosts.json` 配置，走 `ssh -L` 隧道）。UI 任一时刻有一个「当前主机」上下文（`selectedHostId`），会话/平台/分析都限定在该主机内。
_Avoid_: 服务器（歧义：可指 AgentLRay 服务本身）、远端（口语，未区分 local/ssh）

**隧道（Tunnel）**：
本地网关触达远端 AgentLRay HTTP 的传输通道。第 1 版只支持 ssh 本地端口转发（`ssh -L 127.0.0.1:<port>:127.0.0.1:3800`），远端保持 localhost 绑定、安全边界在 ssh 层。隧道生命周期绑定当前选中主机，进程退出兜底清理。
_Avoid_: 连接（歧义：既指隧道又指 HTTP 会话）

**网关（Gateway）**：
多主机模式下本地 AgentLRay 的转发角色：按 `X-Host-Id` 请求头把前端请求路由到对应主机（`local` 走本地路由，远端走隧道），数据面全透传、写设置面不透传。网关不重复实现平台解析逻辑——解析在远端发生。
_Avoid_: 代理（同义，但网关强调主机路由语义）

**能力降级（Capability degradation）**：
平台能力在不支持的 OS 上的明确降级处理：非静默失效，而是检测平台后打印提示或跳过。如 omp 持有检测/自动终止在 Windows 上降级为「提示用户手动处理」，而非静默返回 null 或误操作进程。
_Avoid_: 静默失效（如 `/proc` 读取失败直接 return null 不提示）

**dsh 主机（dsh host / `type: 'dsh'`）**：
多主机模式下第三种主机来源，经 **ds-harness-remote** 通过中继服务器连接远端 AgentLRay（`local` 是本机、`ssh` 是 ssh 隧道、`dsh` 是 ds-harness-remote 通道）。连接目标是中继服务器上的设备（`dsh.deviceId`），而非 ssh 的网络地址（`ssh.host`）。`lib/hosts.js` 的 `openHost`/`tunnelAndProbe` 按 `type` 分支到 dsh 模块。_Avoid_: dsh 平台（那是会话来源平台，与主机连接类型无关）

**连接方（Client role）**：
AgentLRay 实例作为「去连别的 AgentLRay」的一端。用 `LoopbackPreview` 在本地开随机端口、经 ds-harness-remote 加密通道把 HTTP/WS 转发到远端 AgentLRay 的 loopback 端口，喂给现有 proxy 数据面。与 ssh 隧道的连接方语义一致（建隧道 + 探测 `/api/version`）。

**被连接方（Host role）**：
AgentLRay 实例作为「被别的 AgentLRay 连」的一端。随 server 常驻（`role ∈ { host, both }`），用 `LoopbackHost` 收到连接方请求转发到本机 AgentLRay 端口。独立于「当前选中主机」，不占 runtime 连接槽。_Avoid_: 服务器（歧义：可指 AgentLRay 服务本身或中继服务器）

**中继服务器（Relay server）**：
ds-harness-remote 的账号认证 + WebRTC/TURN/Relay 转发服务。AgentLRay 每个实例配一个 `serverUrl`（默认官方 `https://dsh.r2049.cn`，可改自托管 `apps/server`）；AgentLRay **不内置、不托管**中继服务器。账号体系归中继服务器。

**loopback 端口转发（Loopback）**：
ds-harness-remote 提供的、经加密通道把 HTTP/WS 代理到显式 IPv4 loopback 端口的机制（连接方 `LoopbackPreview` / 被连接方 `LoopbackHost` 镜像对称）。AgentLRay 用它把本地 HTTP 请求转发到远端 AgentLRay 的 loopback 端口（目标端口 = dsh 主机「远端 AgentLRay 端口」字段，默认 3800），等价于 ssh `-L` 后的本地转发。被连接方需在 dsh 设置放行对应端口。

**设备身份（Device identity）**：
AgentLRay 实例在中继服务器上的身份，首启生成 25519 密钥对落 `~/.agentlray/dsh-device.json` + `.key`（0600）。配合共享账号 + Host 固定身份做「账号成员 + 设备身份 + Host 固定身份」三重校验。

**连接来源（via）**：
inbound peer 快照每项标注的连接方式来源：`ssh`（连接方 ssh 上报 + 心跳）或 `dsh`（ds-harness-remote 被连接方从设备体系直接获知）。旧 peer 无 `via` 视为 `ssh`。前端「被 N 连」徽标与明细统一展示两种来源。

> 注：本文档随 grill-with-docs 设计会话逐步增补，尚未定稿。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：参考文档（术语表，随实现增补）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 术语与既定实现一致 | ✅ 已核对 | 平台/会话/状态/多主机/dsh 术语均可在 `lib/` 与 `platforms/` 找到对应实现 |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
