# 计算机方案设计：会话状态信息、监控更新与按状态分组排序

> 本文是 AgentLRay 会话功能增强的**方案设计文档**（Orca 协调任务 P0 产物）。
> 参考实现：`docs/.local/csm-analysis.zh-CN.md`（csm 1.3.1 三种机制分析，下文简称 csm）。
> 状态：**P0 设计审查已完成**（reviewer agent，结论"需修订"）。本版已并入全部阻断项/重要项与可行建议（见 §5.1 审查结论与采纳）。

---

## 0. 目标

1. **为会话添加状态信息**：每个会话摘要（`SessionSummary`）携带统一四态 `status`，跨全部 7 个平台（openclaw / codex / claude-code / hermes / omp / dsh / gemini）语义一致。
2. **监控更新**：状态随日志增长与时间流逝自动更新（非进程级实时，见 §2.1），前端轮询与 SSE tail 都能反映最新状态。
3. **排序默认按状态分组**：`待用户输入 → 工作中 → 等待中 → 已停止` 四组顺序，组内沿用当前默认排序（每平台既有默认：多数按会话开始时间 `timestamp` 降序；hermes 按 `lastActivity` 降序）。

四个状态对应 csm 四态：`Needs Input / Working / Waiting / Inactive`（"组内现在的默认排序"以各平台既有行为为准）。

---

## 1. 现状（依据源码）

| 项 | 现状 | 位置 |
|---|---|---|
| 会话列表默认排序 | 各平台 `list*` 按 `timestamp` 降序（`sortSessionsByTimestampDesc`）；hermes 内联按 `lastActivity` 降序 | lib/platforms/{claude,codex,dsh,gemini,omp,openclaw}.js；hermes.js:163-170 |
| `status` 字段 | 仅 openclaw（`archived`/`active`）、hermes（`archived`/`active`）写了**归档标记** | openclaw.js:136、hermes.js:148 |
| 状态徽标渲染 | React `SessionCard` 与 legacy `sessionCardHtml` 渲染 `session.status` 徽标 | frontend/src/views/sessions/SessionList.tsx、public/js/app.js:2812 |
| 元数据缓存 | `withMetadataCache` 按文件 `mtimeMs` 缓存平台解析结果 | lib/platforms/shared.js |
| 会话列表刷新 | React 5s 轮询（`useSessionsList`）+ SSE tail；legacy 类似 | frontend/src/views/sessions/queries.ts、routes/watch.js |
| 测试 | `node --test test/*.test.js`；lint = biome | package.json |

**关键结论**
- `sortSessionsByTimestampDesc` 被 7 个 `list*` 尾部使用；search/insights/prompts 走 `collectFiles` 自算聚合，不受本方案影响。
- 现有 `status` 只是"归档/活跃"文件标记；本方案改为统一四态，归档过滤（`isArchivedFile`/`include_archived`）独立于 `status`，不受影响。
- **缓存**：`status` 依赖墙钟 `now`，**必须**在缓存命中之后、列表返回之前动态计算，绝不能写进 `withMetadataCache` 缓存载荷（否则状态被冻结）。openclaw 现有 `status` 写在缓存载荷内（openclaw.js:136），改造时**必须显式移除**。

---

## 2. 总体设计

### 2.1 定位与语义（借鉴 csm §4.1）

csm 是实时进程监视（`isRunning` 来自 OS 进程表）；AgentLRay 是**取证/证据回放**，明确不查活进程（`inspect.js:254`：`not a ... live process status`）。因此：

- 状态由**日志记录证据 + 时间窗口**推导，并明确标注"依据记录推断"而非进程实况。
- 会话关闭以**记录级结束标记**（`session_exit`/`ended_at`）判定；无结束标记时以"无任何证据超过取证闭口窗口"作为**取证默认关闭**（替代 csm 的 `isRunning` 门控，见 §2.4）。

四态语义（取证口径）：

| 状态 key | 中文 | csm | 语义 |
|---|---|---|---|
| `awaiting-input` | 待用户输入 | Needs Input | 会话卡在未完成的工具调用/待用户应答处；**唯一不靠用户就不会动的状态，排最上**（有取证上界，见 §2.4） |
| `working` | 工作中 | Working | 正在进行中有活动：工具执行 / 等待工具输出 / 思考阶段在"进行中工作上界"（≤15min，§2.2）内即算工作（记录证据，非进程） |
| `waiting` | 等待中 | Waiting | 未显式关闭、活动仍在取证闭口窗口内（空转 / 启动中 / 回合结束待下一条输入） |
| `stopped` | 已停止 | Inactive | 显式结束标记（session_exit/ended_at），或超取证闭口窗口无任何证据 |

排序优先级（组顺序）：`awaiting-input(0) < working(1) < waiting(2) < stopped(3)`。

### 2.2 共享时间窗口（唯一锚点，仿 csm §1.2）

集中在 `lib/status.js`：

| 常量 | 值 | 语义 |
|---|---|---|
| `RECENT_ACTIVITY_MS` | 2 min | 通用"最近活动"短鲜度：回合已完成 / 无进行中证据时的 `working` 短窗口 |
| `ACTIVE_WORK_CEIL_MS` | 30 min | **"进行中回合"工作的判定上界**：工具执行、等待工具输出、真实 prompt 待处理、消息间隙思考仍无新记录也在工作；超过此界才降级 `awaiting-input`/`waiting`（修复 2026-10 反馈：长工具/深思考被误判等待中） |
| `HISTORY_CEIL_MS` | 12 h | **取证闭口窗口**：无结束标记的会话证据超过此界 → `stopped`；`awaiting-input`/`waiting` 的上界（替代 csm 的 `isRunning` 门控） |

> **取值以 `lib/status.js` 当下常量为准**：初版为 15min / 1h，2026-10 用户据实际使用调宽为 30min / 12h（§5.6 表格所述）。

不需要 csm 的 `logWriteWindow`（不把 mtime 当工作证据，csm §4.4 不建议照搬）；mtime 仅在"空会话"分支作为启动迹象（§2.4 第 1 步）。

### 2.3 证据契约 `tail`（平台中立）+ precision 分级

每个会话摘要新增（文件派生、可安全进缓存）`tail` 对象：

```js
tail = {
  lastAssistantAt,      // ISO|null  最后一条 assistant（agent 输出）时间
  lastPromptAt,         // ISO|null  最后一条"真实用户 prompt"时间（过滤工具回执/注入噪音）
  endTurnAt,            // ISO|null  最后一条"回合完成"标记时间（仅回合结束，非会话关闭）
  endedAt,              // ISO|null  会话已显式关闭标记时间（session_exit / ended_at）
  pendingToolAt,        // ISO|null  最旧的未应答工具调用时间（awaiting-input 锚）
  pendingNewestAt,      // ISO|null  最新的未应答工具调用时间（"正在执行"新鲜度锚）
  oldestPendingToolName // string|null 最旧未应答调用的工具名（识别用户交互类工具，如 ask）
}
```

> `pendingNewestAt`（P1 审查新增）：pending 分支以它判 working 新鲜度，`pendingToolAt` 判 awaiting-input/stopped 上界——避免"旧残留未应答调用"碾压"正在推进的新调用"导致误判老化/stopped（csm 靠 `isRunning` 兜底，本方案无进程信号）。

**重要映射约束（防把正常回合当会话关闭）**：
- `endedAt` ← **仅** omp `session_exit`、hermes `ended_at`（会话级关闭）。
- `endTurnAt` ← omp `stopReason ∈ {stop, aborted}`、claude-code `turn_duration` 或 `stop_reason == 'end_turn'`（回合级结束）。**不得**把 `stopReason` 喂给 `endedAt`，否则每轮正常结束的活跃会话都会被判 `stopped`（csm 明言这些是 Waiting，omp.go:528-536）。

**precision 分级（按记录形态实证，越精确越好）**：

| 平台 | 级 | pending 证据 | 结束证据 |
|---|---|---|---|
| omp | precise | toolCall.id vs toolResult.toolCallId 集合差（最旧未应答） | `session_exit`→endedAt；`stopReason`→endTurnAt |
| claude-code | precise | tool_use.id vs tool_result.tool_use_id | `turn_duration`/`stop_reason`→endTurnAt |
| codex | precise | function_call/custom_tool_call.call_id vs 对应 output.call_id | 无可靠回合标记→endTurnAt 置 null |
| openclaw | precise | toolCall(`id`) vs toolResult(`toolCallId`) | 无→null |
| dsh | precise | tool/call.callId vs tool/result callId（dsh.js:237-268） | 无→null |
| gemini | generic | 工具结果内联在 toolCalls[].result/status，**无**独立结果记录（gemini.js:246-258）→ pending 不可得，置 null | 无→null |
| hermes | db | `ended_at`→endedAt；lastAssistantAt/lastPromptAt 由 messages 聚合；pending 用"最后 assistant 带 tool_calls 且其后无 tool 行"近似 | `ended_at`≠null |

> 通用回退：预判证据缺失时偏向"宽 / 新鲜 = working"（csm §2.7 generous bias：误标 working 自愈，误标 stopped 隐藏活会话）。

### 2.4 状态判定 `deriveStatus(tail, meta, nowMs)`（仿 csm §1.3/1.4，取证化）

评估顺序（照 csm 关键不变量：pending 先于老化、结束标记≒Inactive、回合结束先于最近活动回退）：

> 实现顺序说明（P1 审查确认）：显式关闭步骤**先于**空证据步骤（有结束标记的空会话应为 stopped 而非"启动中 waiting"），与 §2.4 下方列表的编号顺序相反，属刻意。

1. **空证据兜底**：`lastActivity` 与 `timestamp` 均无 → 文件 `mtimeMs` 距今 ≤ `RECENT_ACTIVITY_MS` → `waiting`（启动中），否则 `stopped`。**mtime 来源**：各文件平台元数据解析返回 `mtimeMs`（stat 已由缓存路径执行，作为文件派生字段进缓存载荷）。
2. **显式关闭优先**：`endedAt` 非空且 `lastActivity <= endedAt` → `stopped`（csm `!isRunning → Inactive` 的记录级替代）。
3. **pending 工具**（唯一 `awaiting-input` 生产者，**先于任何老化检查**，csm 注释 session.go:1178）：
   - 最新未应答调用（`pendingNewestAt`，兼容只有 `pendingToolAt` 时以它回退）距今 ≤ `ACTIVE_WORK_CEIL_MS` → `working`（工具执行中 / 等待工具输出，**长工具（>2min）也保持工作中**，将自动推进）；
   - **用户交互类工具豁免**：`oldestPendingToolName ∈ USER_AWAIT_TOOLS`（`ask` 等，发起即等用户输入/授权）→ 超 working 上界即 `awaiting-input`，**不受** `HISTORY_CEIL_MS` 约束——用户可能很久才回复，降 stopped 会把"明明在等用户"误读为已结束（等同 csm Needs Input 无时间上界，见 §5.6）；
   - `pendingToolAt` 距今 ≤ `HISTORY_CEIL_MS` → `awaiting-input`（停等用户授权/输入）；
   - 距今 > `HISTORY_CEIL_MS` → `stopped`（**取证上界**：崩溃/中断且未写 toolResult 或 session_exit 的会话不无限置顶，替代 csm 的 `isRunning` 门控；P0 阻断项，仅适用于自动工具，交互工具不适用）。
4. **回合完成**：`endTurnAt` 存在且其后无更新的真实 prompt → 距今 ≤ `HISTORY_CEIL_MS` → `waiting`，否则 → `stopped`。（先于"进行中活动"回退，仿 csm turn_duration 先于 mtime。）
5+6. **进行中回合活动回退**（原第 5/6 步合并）：走到此说明"回合仍在推进"（`endTurnAt` 缺失，或其后又来了新的真实 prompt）——真实 prompt 待答（Processing...）、工具结果后的思考、多步任务的消息间隙，距今 ≤ `ACTIVE_WORK_CEIL_MS` → `working`（长思考 / 长停顿不因超过 2min 短鲜度而降级）。
7. **活跃待机**：距今 ≤ `HISTORY_CEIL_MS` → `waiting`（进行中但安静超过工作上界的会话，以及无结束标记平台在 [ACTIVE_WORK_CEIL, HISTORY_CEIL) 区间的 idle 会话，避免"等待中"组在这些平台几乎为空、与宽证据口径矛盾）。
8. **兜底** → `stopped`。

`STATUS_LABELS` 提供中文标签供 UI 使用。

### 2.5 分组排序（服务端，两个 UI 与 API 一致）

`lib/status.js::sortSessionsByStatusGroups(sessions, { nowMs, sortBy = 'timestamp' })`：

1. 统一 `nowMs` 对每个会话计算 `status` 并写回 `session.status`（一次校准，避免排序内反复算）；
2. 按 `STATUS_ORDER` 分组；
3. 组内按各平台**既有默认排序**：`sortBy='timestamp'` 降序（多数平台）；hermes 传 `'lastActivity'` 降序保留其"最近活动置顶"语义（hermes.js:163-170 现行为，不改）。

各平台 `list*` 尾部把原排序替换为 `sortSessionsByStatusGroups(resolved, { nowMs: Date.now(), sortBy })`。`sortSessionsByTimestampDesc` 保留导出（作组内默认与未受影响消费者）。

### 2.6 监控更新

- **每次拉取重算**：`status` 在 `list*` 返回前按当前 `now` 计算 → React 5s 轮询 / legacy 轮询持续刷新（列表缓存只冻文件派生字段与 tail，不冻状态）。
- **SSE tail 即时刷新（关键接线）**：现状下 `newMessages` 的 `session` 字段只有当增量含 `type:'session'` 记录才出现（进行中会话基本不出现），hermes 分支完全不带 session，前端只把 `payload.session` 合进详情缓存。要达成即时刷状态必须：
  1. `routes/watch.js` 在路由层**总是**在 `newMessages` 负载附加 `session.status`（用当前 `now` 由 `parseWatchLines` 得到的 sessionMeta/lastActivity 推导；**不要**写进 `parseWatchLines`，避免被 search-watch.test.js:134-135 深比较断言破坏）；
  2. 前端（React `useSessionSse` / legacy SSE 处理）合并 `payload.session.status` 进 **`['sessions', platform, agent, includeArchived]` 列表缓存**（React 需在查询缓存扁平更新对应 session.status），并保留原有详情缓存合并。
- 无客户端时不额外扫描（沿用按需轮询，不新增扫描器）。
- **归口说明**：本方案不做进程级实时；"监控"= 证据 + 时间随拉取/推送推进，UI 明示基于记录推导。

### 2.7 前端展示

- 状态徽标：React `SessionCard` 与 legacy `sessionCardHtml` 渲染四态徽标（中文标签 + 配色，`awaiting-input`/`working`/`waiting`/`stopped`）。
- **React 分组头**（"分组"的可见呈现）：把"展示行数组"（组头行 + 卡片行，组头 only-if-有卡片）作为虚拟列表行来源，**重映射三处对 `filtered[row.index]` 的直用**：渲染取行（SessionList.tsx:170）、↑↓ 键盘导航 findIndex（:99-101）、选中滚动 findIndex（:117-120）。`measureElement` 已支持动态行高，组头行成立。
- **legacy**：>VIRT_THRESHOLD 时固定行高虚拟化，插入组头会错位；legacy 仅做四态徽标 + 服务端分组序，**不做组头**（避免破坏旧 UI 虚拟化，React 为组头唯一实现）。
- CSS：`public/css/app.css` 增加 `.badge.awaiting-input/.working/.waiting/.stopped` 四态配色；`archived`/`active` 徽标随 `status` 语义变更移除以避免误读。

---

## 3. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/status.js`（新） | 四态枚举、`STATUS_ORDER`、`STATUS_LABELS`、`RECENT_ACTIVITY_MS`/`HISTORY_CEIL_MS`、`deriveStatus`、`sortSessionsByStatusGroups` |
| `lib/platforms/shared.js` | 不动 `sortSessionsByTimestampDesc` 语义（组内默认仍用它） |
| `lib/platforms/omp.js` | 精确 tail + `listOmpSessions` 换分组排序 |
| `lib/platforms/claude.js` | 精确 tail + `listClaudeCodeSessions` 换分组排序 |
| `lib/platforms/codex.js` | 精确 tail（call_id 匹配）+ `listCodexSessions` 换分组排序 |
| `lib/platforms/openclaw.js` | 精确 tail + **从缓存载荷移除旧 `status`** + 用 `isArchivedFile` 另出 `archived: Boolean` + `listSessionsForAgent` 换分组排序 |
| `lib/platforms/dsh.js` | 精确 tail（callId 匹配）+ `listDshSessions` 换分组排序 |
| `lib/platforms/gemini.js` | 通用 tail + `listGeminiSessions` 换分组排序 |
| `lib/platforms/hermes.js` | DB tail + 分组排序（`sortBy='lastActivity'`）；`status` 改四态（`ended_at`→`stopped`） |
| `lib/routes/watch.js` | 路由层总是附加 `session.status` 到 `newMessages` 负载（不动 `parseWatchLines`） |
| `test/status.test.js`（新） | `deriveStatus` 8 分支 + 分界（含 awaiting-input 上界、结束/回合标记映射、闭口窗口）+ 分组排序（组序固定、hermes 按 lastActivity、其它按 timestamp） |
| `test/hermes.test.js` | **按行为变更更新**：:85-86 `archived`/`active` → `stopped` |
| `test/search-watch.test.js` | **不改**（status 加在路由层，保持 sessionMeta 深比较断言） |
| `frontend/src/views/sessions/SessionList.tsx` | 展示行数组（组头+卡片）、四态徽标、三处下标重映射 |
| `frontend/src/views/sessions/useSessionSse.ts` | 合并 `payload.session.status` 进列表缓存 |
| `public/js/app.js` | 四态徽标；SSE 合并状态（分组头不做） |
| `public/css/app.css` | 四态徽标配色；移除 archived/active 徽标样式 |
| `docs/.local/session-status-design.zh-CN.md` | 本文档；P4 在 `docs/usage.zh-CN.md` 补一句状态说明 |

**不做（明确排除）**：进程扫描/ghost 击杀、以 mtime 作为工作证据、`--kill-ghosts` 语义、legacy 分组头。

---

## 4. 验证方案

1. **单元**：`test/status.test.js` 覆盖 `deriveStatus` 全分支与分界——pending 新鲜/过期/超闭口、endedAt/endTurnAt 映射隔离、回合完成后等待、[RECENT,HISTORY_CEIL) idle→waiting、HISTORY_CEIL 外→stopped、空证据 mtime 分支；分组排序组序固定、同组按各平台 sortBy 降序。
2. **集成**：`node --test test/*.test.js` 全绿；`hermes.test.js:85-86` 按行为变更更新为 `stopped`；`search-watch.test.js` sessionMeta 深比较保持通过。
3. **冒烟**：起服务 `npm start`，对真实 `~/.omp/agent/sessions`、`~/.claude/projects` 抽查 `/api/omp/sessions`、`/api/claude-code/sessions`：确认 `status` 出现、分组序正确（待用户输入/工作中置顶，已停止沉底）、5s 内状态随日志变化。
4. **UI**：React 组头与 badge、legacy badge 无回归。

---

## 5. 分阶段执行与审查计划（Orca）

| 阶段 | 内容 | 执行后派送审查 |
|---|---|---|
| P0 | 本文档 | 设计审查 agent ✓（已完成，见 §5.1） |
| P1 | 后端：status.js + 各平台 tail + list* 分组排序 + 单测 | 代码审查 agent ✓（见 §5.2） |
| P2 | 前端：React 组头/徽标 + legacy 徽标 + CSS | 代码审查 agent ✓（见 §5.3） |
| P3 | 监控：SSE 会话状态 + 前端列表缓存合并 + 测试 | 代码审查 agent ✓（见 §5.4） |
| P4 | 全量验证（测试 + 冒烟 + UI） | 最终验证 agent ✓（§6 验收） |

### 5.1 P0 设计审查结论与采纳

reviewer agent 结论：**需修订**（1 阻断 + 6 重要 + 5 建议）。已全部采纳：

- **阻断**：pending 过期无上界 → 崩溃/中断会话永久 `awaiting-input` 置顶。→ §2.4 第 3 步加 `HISTORY_CEIL_MS` 上界；§4 配套边界用例。已修。
- **重要-1**：stopReason 归属歧义可能把活跃会话判 stopped。→ §2.3 显式映射 `endTurnAt`/`endedAt`。已修。
- **重要-2**：[2,5)min 无结束标记平台直接落 stopped 与 csm Waiting 矛盾。→ §2.4 第 7 步新增"活跃待机"→ waiting。已修。
- **重要-3**：openclaw 旧 `status` 在缓存载荷内会被冻结。→ §3 openclaw 从缓存载荷移除、另出 `archived`。已修。
- **重要-4**：SSE status 现状机制不成立。→ §2.6 路由层总附加 + 前端合并进列表缓存。已修。
- **重要-5**：hermes 组内排序语义（lastActivity）。→ §2.5 `sortBy` 参数保留各平台默认。已修。
- **重要-6**：React 组头需展示行数组并重映射三处。→ §2.7 已修。
- **建议**：codex/dsh/openclaw 升 precise（id 匹配可行）、gemini 保持 generic。→ §2.3 采纳。空证据 mtime 来源→用 `mtimeMs` 进缓存载荷。`search-watch` 断言不动→status 加路由层。仅 hermes.test.js 需按行为变更更新。均采纳。

### 5.2 P1 代码审查结论与采纳

reviewer agent 结论：**需修订**（0 阻断 + 1 重要 + 7 建议）。采纳：
- 1 **重要**：hermes pending 原按"时间戳 > "近似，同秒工具结果误判、部分应答漏判。→ 改为按 `tool_call_id` 集合包含配对（lib/platforms/hermes.js）。已修。
- 2 **建议-1**：`finishTail` 字典序比较最旧 pending 有精度/时区隐患。→ 改 `Date.parse` 数值比较。已修。
- 3 **建议-2**：`laterThan` 对数值 ms 入参无双宁。→ 显式数值分支。已修。
- 4 **建议-4**：单"最旧 pending"锚会把带旧残留 pending 的正在执行会话误判老化/stopped。→ 新增 `pendingNewestAt`，working 新鲜度用最新锚。已修（§2.3）。
- 5 **建议-5**：显式关闭先于空证据的实现顺序与文档编号相反。→ 本文档 §2.4 增加实现顺序说明。已修。
- 6 **建议-6**：补边界等号与数值入参测试。→ status.test.js 增边界用例。已修。
- **保留不修**：建议-3（空证据分支只判 lastActivity===null——文件平台有 mtime 正确工作，hermes 恒有 lastActivity 故不受影响）；建议-7（hermes 新鲜会话夹具集成测试→P4 验证补）；建议-8（openclaw `archived` 布尔在 P2 前端作归档标记消费，非死字段）。

### 5.3 P2 前端展示审查结论与采纳

reviewer agent 结论：**需修订**（0 阻断 + 1 重要）。采纳：
- **重要**：四态标签/配色在前端三处（lib/status.js / React SessionList STATUS_META / legacy STATUS_LABELS）硬编码，无一致性守门会静默分叉。→ 新增 `GET /api/status-labels`（lib/routes/sessions.js）从 lib/status.js 单源透出 `order`+`labels`；React `useServerStatusLabels()` 与 legacy `loadStatusLabels()` 启动消费（本地同键配色/标签作闪屏回退，失败静默），并加 `test/status.test.js` 断言 `STATUS_LABELS` 键集==`STATUS_ORDER`。已修。
- 附带修正（自研/浏览器实测发现）：`groupRows` 头计数更新曾误把最后一张卡片替换成组头（末尾在播会话丢失）→ 改为"组头于每状态首个会话前插入 + 计数 map"。已修。

### 5.4 P3 监控更新审查结论与采纳

reviewer agent 结论：**需修订**（0 阻断 + 3 重要 + 4 建议）。均为即时性/一致性瑕疵，5s 轮询归口内会被修正。采纳：
- **重要-1**：SSE `watchLastActivityAt` 跨批次直接覆盖会在时间戳倒挂时倒退 → 活跃会话瞬时误判老化。→ 改为单调 max。已修（lib/routes/watch.js）。
- **重要-2**：SSE 端缺结束/回合标记证据（归一化丢弃 stopReason/turn_duration/session_exit），且"结束后无消息、退出标记不产生新消息"的批次根本不推送，显式结束徽标停在 active 直到轮询。→ 路由层识别 OMP `custom.customType==='session_exit'` → noteEnded，无消息批次也推 status-only（前端处理空消息事件），OMP 显式结束时即时置 stopped；其余平台仍以轮询收敛（best-effort 归口，§2.6 声明）。已修。
- **重要-3**：gemini 的 SSE lastActivity（最后归一化消息）与列表 lastUpdated 锚不同、且列表不追踪 pending。→ 明确为已知差异、由 5s 轮询收敛（SSE 为订阅会话的即时预览，非精确终态）。备注于 §2.6。
- **建议-1**：`latestMessageTimestamp` 字符串比较改数值比较（免疫混合时区/毫秒格式）。已修（lib/watch.js）。
- **建议-2**：无消息批次也推 status（状态不依赖新消息到达即收敛）。已修（同重要-2）。
- **建议-3**：React 对每次 newMessages 全量 invalidate+setQueriesData 的高频开销→低频影响，未处理（记注意事项）。
- **建议-4**：补 reasoning→noteAssistant 与同批 addPending→resolvePending 净清零测试。已修（test/watch-tail.test.js）。

### 5.5 修复记录（2026-10：长工具/深思考误判等待中）

**现象**：会话在**执行工具、等待工具输出或思考**时，停顿稍长（>2min）即被降级成 `等待中`/`待用户输入`，而非 `工作中`。

**根因**：`RECENT_ACTIVITY_MS`（2 min）原被当作**所有** working 证据的新鲜度上界（pending 新鲜原点、prompt 处理、最近活动）。真实 agent 的长工具执行 / 等输出 / 思考阶段常远超 2min，一旦停顿即触发降级。

**修复**（已采纳用户选择的取值）：
- 新增 `ACTIVE_WORK_CEIL_MS = 15 min`：凡有"进行中回合"证据（pending 工具、真实 prompt 待答、endTurn 缺失或其后有新 prompt 的活动），15min 内一律 `working`；只有超过此上界才降级 `awaiting-input`/`waiting`。
- `pending` 分支的 working 判定由 `RECENT_ACTIVITY_MS` 改为 `ACTIVE_WORK_CEIL_MS`（§2.4 第 3 步）。
- 原第 5/6 步（真实 prompt 待答 / 最近活动回退）合并为一步，统一按 `ACTIVE_WORK_CEIL_MS` 判 working（§2.4 第 5+6 步）。
- `HISTORY_CEIL_MS` 定为 **1 h**（取代 30min 草案值与 12h 的提交值，三者此前不一致）；`awaiting-input`/`waiting` 上界随之统一为 1h，测试按 1h 语义更新。
- 删除 `deriveStatus` 中未使用的 `startMs`。

**验证**：`test/status.test.js` 新增长工具回归用例（pending 6min / prompt 待答 10min → working）；3 处按 30min 语义写的旧用例与 `watch-tail.test.js` 挂起边界改为 1h 语义。全量 `node --test test/*.test.js` 394/394 绿。

### 5.6 修复记录（2026-10：等用户输入的会话被误判已停止）

**现象**：omp 会话 `01a17645-…-990b6fd51377` 状态不准确——agent 调用了 `ask` 工具向用户确认需求（`toolCall name=ask` + `tool_execution_start`），之后 2h+ 无 `toolResult`（用户未答），被推导成 `已停止`。

**根因**：`pending` 分支对所有工具一视同仁走 `HISTORY_CEIL_MS`(1h) 取证上界。但 `ask` 这类**用户交互类工具**发起即表明"agent 停在等用户"——用户可能很久才答，降 `stopped` 与 `awaiting-input` 语义（唯一不靠用户就不会动、排最上）直接矛盾。P0 阻断项的取证上界是针对**自动工具崩溃/中断**挂起（bash/read 等），交互工具不适用。

**修复**：
- `tail-state.js`：`pendingByTs` 旁新增 `pendingNames`（toolCallId → 工具名），`addPending(state, id, ts, toolName)` 记录、`resolvePending` 清除（幂等保留首个）；`finishTail` 输出 `oldestPendingToolName`（最旧未应答调用的工具名）。各平台 `addPending` 传入工具名（omp/claude/codex/openclaw/dsh 各自已解的 `name`；watch.js SSE 路径传 `toolName`/`name`）；gemini 无 pending、hermes 为近似 pending 无名字信息，维持既有上界逻辑。
- `lib/status.js`：新增 `USER_AWAIT_TOOLS = new Set(['ask'])`；pending 分支在 working 上界之后、闭口上界之前插入豁免——`oldestPendingToolName` 命中交互工具则直接 `awaiting-input`，不受 `HISTORY_CEIL_MS` 约束。

**验证**：`test/status.test.js` 新增 3 用例（ask 超界→awaiting-input、ask 新鲜→working、非交互 bash 超界→stopped 且无名字信息回退普通上界）。全量 `node --test test/*.test.js` 404/404 绿；目标 omp 会话经真实 parser 推导为 `待用户输入`（修复前 `已停止`）。

### 5.7 修复记录（2026-10：ask 残留 pending 把已结束会话误判为"待用户输入"）

**现象**：omp 会话 `01a17713-…` 状态显示"待用户输入"，实际应为"等待中"。日志尾部：03:49 旧阶段 `ask` 工具挂起 → 06:42 `custom session_exit`（其 `parent` 指向该 ask 的 `tool_execution_start`，即 ask 结果闭环/阶段退出）→ 06:42 起用户续写、大量工具 → 07:37 回合正常 `stop`。

**根因**：omp 的 `ask` 等交互工具**结果闭环是 `custom session_exit` 记录，而非 `toolResult` role**——`resolvePending` 永不触发，ask 调用永久残留 pending。残留把状态锁死成 `awaiting-input`（配合 §5.6 的交互豁免后更甚：无论闭口上界多大都置顶待输入），而真实语义是"该轮已结束、等用户下一条"。

**修复**：
- `tail-state.js` 新增 `resolveAllPending(state)`（清空 pendingByTs 与 pendingNames）。
- omp 解析遇到 `custom session_exit`：除既有 `noteEnded` 外，同时 `resolveAllPending`——该标记既承"会话段退出/阶段边界"，也承"ask 结果闭环"，清掉挂起的交互调用。SSE 路由（`routes/watch.js`）OMP `session_exit` 识别分支同样处理。
- `ask` 仍在真实挂起且无 `session_exit`（如 `01a17645`）时，无任何清除 → 交互豁免使其保持 `awaiting-input`，两种语义各自成立。

**验证**：`test/watch-tail.test.js` 新增 2 用例（`resolveAllPending` 基础清除；omp 恢复会话场景 ask→session_exit→后续回合 → `waiting`）。目标会话经真实 parser 推导为 `待用户输入`→`等待中`（pendingToolAt 已清、endTurn 07:37 主导）。全量 `node --test test/*.test.js` 408/408 绿。

### 5.8 修复记录（2026-11：omp 的 ask 发起即待输入，误判为"工作中"）

**现象**：omp 会话 `01a196f9-…` 状态显示"工作中"，实际应为"待用户输入"。日志尾部：`toolCall name=ask`（12:52:35）→ `custom tool_execution_start`（12:52:35）——ask 发起后 agent 即停在界面等用户点选 questions，无任何后续活动直到用户答复，但被推导成 `working`。

**根因**：`ask` 归入 `USER_AWAIT_TOOLS`（§5.6 决策），设计为"发起后 working 上界（30min）内仍按 working、超上界才 awaiting-input"。但 omp 的 `ask` 与 claude-code/co-mind 的 `AskUserQuestion` 同属**发起即待输入**的阻塞式交互提问——发起后 agent 不再推进，应立即 `awaiting-input`，而非等 30min。§5.6 的"ask 新鲜→working"缓冲假设不成立。

**修复**（grill 决策：全局改，非仅 omp）：
- `lib/status.js`：删除 `USER_AWAIT_TOOLS`（原仅 `ask`），把 `ask` 并入 `IMMEDIATE_AWAIT_TOOLS = ['AskUserQuestion', 'ask']`——pending 分支**发起即判 `awaiting-input`**，不进入 working 上界判断，不受 `HISTORY_CEIL_MS` 取证上界约束（用户可能很久才回复）。`isUserAwaitTool` 及相关死代码分支删除。
- 同步 co-mind 适配器内联副本（`~/.agentlray/platforms/co-mind.js` 与规范源 `docs/.local/platforms/co-mind.js`）同一套 `IMMEDIATE_AWAIT_TOOLS` 语义。

**验证**：`test/status.test.js` 将「ask 进行中工作上界内 → working」改为「ask 发起即待输入：30s/12min 前发起 → awaiting-input」。目标 omp 会话经真实 parser 推导为 `工作中`→`待用户输入`（pending ask 主导）。全量 `node --test test/*.test.js` 503/503 绿。

---

## 6. 验收记录（P4 最终验证）

最终验证 agent（reviewer，只读）结论：**通过**。逐条验收证据（摘录）：
1. 四态 status 统一且 7 平台接入：lib/status.js 四态 + tail-state.js + 各 lib/platforms/* list* 内建 tail（omp/claude/codex/openclaw/dsh 精确、gemini 通用、hermes DB）。
2. 监控更新：status 不在 withMetadataCache 载荷（openclaw 已移除旧 cached status），list* 返回前按 now 现算；SSE /api/watch 基线+增量累积 + OMP session_exit 识别 + 无消息 status-only 推送；React/legacy 合并进列表缓存即时刷新。
3. 分组排序：sortSessionsByStatusGroups 在 7 个 list* 尾部生效（组序 awaiting-input→working→waiting→stopped，组内 timestamp 降序、hermes lastActivity 降序）。
4. 文档：设计文档含 P0/P1/P2/P3 各阶段审查结论与采纳（§5.1–5.4）；docs/usage.zh-CN.md 已更新四态状态说明（功能特性与基本流程）。
5. 实现质量抽查通过：deriveStatus 顺序、/api/status-labels 单源 + 前端回退、无旧 archived/active 消费者残留。全量 `node --test test/*.test.js` 376/376 绿。

已确认的中低风险（best-effort，不遮蔽验收）：SSE 为即时预览以 5s 轮询为准（显式结束即时置 stopped 仅 OMP）；gemini 锚点差异已知；hermes pending 只查最后一条 assistant；空消息会话在 SSE 端恒 stopped；平台记录形态差异的取证精度分级属 §2.3 设计。
