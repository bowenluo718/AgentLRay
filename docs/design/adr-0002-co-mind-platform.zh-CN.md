# ADR-0002：co-mind（Claude fork）以自包含自定义适配器接入

co-mind（命令 `co-mind`，数据目录 `~/.icodemate/cli/projects`）是与 claude-code **逐字段同构**的
Claude Code 二次开发 fork；在 AgentLRay 中以**自包含自定义适配器**接入
（`~/.agentlray/platforms/co-mind.js`），把 claude-code 解析逻辑与
shared/tail-state/status 依赖**内联**进单文件，零改 AgentLRay 源码。

Status: accepted

决策依据（grill-with-docs 收敛）：[design-co-mind-platform.zh-CN.md](design-co-mind-platform.zh-CN.md) R1-Q1。

## 背景（Context）

co-mind 平台要能用 AgentLRay 看会话/续跑。它数据格式与内置 claude-code 完全一致——最省事的
直觉是"让 co-mind 复用 claude-code 适配器"。但落地路径有三个候选：

- **内置平台**（仓库加 `lib/platforms/co-mind.js` + `index.js` 注册）：保真度最高，直接共享
  `tail-state`/`shared`/`status` 模块。代价：公司专属路径硬编码进包、随 fork 分发全体可见、
  需改 README"7 平台"表述与 `platforms.test.js` 断言。
- **薄适配器 require AgentLRay 内部模块**（`~/.agentlray/platforms/co-mind.js` 里
  `require('@bowenluo718/agent-lray/lib/platforms/claude')`）：**不可行**——Node 从适配器
  文件所在目录向上解析 require，`~/.agentlray/platforms/` 不在 agentlray 包的 node_modules
  解析链上，除非按机器硬编码绝对路径（脆）。
- **自包含自定义适配器**（实测采纳）：单文件内联 claude-code 全部所需逻辑 + 依赖，只换目录
  常量，零改包。

## 决策（Decision）

- 适配器 = 单文件 `docs/.local/platforms/co-mind.js`（规范源）＋安装副本
  `~/.agentlray/platforms/co-mind.js`；`id=co-mind`，`defaultDir = env CO_MIND_DIR 缺省
  ~/.icodemate/cli/projects`，能力位全开（list/find+watchParse/collectFiles/resume），
  `resume` 带 `--dangerously-skip-permissions`（与内置 claude-code resume 对齐）。
- **内联范围**：`shared.js`（withMetadataCache 改本地 Map / makeMessage / topToolsOf /
  captureLastMessage）、`tail-state.js` 全量、`status.js` 的 `deriveStatus` +
  `sortSessionsByStatusGroups`（`list` 必须自产 `status`，服务端对自定义平台不做二次重推导）。
- **运行时状态窗口对齐**：适配器每次 `list()` 读取 `~/.agentlray/status-config.json` 覆盖
  默认窗口，与 web 设置面板口径一致（内置平台经 `setStatusConfig` 运行时注入同源文件）。
- **不随仓库分发**：适配器留在 gitignored 的 `docs/.local/`；仓库零改动。

## 后果（Consequences）

- 正向：co-mind 即刻可用（list/详情/export/OTLP/watch/tool-audit/resume），其余 fork 使用者
  无需更新包；卸载 = 删文件；不改 README/测试断言。
- 负向/约束：单文件约 480 行，与内置 claude-code 逻辑**镜像漂移**风险（格式稳定，可接受）；
  状态窗口需自读配置文件对齐；`search` 对自定义平台在 AgentLRay 源码层本就缺位
  （硬编码内置平台枚举，见 design 文档 §6）——2026-10-30 `prompts` 已由通用 JSONL 提取器
  （`lib/prompts.js::extractGenericJsonlPrompts`）接入，`search` 仍缺位，本决策不修源码、不扩大边界。
- 信任权衡：适配器以用户全权限执行（与 ADR-0001 一致），只投递可信文件；逃生
  `AGENTLRAY_NO_PLUGINS=1` + 删文件。
