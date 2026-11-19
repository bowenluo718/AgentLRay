# 首帧「先连后加载」主机就绪门控（design-host-gate-before-load）

> 多主机 P0（[design-multi-host.zh-CN.md](design-multi-host.zh-CN.md) / [plan-multi-host.zh-CN.md](plan-multi-host.zh-CN.md)）已合入主干（`d005166`）。本设计解决 P0 遗留的**首帧启动顺序问题**：页面先按本机渲染、再重连记忆的远端，导致一帧本机内容闪烁，且本机 `/api/sessions`、`/api/settings` 等数据面请求被白拉一遍。
> 状态：设计稿（待评审）。

## 1. 问题现状

首帧加载链路（`frontend/src`）：

1. store 初始 `selectedHostId = 'local'`，`platforms` 用内置降级表、`platformsLoaded = false`。
2. `App.tsx` 挂载即跑：
   - `usePlatforms()` → `GET /api/platforms`（**本机**）→ `setPlatforms` 收敛；
   - `useSessionsList()` → `GET /api/sessions`（enabled 只等 `platformsLoaded`，**不等主机就绪**）→ 按本机拉会话列表；
   - `useVersionPoller()` → `GET /api/version`（`local:true`，本机，仅做 bootId 变更检测，无碍）；
   - `App` 的 hosts effect → `GET /api/hosts`（local）。
3. hosts 到位后，若 localStorage 记忆的 `rememberedHostId` 是远端 → `connectHost(id)`（建 ssh 隧道 + `GET /api/version` 探测）→ 成功才 `setActiveHostId(id)` 注入 `X-Host-Id`，随后 `invalidateQueries(['platforms'])` 以远端头**重拉平台/会话/设置**。
4. 结果：
   - **闪烁**：先展示一帧本机会话列表（或本机空态/错误态），再整块切换为远端数据。
   - **白拉**：本机 `/api/sessions`、`/api/settings`（Kanban 的 kanbanCfg）等数据面请求在连接成功前已发出，随后被远端结果覆盖，纯浪费。
   - 本机空态/错误态可能误导（如远端有数据但首帧显示「没有找到任何会话日志」）。

## 2. 目标（用户已确认三项取舍）

1. **先连后加载**：首帧若记忆的是远端主机，先进入「连接中」占位，只走本地网关（hosts/平台校验等 local 端点），隧道与探测完成后才渲染数据面（平台/会话/设置全部按远端）。本机主机（`rememberedHostId = 'local'`）无感，行为与现状一致。
2. **门控全部数据面**：sessions 列表/详情/SSE、insights、prompts、kanban、settings 等所有带 `X-Host-Id` 的请求，统一等「主机就绪」后再发。
3. **超时/失败回落本机**：连接超时（沿用探测 5s×3 语义，另加前端兜底）或失败后自动回落本机数据并 toast 提示，页面不永久卡在「连接中」。

## 3. 主机就绪状态机（store 层）

`AppState` 新增（`frontend/src/store.ts`）：

```ts
/** 当前主机数据面是否就绪（local 恒 true；远端=隧道连接+探测成功）。 */
hostReady: boolean;
/** 主机就绪失败/回落的文案（有值=失败已回落本机）。 */
hostReadyError: string | null;
/** 主机是否处于连接中（用于首帧占位与顶栏徽标）。 */
hostConnecting: boolean;
```

- **local**：初始即 `hostReady = true`（直连本进程，无需任何异步探测——现有 `connectHost('local')` 恒 `{ok:true}`，可跳过）。
- **远端**：
  - 进入（`App` 恢复流程 / `HostSelector` 切换 / `setSelectedHostId`）→ `hostConnecting = true`、`hostReady = false`。
  - `connectHost` 成功 → `hostReady = true`、`hostConnecting = false`、`hostReadyError = null`。
  - 失败 → 停留在原主机（现有语义：`setSelectedHostId` 返回 false 不提交）→ `hostConnecting = false`；若原主机是 local 则 `hostReady = true`（回落本机数据）且 `hostReadyError = 文案`（toast）。
  - **超时兜底**：`App` 恢复远端时，若连接超过前端超时（默认沿用后端探测预算：5s×3≈15s，前端取 15s，加个 `HOST_CONNECT_TIMEOUT_MS` 常量），强制回落本机并置 `hostReadyError`。

## 4. 门控接线

### 4.1 统一守卫源：`useHostGate()`

新增 `frontend/src/hooks/useHostGate.ts`：

```ts
/** 数据面是否可发：当前主机已就绪（local 恒 true；远端=连接成功）。 */
export function useHostGate(): boolean {
  return useAppStore((s) => s.hostReady);
}
```

所有数据面查询在现有 `enabled` 上追加 `hostReady`。逐点清单（文件:行号）：

| 调用点 | 文件 | 现有 enabled | 追加 |
| --- | --- | --- | --- |
| `usePlatforms` | `queries.ts:25` | `!DEMO` | 改为 `!DEMO && hostReady` |
| `useSessionsList` | `queries.ts:98` | `platformsLoaded` | `platformsLoaded && hostReady` |
| `useSessionDetail` | `queries.ts:126` / `sessionDetailOptions:116` | `!!sessionId` | `!!sessionId && hostReady` |
| `usePlatformProbe` | `hooks/usePlatformProbe.ts:28` | `platformIds.length > 0` | 追加 `&& hostReady` |
| `GlobalInsights` | `views/insights/GlobalInsights.tsx:69` | 无 | 加 `enabled: hostReady` |
| `SessionInsights` | `views/insights/SessionInsights.tsx:35` | `!!selectedSessionId` | 追加 `&& hostReady` |
| `PromptsView`（promptsQuery） | `views/prompts/PromptsView.tsx:61` | 无 | 加 `enabled: hostReady` |
| `PromptsView`（hiddenQuery） | `views/prompts/PromptsView.tsx:65` | 无 | 加 `enabled: hostReady` |
| `KanbanView`（kanbanCfg） | `views/kanban/KanbanView.tsx:114` | 无 | 加 `enabled: hostReady` |
| `SessionFiltersDialog`（getAgents） | `components/SessionFiltersDialog.tsx:236` | 无（弹窗开才挂载） | 加 `enabled: hostReady` |
| `SessionSummary`（getResumeCommand） | `views/sessions/SessionSummary.tsx:130` | `supported` | 追加 `&& hostReady` |
| `childAgents.ts`（3 处） | `views/trace/childAgents.ts:28/43/56` | 各自条件 | 各追加 `&& hostReady` |
| `useSessionSse`（SSE） | `views/sessions/useSessionSse.ts:30` | `!DEMO && autoRefresh && !!sessionId && !viewingChildAgent` | 追加 `&& hostReady` |
| `CmdkDialog`（fetchQuery） | `views/sessions/CmdkDialog.tsx:148/155` | 手动触发 | 触发前守卫 hostReady（非首帧，可选） |

**不在门控内**（本地资源 / 非数据面，保持现状）：
- `getHosts`（`HostsTab` / `App`）——`local:true`，主机管理必需，首帧即发。
- `getVersion`（`useVersionPoller`）——`local:true`，仅 bootId 检测。
- `getToolsAudit`、`getPromptAnalysis(cached)`——裸 `fetch` 不带 `X-Host-Id`（本地分析网关资源）。
- `hosts` CRUD、`connectHost`/`testHost`——本地网关端点。

> 说明：`usePlatforms` 也加 `hostReady` 守卫，是为了**远端首帧不先按本机平台表渲染一帧**；同时平台列表是「数据面」且当前主机就绪才应拉（本机直连时 `hostReady` 初始即 true，行为不变）。

### 4.2 client.ts：非阻塞「主机就绪」判定（供裸 fetch / SSE）

`client.ts` 维护 `hostReady` 的同步镜像（不引 store 避免环）：

```ts
let hostReady = true;            // local 初始即就绪
export function setHostReady(v: boolean) { hostReady = v; }
export function getHostReady(): boolean { return hostReady; }
```

- `fetchJson`：`init.local === true` 的本地端点不检查；其余数据面请求**不发**，直接抛 `HostNotReadyError`（或 resolve 占位）——但实际大部分请求已被 useQuery 的 `enabled` 挡住，此处是**兜底**（如 CmdkDialog 手动 fetchQuery、mutation）。
- `useSessionSse`：`enabled` 追加 `getHostReady()`（SSE 无法用 hook 订阅，用同步镜像即可；就绪后再建 EventSource）。
- `App` / `store.setSelectedHostId` 在就绪状态变化时同步 `setHostReady`。

### 4.3 App.tsx：先连后加载 + 连接占位

重构启动顺序（对应 `App.tsx:55-100` 三个 effect）：

1. **hosts 首帧**（现有 effect 保留）：`getHosts` → `setHosts`。local 端点，立即发。
2. **远端恢复**（现有 effect 改造）：`hosts` 落位且记忆远端时：
   - `store` 先置 `hostConnecting = true`、`hostReady = false`；
   - 调 `connectHost(id)`（带前端超时 `HOST_CONNECT_TIMEOUT_MS`，默认 15000）；
   - 成功 → `setSelectedHostId` 提交（复用现有逻辑：setActiveHostId + invalidate platforms 等）→ `hostReady = true`；
   - 失败/超时 → 停留本机（`selectedHostId` 保持 `'local'`）→ `hostReady = true`（本机数据）、`hostReadyError` 置文案并 `toast.error`；`didRestoreHost` 置位防重试循环。
3. **远端 ui 应用**（现有 effect 保留）：`platformsLoaded` 且远端时 `getSettings`（跟随远端头）→ `applyRemoteSelection`。就绪后自然触发。

渲染层（`App.tsx` 顶部）：

```tsx
// 首帧记忆远端且尚未就绪 → 连接占位（不渲染数据面）
if (!hostReady && hostConnecting && rememberedHostId !== 'local') {
  return <HostConnectingView hostLabel={...} />;  // 轻量占位：主机名 + 状态徽标 + 「连接中…」
}
if (!hostReady && hostReadyError) {
  // 失败已回落本机：正常渲染数据面，顶栏/占位 toast 提示已回本机
}
```

- **本机无感**：`hostReady` 初始 `true`，占位分支永不命中。
- **占位组件**：新增 `frontend/src/components/HostConnectingView.tsx`（极简，不引任何数据面 hook；仅主机名 + `HOST_STATUS_DOT` 徽标 + 文案）。

### 4.4 顶栏徽标联动

`HostSelector.tsx:41` 当前读 `hostStatus[selectedHostId]`。`setSelectedHostId` 已维护 `connecting/connected`，占位期显示「连接中」。首帧占位时不渲染 `HostSelector`（由 `HostConnectingView` 承担），就绪后恢复。

## 5. 边界与兼容

- **不改变切换语义**：`HostSelector` 切换、`setSelectedHostId` 的「失败停留原主机」逻辑保持；仅新增就绪状态同步。
- **不改变本机路径**：本机主机所有查询立即就绪，行为与现状一致。
- **不碰后端**：纯前端改动；隧道/探测/透传边界（`lib/hosts.js` / `transport.js` / `proxy.js`）零改动。
- **query 缓存失效**：`invalidateQueries(['platforms'])` 已存在于恢复流程（`App.tsx:74`）；就绪后各 useQuery 因 `enabled` 由 false→true 自动触发，无需额外 invalidate。
- **DEMO 模式**：`DEMO` 下无真实后端，`hostReady` 恒 `true`（初始值），门控不生效。

## 6. 验证

1. `frontend npm run build` 通过（类型 + 构建）。
2. 手动：本机主机 → 首帧直接渲染数据面，无占位、无闪烁（与现状一致）。
3. 手动：配置一个远端主机并切换 → 刷新 → 先见「连接中」占位（无本机空态闪烁），连接成功后直接以远端数据渲染；`Network` 面板确认连接成功前**未发出** `/api/sessions`、`/api/settings` 等本机数据面请求。
4. 手动：远端不可达（hosts.json 指向错误端口）→ 约超时后回落本机 + toast 提示，不卡死。
5. `npm test` 回归（前端无单测覆盖此路径，至少确认服务端 642/642 不受影响）。

## 7. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/store.ts` | `AppState` 加 `hostReady`/`hostConnecting`/`hostReadyError` + setter；`setSelectedHostId` 同步就绪状态；初始 local 就绪 |
| 新增 `frontend/src/hooks/useHostGate.ts` | `useHostGate()` 读 `hostReady` |
| `frontend/src/api/client.ts` | `hostReady` 同步镜像 + `setHostReady`/`getHostReady`；`fetchJson` 数据面兜底守卫（可抛 `HostNotReadyError`） |
| `frontend/src/App.tsx` | 启动顺序改造：先 hosts → 再连接远端 → 就绪后渲染；连接占位分支；超时回落；toast |
| 新增 `frontend/src/components/HostConnectingView.tsx` | 连接占位组件 |
| `frontend/src/views/sessions/queries.ts` | `usePlatforms`/`useSessionsList`/`useSessionDetail` 追加 `hostReady` 守卫 |
| `frontend/src/hooks/usePlatformProbe.ts` | 追加 `hostReady` |
| `frontend/src/views/insights/GlobalInsights.tsx` | 加 `enabled: hostReady` |
| `frontend/src/views/insights/SessionInsights.tsx` | 追加 `hostReady` |
| `frontend/src/views/prompts/PromptsView.tsx` | promptsQuery/hiddenQuery 加 `enabled: hostReady` |
| `frontend/src/views/kanban/KanbanView.tsx` | kanbanCfg 加 `enabled: hostReady` |
| `frontend/src/components/SessionFiltersDialog.tsx` | getAgents 追加 `hostReady` |
| `frontend/src/views/sessions/SessionSummary.tsx` | resume 查询追加 `hostReady` |
| `frontend/src/views/trace/childAgents.ts` | 3 处追加 `hostReady` |
| `frontend/src/views/sessions/useSessionSse.ts` | enabled 追加 `getHostReady()` |
| `docs/.local/README.md` | 登记本文档索引 |

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（文档内「待评审」为历史状态）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| `hostReady` 门控 | ✅ 已实现 | `frontend/src/hooks/useHostGate.ts`、`frontend/src/App.tsx` |
| 恢复记忆主机的就绪状态机 + 超时回落 | ✅ 已实现 | `frontend/src/store.ts`、`frontend/src/App.tsx` |
| `exportUrl` 补 `?host=` | ✅ 已实现 | `frontend/src/api/client.ts` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
