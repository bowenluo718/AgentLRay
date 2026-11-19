# ADR-0002：co-mind（Claude fork）以薄适配器复用内置 claude-code 接入

co-mind（命令 `co-mind`，数据目录 `~/.icodemate/cli/projects`）是与 claude-code **逐字段同构**的
Claude Code 二次开发 fork；在 AgentLRay 中以**薄适配器**接入
（`~/.agentlray/platforms/co-mind.js`），经 `AGENTLRAY_PKG_ROOT` 包根复用内置
claude-code 适配器并只覆写身份/目录/命令差异，零改 AgentLRay 源码。

Status: accepted

决策依据（grill-with-docs 收敛）：[design-co-mind-platform.zh-CN.md](design-co-mind-platform.zh-CN.md)。

> **2026-11-08 修订**：原决策为「自包含自定义适配器」（内联 claude-code 解析逻辑 + 依赖）。
> ADR-0005 D10 引入 `AGENTLRAY_PKG_ROOT` 包根解析 + `@agentlray/shared` 全局别名后，
> 「薄适配器 require 内部模块不可行」结论作废，co-mind 改为薄适配器复用内置 claude-code，
> 与项目级平台（`platforms/` 下 dsh/gemini/hermes）同形态，消除镜像漂移。

## 背景（Context）

co-mind 平台要能用 AgentLRay 看会话/续跑。它数据格式与内置 claude-code 完全一致——最省事的
直觉是"让 co-mind 复用 claude-code 适配器"。但落地路径有三个候选：

- **内置平台**（仓库加 `lib/platforms/co-mind.js` + `index.js` 注册）：保真度最高，直接共享
  `tail-state`/`shared`/`status` 模块。代价：公司专属路径硬编码进包、随 fork 分发全体可见、
  需改 README"平台"表述与测试断言。
- **薄适配器 require AgentLRay 内部模块**：2026-10-29 时因 Node 从适配器文件所在目录向上
  解析 require、`~/.agentlray/platforms/` 不在 agentlray 包解析链上而判「不可行」。ADR-0005
  D10 之后 loader 在加载前注入 `AGENTLRAY_PKG_ROOT`，自定义适配器可
  `require(path.join(process.env.AGENTLRAY_PKG_ROOT, 'lib/platforms/builtin/<id>/index.js'))`
  复用包内实现——该结论**已被修订**。
- **自包含自定义适配器**（原采纳，2026-11-08 废弃）：单文件内联 claude-code 全部所需逻辑 +
  依赖，只换目录常量。缺陷：约 480+ 行镜像拷贝，与内置 claude-code 逻辑漂移风险。

## 决策（Decision）

- 适配器 = 薄适配器单文件 `docs/.local/platforms/co-mind.js`（规范源）＋安装副本
  `~/.agentlray/platforms/co-mind.js`；`id=co-mind`，`defaultDir = env CO_MIND_DIR 缺省
  ~/.icodemate/cli/projects`；经 `AGENTLRAY_PKG_ROOT` require 内置 claude-code 适配器本体，
  展开后覆写 `id/label/defaultDir/dirSettingKey/dirParam/color/resume/create/bin`，
  `searchSupplement` 置 null。
- **全表面等价**：`list/find/parse/getSession/collectFiles/watchParse/listChildren/getChild/
  extractPromptsFromFile/inspect/resume/create` 随内置 claude-code 完全一致——含 `deriveStatus`
  四态推导、tail 证据、title 回退、状态窗口（同源 `statusConfig`）、subagents、prompts、inspect。
- **auto-follow**：薄适配器随包升级自动跟随 claude-code 新实现，零镜像漂移；这是相对自包含
  版（需手工同步内联逻辑，如 IMMEDIATE_AWAIT_TOOLS 语义）的最大收益。
- **不随仓库分发**：适配器留在 gitignored 的 `docs/.local/`；仓库零改动。

## 后果（Consequences）

- 正向：co-mind 即刻可用且与 claude-code **逐位对齐**（list/详情/export/OTLP/watch/工具体检/
  subagents/prompts/inspect/resume/create），其余 fork 使用者无需更新包；卸载 = 删文件；
  不改 README/测试断言；无内联逻辑可漂移。
- 负向/约束：薄适配器依赖 `AGENTLRAY_PKG_ROOT` 与 `@agentlray/shared` 别名（`platform
  validate` / server 均先 require `lib/platforms` 故可用）；复用 claude-code 意味着 co-mind
  行为随内置 claude-code 演进（对同构 fork 是特性而非缺陷）；`searchSupplement` 缺位（无
  claude history 来源）。
- 信任权衡：适配器以用户全权限执行（与 ADR-0001 一致），只投递可信文件；逃生
  `AGENTLRAY_NO_PLUGINS=1` + 删文件。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：Accepted（2026-11-08 修订为薄适配器），已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 薄适配器复用内置 claude-code | ✅ 已实现 | `docs/.local/platforms/co-mind.js`（安装副本 `~/.agentlray/platforms/co-mind.js`） |
| `AGENTLRAY_PKG_ROOT` 包根解析 | ✅ 已实现 | `lib/platforms/loader.js:23` |
| 全表面等价（list/show/resume/prompts/inspect） | ✅ 已实现 | `docs/.local/platforms/co-mind.js` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
