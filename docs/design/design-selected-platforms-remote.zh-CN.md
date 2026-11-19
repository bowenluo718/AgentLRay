# 远端已选平台失效修复：专用接口 + settings 本机化 + 列表配置驱动（design-selected-platforms-remote）

> 多主机（[design-multi-host.zh-CN.md](design-multi-host.zh-CN.md) / [plan-multi-host.zh-CN.md](plan-multi-host.zh-CN.md)）P0 已合入主干（`d005166`）。本设计解决 P0 遗留的**远端已选平台失效 bug**：连接远端主机时前端取已选平台走 `GET /api/settings`，被网关写设置面黑名单（`WRITE_SETTINGS_BLOCKED`）连同 GET 一起 403，`applyRemoteSelection` 从未执行、远端已选平台不生效。
> 状态：设计稿（待评审）。

## 1. 问题现状

连接远端主机（ssh 隧道）时，前端取「已选平台」的链路：

1. `store.setSelectedHostId(remoteId)` 成功 → `hostReady=true`、`activeHostId=remoteId`。
2. `App.tsx:112-131` effect 触发（`platformsLoaded && selectedHostId !== 'local'`）→ `getSettings()` → `fetchJson('/api/settings')` → 注入 `X-Host-Id: remoteId`（client.ts:85-87）。
3. 网关 `lib/routes/proxy.js:74-92`：`hostId !== 'local'` → `isBlockedWrite('/api/settings')` **恒真**（黑名单精确匹配，不区分方法）→ 直接 `403`。
4. `fetchJson` 非 2xx 抛错 → `App.tsx:125` `.catch()` 静默吞掉 → `applyRemoteSelection` 未执行 → `selectedPlatforms` 停在默认「全部平台」（或上次本机值），远端已选平台失效。

**根因**：`proxy.js` 的 `WRITE_SETTINGS_BLOCKED` 把 `/api/settings` 无条件拦（proxy.js:10-14），只按路径判断、不区分 GET/PUT，导致只读 GET 也被 403。

## 2. 目标（用户已确认决策）

| # | 需求 | 决策 |
| --- | --- | --- |
| 1 | 新增专用只读接口返回 `selectedPlatforms`，远程连接不拦截 | 新接口 `GET /api/ui-selection`，只返回 `{ selectedPlatforms }`，不含 platform；远端透传取远端真源 |
| 2 | `/api/settings` 不代理到远端，直接获取本机配置 | 后端网关拦截：GET/PUT `/api/settings` 对远端请求一律 `next()` 走本地路由读/写**本机**配置；前端已选平台不再从 settings 取 |
| 3 | 前端不再传 `platform` 参数，由后台从配置读取，无配置默认全部 | 聚合列表 `GET /api/sessions` 不传 platform，后端从 `selectedPlatforms` 读取，空 → 全部。**不动** `ui.platform` 默认平台单选逻辑与设置面板 |
| 4 | 保留 `applyRemoteSelection`（远端只读真源） | 改从新专用接口取数，不再从 `getSettings()` |
| 5 | 会话列表取数方式 | **列表恒走聚合接口**（移除 `useSessionsList` 单平台分支；详情仍走 `/api/:platform/sessions/:id` 单平台路径） |

## 3. 后端设计

### 3.1 新专用只读接口 `GET /api/ui-selection`

`lib/routes/settings.js`（与 ui section 读写同模块，风格一致）：

```js
app.get('/api/ui-selection', async (_req, res) => {
  try {
    const ui = await loadUiSettings();
    const selectedPlatforms = (ui && Array.isArray(ui.selectedPlatforms) ? ui.selectedPlatforms : [])
      .filter((id) => isMounted(id));
    res.json({ selectedPlatforms });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
```

- 返回形状 `{ selectedPlatforms: string[] }`，**不含 platform**（平台默认逻辑由设置面板独占，不走此接口）。
- 过滤 `isMounted`（未挂载平台剔除），与 `applyRemoteSelection` 的运行时收敛一致。
- **透传保证**：`/api/ui-selection` 不在 `WRITE_SETTINGS_BLOCKED`（proxy.js:10-14）、不命中 `WRITE_RESOURCE_RE`，远端请求（带 `X-Host-Id`）自动走 `proxyTo()` 透传到远端同路径。**proxy.js 无需为此新增放行**。
- `isMounted` 需从 `../platforms` require 追加解构（settings.js:14 已 require 该模块）。

### 3.2 proxy.js：`/api/settings` 本机化

`lib/routes/proxy.js` 中间件（74-92 行），在 `isBlockedWrite` 分支（80 行）**之前**插入：

```js
// 本机设置（GET/PUT /api/settings）不随当前查看的远端透传：设置是网关本机资源
//（settings.json 在本地），远端请求一律走本地路由读/写本机配置。其余方法
//（POST/DELETE）与 /api/settings/cli-bins、/api/hosts 仍落黑名单 403。
if (req.method === 'GET' || req.method === 'PUT') {
  if (pathname === '/api/settings') return next();
}
```

- **行为**：GET/PUT `/api/settings` 远端 → `next()` → csrfGuard（PUT 校验）→ express.json parse body → 本地 settings 路由。
- **保留 403**：`/api/settings/cli-bins`（精确匹配不命中 `/api/settings`）、`/api/hosts`、POST/DELETE `/api/settings`（非 GET/PUT 不在本地化分支）。
- **挂载位置**：proxy 是第一个 `/api` 处理器（server.js:37，在 csrfGuard 51 / express.json 52 之前）。本地化分支 `next()` 不消费 body 流，PUT 的 body 由后续 express.json 正常 parse，本地 settings 路由可得完整 body。
- 更新文件头注释第 4 行「写设置面 403」边界说明。

### 3.3 后端 `GET /api/sessions` 缺省取数

`lib/session-list.js` 新增（`PLATFORMS` 已在 :12 引入；新增 `require('../ui-settings')`）：

```js
// 未传 platform 时的缺省选择：优先页面持久化 selectedPlatforms（聚合），空 → 全部平台。
// 与 CLI resolveDefaultPlatform 的 list 语义一致（读同一 settings.json ui section）。
async function defaultSelection() {
  const ui = await loadUiSettings();
  const picked = (ui && Array.isArray(ui.selectedPlatforms) ? ui.selectedPlatforms : [])
    .filter((id) => PLATFORMS[id]);
  if (picked.length === 0) return { all: true, ids: Object.keys(PLATFORMS) };
  return { all: picked.length === Object.keys(PLATFORMS).length, ids: picked };
}
```

`lib/routes/sessions.js:76`：

```js
const selection = req.query.platform
  ? parsePlatformSelection(req.query.platform)
  : await defaultSelection();
```

- 显式 `platform=` 走原 `parsePlatformSelection`（校验/报错路径保留，零回归）。
- 缺省时读配置，空 → `{ all: true, ids: all }`（等价 `platform=all`，非 `defaultPlatformId` 单平台）。
- **不动** `ui.platform` 单选与设置面板逻辑。移除 sessions.js:7 的 `defaultPlatformId` 引用（settings.js `platforms.default` 镜像仍用它，保留该文件 import）。

## 4. 前端设计

### 4.1 client.ts

新增：

```ts
/** GET /api/ui-selection — 远端只读真源：当前主机（本机/远端）已选平台集合。
 *  远端下经 X-Host-Id 头透传取远端配置；不再从 /api/settings 取（settings 已本机化）。 */
export interface UiSelection { selectedPlatforms: Platform[]; }
export function getSelectedPlatforms(): Promise<UiSelection> {
  return fetchJson('/api/ui-selection');
}
```

`getSessionsAll` 去掉 `platforms` 参数与 `platform` query（后端配置驱动）：

```ts
export function getSessionsAll(opts: {
  agent?: string; status?: string; match?: string; limit?: number; offset?: number;
} = {}): Promise<SessionsListResponse> {
  const params: Record<string, ParamValue> = {
    agent: opts.agent || undefined, status: opts.status, match: opts.match,
    limit: opts.limit, offset: opts.offset,
  };
  return fetchJson<SessionsListResponse>(withParams('/api/sessions', params));
}
```

### 4.2 App.tsx 远端 effect

- import：`getSettings` → `getSelectedPlatforms`。
- effect（112-131 行）改调：

```ts
getSelectedPlatforms()
  .then((sel) => {
    if (cancelled) return;
    applyRemoteSelection({
      platform: 'openclaw', // 与远端 server ui 缺省对齐；applyRemoteSelection 收敛到有效平台
      selectedPlatforms: sel?.selectedPlatforms ?? [],
    });
  })
  .catch(() => { /* 远端 ui 读取失败：保持当前选择，不阻断 */ });
```

- `SettingsDialog.tsx:111` 的 `getSettings()`（本机设置面板全量读写）**保持不动**——需求只针对远端 effect 取数路径。

### 4.3 queries.ts

`sessionsAllListOptions` 无参（不再传 platformIds）：

```ts
export function sessionsAllListOptions() {
  return {
    // 后端配置驱动：GET /api/sessions 无 platform → 读配置 selectedPlatforms（空 → 全部）。
    queryKey: ['sessions', 'multi', 'config'] as const,
    queryFn: async (): Promise<SessionSummary[]> => {
      const result = await getSessionsAll();
      const flat: SessionSummary[] = [];
      for (const block of result.platforms)
        for (const session of block.sessions)
          flat.push({ ...session, platform: block.platform, agent: block.agent ?? undefined });
      return flat;
    },
  };
}
```

`useSessionsList`（85-104）：移除聚合/单平台二分支，恒走 `sessionsAllListOptions()`。`platform`/`selectedPlatforms`/`selectableCount` 订阅不再用于列表取数（store 状态保留供侧栏 UI 与详情聚焦）。`sessionsListOptions`（单平台）保留供 `sessionDetailOptions`/CmdkDialog 等详情路径使用。

### 4.4 demo/router.ts

新增夹具：

```ts
if (parsed.pathname === '/api/ui-selection') return ok({ selectedPlatforms: [] });
```

## 5. 闭环自洽性

- **本机**：侧栏多选 `togglePlatform`/`selectAllPlatforms` → `persistState()`（store.ts:415 有 `selectedHostId === 'local'` 守卫）→ `saveUiSettings({ selectedPlatforms })` PUT 落盘 → 后端 `GET /api/sessions` 每次从配置读（5s 轮询自动反映）。
- **本机单平台**：`setPlatform`/`togglePlatform` 退回单平台时 `selectedPlatforms` 落服务端为 **`[platform]`（单元素）而非空数组**（store.ts `setPlatform` 注释）。原因：列表恒走聚合接口 `GET /api/sessions`、后端 `defaultSelection` 对**空** `selectedPlatforms` 回退 `all`（全部平台）——若落空数组，单平台会话会与其余平台混列、与侧栏单选不一致。`[platform]` 使后端读到单元素子集、列表只返回该平台，与侧栏单选一致。（注：侧栏单选原本以 `selectedPlatforms.length === 0` 表达 `multiView=false`，现为 `[platform]` 非空即多选视图；语义统一为「列表恒=服务端 selectedPlatforms 配置」，侧栏勾选态与列表内容一致。）
- **远端**：`filtersReadOnly` 为 true → 多选不可改，不污染本机配置；`GET /api/sessions` 透传远端（读**远端**配置）；`GET /api/ui-selection` 透传远端 → `applyRemoteSelection` 取远端真源。**本机视图用本机配置、远端视图用远端配置，自洽。注意：远端列表数据由远端实例自身的 `ui.selectedPlatforms` 决定，用户在本机配置的选择不会作用于远端数据面——若需改变远端视角，应在远端实例自身配置。**

## 6. CLI 连带

`bin/sessions.js` `resolveDefaultPlatform`（156-179）list 分支已读 `loadUiSettings().selectedPlatforms`（空 → platform → all），与后端 `defaultSelection()` 语义一致。**无需改动。**

## 7. 测试连带

### 修改 test/proxy.test.js
- 154-168「PUT /api/settings 远端 → 403」→ 改为断言 **200** 且 body 为本地 mock（makeApp 已有 `app.put('/api/settings')` → `{ ok: 'local-settings' }`，proxytest.js:64）。
- 新增：GET /api/settings 远端 → 200 本地 mock（`{ where: 'settings' }`）。
- 新增：GET /api/ui-selection 远端 → 透传 mock（mock 远端 createServer 30-46 行加分支返回 `{ selectedPlatforms: ['codex'] }`）。
- 新增：GET /api/settings/cli-bins 远端 → 仍 403（锁定现状）。

### 新增 test/api.test.js
- GET /api/ui-selection 默认 `{ selectedPlatforms: [] }`。
- PUT `ui.selectedPlatforms=['omp','codex']` 后 GET /api/ui-selection 返回同值。
- GET /api/sessions（无 platform）缺省：无配置 → `all: true`、platformIds 为全部已挂载平台；PUT `ui.selectedPlatforms=['omp','codex']` 后 → `platformIds: ['omp','codex']`、`all: false`。

### 不变（回归保护）
- 显式 `platform=` 参数路径（api.test.js:357-403）、`test/settings.test.js`、`test/session-cli.test.js` 不触碰。

## 8. 风险

- **queryKey 变更**：`['sessions','multi','config']` 使 refetch 不再随 selectedPlatforms 变化触发（改由 5s 轮询 + 后端配置驱动）。CmdkDialog 用 `sessionsListOptions`（单平台）不受影响。
- **SSE 即时刷新（评审修复）**：`useSessionSse` 的推送分支对聚合 key（`['sessions','multi']`）增加 `setQueriesData`（状态合并）+ `invalidateQueries`（新消息触发重拉），恢复「列表即时反映状态/新消息、不依赖 5s 轮询」。单平台 key（`['sessions', platform]`）原有逻辑保留，双写不冲突。
- **csrf**：远端 PUT /api/settings 本地化后仍走 csrf(51)，与本地路径一致，无绕过。
- **POST/DELETE /api/settings**：不在本地化分支 → 仍 403（防御非规范客户端）。

## 9. 验证

1. 后端：`npm test`（重点 proxy、api）。
2. 前端：`cd frontend && npm run build`（TS 类型检查 + 打包）。
3. 手动冒烟（`npm run build:ui` 后）：连远端确认远端已选平台即时生效（原 bug 场景）；回归本机多选 → 刷新后仍按多选。
4. 确认显式 `platform=` 参数路径无回归。
5. （评审修复）回归本机**单平台**：侧栏点单选 → 列表只显示该平台会话；刷新后保持单平台；SSE 新消息/状态变化列表即时反映（不落后 5s）。

## 10. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `lib/routes/settings.js` | 新增 `GET /api/ui-selection`；追加解构 `isMounted` |
| `lib/routes/proxy.js` | GET/PUT `/api/settings` 远端 → `next()` 本地化分支；更新头注释 |
| `lib/session-list.js` | 新增并导出 `defaultSelection()`（读 ui selectedPlatforms，空→all） |
| `lib/routes/sessions.js` | `:76` 缺省改用 `defaultSelection()`；移除 `defaultPlatformId` 引用 |
| `frontend/src/api/client.ts` | 新增 `getSelectedPlatforms()`；`getSessionsAll` 去掉 `platforms` 参数 |
| `frontend/src/App.tsx` | 远端 effect 改调 `getSelectedPlatforms()` 而非 `getSettings()` |
| `frontend/src/views/sessions/queries.ts` | `sessionsAllListOptions` 无参；`useSessionsList` 恒聚合；queryKey 调整 |
| `frontend/src/store.ts`（评审修复） | `setPlatform`/`togglePlatform` 单平台时 `selectedPlatforms` 落 `[platform]` 而非 `[]`（后端配置驱动下列表才与单选一致） |
| `frontend/src/views/sessions/useSessionSse.ts`（评审修复） | 推送分支增加对聚合 key `['sessions','multi']` 的 `setQueriesData` + `invalidateQueries`（恢复列表即时刷新） |
| `frontend/src/demo/router.ts` | 新增 `/api/ui-selection` 夹具 |
| `test/proxy.test.js` | 改 154-168 为本地化断言；新增 settings 本机化 / ui-selection 透传用例 |
| `test/api.test.js` | 新增 ui-selection + `/api/sessions` 缺省取数用例 |
| `docs/design/README.md` | 登记本文档索引 |

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（文档内「待评审」为历史状态）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 专用只读 `GET /api/ui-selection` | ✅ 已实现 | `lib/routes/settings.js:89` |
| settings GET/PUT 对远端本机化 | ✅ 已实现 | `lib/routes/proxy.js`、`lib/routes/settings.js` |
| 聚合列表配置驱动 selectedPlatforms | ✅ 已实现 | `lib/routes/sessions.js`、`frontend/src/App.tsx` |

