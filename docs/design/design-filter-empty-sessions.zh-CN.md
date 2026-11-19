# 空会话统一过滤设计（仅列表，详情保留）

> 设计日期：2026-11-11　状态：已确认，待实现（2026-11-11 修订：详情不过滤，仅列表过滤）
> 触发场景：dsh 平台会留下"只有会话元数据 header、无任何对话事件"的空会话日志文件（如 `session-6d48bc18-…` 仅含 `session` header + `permission/preset`/`sandbox/mode`/`approval/policy`/`session/end-seed`，无 `user/message`/`assistant/message`/`tool/*`），AgentLRay 解析后 `messages` 为空，前端/CLI 列表呈现为空会话。

## 目标

在 AgentLRay 侧统一过滤空消息会话的**列表呈现**：

- **语义**：列表（看板 / HTTP 列表 / CLI `list` / openclaw 全 agent 聚合）隐藏空会话。**详情（HTTP 详情 `GET /api/:platform/sessions/:id`、CLI `show`）不过滤**——保留原始空会话，便于排查/追溯。
- **判定条件**：`userCount === 0 && messageCount === 0`（会话从未产生任何消息）。
- **默认开启，无配置开关**。
- **不改各平台适配器**（dsh/gemini/hermes/codex/claude-code/omp/openclaw 的 `parse`/`getSession` 均不动）——统一过滤，避免 6+ 平台逐个改动且不影响 `parse` 被 watch/search/insights 等面复用。
- **不过滤**：详情（HTTP + CLI show）、子会话（children）、`resume` 链路（续跑需要 `session.cwd`，且空会话可被续跑填充内容）。

## 现状梳理（各平台空会话形态）

| 平台 | list 摘要解析 | 详情解析 | 是否可能产生空会话 |
| --- | --- | --- | --- |
| dsh | `platforms/dsh/parse.js` `_parseDshSessionMetadataRaw`（`messageCount`/`userCount`/`firstUserMessage`） | `parseDshSessionFile` → `{session, messages}` | 是（目录即会话，seed 后无对话即空） |
| gemini | `platforms/gemini/parse.js` `_parseGeminiSessionMetadataRaw` | `parseGeminiSessionFile` → `{session, messages}` | 是 |
| hermes | `platforms/hermes/parse.js` `listHermesSessions`（SQLite，`messageCount`=s.message_count、`userCount`=st.user_count） | `getHermesSession` → `{session, messages}` | 是（DB 会话记录与消息表分离） |
| codex | `lib/platforms/builtin/codex/parse.js` `_parseCodexSessionMetadataRaw` | `parseCodexSessionFile` → `{session, messages}` | 是 |
| claude-code | `lib/platforms/builtin/claude-code/parse.js` `_parseClaudeCodeSessionMetadataRaw` | `parseClaudeCodeSessionFile` → `{session, messages}` | 是（较少见） |
| omp | `lib/platforms/builtin/omp/parse.js` `_parseOmpSessionMetadataRaw` | `parseOmpSessionFile` → `{session, messages}` | 是 |
| openclaw | `lib/platforms/builtin/openclaw/parse.js` `_parseSessionMetadataRaw` + `listSessionsForAgent` | `parseSessionFile` → `{session, messages}` | 是 |
| co-mind | 薄适配器复用 claude-code，判定同 claude-code | 同 claude-code | 是 |

**关键结论**：

1. 所有平台 list 摘要统一含 `userCount` / `messageCount` / `firstUserMessage` 字段。
2. 所有平台 list 摘要最终都经过 `lib/status.js:217 sortSessionsByStatusGroups`（含 needsAgent 的 openclaw `listForAgent`/`listAllAgents`、hermes SQLite）——这是**列表层统一过滤的天然锚点**。
3. 聚合/API/CLI 列表层此前**无统一空会话过滤点**（`lib/session-list.js` 的 `filterAndPage` 只做 status/match/时间过滤）。

## 设计决策

### D1：列表层过滤锚点 = `sortSessionsByStatusGroups`（lib/status.js:217）

在 `sortSessionsByStatusGroups` 入口、状态推导之前**原地过滤**（保持既有的原地修改语义——调用方持有的数组引用仍是过滤后结果，测试 `status.test.js` 用原数组引用断言排序/status 写回）：

```js
function sortSessionsByStatusGroups(sessions, opts = {}) {
  if (!Array.isArray(sessions)) return sessions;
  // 原地剔除空会话（userCount===0 且 messageCount===0），保持调用方数组引用仍有效；
  // 后续状态推导/排序在过滤后的同一数组上进行。
  for (let i = sessions.length - 1; i >= 0; i--) {
    const s = sessions[i];
    if (s.userCount === 0 && s.messageCount === 0) sessions.splice(i, 1);
  }
  // …状态推导与排序在 sessions 上进行…
}
```

- **原地 splice 而非 `filter` 生成新数组**：既有调用方（dsh/gemini/hermes/codex/claude-code/omp/openclaw 的 `return sortSessionsByStatusGroups(...)` 与测试的原数组断言）都依赖该函数**原地修改 + 返回同一数组**。`filter` 会破坏该契约（测试 `status.test.js:293/311/320` 用原数组引用断言排序与 status 写回）。
- 一处改动覆盖全部平台 list、needsAgent（openclaw `listForAgent`/`listAllAgents`）、hermes、看板 / HTTP 列表 / CLI `list` / openclaw 全 agent 聚合。
- 摘要若缺 `userCount`/`messageCount`（理论上各平台均提供），按 `undefined === 0` 为 false 处理 → 不误过滤；判定表达式用 `s.userCount === 0 && s.messageCount === 0` 严格等于。
- 副作用确认：dsh `listDshSessions` 先算 `childCountMap` 再调本函数，过滤空会话不影响 childrenCount 归属（childrenCount 挂在非空会话上）。
- openclaw `listAllAgents`（builtin/openclaw/index.js:49）与 `listOpenclawSessionsFlat`（lib/session-list.js:148）会**二次**经过本函数（前者内部排序后，后者再对合并集排序）——二次经过时空会话已在前一次被 splice，幂等无副作用，无需额外处理。

### D2：详情层不过滤（维持现状）

- HTTP 详情 `GET /api/:platform/sessions/:sessionId`（lib/routes/sessions.js:131）与 legacy shim openclaw 详情（lib/routes/sessions.js:401）**保持现状**，空会话仍可访问（返回 `{session, messages:[]}`）。
- CLI `show`（bin/sessions.js:381）**保持现状**，空会话仍可查看（显示 `(no messages)`）。
- 不新增 `fetchSessionDetail` 共享函数——详情层无过滤需求。

### D3：不动的边界

- **不改任何平台适配器**（各平台 `parse`/`getSession`/`getSessionAcrossAgents` 原样保留）——`parse` 被 watch/search/insights/tool-audit 等分析面复用，过滤放在展示/查询层不影响它们。
- **resume 不过滤**：`resumeSession`（bin/sessions.js:510）仍直接调 `platform.getSession` 拿 `session.cwd`，允许对空会话续跑（续跑后即有内容）。
- **子会话（children）不过滤**：`listChildren`/`getChild` 维持现状。

## 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `lib/status.js` | `sortSessionsByStatusGroups` 入口原地过滤空摘要（D1） |

（仅此一处。无路由 / CLI / session-list / 平台适配器改动。）

## 测试计划

- `test/status.test.js`：`sortSessionsByStatusGroups` 剔除 `userCount===0&&messageCount===0` 摘要、保留有消息摘要；缺字段不误伤；原地 splice 契约（原数组引用过滤后仍是同一数组，非空元素保留）。
- 各平台 list 测试：空会话不再出现在列表（可复用既有 `listDshSessions`/`listCodexSessions` 等测试，构造空摘要夹具验证）。
- 详情保留测试：空会话 `getSession`/路由详情仍返回 `{session, messages:[]}`（现状，防回归）。
- 回归：`npm test` 全量 + `frontend npm run build`。

## 验证方式

1. `npm test` 全部通过（含新增用例）。
2. 构造 dsh 空会话夹具（仅 header + seed 事件）→ 列表（`GET /api/dsh/sessions`、`agentlray sessions list --platform dsh`、看板）不出现；`GET /api/dsh/sessions/<id>` 与 `agentlray sessions show --platform dsh --id <id>` 仍可访问（返回空消息）。
3. 真实会话不受影响（列表/详情/看板正常）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 列表剔除空会话（`userCount===0 && messageCount===0`） | ✅ 已实现 | `lib/status.js:219-224` |
| 详情不过滤 | ✅ 已实现 | `lib/routes/sessions.js` 详情链路未过滤 |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
