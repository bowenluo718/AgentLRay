# 设计：侧栏会话列表筛选迁移（平台/项目筛选 + 分组 + 折叠）

> 需求：把 web 顶部平台选择迁入左侧栏会话列表筛选条件；筛选新增「项目」；支持分组显示（按平台 / 按项目 / 不分组），组内按状态与最后更新时间排序；两级组头可折叠。
> 状态：与用户经 grill-with-docs（grilling + domain-modeling）达成共享理解后定稿。领域词见根 `GLOSSARY.md`。

## 0. 定稿决策（共享理解）

| 维度 | 决定 |
|---|---|
| 范围 | 只做 React SPA；`/legacy`（public/js/app.js）不动，保留其独立 `#platformBar`。配置收进弹框：侧栏默认只显示标题/文本过滤/会话列表，平台/分组/项目/agent/开关全部置于「会话筛选与分组」弹框 |
| 平台筛选 | 移除顶部 `PlatformBar`（`App.tsx:121`），平台多选（「全部 + 多选」，默认全部平台；单选平台时禁用「按平台分组」）收进筛选/分组弹框 |
| 项目定义 | **后端不新增 project 字段**，直接复用现有 `cwd`；前端推导显示值 = cwd 末段，末段重复 → 该组显式显示完整 cwd 消歧（同名 cwd 与会话全部升级，保障分组一致）；cwd 缺失 → `未知项目` |
| 项目筛选 | 多选 checkbox + 「全部项目」+「未知项目」项，选项从当前已加载数据动态收集 |
| 分组模式 | `按平台`（每组=平台，组内嵌状态子组头）/ `按项目`（纯值跨平台合并组、未知项目自成一组，组内嵌状态子组头）/ `不分组`（当前扁平状态组头） |
| 组内排序 | 状态优先级（awaiting-input→working→waiting→stopped）→ `lastActivity` 降序 |
| 折叠 | 两级组头（平台/项目外层 + 状态子组）均可折叠；默认全展开；折叠组头显示会话数徽标；折叠态按「分组模式+组名」持久化 localStorage；**状态子组头相对外层组头左缩进分出层级** |
| 持久化 | 平台多选、项目筛选、分组模式、折叠集 → localStorage（现 `agent-xray-settings` 通道）；文本筛选不持久化 |
| 后端边界 | 仅 openclaw 列表 summary 补上已有 `cwd`；不加新过滤参数；`agentlray sessions` CLI 不动；web 筛选/分组/折叠全客户端 |
| 详情与筛选解耦 | 引入详情上下文 `detailPlatform`/`detailAgent`：聚合视图点击会话跳详情只更新详情上下文与选中会话，**不改变** 平台多选/分组模式/项目筛选/折叠等筛选配置；详情按会话来源平台/agent 加载（`/api/omp/sessions/omp1` 等），SSE/子 agent/导出/断点续跑同受详情上下文驱动 |
| 路由持久化 | 会话详情 ↔ URL query `?session=&sid=&agent=`（replaceState，不产生历史栈噪音）：点击查看详情即写入；刷新后从 URL 恢复「正在查看的会话详情」默认进入；清空选中/切平台时移除参数。筛选/分组仍走 localStorage，两者独立同步 |

关键数据事实（据 scout 勘察）：
- `SessionSummary` 已有 `cwd`（codex/claude/dsh/gemini/omp 的 list summary 均带；openclaw 列表丢弃、hermes 无）与 `lastActivity`（7 平台统一）。
- openclaw detail 解析已读 `record.cwd`（lib/platforms/openclaw.js:304），列表 summary 只留 id/timestamp（:38-59）→ 补字段即可。
- 聚合端点 `/api/sessions` 每块已有 `{platform, agent, sessions}`（session-list.js:143-162），`queries.ts:51-53` 已展平并打 `platform`。
- 现有状态组头：`SessionList.tsx:62-136` groupRows（组头只插入到有卡片的组）+ 三处下标直用（渲染 :170、↑↓ :99-101、选中滚动 :117-120）；>200 条虚拟化（useVirtualizer :271-282）。
- 折叠持久化已具备基建：`store.ts:19-24` loadStoredFlag/saveStoredFlag、`axr-*` 键；`MessageItem.tsx:73` Collapse 组件可复用。

## 1. 后端改动（最小）

`lib/platforms/openclaw.js` 列表 summary 增加 `cwd`：
- `_parseSessionMetadataRaw` 已解析的 session 记录补充 `cwd: record.cwd || null`，随 metadata 返回，summary 透出。
- 其余平台不动；hermes 无 cwd → 前端归「未知项目」。
- 同步更新 openclaw 相关测试期望。

## 2. 前端改动（React）

### 2.1 store 状态扩展
- 保留 `platform` / `selectedPlatforms`（“全部” = 全选，与现聚合通道一致）；默认 `selectedPlatforms` 全选 = 默认全部平台。
- 新增感受态：
  - `groupBy: 'platform' | 'project' | 'none'`（默认 `'none'`）
  - `projectFilter: string[]`（选中项目名，含哨兵 `未知项目`；空 = 全部）
  - `collapsed: Record<string, string[]>`（键 = `groupBy`，值 = 折叠组名集合）
  - 以上随 `persist()` 进 `agent-xray-settings`；文本筛选不入 store。

### 2.2 配置收进弹框（SessionFiltersDialog）、移除 PlatformBar
- `App.tsx` 删除 `<PlatformBar />`，组件删除。
- 新增 `components/SessionFiltersDialog.tsx`：「会话筛选与分组」弹框承载平台多选（全部+多选）、分组模式、项目筛选、OpenClaw agent 下拉（单平台 openclaw）、Include archived / Auto-refresh / Auto-scroll 开关。
- `Sidebar` 精简为默认只显示标题、会话文本过滤框、会话列表；右上「筛选」图标打开弹框。
- `queries.ts:59-73` 通道选择逻辑复用：选中多个（含全部）→ `sessionsAllListOptions`；单选 → `sessionsListOptions`（openclaw 单选带 agent，沿用）。
- 单选平台时：platform 分组选项禁用（置灰），仅「按项目 / 不分组」。

### 2.3 项目推导与筛选
- `lib.ts` 新增 `resolveProject(cwd)` → 末段；`buildProjectOptions(sessions)` → 对当前（已过滤文本前的基础集合）cwd 全集计算：
  1. 按末段分组，统计“同一末段对应不同完整 cwd 的集合大小 >1”；
  2. 命中即该末段所有会话显示完整 cwd，否则显示末段；
  3. 无 cwd → `未知项目` 常量项。
- 项目筛选多选；「全部项目」快捷项；「未知项目」可勾选；选项动态收集、按出现次数降序（可选）排序。

### 2.4 分组 + 两级组头 + 折叠
`SessionList.tsx` 展示行数组扩展为两级：
- 外层行 = 平台组头（`groupBy=platform`）或项目组头（`groupBy=project`）；`groupBy=none` 时无外层行。
- 内层行 = 状态子组头（复用现有 `SessionRowHeader` + STATUS_ORDER），**三种模式都保留**（现状不分组行为不回归）。
- 外层每组项内嵌 4 个状态子组（空先剔除）；组内排序 = 状态优先级 → lastActivity（`lastActiveMs` 现成）。
- 折叠：外层组头/状态子组头均可折叠；折叠集存 store `collapsed[groupBy]`（组名 = 平台名 / 项目名 / 状态 key）；折叠组头显示会话数徽标；`only-if-有可见子内容` 保持不变（文本筛选后空组隐藏，折叠态保留）。
- 层级区分：状态子组头相对外层组头左缩进（`pl-4`，外层仅 `px-1`），与折叠箭头双信号区分「状态折叠」与「分组折叠」；行 key 带分组前缀保证 React key 唯一。
- 三处下标直用（渲染行取数、↑↓、选中滚动）随展示行数组扩展一并重映射；虚拟化 `measureElement` 支持动态行高，沿用。

### 2.5 依赖与复用
- Collapse 交互复用 `MessageItem.tsx:73` 的模式（不直接 import 该内部组件，侧栏列表内新写轻量行内折叠头组件或复用若可导出）。
- 状态标签仍走 `useServerStatusLabels()`（`/api/status-labels` 单源）。

## 3. 文件改动清单

| 文件 | 改动 |
|---|---|
| `lib/platforms/openclaw.js` | list summary 补 `cwd` |
| `test/openclaw.test.js`（或对应） | 期望补 cwd 字段 |
| `frontend/src/store.ts` | groupBy / projectFilter / collapsed 状态 + 持久化 |
| `frontend/src/App.tsx` | 移除 `<PlatformBar />` |
| `frontend/src/components/SessionFiltersDialog.tsx` | 新增：平台/分组/项目/agent/开关配置弹框 |
| `frontend/src/components/Sidebar.tsx` | 精简为标题+文本过滤+会话列表；右上「筛选」按钮打开弹框 |
| `frontend/src/components/PlatformBar.tsx` | **删除**（逻辑迁入弹框） |
| `frontend/src/views/sessions/SessionList.tsx` | 两级组头 + 折叠（状态头缩进）+ 组内排序 + 唯一 key |
| `frontend/src/views/sessions/lib.ts` | `resolveProjectValues`/`buildProjectOptions` 推导 |
| `public/js/app.js` / legacy | **不动** |

## 4. 验证

1. 单测：openclaw summary 断言 `cwd`；前端纯函数 `resolveProject`/`buildProjectOptions` 消化歧用例（同名 cwd 合组、末段撞名全升级、无 cwd → 未知项目）。
2. `npm test` 全绿；`tsc -b` 通过。
3. 冒烟：起服务，多选平台聚合视图下三种分组模式分别渲染两级组头且可折叠；单选平台「按平台分组」置灰；项目筛选/未知项目项生效；刷新页面持久化保留（分组模式、折叠集、平台/项目筛选）；openclaw `/api/openclaw/sessions` 每条带 cwd。
4. UI 截图证据。

## 5. 明确不做

- `agentlray sessions` CLI 新增 project/分组参数。
- 后端 project 过滤参数。
- legacy `/legacy` 同步迁移。
- 文本筛选持久化。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 平台/项目筛选迁入侧栏 | ✅ 已实现 | `frontend/src/components/Sidebar.tsx`、`SessionFiltersDialog.tsx` |
| 分组模式与折叠持久化 | ✅ 已实现 | `frontend/src/store.ts`、`frontend/src/views/sessions/SessionList.tsx` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
