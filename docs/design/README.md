# docs/design —— 设计与决策文档索引

> 本目录存放 **AgentLRay 已实现或部分实现的设计、计划、决策与参考文档**，随代码提交，是这些能力的正式文档真源。
> 中间过程文档（评审意见、执行进度、交接、外部系统研究、草图等）属于本地开发材料，不随仓库分发。
> 语言约定：默认**简体中文**；代码标识符、命令、配置键、错误信息保持原文。
>
> **进度维护规则**：每篇文档末尾的「实现进度（代码核对）」是其状态真源；实现有变更时必须同步更新该节与本索引的「实现进度」列。
> 最近一次全量代码核对：**2026-11-19**（基线 `c7fdb8f`）。
>
> **历史术语**：2026-11-08（`f7c446f`）起，legacy vanilla UI（`public/`、`/legacy` 路由）、会话备份（`lib/backup.js`）与提示词资产库（`lib/library.js`）已整体移除。早于该日期的设计文档中关于 `public/js/app.js`、`public/css/app.css`、`/legacy`、「legacy 冻结快照」的表述属于当时的历史记录，**不代表当前实现**；当前前端只有 `frontend/` 一个面。
>
> **目录演进**：早于 2026-11-08 的设计/计划文档中出现的 `lib/platforms/<id>.js`（如 `lib/platforms/codex.js`）与 `lib/platforms/shared.js` 为当时的文件布局；当前为 `lib/platforms/builtin/<id>/`（包内置）与 `platforms/<id>/`（项目平台）、`lib/platforms/shared/{helpers,tail-state,contracts,...}.js`（经裸名 `@agentlray/shared/*` 引用），见 [design-builtin-cohesion.zh-CN.md](design-builtin-cohesion.zh-CN.md)。

---

## 文档清单

### 平台与适配器

| 文档 | 类型 | 说明 | 实现进度 | 更新日期 |
| --- | --- | --- | --- | --- |
| [design-custom-platforms.zh-CN.md](design-custom-platforms.zh-CN.md) | 方案设计 | 自定义平台扩展：运行时 JS 适配器、契约与能力位、加载器隔离、`GET /api/platforms`、CLI、resume opt-in | ✅ 已实现 | 2026-10-27 |
| [custom-platform-example.zh-CN.md](custom-platform-example.zh-CN.md) | 样例文档 | 可运行的自定义平台适配器样例、契约速查、启用与验证命令 | ✅ 参考文档（与实现一致） | 2026-10-27 |
| [guide-custom-platforms.zh-CN.md](guide-custom-platforms.zh-CN.md) | 参考文档 | 自定义平台开发指导：上手流程、契约要点、硬性边界、checklist | ✅ 参考文档（与实现一致） | 2026-10-27 |
| [design-platform-equivalence.zh-CN.md](design-platform-equivalence.zh-CN.md) | 方案设计 | 平台三来源（package/project/user）、`disabled`/`replaced`、catalog、全表面 hook、薄适配器导出 | ✅ 已实现 | 2026-11-07 |
| [plan-platform-equivalence.zh-CN.md](plan-platform-equivalence.zh-CN.md) | 任务计划 | 平台来源统一与全表面等价实施计划 P0–P6 | ✅ 已实现 | 2026-11-07 |
| [design-platform-mount.zh-CN.md](design-platform-mount.zh-CN.md) | 方案设计（已取代） | v1 内置平台 mount/unmount；已被 `design-platform-equivalence` 取代，保留历史 | ⛔ 已取代 | 2026-11-07 |
| [review-platform-mount.zh-CN.md](review-platform-mount.zh-CN.md) | 评审意见 | v1 mount/unmount 设计评审（不通过/需修订），修订结论落到 v2 | ✅ 结论已落地 | 2026-11-07 |
| [design-builtin-cohesion.zh-CN.md](design-builtin-cohesion.zh-CN.md) | 方案设计 | 内置平台代码内聚到 `lib/platforms/builtin/<id>/`、共享层 barrel、`@agentlray/shared` 别名 | ✅ 已实现 | 2026-11-08 |
| [design-platform-dir-decl.zh-CN.md](design-platform-dir-decl.zh-CN.md) | 方案设计 | 平台目录/名词解耦到各平台 `dirs.js`，`resolveDirs` 统一解析 | ✅ 已实现 | 2026-11-08 |
| [design-co-mind-platform.zh-CN.md](design-co-mind-platform.zh-CN.md) | 方案设计 | co-mind（Claude fork）以薄适配器复用内置 claude-code 接入 | ✅ 已实现 | 2026-11-08 |
| [design-resume-more-platforms.zh-CN.md](design-resume-more-platforms.zh-CN.md) | 方案设计 | 会话续跑多平台化 + 自定义平台（dsh 于 `0c38d61` 移出，现 5 平台） | ✅ 已实现（后续收敛） | 2026-11-19 |
| [design-new-session-create.zh-CN.md](design-new-session-create.zh-CN.md) | 方案设计 | 新建会话（create）与 resume 对称：`NEW_BINS`、CLI `sessions new`、Web 新建任务 | ✅ 已实现 | 2026-11-03 |
| [plan-custom-platforms.zh-CN.md](plan-custom-platforms.zh-CN.md) | 任务计划 | 自定义平台扩展实施计划 P0–P6 | ✅ 已实现 | 2026-10-27 |
| [design-openclaw-all-agents.zh-CN.md](design-openclaw-all-agents.zh-CN.md) | 方案设计 | openclaw 会话查询默认合并全部 agent | ✅ 已实现 | 2026-10-26 |
| [change-shared-module-cohesion.zh-CN.md](change-shared-module-cohesion.zh-CN.md) | 变更记录 | hermes 会话库 / gemini 记录格式内聚到平台内部 | ✅ 已实现 | 2026-11-09 |

### 会话状态、列表与看板

| 文档 | 类型 | 说明 | 实现进度 | 更新日期 |
| --- | --- | --- | --- | --- |
| [session-status-design.zh-CN.md](session-status-design.zh-CN.md) | 方案设计 | 统一四态 `status`、证据契约 `tail`、`deriveStatus`、SSE 即时刷状态、分组排序 | ✅ 已实现 | 2026-10-23 |
| [design-status-config.zh-CN.md](design-status-config.zh-CN.md) | 方案设计 | 四态判定窗口可配置 + 设置面板页签化 | ✅ 已实现 | 2026-10-27 |
| [design-sidebar-filters.zh-CN.md](design-sidebar-filters.zh-CN.md) | 方案设计 | 平台/项目筛选迁入侧栏、分组模式、折叠与持久化 | ✅ 已实现 | 2026-10-26 |
| [design-filter-empty-sessions.zh-CN.md](design-filter-empty-sessions.zh-CN.md) | 方案设计 | 列表统一过滤空会话，详情保留 | ✅ 已实现 | 2026-11-11 |
| [design-kanban.zh-CN.md](design-kanban.zh-CN.md) | 方案设计 | 任务看板四态视图、`maxPerStatus`、共享侧栏筛选 | ✅ 已实现 | 2026-10-28 |
| [design-kanban-mobile.zh-CN.md](design-kanban-mobile.zh-CN.md) | 方案设计 | 看板移动端 <768 纵向堆叠、单列展开（原「建议」的 `kanbanLib` 单测未落地：前端无测试运行器） | ✅ 已实现（单测未实现） | 2026-11-19 |
| [design-sticky-headers.zh-CN.md](design-sticky-headers.zh-CN.md) | 方案设计 | 看板移动端状态组头 + 左侧分组折叠头吸顶 | ✅ 已实现 | 2026-10-29 |
| [design-session-cli.md](design-session-cli.md) | 方案设计 | 终端会话查询与续跑 CLI（`sessions list/show/resume`） | ✅ 已实现 | 2026-10-23 |
| [design-sse-push.zh-CN.md](design-sse-push.zh-CN.md) | 参考分析 | SSE 实时推送机制（服务端增量读取 + 前端缓存合并） | ✅ 参考分析（与实现一致） | 2026-11-14 |

### 设置、主题与 Windows 兼容

| 文档 | 类型 | 说明 | 实现进度 | 更新日期 |
| --- | --- | --- | --- | --- |
| [design-settings-merge.zh-CN.md](design-settings-merge.zh-CN.md) | 方案设计 | 统一 `settings.json` + 公用 Save/Reset | ✅ 已实现 | 2026-10-29 |
| [design-platform-settings-merge.zh-CN.md](design-platform-settings-merge.zh-CN.md) | 方案设计 | 平台设置归并 + 目录/启停落盘服务端 | ✅ 已实现 | 2026-11-09 |
| [design-default-platform.zh-CN.md](design-default-platform.zh-CN.md) | 方案设计 | 设置面板「默认平台」+ 移除两个一次性迁移 | ✅ 已实施 | 2026-11-10 |
| [design-cli-bin-config.zh-CN.md](design-cli-bin-config.zh-CN.md) | 方案设计 | 平台 CLI 命令可配置（env > 配置 > 默认名） | ✅ 已实现 | 2026-10-26 |
| [design-cli-platform-default.zh-CN.md](design-cli-platform-default.zh-CN.md) | 方案设计 | 终端命令平台非必填，缺省用页面持久化数据 | ✅ 已实现 | 2026-10-26 |
| [design-theme-light-dark.zh-CN.md](design-theme-light-dark.zh-CN.md) | 方案设计 | Web 界面白天/黑夜两态主题 | ✅ 已实现 | 2026-10-30 |
| [design-windows-compat.zh-CN.md](design-windows-compat.zh-CN.md) | 方案设计 | Windows 兼容：HOME、目录、命令串、spawn shell、测试拆分 | ✅ 已实现 | 2026-10-29 |

### 多主机与远端连接

| 文档 | 类型 | 说明 | 实现进度 | 更新日期 |
| --- | --- | --- | --- | --- |
| [design-multi-host.zh-CN.md](design-multi-host.zh-CN.md) | 方案设计 | 多主机模式：ssh 隧道 + 网关代理 + 数据面透传 | 🟡 部分实现（P0 + P1 ①②；CLI `--host`、多隧道池未实现） | 2026-11-12 |
| [plan-multi-host.zh-CN.md](plan-multi-host.zh-CN.md) | 实现方案 | 多主机 P0/P1 实现级方案与文件清单 | 🟡 部分实现（同上） | 2026-11-12 |
| [design-remote-settings-tunnel.zh-CN.md](design-remote-settings-tunnel.zh-CN.md) | 方案设计 | 远端设置/筛选/平台透传 + 主机本地化 | ✅ 已实施并验证 | 2026-11-16 |
| [design-selected-platforms-remote.zh-CN.md](design-selected-platforms-remote.zh-CN.md) | 方案设计 | 远端已选平台失效修复：`/api/ui-selection` + settings 本机化 | ✅ 已实现 | 2026-11-13 |
| [design-host-gate-before-load.zh-CN.md](design-host-gate-before-load.zh-CN.md) | 方案设计 | 首帧「先连后加载」主机就绪门控 | ✅ 已实现 | 2026-11-13 |
| [design-host-disconnect.zh-CN.md](design-host-disconnect.zh-CN.md) | 方案设计 | 远端主机手动退出连接 | ✅ 已实现 | 2026-11-14 |
| [design-host-settings-redesign.zh-CN.md](design-host-settings-redesign.zh-CN.md) | 方案设计 | 主机设置布局与显示调整（侧栏入口 + 独立弹框） | ✅ 已实现 | 2026-11-14 |
| [design-inbound-peers.zh-CN.md](design-inbound-peers.zh-CN.md) | 方案设计 | 被连接主机情况查看（inbound peers） | ✅ 已实现 | 2026-11-13 |
| [design-dsh-host-connection.zh-CN.md](design-dsh-host-connection.zh-CN.md) | 方案设计 | 基于 ds-harness-remote 的 dsh 远程主机连接 | ✅ 已实现 | 2026-11-17 |
| [design-dsh-login-methods.zh-CN.md](design-dsh-login-methods.zh-CN.md) | 方案设计 | dsh 多登录方式（扫码 + 账号密码） | ✅ 已实现 | 2026-11-19 |
| [design-thin-service.zh-CN.md](design-thin-service.zh-CN.md) | 方案设计 | 独立薄服务（thin service）：仅远程连接的连接方网关——`/api/mode` 运行时信号、无 `local`、dsh 强制 client、boot 自动连接、系统配置面不挂/不透传、前端 thin 裁剪；`agentlray thin` | ✅ 已实现 | 2026-11-20 |
| [design-android-mobile-app.zh-CN.md](design-android-mobile-app.zh-CN.md) | 方案设计 | Android 移动端 App 工程蓝图：PRoot + Ubuntu + Node 22/24 承载 dsh-only 薄服务 + Capacitor WebView 套壳；仓库模块改造（hosts 守卫/lastHostId/mode capabilities/传输过滤/下载桥接）、`android/` 工程骨架、P1 最小壳、P2 导出桥接、P3 版本兼容已落地；P0 静态推断/16KB 量测见 [android/docs/p0-runtime-inference.zh-CN.md](../../android/docs/p0-runtime-inference.zh-CN.md)；debug APK 本机构建通过 | 🟡 部分实现（P0 真机验证待做；P4 部分实现） | 2026-11-21 |

### 决策记录（ADR）

| 文档 | 类型 | 说明 | 实现进度 | 更新日期 |
| --- | --- | --- | --- | --- |
| [adr-0001-custom-platform-adapter.zh-CN.md](adr-0001-custom-platform-adapter.zh-CN.md) | 决策记录 | 自定义平台采用运行时 JS 适配器 | ✅ Accepted，已实现 | 2026-10-27 |
| [adr-0002-co-mind-platform.zh-CN.md](adr-0002-co-mind-platform.zh-CN.md) | 决策记录 | co-mind 以薄适配器复用内置 claude-code（2026-11-08 修订） | ✅ Accepted，已实现 | 2026-11-08 |
| [adr-0003-windows-compat.zh-CN.md](adr-0003-windows-compat.zh-CN.md) | 决策记录 | Windows 兼容关键决策 D1–D6 | ✅ Accepted，已实现 | 2026-11-08 |
| [adr-0004-new-session-create.zh-CN.md](adr-0004-new-session-create.zh-CN.md) | 决策记录 | 新建会话 create 契约 | ✅ Accepted，已实现 | 2026-11-03 |
| [adr-0005-platform-sources.zh-CN.md](adr-0005-platform-sources.zh-CN.md) | 决策记录 | 平台来源统一与全表面等价 D1–D10 | ✅ Accepted，已实现 | 2026-11-07 |
| [adr-0006-dsh-host-connection.zh-CN.md](adr-0006-dsh-host-connection.zh-CN.md) | 决策记录 | 基于 ds-harness-remote 的 dsh 远程主机连接 D1–D11 | ✅ Accepted，已实现 | 2026-11-17 |
| [adr-0007-thin-service.zh-CN.md](adr-0007-thin-service.zh-CN.md) | 决策记录 | 独立薄服务（thin service）Q1–Q27 决策收敛 | ✅ Accepted，已实现 | 2026-11-20 |
| [adr-0008-android-mobile-app.zh-CN.md](adr-0008-android-mobile-app.zh-CN.md) | 决策记录 | Android 移动端 App：**PRoot + Ubuntu + Node 22/24** 承载 dsh-only 薄服务 + Capacitor WebView 套壳（grill R1–R6 收敛；2026-11-21 修订 R2，原 nodejs-mobile 因 Node 18 无法承载 dsh 被否决） | 🟡 Accepted，仓库改造已实现（P0 真机验证未完成） | 2026-11-21 |

### 参考

| 文档 | 类型 | 说明 | 实现进度 | 更新日期 |
| --- | --- | --- | --- | --- |
| [cli-usage.md](cli-usage.md) | 参考文档 | `agentlray` 主入口与 `inspect`/`evidence`/`sessions`/`platform` 命令完整说明 | ✅ 与当前 CLI 一致 | 2026-11-08 |
| [glossary.zh-CN.md](glossary.zh-CN.md) | 参考文档 | AgentLRay 术语约定与 Avoid 词 | ✅ 已核对 | 2026-11-17 |

---

## 未随仓库分发的文档

以下文档**对应能力尚未实现**，或属于过程性材料，暂不随代码提交：

| 文档 | 类型 | 未随仓库分发的原因 |
| --- | --- | --- |
| `design-ssh-password.zh-CN.md` | 方案设计 | ❌ 未实现：无 `SSH_ASKPASS`/`SSHPASS`/`passwordEnc`（SSH）代码；`lib/secret.js` 当前仅用于私钥与 LLM key 加密 |
| `design-multi-host-tunnel-pool.zh-CN.md` | 方案设计 | ❌ 未实现：`lib/routes/hosts.js` 连接成功后仍 `closeAllExcept(id)`，无后台常驻隧道池 |
| `implementation.md` / `architecture.md` | 方案设计 | v1.24.0 历史快照，已被 `docs/architecture*.md` 与现行设计取代 |
| `csm-analysis.zh-CN.md` / `orca-worker-diagnosis.zh-CN.md` | 参考分析 | 外部系统研究与一次性排障记录 |
| `review-*.zh-CN.md` / `progress-*.md` / `handoff-*.md` / `plan-platform-mount.zh-CN.md` | 过程材料 | 评审意见、执行进度、交接记录、已取代的历史计划，属于本地过程材料 |
| `image-dsh-kanban.zh-CN.json` | 图像提取数据 | 一次性视觉识别结果 |

> 本目录仅收录随仓库分发的正式文档。
