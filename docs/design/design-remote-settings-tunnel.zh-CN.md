# 远端设置/筛选/平台透传 + 主机本地化（design-remote-settings-tunnel）

> grill 定稿并实施：多主机（[design-multi-host.zh-CN.md](design-multi-host.zh-CN.md)）代理边界的一次调整——把「设置写面 403」收窄为「仅本地网关资源 403」，让远程连接时可修改远端系统设置、会话筛选/分组、选择远端平台；主机查看/连接仍走本地不透传。
> 状态：已实施并验证（`npm test` 678/678、`frontend npm run build` 通过）。

## 1. 背景与目标

多主机 P0 阶段（`design-multi-host`）的透传边界是「**数据面全透传；写设置面 403**」：远端请求 `GET/PUT /api/settings` 被网关**本机化**（`next()` 走本地路由读/写本机配置），`cli-bins`、`platforms mount|replace` 一律 403；前端远端下 `filtersReadOnly=true`，平台选择只读不可改。

用户确认调整为四条需求：

| # | 需求 | 决策 |
| --- | --- | --- |
| 1 | 允许远程连接时修改系统设置，从远程获取，报错到远程去 | `/api/settings`、`/api/settings/cli-bins`、`/api/platforms/:id/(mount|replace)` **透传远端**——设置是远端主机自身资源，读写/报错都落远端 |
| 2 | 会话筛选与分组的数据，及支持选择远程的平台 | 移除 `filtersReadOnly` 只读；远端可改平台选择；**仅 `selectedPlatforms` 写回远端 server**（`groupBy`/`projectFilter`/`collapsedGroups` 仍 localStorage 按主机区分） |
| 3 | `/api/sessions` 远程透传 | **现状已满足**（GET 数据面 + `X-Host-Id` 注入），仅回归测试锁定 |
| 4 | 主机查看/设置/连接仍用本地，不进行非必要的透传 | `/api/hosts`、`/api/inbound` **保持 403 本机化**（本地网关资源），现状已满足 |

## 2. 透传边界收窄后的 proxy

`lib/routes/proxy.js` 透传边界从「写设置面 403」收窄为「**仅本地网关资源 403**」：

- `WRITE_SETTINGS_BLOCKED` 只剩 `/api/hosts`；`WRITE_RESOURCE_RE` 只剩 `/api/hosts(\/|$)` 与 `/api/inbound(\/|$)`。
- 删除 `/api/settings` 本机化分支（原 `if (GET|PUT /api/settings) return next()`）。
- 删除 `CONSENTED_WRITES` / `isConsentedWrite` 审计机制：原为区分「合意写透传 vs 写设置面 403」；边界收窄后 `resume/create`、`prompts analyze/rewrite` 本就随默认透传，登记失去意义，随死代码删除。
- 403 文案改为「主机/入站连接管理是本地网关资源，不透传，请在本机操作」。
- 头注释更新：设置面（settings / cli-bins / platforms mount|replace）随远端透传；仅 hosts/inbound 本地化。

### csrf 安全性（已查明，非新增代码）

`proxyTo` 转发保留原始 `headers`（含 `Host` 与 `Origin`，只删 `x-host-id`）；且 `server.js` 中 proxy 挂载在 csrfGuard **之前**、透传经 `req.pipe` 不消费 body、不经本地 csrf。透传后远端收到的 `Host==Origin` 匹配 → 远端 csrf 校验放行。两端安全，无需额外处理。

## 3. 前端：远端筛选/分组可写

### 3.1 store.ts

- **删除 `filtersReadOnly`**：字段、初始值、`setSelectedHostId` 里的 `filtersReadOnly: isRemote`、三个平台 action（`setPlatform`/`togglePlatform`/`selectAllPlatforms`）的 `if (get().filtersReadOnly) return` 守卫全部移除。
- **`persistState` 拆出服务端同步为 `syncSelectedPlatforms`**：`persistState` 现在**只做 localStorage**（按当前主机键），不再内嵌 `saveUiSettings`——避免非平台 UI 状态（groupBy/theme 等）在远端下触发 PUT 写远端。服务端 `selectedPlatforms` 同步收敛到 `syncSelectedPlatforms`（见 §3.1 末条），仅用户操作触发。
- **`setPlatforms` 收敛仅本机 localStorage、不写服务端**：`setPlatforms` 收敛（平台列表加载导致选择被动对齐）在**本机**且 changed 时只 `persistState()`（localStorage），**不调 `syncSelectedPlatforms`**——服务端 `ui.selectedPlatforms`（后端聚合列表 `defaultSelection` 缺省真源）**仅由用户操作同步**（见本节约 `syncSelectedPlatforms` 条）。收敛属被动对齐，不自动写服务端，避免平台列表加载触发 PUT 的复杂性与潜在覆盖。收敛不置 `remoteDirty`（不阻挡后续 `applyRemoteSelection` 远端初始化）。
- **新增 `remoteDirty` 竞态守卫**：切到远端时置 `false`；用户自主改动平台选择（三个 action 的 `set`）置 `true`；`applyRemoteSelection` 开头 `if (get().remoteDirty) return`——避免「切换远端瞬间拉取 `GET /api/ui-selection` 初始化」返回晚于用户即时操作而覆盖用户选择。
- **`saveUiSettings` 拆出为 `syncSelectedPlatforms`（仅用户操作同步服务端）**：`persistState` 只做 localStorage（非平台 UI 状态 groupBy/theme 等不再误写服务端）；`syncSelectedPlatforms` 仅在三个平台 action（`setPlatform`/`togglePlatform`/`selectAllPlatforms`）调用，按当前主机透传写 `selectedPlatforms`。**`setPlatforms` 收敛不调它**（见上）——取舍：自定义平台 + 全选扩展场景下列表真源会在收敛后短暂与页面不一致，待用户下次操作同步（可接受）。

### 3.2 App.tsx

远端 effect（`getSelectedPlatforms` → `applyRemoteSelection`）保留作初始化，注释更新为「远端可写 + 竞态守卫」。

### 3.3 SessionFiltersDialog.tsx / SettingsDialog.tsx

- 平台筛选只读提示条（`filtersReadOnly` 琥珀条 + `disabled`）改为：远端下显示「正在编辑远端 \<host\> 的平台选择，改动会写回该远端主机的配置」，按钮不再禁用。
- 设置面板 `DialogTitle` 下，远端下显示「正在编辑远端 \<host\> 的设置，保存会写回该远端主机的配置」。

## 4. 测试连带

`test/proxy.test.js`：
- 删除 P1 审计登记测试（`isConsentedWrite`）。
- 「PUT/GET `/api/settings` 远端 → 本地化」改为「→ 透传远端真源」。
- 「`cli-bins` 远端 → 403」改为「→ 透传远端真源」。
- 「`platforms/:id/mount` 远端 → 403」改为「→ 透传远端真源」。
- mock 远端补 `/api/settings`、`/api/settings/cli-bins`、`/api/platforms/:id/mount` 透传分支。
- hosts/inbound 403（本地网关资源）保留锁定；`/api/sessions`、`/api/ui-selection` 透传用例保留。

## 5. 验证

1. `node --test test/proxy.test.js` 16/16 通过（透传 + 本地化边界）。
2. `npm test` 678/678 通过。
3. `frontend npm run build`（tsc -b + vite）通过。

## 6. 改动文件清单

| 文件 | 改动 |
| --- | --- |
| `lib/routes/proxy.js` | 黑名单收窄（仅 hosts/inbound）；删 settings 本机化分支、`CONSENTED_WRITES`/`isConsentedWrite`；更新注释/403 文案 |
| `test/proxy.test.js` | 删 P1 审计测试；settings/cli-bins/mount 改透传断言；mock 加透传分支；hosts/inbound 403 保留 |
| `frontend/src/store.ts` | 删 `filtersReadOnly`（字段/守卫）；`persistState` 无条件 `saveUiSettings`；`setPlatforms` 收敛写回无条件；新增 `remoteDirty` 竞态守卫 + 三个平台 action 置位 |
| `frontend/src/App.tsx` | 远端 effect 注释更新（可写 + 守卫） |
| `frontend/src/components/SessionFiltersDialog.tsx` | 平台筛选只读提示条改「编辑远端」；去 `disabled` |
| `frontend/src/components/SettingsDialog.tsx` | 标题下加「编辑远端」提示条 |
## 7. 修复：`setPlatforms` 无条件写回覆盖远端真源（2026-11-16）

### 现象

连接远程主机 → 切换当前选择平台 → **立即刷新页面** → 触发 `PUT /api/settings`，真实选中主机（远端）的 `selectedPlatforms` 被覆盖，用户刚切换的选中值未生效。调用链：`usePlatforms.queryFn → setPlatforms → persistState → saveUiSettings (PUT /api/settings)`。

### 根因

初版把 `setPlatforms` 的收敛写回从「仅本机」改为**无条件**（`if (changed) persistState()`），且 `persistState` 内 `saveUiSettings` 无条件。刷新时序：

1. `loadPersisted()` 从**本机键** localStorage 恢复 `selectedPlatforms`（刷新首帧主机为 local）。
2. App 重连远端 → `selectedHostId=远端`、`hostReady=true`。
3. `usePlatforms` 查询 `GET /api/platforms`（X-Host-Id=远端）→ `setPlatforms(infos)` 收敛。
4. 收敛时 `state.platforms` 还是 `FALLBACK_PLATFORM_INFOS`，`beforeCount=内置平台数`；恢复的本机键 `selectedPlatforms` 与真实 `infos` 比对常触发 `wasAll`/`changed`。
5. `changed=true` → `persistState()` → `saveUiSettings`（X-Host-Id=**远端**）→ 把**本机恢复/收敛后的值**写回远端 server，覆盖用户刚切换的真实选中数据。

### 修复

- **`setPlatforms` 收敛仅本机 localStorage、不写服务端**：`setPlatforms` 收敛（平台列表加载触发的被动对齐）在**本机**且 changed 时只 `persistState()`（localStorage），**不调 `syncSelectedPlatforms`**——远端下收敛不写回服务端，避免用本机恢复值覆盖远端真源；本机下收敛也不写服务端（服务端同步仅用户操作负责）。收敛不置 `remoteDirty`。
- **`saveUiSettings` 从 `persistState` 拆出为 `syncSelectedPlatforms`（仅用户操作同步服务端）**：`persistState` 只做 localStorage（非平台 UI 状态 groupBy/theme 等不再误写服务端）；`syncSelectedPlatforms` 仅在三个平台 action（`setPlatform`/`togglePlatform`/`selectAllPlatforms`）调用，按当前主机透传写 `selectedPlatforms`。这同时消除「远端下任一非平台状态变更触发 PUT /api/settings 用本机恢复值覆盖远端」的隐患。

### 行为不变项

- 远端下用户**操作**平台选择仍写回远端（需求 2 保留）。
- 本机下平台列表收敛只写 localStorage；服务端 `selectedPlatforms` 同步仅由用户操作触发（取舍：自定义平台 + 全选扩展场景下列表真源会在收敛后短暂与页面不一致，待用户下次操作同步）。
- `/api/settings` 远端透传、hosts/inbound 本机化（第 2 节）不变。
…

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实施并验证**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 设置/筛选/平台随远端透传 | ✅ 已实现 | `lib/routes/proxy.js` |
| 仅本地网关资源本机化 | ✅ 已实现 | `lib/routes/proxy.js`、`lib/routes/hosts.js` |
| `selectedPlatforms` 写回远端 | ✅ 已实现 | `frontend/src/store.ts` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
