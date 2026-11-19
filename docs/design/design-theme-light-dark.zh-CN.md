# 设计：web 界面白天/黑夜主题（两态手动切换）

> 类型：方案设计 · 日期：2026-10-30 · 状态：已批准待实现

## 背景与目标

当前 React 前端（`frontend/`）是**暗色唯一**主题：`index.css` 的 `:root, .dark` 共用同一套暗色 token；legacy（`public/`）同为暗色。目标：让 web 界面支持**白天/黑夜两态手动切换**。

已确认的需求（brainstorming 澄清）：

- **切换方式**：两态（亮/暗）手动切换；**首次**无持久化偏好时跟随系统一次（`prefers-color-scheme`），之后用户手动切换即固定。
- **应用范围**：仅 React 前端（`frontend/`）。legacy `public/` 是冻结快照，只接受安全修复，**不动**——切到 `/legacy` 仍为暗色，符合项目约定。
- **开关位置**：顶栏图标快捷切换（太阳/月亮），不进 Settings 面板。
- **持久化**：仅 localStorage（`agent-xray-settings`），与侧栏折叠等 UI 偏好同级；不涉及服务端。

## 方案

沿用 shadcn 标准做法：**CSS 变量 + `.dark` 类**，配合 `tailwind.config` 已配好的 `darkMode: ['class']`。

### 1. 样式层：`frontend/src/index.css`

当前 `:root, .dark` 共用暗色 token。改为：

- `:root` = **亮色** token；
- `.dark` = **暗色** token（沿用现在这组值）。

所有 shadcn 组件与 `bg-*/text-*/border-*` 工具类均消费 `hsl(var(--...))`，因此**无需逐个组件改**。Tailwind 侧亮色为默认、`.dark` 下用暗色——与 shadcn 语义一致（默认即亮，暗色需挂 `.dark`）。

`.dark` 类挂 `document.documentElement`（`<html>`），由小 hook 统一管理。

### 2. 状态与持久化：store + 手写 hook

- 在 `frontend/src/store.ts` 加 `theme: 'light' | 'dark'` 字段与 `setTheme` action，持久化进 `agent-xray-settings`（`loadPersisted` / `persistState` 各加一项，与其他 UI 偏好一致）。
- 新建 `frontend/src/hooks/useTheme.ts`：
  - 挂载时若无持久化偏好 → 用 `matchMedia('(prefers-color-scheme: light)')` 决定初始主题（跟随系统一次），随后切换即固定；
  - 每次 `theme` 变化 → 增删 `document.documentElement` 的 `.dark` 类；
  - 暴露 `{ theme, setTheme }`（或 `toggleTheme`）。
- **不引入 `next-themes`** 依赖：项目习惯不为此类小事引依赖（如 kanban 用原生 `matchMedia` 处理断点），手写小 hook 即可。

### 3. 顶栏图标切换：`frontend/src/App.tsx`

在移动端顶栏（`md:hidden` header，与"会话列表"按钮同排）加一个太阳/月亮图标按钮（lucide `Sun` / `Moon`），点击在亮/暗间切换。两态互斥，无需 dropdown。桌面端顶栏另有空间可一并放置（实现时按布局取舍，保持一处入口即可）。

### 4. 亮色 token 取值

按现有 legacy GitHub 风格延伸，把暗色值反相成亮色。示意（实现时打磨）：

| token | 暗色（现状，.dark） | 亮色（:root） |
| --- | --- | --- |
| `--background` | `216 28% 7%` | 浅灰白（如 `210 20% 98%`） |
| `--foreground` | `212 17% 82%` | 深灰（如 `215 25% 15%`） |
| `--card` / `--panel` | `215 21% 11%` | 白（如 `0 0% 100%`） |
| `--border` | `213 12% 21%` | 浅灰（如 `214 15% 88%`） |
| `--muted-foreground` | `212 9% 58%` | 中灰（如 `215 12% 42%`） |
| `--primary` / `--user` | `212 84% 52%` | 保留品牌蓝（可略加深保证对比度） |
| `--assistant` | `132 59% 33%` | 保留品牌绿（略加深） |
| `--danger` | `3 93% 63%` | 保留品牌红 |

### 5. 硬编码颜色核查（不改大改，逐处过）

组件里约 180 处 `<size>` 类（尺寸，无关）与少量颜色硬编码。分类处理：

- **状态色/徽章色**（`#3fb950` 绿、`#d29922` 黄、`#f0883e` 橙、`#58a6ff`/`#a5d6ff` 蓝、emerald/sky 等）：亮暗下均可读，**保留**。
- **`bg-black`**（demo 横幅内，4 处）：亮色下需检查，必要时改透明/浅色底。
- **demo 横幅 `#e3b341`（黄）**：保留（暗/亮下均为可读黄）。
- **`text-[#ff7b72]` / `text-[#f85149]`**：保留。

结论：**无结构改动**，仅实现时对 `bg-black` 一处视情况微调；不把硬编码迁移为变量（YAGNI，避免无谓 diff）。

### 6. `#about` 静态区

挂在 `#root` 之后、非 React 管辖，但其 CSS 在 `index.css` 内并消费 `var(--panel-alt)`/`var(--border)` 等 token → 跟随 `:root` 自动变亮，**无需额外处理**。

## 范围边界（不做）

- 不改 legacy `public/`（冻结快照）。
- 不动服务端（`~/.agentlray/settings.json` 的 `ui` section 不含主题；主题仅前端 localStorage）。
- 不做「跟随系统」三态（需求为两态，首次跟随一次后固定）。
- 不引 `next-themes` 依赖。

## 文件改动清单

| 文件 | 改动 |
| --- | --- |
| `frontend/src/index.css` | `:root` 改亮色 token、`.dark` 保留暗色 token；body 背景辉光分主题（亮色减弱、暗色沿用 legacy 值），滚动条随 `--border` 自动适配 |
| `frontend/src/store.ts` | 加 `theme` 字段 + `setTheme` action；`loadPersisted`（含 `systemTheme()` 首启跟随系统）/ `persistState` 增持久化 |
| `frontend/src/hooks/useTheme.ts` | 新建：theme 变化 → 同步 `html.dark` 类 |
| `frontend/src/index.html` | 移除静态 `class="dark"`，加 head 内联防闪烁脚本（读 `agent-xray-settings.theme`，无则跟随系统，预置 `.dark`） |
| `frontend/src/App.tsx` | 移动端顶栏加太阳/月亮切换按钮；DEMO 横幅 `bg-black` → `bg-foreground/10`（亮暗通用） |
| `frontend/src/components/Sidebar.tsx` | 侧栏标题行图标组加太阳/月亮切换按钮（桌面端入口） |
| `frontend/src/components/ui/sonner.tsx` | `theme="dark"` 硬编码 → 跟随当前主题（亮/暗） |

## 验证

1. `npm run build`（frontend）通过（tsc -b 类型检查 + vite build）。
2. 构建产物核验：dist CSS 含亮暗两套 token（`:root` 亮 / `.dark` 暗）。
3. 运行时冒烟（`node server.js` + curl）：
   - React 根 `<html>` 无静态 dark 类、内联防闪烁脚本存在；
   - `/legacy` 仍为暗色（`--bg: #0d1117`），冻结快照未动。
4. 手测：
   - 首次打开（无持久化）：跟随系统深浅色，无闪白/闪暗（index.html 预置类）；
   - 顶栏/侧栏图标切换亮/暗：页面配色整体切换，无组件残留暗色硬编码；
   - 刷新后主题保持（localStorage 持久化）；
   - 会话/分析/prompts/资产库/看板五视图 + Settings 弹框在亮暗两态下可读性检查。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（文档内「待实现」为历史状态）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 两态主题 + localStorage | ✅ 已实现 | `frontend/src/store.ts`、`frontend/src/hooks/useTheme.ts` |
| CSS 变量 `.dark` 反相 | ✅ 已实现 | `frontend/src/index.css` |
| 顶栏切换入口 | ✅ 已实现 | `frontend/src/App.tsx` |

