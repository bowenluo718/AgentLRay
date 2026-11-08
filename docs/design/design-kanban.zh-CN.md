# 设计：任务看板页面（会话四态看板视图）

> 需求：新增「任务看板」页面，参考 `docs/.local/image-dsh-kanban.zh-CN.json` 的页面实现效果；让用户直观查看会话的执行状态；筛选条件与原页面共享；按四种状态分列；每列按最后更新时间默认最多显示 20 条、条数可配置。
> 状态：与用户经 grill-with-docs（grilling + domain-modeling）两轮问答达成共享理解后定稿。领域词见 `docs/.local/glossary.zh-CN.md`。

## 0. 定稿决策（共享理解）

| 维度 | 决定 |
|---|---|
| 领域映射 | 「任务看板」= 会话（`SessionSummary`）的看板式视图；参考图只取**视觉实现效果**（分列布局、列头数量徽标、空态文案"这个状态还没有任务"、顶部筛选输入框）；**不引入** deepseek 任务实体概念（无 新建/归档/结算于/执行次数/最近失败徽标） |
| 列 | 固定四列，顺序 `待用户输入 → 工作中 → 等待中 → 已停止`（`lib/status.js` `STATUS_ORDER`/`STATUS_LABELS` 单源，`/api/status-labels` 透出）；空列也展示空态文案 |
| 筛选共享 | **完全共享**侧栏筛选状态：平台多选 `selectedPlatforms` 与项目 `projectFilter`（同 store、localStorage `agent-xray-settings`）；看板**不提供任何项目/平台控件**，数据直接跟随共享筛选（用户明确否决在看板放项目/平台控件） |
| 项目语义 | 项目取值沿用 `resolveProjectValues`（cwd 末段、末段重复显完整 cwd、无 cwd → `未知项目`）；`projectFilter` 为空（= 全部项目）时显示该筛选条件下所有可选项（全部项目）的数据 |
| 看板本地控件 | 仅「筛选任务...」文本搜索（复用 `filterSessionList`：匹配 ID/文件名/首条 user message；不写回侧栏、不持久化）+ 每列「展开全部/收起」；均为看板组件内 state（切走 TABS 重置，共享筛选仍在 store 持久化） |
| 排序与截断 | 平台→项目→文本过滤后按状态分桶；列内 `lastActivity` 降序（缺失回退 `timestamp`）；每列截断 `maxPerStatus`（默认 20）；列头计数 = 当前筛选后的**完整数量**（不受截断影响）；截断时列尾「还有 N 条 · 展开全部」/ 展开后可收起 |
| 配置 | `~/.agentlray/kanban-config.json`（`maxPerStatus` 单值、默认 20、白名单校验：正整数）；`GET/PUT /api/settings/kanban`；SettingsDialog 新增「任务看板」tab（与状态时间窗口 tab 同级） |
| 入口 | 顶部 TABS 第 5 项「任务看板」（`MainView` 加 `'kanban'`，列在资产库之后） |
| 卡片 | 首条 user message（不存在则回退会话 `title`，两者皆无 →"（无消息）"）+ 最后更新时间 + 项目 + 平台徽标（聚合视图来源可见）；**不展示 title 为主文本**；点击 → 跳会话详情（复用详情上下文 `setDetailContext(platform, agent)` + `setSelectedSessionId` + `setView('sessions')`） |
| 数据/刷新 | 复用 `useSessionsList()`（同一查询缓存，5s 轮询 + SSE 状态即时合并）；状态分桶与 20 截断全客户端，**无新列表端点** |
| 后端范围 | 仅新增看板配置 GET/PUT 路由；平台列表/聚合端点、CLI、legacy 均不动 |
| demo/legacy | demo router 给 fixtures 补伪四态（轮换），保证看板可演示；legacy（`/legacy`、`public/js/app.js`）不动（React 为唯一功能面，项目约定） |

关键数据事实（据代码勘察）：
- 四态定义、顺序、中文标签在 `lib/status.js`（`STATUS_ORDER`/`STATUS_LABELS`），`GET /api/status-labels` 单源透出；前端 `views/sessions/SessionList.tsx:24-58` 有 `STATUS_FALLBACK_META`（同键配色，如 awaiting-input `text-amber-300`、working `text-emerald-300`）+ `useServerStatusLabels()` 并入服务端标签——看板列头色点/标签复用，需**抽成共享模块**避免第三处硬编码分叉。
- 聚合数据经 `useSessionsList()`（`frontend/src/views/sessions/queries.ts:85-112`）：多选 → `GET /api/sessions`（全选 `platform=all`），已展平并打 `platform`/`agent` 来源标记；共用 `['sessions', …]` 查询键，与侧栏列表同缓存、轮询与 SSE 合并一次共享。
- 项目推导已现成：`views/sessions/lib.ts` `UNKNOWN_PROJECT`（:301）、`resolveProjectValues`（:317）、`buildProjectOptions`（:346）；侧栏项目筛选用法见 `SessionList.tsx:403-412`（`projectFilter` 客户端过滤 + `filterSessionList` 文本过滤）。
- 配置存储基建：`lib/config-store.js` `createConfigStore`（白名单 JSON、load/save/`settingsResult`）；`lib/status-config.js` 是最贴近模板（`~/.agentlray/<name>.json` + GET/PUT 路由 + 前端 client 封装 + SettingsDialog tab）。
- 路由挂载：`server.js:62-74` 依次 `mount*Routes(app)`；`csrfGuard` 已挂，新 PUT 路由随既有配置路由同样受 CSRF 保护。
- 测试：`npm test` = `node --test test/*.test.js`（仅后端 node 测试，无 vitest/jest，前端纯函数不走 npm test、靠 `tsc -b` + 冒烟）；已有 `test/status-config.test.js` 作配置路由/校验测试模板。
- demo fixtures 的 `SessionSummary` **不带 `status`**（实测 status 计数为空），看板在 demo 模式需 router 补伪状态才可演示。

## 1. 后端改动（最小）

### 1.1 `lib/kanban-config.js`（新）
仿 `lib/status-config.js`，用 `createConfigStore` 建 `~/.agentlray/kanban-config.json`：

```js
const KANBAN_CONFIG_FILE = path.join(HOME, '.agentlray', 'kanban-config.json');
const KANBAN_DEFAULTS = { maxPerStatus: 20 };
// validate: Number.isInteger(value) && value > 0  （正整数，条数）
```

纯配置存储，**无**运行注入（`maxPerStatus` 仅前端消费）。

### 1.2 `lib/routes/kanban-config.js`（新）
仿 `lib/routes/status-config.js`：
- `GET /api/settings/kanban` → `settingsResult(await loadKanbanConfig(), KANBAN_DEFAULTS)`。
- `PUT /api/settings/kanban` → `saveKanbanConfig(req.body)` 白名单过滤（非法/空清除回退默认）→ 返回 `settingsResult(saved, DEFAULTS)`。不注入任何模块。

### 1.3 `server.js`
`require` + 挂 `mountKanbanConfigRoutes(app)`（紧跟 `mountStatusConfigRoutes` 之后）。

## 2. 前端改动（React，唯一功能面）

### 2.1 store / 入口
- `frontend/src/store.ts`：`MainView` 联合类型加 `'kanban'`（其余不动，看板无新增持久化状态——共享筛选已在 store）。
- `frontend/src/App.tsx`：`TABS` 追加 `{ view: 'kanban', label: '任务看板', title: '会话状态看板：按待用户输入/工作中/等待中/已停止 四列查看' }`；`<TabsContent value="kanban">` 渲染 `<KanbanView />`。

### 2.2 共享状态元抽取（防漂移）
- 新增 `frontend/src/views/sessions/statusMeta.ts`：把 `SessionList.tsx:20-62` 的 `STATUS_FALLBACK_META`、`statusMetaCache`、`statusMetaFor`、`useServerStatusLabels` 原样迁入并 `export`。
- `SessionList.tsx` 改为从 `./statusMeta` import（行为不变，纯搬移）。

### 2.3 `frontend/src/views/kanban/kanbanLib.ts`（新，纯函数）
- `buildKanbanColumns(sessions, { maxPerStatus, expanded })`：
  1. 以 `session.status ?? 'stopped'` 分桶（缺失状态防御性归入 `stopped` 列尾——真实后端必然带 status，demo 由 router 补）；
  2. 桶内按 `lastActivity`（缺失回退 `timestamp`）降序；
  3. 每桶切片：`expanded[status] ? 全量 : 前 maxPerStatus`；返回每列 `{ status, total, list }`（`total` 为截断前完整量）。
- `lastActivityMs(s)` 与 `SessionList.tsx:49-53` 的 `lastActiveMs` 同口径。

### 2.4 `frontend/src/views/kanban/KanbanView.tsx`（新）
- 数据：`useSessionsList()`（共享查询缓存 + 5s 轮询 + SSE 状态合并）；`useQuery(getKanbanConfig)` 读 `maxPerStatus`（`staleTime` 长，与 SettingsDialog 同缓存键；加载中回退默认 20）。
- 过滤管线（`useMemo`，与侧栏同配方）：`raw → projectFilter 客户端过滤 → filterSessionList(term)`；`projectValues = resolveProjectValues(raw)` 供卡片项目徽标。
- 本地 state：`term`（文本）、`expanded: Record<string, boolean>`（按状态 key 记忆展开）。
- 渲染：
  - 顶部工具条：仅「筛选任务...」搜索框（占位同参考图）。
  - 四列横向平铺（窄屏横向滚动），每列：列头 = 状态色点（`statusMetaFor` 配色）+ 中文标签 + 完整计数徽标；卡片区独立纵向滚动；空列显示"这个状态还没有任务"；截断时列尾按钮「还有 N 条 · 展开全部」/ 展开后「收起」。
  - 卡片：主文本 = 首条 user message（`firstUserMessage`），不存在则回退会话 `title`，两者皆无 → `（无消息）`（`line-clamp` 截断）+ 最后更新时间（`formatDate`）+ 项目 + 平台徽标（`s.platform`）。
  - 卡片点击 → `setDetailContext(s.platform, s.agent)` + `setSelectedSessionId(s.id)` + `setView('sessions')` + `setSessionView('messages')`（与 ⌘K 跳转同路径，详情上下文独立于筛选）。

### 2.5 配置 UI
- `frontend/src/api/client.ts`：新增 `KanbanSetting { value; configured; default }`、`KanbanConfig`、`getKanbanConfig()`、`saveKanbanConfig({ maxPerStatus })`（仿 status 段，用 `fetchJson`/`requestJson`）。
- `frontend/src/components/SettingsDialog.tsx`：新增 `KanbanConfigSection`（label + 整数输入 + hint"每列最多显示的会话条数，默认 20；正整数"），`TABS` 加「任务看板」页签（现有页签化框架内追加，不重构）。

### 2.6 demo
- `frontend/src/demo/router.ts`：demo 会话列表返回前按 fixture 顺序轮换补 `status`（`['awaiting-input','working','waiting','stopped']`），使看板与侧栏徽标在 demo 下可演示；真实后端不受影响。

## 3. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/kanban-config.js`（新） | `KANBAN_DEFAULTS`/`load`/`save`（`~/.agentlray/kanban-config.json`，`maxPerStatus` 正整数白名单） |
| `lib/routes/kanban-config.js`（新） | `GET/PUT /api/settings/kanban` |
| `server.js` | 挂载 `mountKanbanConfigRoutes` |
| `frontend/src/store.ts` | `MainView` 加 `'kanban'` |
| `frontend/src/App.tsx` | TABS 第 5 项「任务看板」+ `<TabsContent value="kanban">` |
| `frontend/src/views/sessions/statusMeta.ts`（新） | 自 SessionList 迁移 `STATUS_FALLBACK_META`/`statusMetaFor`/`useServerStatusLabels` 并导出 |
| `frontend/src/views/sessions/SessionList.tsx` | 改从 `./statusMeta` import（行为不变） |
| `frontend/src/views/kanban/KanbanView.tsx`（新） | 看板视图：共享筛选 + 文本搜索 + 四列 + 截断/展开 + 卡片跳详情 |
| `frontend/src/views/kanban/kanbanLib.ts`（新） | `buildKanbanColumns`/`lastActivityMs` 纯函数 |
| `frontend/src/api/client.ts` | `getKanbanConfig`/`saveKanbanConfig` + 类型 |
| `frontend/src/components/SettingsDialog.tsx` | 「任务看板」tab + `KanbanConfigSection` |
| `frontend/src/demo/router.ts` | fixtures 列表补伪四态 |
| `test/kanban-config.test.js`（新） | 默认值/白名单过滤/非法清除/路由 GET-PUT（仿 `status-config.test.js` 临时 HOME） |

## 4. 验证

1. 单测：`test/kanban-config.test.js`——默认 20、正整数字段落盘 `~/.agentlray/kanban-config.json`、非法（0/负数/浮点/缺失）清除回退、GET/PUT 路由返回 `{ value, configured, default }`。
2. `npm test` 全绿；`cd frontend && npx tsc -b` 通过；`npm run lint` 通过。
3. 冒烟：`npm start` 起服务；确认：
   - TABS「任务看板」可进、四列按状态渲染、列头计数正确、`GET /api/settings/kanban` 默认 20；
   - 侧栏改平台/项目筛选（含 `未知项目`、全部项目）→ 看板实时跟随（同一查询缓存）；
   - 某列 >20 条时只显示 20 + 「还有 N 条 · 展开全部」可展开/收起；列内按最后更新时间降序；
   - 配置面板把 `maxPerStatus` 改 50 保存 → 看板按 50 截断；
   - 点击卡片跳会话详情（sessions/messages），侧栏筛选不被扰动；SSE 下状态变化 5s 内反映到看板列。
4. UI 截图证据。

## 5. 明确不做

- 看板页不放任何项目/平台筛选控件（用户明确决定：直接共享侧栏筛选数据）。
- 不引入任务实体模型（无新建/归档/结算于/执行次数/最近失败）。
- 后端列表新增分页/过滤参数、`maxPerStatus` 服务端分页——截断全客户端（现有聚合端点已返回全量，量级现状可接受）。
- CLI（`agentlray sessions`）、legacy（`/legacy`）同步迁移。
- 看板列内增量"加载更多/加载 N 条"——只做「展开全部/收起」单档。

## 6. grill 决策记录（共享理解形成过程）

| 轮次 | 问题 | 决定 |
|---|---|---|
| R1-Q1 | 领域映射：任务=会话、四列=四态、参考图只取视觉 | 同意 |
| R1-Q2 | 项目指定方式（共享多选 / 独立下拉） | **否**；用户澄清后确认：看板**不设项目控件**，直接共享侧栏 projectFilter；不指定/全部 = 显示该筛选下所有已选项目的数据 |
| R1-Q3 | 截断/展开 + 配置位置 | 按推荐：lastActivity 降序、「还有 N 条 · 展开全部」、`kanban-config.json` + SettingsDialog tab、单值 `maxPerStatus=20` |
| R1-Q4 | 入口 | 按推荐：TABS 第 5 项「任务看板」 |
| R1-Q5 | 卡片内容与点击 | 按推荐；**卡片展示首条 user message、不展示标题**；点击跳详情。**补充**：首条 user message 不存在时回退会话 `title`，两者皆无显示"（无消息）" |
| R1-Q6 | 看板局部文本搜索 | 按推荐：看板自带局部搜索，不同步侧栏、不持久化 |
| R2-Q2r | 项目共享方式复核 | 看板无项目下拉；直接共享左侧项目筛选对应数据 |
| R2-R1 | 平台控件 | 看板不需要平台选择控件 |
