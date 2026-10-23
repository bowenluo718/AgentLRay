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

## 代码库现状提示

工作区当前含**未提交**的"会话状态功能"改动（`lib/status.js`、`lib/platforms/tail-state.js`、`test/status.test.js`、`test/watch-tail.test.js` 及 `lib/platforms/*`、`lib/routes/*`、`lib/watch.js`、前端若干文件的修改），与 [session-status-design.zh-CN.md](docs/.local/session-status-design.zh-CN.md) 对应。`architecture.md`/`implementation.md` 基于 v1.24.0 快照撰写，尚未并入该功能——阅读时留意差异。
