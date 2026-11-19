# 吸顶设计（看板移动端状态头 + 左侧分组头）（design-sticky-headers.zh-CN.md）

> 类型：方案设计　｜　日期：2026-10-29　｜　状态：已实现
> 需求来源：「web界面任务看板在窗口宽度小于768px状态头部吸顶展示。左侧任务列表外场分组折叠头吸顶展示。」
> 前置文档：`design-kanban-mobile.zh-CN.md`（移动端看板布局，本文档是其吸顶增量）

## 1. 背景与目标

- **任务看板**移动端（视口 <768）四列纵向堆叠，页面级滚动由外层 `TabsContent`（`overflow-auto`）承担。滚动过程中组头（状态徽标 + 计数）随内容滚出视口，用户切换状态列时缺乏参照。
- **左侧任务列表**在按平台/按项目分组时，外层分组折叠头（组标签 + 计数）在滚动时滚出视口，用户难以感知当前所处分组。

目标：两处折叠头在滚动时**吸顶展示**，作为当前分组/状态的常驻参照。

## 2. 方案设计

两处均用 CSS `position: sticky`，各自相对于最近的滚动容器吸顶；不透明背景遮住滚动上来的内容，避免文字重叠。

### 2.1 看板移动端状态头（`KanbanView.tsx`）

- 移动端列组头容器加 `sticky top-0 z-10 bg-card/95 backdrop-blur-sm`。
- 滚动容器 = 外层 `TabsContent`（`overflow-auto`），组头相对它吸顶。
- `bg-card/95`（近似不透明卡片底色）+ `z-10` 遮住滚动上来的卡片。
- 仅移动端生效（`isMobile` 为 true 时才附加类）；桌面横向列 + 列内滚动不受影响。

### 2.2 左侧列表外层分组头（`SessionList.tsx`）

- 非虚拟化路径的外层 `group` 头包一层 wrapper：`sticky top-0 z-10 -mr-1 bg-panel-alt/95 backdrop-blur-sm`。
  - 滚动容器 = `SessionList` 自身的 `overflow-y-auto`（`data-testid="session-list"`），分组头相对它吸顶。
  - `-mr-1` 抵消容器 `pr-1`，让吸顶背景横向铺满。
  - 背景用侧栏底色 `bg-panel-alt/95`（`Sidebar` 容器为 `bg-panel-alt/95`）与侧栏融为一体。
- **仅外层 group 头**吸顶；组内四态状态子组头（`kind: 'header'`）保持随流滚动——子组头只是状态切换的次级参照，且数量少、常在同一屏内，吸顶会造成层级混乱（多组叠加）。
- **虚拟化路径（>200 条）不吸顶**：虚拟化行的定位由 virtualizer 用 `translateY` 驱动（`absolute`），sticky 在其中不生效且会破坏布局，故保持现状。

## 3. 验收（可执行）

1. DevTools 375px 看板：滚动时每列组头吸顶，卡片从其下方滚过，无文字重叠。
2. DevTools 375px 左侧列表（按平台/按项目分组，<200 条）：外层分组头滚动时吸顶，背景与侧栏一致。
3. 桌面 ≥768 回归：看板横向四列 + 列内滚动、组头不吸顶；左侧列表分组头不吸顶（虚拟化 / 桌面行为不变）。
4. `cd frontend && npm run build` 通过（tsc -b + vite build）。

## 4. 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/views/kanban/KanbanView.tsx` | 移动端列组头加 `sticky top-0 z-10 bg-card/95 backdrop-blur-sm`（仅 `isMobile` 时） |
| `frontend/src/views/sessions/SessionList.tsx` | 非虚拟化路径外层 group 头包 `sticky top-0 z-10 -mr-1 bg-panel-alt/95 backdrop-blur-sm` wrapper |

后端 / API / legacy（`public/`）无改动。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 看板移动端状态组头吸顶 | ✅ 已实现 | `frontend/src/views/kanban/KanbanView.tsx:206` |
| 左侧分组折叠头吸顶 | ✅ 已实现 | `frontend/src/views/sessions/SessionList.tsx:542` |

