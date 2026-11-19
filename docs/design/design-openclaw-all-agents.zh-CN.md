# OpenClaw 会话查询默认合并全部 Agent

> 需求：openclaw 平台查询会话信息时默认查询所有 agent 的数据，包括终端命令查询（web 看板与 `agentlray sessions` CLI 都覆盖）。
> 结论：list 不再强制 `--agent`，缺省即全部 agents 合并；show 缺省跨 agents 查找。来源 agent 在每条会话上标注，前端下拉默认「全部 agent」。

## 背景与目标

- 现状：AgentLRay 查 openclaw 会话必须指定单个 agent —— web 前端从下拉框选一个（默认第一个）；`agentlray sessions list/show`（`bin/sessions.js`）强制 `--agent`，缺省直接报错。
- 变化：查询 openclaw 会话信息默认返回**全部 agents 的合并结果**，每条会话标注来源 `agent`；终端命令与 web 前端同步生效。
- 兼容：`--agent NAME` 仍存在，传了即限定单 agent；多平台聚合端点 `/api/sessions` 的「每个 agent 一块」语义保持不变。

## 数据层

`lib/platforms/openclaw.js`：

- `listSessionsForAgent()` 在返回前给每条会话补 `agent: agentName`（来源标注，合并视图与导出据此区分）。
- 新增 `listSessionsForAllAgents(baseDir, includeArchived)`：遍历 `readAgents(dir)` 对每个 agent 调 `listSessionsForAgent`，展平后在**合并集**上做全局 `sortSessionsByStatusGroups`（状态组内时间降序）；某 agent 目录缺失/不可读直接跳过，不整体失败。
- 新增 `getSessionAcrossAgents(baseDir, sessionId)`：按 `readAgents` 顺序（字典序）逐 agent 调 `resolveSessionFile` → `parseSessionFile`，返回 `{ session, messages, agent }`。同一 id 在多个 agent 下都存在时取首个命中；文件解析失败则继续找下一个 agent。

`lib/session-list.js`：`listPlatformSessions` 把 `opts.includeArchived` 透传给 `listSessionsForAgent`（聚合端点/CLI 均生效，缺省仅活跃）。

## 路由层（`lib/routes/sessions.js`）

- `GET /api/:platform/sessions`：openclaw 分支 —— `?agent=` 限定单 agent；**缺省调用 `listSessionsForAllAgents`**（flat 数组，每条带 `agent`）。非 openclaw 走原 `platform.list` 路径。
- `GET /api/:platform/sessions/:sessionId`：openclaw 分支 —— `?agent=` 走 per-agent；**缺省跨全部 agents 查找**，响应 `{ session, messages, agent }`。非 openclaw 走原注册表 `getSession` 路径。
- 聚合端点 `GET /api/sessions` 新读 `include_archived` 透传（前端全部 agent 视图的「Include archived」开关）。
- 既有 `/api/agents/:name/sessions` 端点保留（legacy 前端与既有调用）。

## CLI（`bin/sessions.js`）

- `list`：单平台 openclaw 缺省 `--agent` 时走新分支 —— `listSessionsForAllAgents(dir, false)` → `filterAndPage`（过滤/分页在合并集上全局生效）→ 输出。JSON 增加 `allAgents:true` 标记；纯文本表在行首新增 **agent** 列（`renderSessionsTable(shown, withAgent)`）。仍传 `--agent` 则原逻辑（单 agent）。
- `show`：openclaw 缺省 `--agent` 时用 `getSessionAcrossAgents`，命中后 JSON 输出含 `agent`，纯文本标题行 `# Session <id> (openclaw / <agent>)`；未命中报 `not found`。
- 帮助文本、头注释同步更新（`--agent` 改为「可选，缺省=全部 agents」）。

## 前端（React，`frontend/src`）

- `api/client.ts getSessions`：openclaw 无 `agent` → `GET /api/openclaw/sessions`，并把每条会话补 `platform:'openclaw'`（触发列表按平台/agent 分组渲染）；有 `agent` → 原 `/api/agents/:name/sessions`。
- `getSessionDetail`：openclaw 无 `agent` → `GET /api/openclaw/sessions/:id`（跨 agent 查找）。
- `queries.ts sessionsListOptions`：`enabled` 去掉「openclaw 必须有 agent」限制（空 agent 即全部 agents 合并视图）。
- `components/Sidebar.tsx AgentNav`：删除「默认选第一个 agent」的 effect；下拉新增「**全部 agent**」选项（哨兵值 `'__all__'` 承载，选中置 `selectedAgent=''`），默认即全部 agents 合并视图。空 `selectedAgent` 进入 insights/prompts 时后端本就按「全部 agent」聚合并集文件，无回归。

## 验证

- 单元/集成：`test/session-cli.test.js` 16 用例（改写「openclaw 缺省合并全部 agents + `--agent` 限定」、新增「show 跨 agents 查找并标注 agent」）；`test/api.test.js` 新增「`/api/openclaw/sessions` 合并、详情跨 agent、`?agent=` 限定、404」。
- 全量：`npm test` → `406/406` 通过。
- 冒烟（真实 `~/.openclaw`，4 个 agent）：
  - `agentlray sessions list --platform openclaw --json` → `allAgents:true total 550`，每条带 `agent`；
  - 纯文本列表行首为 agent 列；`--agent main` → `495` 条且全为 `main`；
  - `show --id <id>` 缺省命中并标注 `co-xiaoxing`；
  - `GET /api/openclaw/sessions` → 550 条、agents 集合为 4；`?agent=main` → 495 条；`/api/openclaw/sessions/<id>` → 返回 `agent`；不存在 → 404；`/api/sessions?platform=openclaw` 仍为每 agent 一块（4 块）。
- 前端 `tsc -b` 通过。

## 影响面

- 破坏性：`agentlray sessions list/show` 对 openclaw 的**必填 `--agent` 取消**（宽松化，向兼容）；旧调用不受影响。
- 新增路由 `/api/openclaw/sessions`、`/api/openclaw/sessions/:id`；聚合端点 `include_archived` 参数（宽松化）。
- `openclaw` 会话 summary 新增 `agent` 字段（宽松化，前端已用）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 缺省合并全部 agents | ✅ 已实现 | `lib/routes/sessions.js:73,102` |
| 每条标注来源 `agent` | ✅ 已实现 | `lib/platforms/builtin/openclaw/index.js`、`lib/session-list.js` |
| CLI 缺省全部 agents | ✅ 已实现 | `bin/sessions.js` |

