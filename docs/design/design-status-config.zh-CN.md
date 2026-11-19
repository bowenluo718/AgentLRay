# 状态时间配置可配置 + 设置面板分组折叠

> 类型：方案设计 · 日期：2026-10-26 · 关联：`lib/status.js`、`lib/status-config.js`、`SettingsDialog.tsx`、`SettingsSection.tsx`（`lib/routes/status-config.js` 与 `GET/PUT /api/settings/status` 已在 settings-merge 后并入统一 `GET/PUT /api/settings` 的 `status` section，见 [design-settings-merge.zh-CN.md](design-settings-merge.zh-CN.md)）

## 背景

`lib/status.js` 三个会话状态判定时间窗口（`RECENT_ACTIVITY_MS` 2min / `ACTIVE_WORK_CEIL_MS` 30min / `HISTORY_CEIL_MS` 12h）是模块顶层常量，之前只能手动改代码调宽（见 session-status-design 记录）。需求：web 设置面板可配置，并优化配置视图（按模块分组、折叠展开、每项加说明）。

## 设计

### 状态时间注入

三常量只被 `deriveStatus()`/`sortSessionsByStatusGroups()` 消费，外部全经这两个函数。改造为**模块级运行时配置 + setter**（最小侵入，各平台 list 与 SSE watch 调用点零改动）：

- `lib/status.js`：保留 `RECENT_ACTIVITY_MS` 等导出名（兼容测试），新增 `DEFAULT_*` 与 `statusConfig` 缓存；`deriveStatus` 内部读 `opts.recentActivityMs ?? statusConfig.recentActivityMs ?? 默认`；新增 `setStatusConfig`/`getStatusConfig`/`resetStatusConfig`。
- `lib/status-config.js`：仿 `cli-bins.js` 持久化 `~/.agentlray/status-config.json`，白名单过滤、非法值清除、`STATUS_DEFAULTS` 回退。
- `lib/routes/status-config.js`：`GET/PUT /api/settings/status`，GET 返回 `{value, configured, default}`；PUT 保存并 `setStatusConfig` 立即注入。
- `server.js`：启动 `loadStatusConfig().then(setStatusConfig)` + 挂载路由。
- `bin/sessions.js`：`list` 前 `setStatusConfig(await loadStatusConfig())`，保证终端与 web 一致。

### 配置视图页签化 + 弹框尺寸优化

设置面板由「模块折叠（SettingsSection）」调整为「按模块划分页签」，支持页签切换；并加大弹框宽度、优化高度（最大高度不超过浏览器窗口、必要时垂直滚动条）、优化每个配置项的区分：

- **页签化**：`Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`（@radix-ui/react-tabs）替换 `SettingsSection` 折叠组件（后者已删除）。5 个页签：数据目录 / LLM 接口 / 平台 CLI 命令 / 状态时间配置 / 会话备份。
- **弹框尺寸**：`DialogContent` 由 `max-w-lg` 改为 `max-w-2xl max-h-[85vh] overflow-y-auto`——加宽、高度不超过浏览器窗口、内容超出时垂直滚动。
- **配置项区分**：统一字段范式为「label（htmlFor 关联）+ 输入框 + 小字 hint」堆叠；数据目录 label 改中文、hint 移到输入框下方（不再与 label 同排）；LLM 接口三个输入框补 label（Base URL / 模型名 / API Key）并垂直堆叠（原仅 placeholder 无 label、模型名与 API Key 并排易混淆）；各页签顶部加分组说明文字。

分组内容：数据目录（7 目录字段）、LLM 接口、平台 CLI 命令、状态时间配置、会话备份。

## 验证

- `test/status-config.test.js`（新，5 例）：默认值、load 空、save 白名单过滤 + 落盘、setStatusConfig 影响 deriveStatus 判定（含 opts 优先）、非法值忽略。
- `test/api.test.js`：`status-config settings persist`（GET 默认、PUT 落盘 + 非法清除 + 文件）。
- `test/status.test.js`（23 例）与 `watch-tail`/`session-cli`/`unit` 全过——现有注时用例零破坏。
- 端到端冒烟：真实 server `GET/PUT /api/settings/status` 正常、CLI `sessions list` 注入不报错。
- 前端 `tsc -b` 与 `vite build` 通过。
- UI 实测（headless Chromium）：设置面板 5 页签正确渲染、切换正常；弹框宽 672px、高 680px（视口 800px 内未超出）、`overflow:auto`（内容 878px 超出时垂直滚动）；数据目录/LLM 接口页签字段 label + hint 清晰对应。

## 边界

- 时间窗口存毫秒；UI 以分钟/小时输入换算，避免大数字。
- 保存即注入（运行时生效），无需重启；重启时 server/CLI 从文件重新加载。
- 非法/空值清除该 key 回退默认，不污染。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（设置面板页签结构后续随 settings-merge 演进）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 四态判定窗口可配置 | ✅ 已实现 | `lib/status-config.js`、`lib/status.js` |
| `/api/settings` `status` section | ✅ 已实现 | `lib/routes/settings.js` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
