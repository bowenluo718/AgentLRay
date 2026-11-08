# ADR-0001：自定义平台采用运行时 JS 平台适配器

自定义平台扩展走**运行时 JS 平台适配器**：用户写一个 CommonJS 文件放进 `~/.agentlray/platforms/`，启动时并入注册表 `lib/platforms/index.js` 的 `PLATFORMS`，按能力位自动接入全部 generic 表面；前端 v1 经新增的 `GET /api/platforms` 改为服务端驱动展示。

Status: accepted

> **部分被取代（2026-11-07）**：本文“不做 per-platform 启停开关（文件存在即启用）”的结论已由 [ADR-0005](adr-0005-platform-sources.zh-CN.md) 取代（引入 `platforms.disabled` / `platforms.replaced`、三来源与全表面 hook）。本文其余结论（运行时 JS 适配器、信任边界、能力位缺位语义）继续有效。

## 背景（Context）

AgentLRay 需要支持用户扩展内置 7 平台之外的新平台。现状注册表是静态内置对象，但契约与全部 generic 表面（路由 / watch / search / prompts / tool-audit / export / OTLP / CLI）都已就绪——「扩展」的实质是把静态表变成「内置 + 用户可插」的加载机制，并定义自定义平台的适配器契约。

曾考虑：
- **JSON 声明式 + 内置通用适配器**：免写代码，但只能覆盖几种预置形状（扁平/嵌套 jsonl、单文件），表达不了 dsh/gemini 的折叠重写、openclaw 的 agent 维度、hermes 的 SQLite 这类复杂来源——而需要扩展的恰是这些复杂格式。
- **改源码随仓库分发**：非「自定义」，对未 fork 使用的用户不可用。

## 决策（Decision）

- 扩展单元 = **平台适配器（Platform adapter）**：CommonJS 单文件，必需 `id/label/defaultDir/list/parse/getSession`，可选 `find/collectFiles/watchParse/needsAgent/resume/version`；复用统一归一化形状（`makeMessage` 11 字段、摘要含 `timestamp/lastActivity/tail`）。
- 发现/加载：`~/.agentlray/platforms/*.js`，`lib/platforms/index.js` 模块初始化末尾并入；**每文件 try/catch 隔离**，坏适配器标记 `broken` 不拖垮启动；`AGENTLRAY_NO_PLUGINS` 全局逃生。
- id 正则 `^[a-z0-9][a-z0-9-]*$`，与既有 id 冲突即 broken。
- 能力位缺谁谁缺位：无 `collectFiles` → search/prompts/tool-audit 缺位；无 `watchParse` → 无实时尾随（watch 路由对缺位返回 400）。
- 明确不做：`inspect` 离线诊断仅内置；`resume` 内置按原生参数出厂（2026-10-30 扩充后覆盖 codex / claude-code / omp / dsh / gemini / hermes，见 [design-resume-more-platforms.zh-CN.md](design-resume-more-platforms.zh-CN.md)）+ 自定义平台 `resume` 字段 opt-in；不做 per-platform 启停开关（文件存在即启用）。
- 信任边界：适配器以用户全权限执行任意 JS，文档明示只放可信代码，不做沙箱。
- 前端：`GET /api/platforms` 服务端派生列表；React 主前端改服务端驱动，legacy `public/js/app.js` 最小侵入（内置表 + 追加自定义 + 通用分发兜底 + broken 徽标）。

## 后果（Consequences）

- 正向：任何平台可无损接入全部 surface；契约 = 既有注册表契约的直译，复用成本低；加载器供 server 与 CLI 共享，视图一致。
- 负向/约束：新平台必须有人会写一点 JS；前端必须从静态枚举迁移到服务端驱动（React 全量、legacy 侵入处多——这是 v1 里最重的两块）；watch 路由必须补 `watchParse` 守卫（现状缺位会炸）。
- 信任权衡：允许任意 JS = 本机一致信任（等同用户自己跑脚本），换取「无需为每种未来平台预置描述语言」的灵活；此前的 JSON 声明式因表达力不足被否。
