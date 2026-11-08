# 任务看板移动端适配设计（design-kanban-mobile.zh-CN.md）

> 类型：方案设计　｜　日期：2026-10-29　｜　状态：grill 收敛定稿，待实现
> 需求来源：「任务看板视图需要考虑移动端的显示效果」
> 前置文档：`design-kanban.zh-CN.md`（2026-10-28，桌面看板设计）——本文档仅是其**移动端增量**，桌面既有能力不在本文档重复描述。

## 1. 背景与目标

`KanbanView`（`frontend/src/views/kanban/KanbanView.tsx`）当前**无论什么屏幕都是横向四列滚动**，无任何响应式处理：

```jsx
// KanbanView.tsx:132 —— 恒定横向滚动容器
<div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-2">
```

需求原文只有一句「考虑移动端的显示效果」，经 grill 收敛为明确规格（见 §2）。目标：移动端（宽 <768px）看板从「横向四列滚动」变为「纵向四列堆叠」，平板及以上保持现状（零改动）。

## 2. 决策摘要（grill R1–R5 收敛）

| 决策点 | 结论 | 备注 |
| --- | --- | --- |
| 目标设备范围 | **只做手机**（页面宽度 <768）；平板 768+ 免费拿桌面布局，无专门适配 | 平板竖屏 768px 恰在阈值，按桌面处理 |
| 断点 | 视口宽度 **<768 堆叠**、≥768 维持横向四列 | 沿用 `App.tsx` 现有 `max-width: 767px` 约定；断点按视口而非容器，侧栏挤压列宽的问题用户明确不处理 |
| 列布局 | <768 纵向堆叠四列（顺序 `STATUS_ORDER`：待用户输入→工作中→等待中→已停止） | ⚠️ 桌面现有「多列同时展开」能力随全局手风琴**一并取消**（决策 E） |
| 卡片内容 | 保留全局信息（全宽卡片，字段不动：标题/项目/平台/时间/状态徽标） | 堆叠后卡片全宽，比桌面 ~180px 列宽得多，无砍字段必要 |
| 拖拽 | 不支持（无需求） | 状态切换仅通过会话详情页（沿用现状） |
| 堆叠列默认态 | 每列默认只展示 **1 张卡** = 该列 `lastActivity` 降序第一条（`kanbanLib` 现有排序） | 独立于 `maxPerStatus` 配置 |
| 展开交互 | 移动端 **header 整块可点** 展开/收起，隐藏桌面的「展开」按钮 | 桌面保留独立按钮 |
| 展开语义 | **全局手风琴**：任意时刻只展开一列（桌面移动统一） | `expanded` 由 `Record<string,boolean>` 收敛为单值 |
| 展开上限 | 展开了就不再截断，展示该列**全量**（同桌面 expanded 语义） | 配合手风琴 + 页面级滚动，不产生 80 卡长墙 |
| 滚动 | **页面级滚动**（外层容器滚，非列内滚动） | 无嵌套滚动容器，避开手势冲突 |
| 空列占位 | 组头 + 空白灰卡，文案 **「这个状态还没有任务」** | 桌面空列现状不变（最小改动） |
| 断点翻转 | 无需重置 `expanded` | 全局手风琴下单值 state 自洽，翻转天然一致 |
| 性能 | 5s 轮询 + SSE 不变 | 用户明确「不需要管」，记录为主动接受的成本 |
| 验收 | 纯展示优化；可测项见 §6 | — |

## 3. 现状关键点（可追溯）

- 数据源：`useSessionsList()`（与侧栏同缓存、5s 轮询 + SSE 合并）→ `filtered`（共享 `projectFilter` 客户端过滤 + 看板局部文本过滤）。
- 数据整形：`kanbanLib.buildKanbanColumns(filtered, { maxPerStatus, expanded })`，纯函数无 React 依赖；`expanded[status] ? full : full.slice(0, limit)`，`maxPerStatus` 默认 20（配置源 `GET /api/settings/kanban`）。
- 展示：`statusMetaFor`（`statusMeta.ts`）为状态标签/配色唯一来源。
- 外层滚动已存在：`App.tsx:192` `TabsContent value="kanban"` 带 `overflow-auto`——**移动端页面级滚动可直接复用，看板内部容器不应再自建滚动区**。
- 断点约定：`App.tsx` 用原生 `matchMedia('(max-width: 767px)')`，项目无 `useMediaQuery` hook、无前端测试文件（`kanbanLib` 无单测）。

## 4. 方案设计

### 4.1 断点订阅（最小新增）

项目没有媒体查询 hook，为避免引依赖，内联一个小订阅（沿用 `App.tsx` 原生 `matchMedia` 模式）：

```ts
// KanbanView 内或抽成 local hook；<768 判定与 App.tsx 完全一致
const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
useEffect(() => {
  const mq = window.matchMedia('(max-width: 767px)');
  const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
  mq.addEventListener('change', onChange);
  return () => mq.removeEventListener('change', onChange);
}, []);
```

### 4.2 数据整形（`kanbanLib` 签名变化 —— 破坏性但无测试破坏面）

`expanded` 由多值记录收敛为**单值手风琴**，并引入按断点的「折叠展示条数」：

```ts
// 旧：opts: { maxPerStatus: number; expanded: Record<string, boolean> }
//          list = expanded[status] ? full : full.slice(0, maxPerStatus)
// 新：opts: { collapsedLimit: number; expandedStatus: string | null }
//          list = expandedStatus === status ? full : full.slice(0, collapsedLimit)
```

- `collapsedLimit`：桌面 = `maxPerStatus`（默认 20，保留配置语义）；移动端 = **恒 1**（用户定死的「默认 1 卡」）。
- `expandedStatus`：单值；`null` = 全收起。
- `maxPerStatus` 配置在移动端不再参与折叠条数（移动端折叠恒 1），但**不影响**：列头计数 `total`（截断前全量）、展开开关门槛（`total > 1` 即需展开）。
- 影响面：仅 `KanbanView.tsx` 一处调用点；前端无单测（glob 无 `*.test`），无测试需同步改。**建议**顺手补 `kanbanLib` 单测（§6.7，纯函数已是现成可测单元，属长期债务而非本需求强加）。

### 4.3 布局与交互（`KanbanView`）

**容器**（`KanbanView.tsx:132`）：

- ≥768：保持现状 `flex flex-row gap-3 overflow-x-auto pb-2`。
- <768：`flex flex-col`，**取消自身纵向滚动**，交给外层 `TabsContent` 的 `overflow-auto`（页面级滚动，§3）；列区块纵向堆叠。

```jsx
<div className={cn(
  "flex min-h-0 flex-1 gap-3 pb-2",
  isMobile ? "flex-col overflow-y-visible" : "flex-row overflow-x-auto"
)}>
```

**列区块（移动端形态）**：组头（状态徽标 + 计数 `total` 带「展开全部/收起」语义指示）+ 卡片区。

- 每列默认 1 卡（`collapsedLimit=1`）；展开后全量。
- **组头整块可点** → toggle：点当前展开列 = 收起（置 `null`）；点其他列 = 换开（全局手风琴）。
- 桌面保留独立「展开」按钮（`showExpand = col.total > maxPerStatus` 逻辑沿用）；移动端隐藏按钮、由组头整块承担，避免双触发。

**空列占位**（移动端）：`col.list.length === 0` 时渲染组头 + 空白灰卡（`text-muted-foreground` 的「这个状态还没有任务」）。桌面空列现状不动。

**卡片**：`KanbanCard` 复用于移动端全宽形态，字段、点击 `openSession` 行为不变。

### 4.4 交互状态（全局手风琴）

- `useState<string | null>(null)` 单值 `expandedStatus`，替代 `Record<string, boolean>`。
- 桌面/移动共用同一 state；断点翻转自然自洽（决策 F），无需额外重置逻辑。
- ⚠️ 桌面行为回归：原「每列独立展开/收起（可多列同开）」变为「全局同时仅一列展开」——这是决策 E 主动接受的破坏性行为变化，须在验证项明确回归。

### 4.5 触控与样式（建议）

- 组头/卡片触控目标 ≥ 44px 高（建议项；用户未逐项验收，属移动端展示质量的合理底线）。
- 无后端改动、无 API 改动、legacy 前端（`public/`）不在功能面，**不动**。

## 5. 文件改动清单

| 文件 | 改动 | 类型 |
| --- | --- | --- |
| `frontend/src/views/kanban/KanbanView.tsx` | 断点订阅（4.1）、容器布局与组头/空列交互（4.3）、`expandedStatus` 单值 state（4.4） | 修改 |
| `frontend/src/views/kanban/kanbanLib.ts` | 签名：`{ collapsedLimit, expandedStatus }`，`list` 切片逻辑（4.2） | 修改（破坏性） |
| `frontend/src/views/kanban/kanbanLib.test.ts`（新增） | 手风琴单值、`collapsedLimit` 生效、空桶、未知态保序（§6.7） | 新增（建议） |
| 后端 / API / legacy | — | 无 |

## 6. 验收（可执行）

1. DevTools 375px：四列纵向堆叠、每列仅 1 卡、**无横向溢出**。
2. 点组头 → 该列展开全量、其余列同时收起（手风琴）；再点同列 → 收起；换点他列 → 换开。
3. 空列显示灰卡「这个状态还没有任务」。
4. 断点拖拽 375↔768 翻转：形态正确切换，`expandedStatus` 自洽无需重置。
5. 桌面 ≥768 回归：横向滚动、每列最多 `maxPerStatus` 条、独立「展开」按钮正常；**确认原多列同开变为单列展开（决策 E）**。
6. 移动端真机/模拟器（360/375/414 宽度）目检视觉与触控目标。
7. `kanbanLib` 单测：展开态=全量、折叠态=`collapsedLimit` 条、两个 `collapsedLimit` 值（1 与 20）各自正确、空桶返回空 `list`、未知状态桶保序后置。

## 7. 记录项（不阻塞实现）

- 5s 轮询 + SSE 的弱网流量成本：用户明确接受，不再议。
- 平板 768–900 视口下侧栏挤压列宽（~140px/列）：用户明确不处理，按现状桌面布局交付。
