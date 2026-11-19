# 统一设置文件与公用保存/重置 — 方案设计

> 状态：已实现（2026-10-29）。grill 决策 R1-Q1~Q5、R2-Q-A/Q-B 全部收敛后按共享理解实现。
> 对应代码：`lib/settings.js`、`lib/routes/settings.js`、`lib/routes/cli-bins.js`（兼容只读）、各 section lib 模块、`server.js`、`bin/sessions.js`、前端 `client.ts`/`SettingsDialog.tsx`/`demo/router.ts`、测试 `test/settings.test.js` 及 api/status/kanban/llm/platforms/session-cli 用例。

## 目标

1. `~/.agentlray` 下的 5 个服务端设置 JSON 聚合为单一 `settings.json`。
2. web 设置面板各页签不再单独保存，只保留公用的一份「Save / Reset to Defaults（警告色）」；Reset 恢复默认到表单、点 Save 才落盘。

## 决策记录（grill 收敛）

| 决策点 | 结论 |
| --- | --- |
| R1-Q1 合并范围 | 只合 5 个设置文件：`ui-settings.json`/`cli-bins.json`/`status-config.json`/`kanban-config.json`/`llm.json`；`hidden-prompts.json`、`analysis/`、`library/`、`archive/`、`platforms/`、`cache/` 属数据/缓存，不动。文件名 `settings.json` |
| R1-Q2 服务端 API | 新增单一 `GET/PUT /api/settings`（按 section 分组，一次原子写）；删除 4 个 section 端点（`/api/settings/ui`、`/status`、`/kanban`、`/llm`）。legacy 依赖单独处理（见 R2-Q-A） |
| R1-Q3 存量迁移 | 首启幂等迁移旧 5 文件 → `settings.json`，成功后删除旧文件；无旧文件不建新文件 |
| R1-Q4 Reset 语义 | 恢复默认到表单（服务器字段留空 = 回默认），须再点 Save 才落盘；按钮用 `variant="destructive"`（警告色） |
| R1-Q5 数据目录 | 保持 localStorage `agent-xray-settings`（与 legacy 共享 key），不迁服务端；仍纳入对话框统一 Save/Reset |
| R2-Q-A legacy 兼容 | 只保留 `GET /api/settings/cli-bins` 只读兼容端点（legacy `app.js:3501` 复制恢复命令唯一依赖，读失败已有回退默认）；不提供 PUT |
| R2-Q-B CLI 迁移 | `bin/sessions.js` 入口也幂等触发迁移（纯 CLI 用户升级后读到旧配置）；`server.js` 启动亦触发 |

## 实现要点

### 后端

- **`lib/settings.js`**（新，单一真源）：`SETTINGS_FILE`、`readSettings()`（缺失/损坏 → `{}`）、`writeSettings()`（tmp+rename 原子写）、`saveSections(partial)`（读-改-原子写，只改写传入 section）、`migrateLegacySettings()`（幂等：`settings.json` 已存在即跳过；否则并入旧 5 文件后写新文件并删旧文件）、`settingsResult()`（`value/configured/default` 型 section 组装，自 `lib/config-store.js` 迁入）。
- **section 视图**（导出签名不变，内部读/写 `settings.json` 对应 section，合并写入）：
  - `lib/ui-settings.js` → `ui`；`lib/cli-bins.js` → `cliBins`（`loadRawBins` 保留自定义 `<id>` 键）；`lib/status-config.js` → `status`；`lib/kanban-config.js` → `kanban`；`lib/llm.js` → `llm`（`saveLlmConfig` 缺失字段沿用，供 API 层做「缺省=保留密钥」语义）。
  - `lib/config-store.js` 删除（原 `createConfigStore` 的使用者全部改写为 section 视图）。
- **`lib/routes/settings.js`**（新）：`GET /api/settings` 全量返回（`cliBins` 的 `bin` 用 `resolveCliBin` 反映「环境变量→配置→默认」，与 `bin/sessions.js` 一致；`llm` 只回 `hasApiKey` 不明文）；`PUT /api/settings` 只保存请求体提供的 section，`ui` 平台白名单校验（沿旧 `/api/settings/ui` 语义）、`status` 保存即 `setStatusConfig` 注入、`llm` 沿用「`apiKey` 缺省=保留 / 空=清除 / 有值=替换，baseUrl 空→清 key」。
- **`lib/routes/cli-bins.js`** → 只读兼容端点（deprecated），`server.js` 仍挂载。
- **`server.js`**：`boot()` 先 `migrateLegacySettings()` 再 `loadStatusConfig → setStatusConfig` 后 `listen`；删除 `mountLlmRoutes`/`mountUiSettingsRoutes`/`mountStatusConfigRoutes`/`mountKanbanConfigRoutes` 挂载。
- **`bin/sessions.js`**：`main()` 解析子命令后 `await migrateLegacySettings()`；帮助与报错路径文本改为 `settings.json`。

### 前端

- **`client.ts`**：新增 `getSettings()`/`saveSettings()`（`SettingsPatch` 只含已编辑 section）+ `AllSettings` 类型；`getCliBins`/`getKanbanConfig` 改为从 `getSettings()` 切片；`saveUiSettings` 改 `PUT /api/settings {ui}`（store 平台选择同步调用点不变）；删除 `getLlmSettings`/`saveLlmSettings`/`saveStatusConfig`/`saveKanbanConfig`/`saveCliBins` 等旧函数。
- **`SettingsDialog.tsx`**：单一 `draft`（`dirs` + `llm` + `cliBins` + `status` + `kanban`）+ 每 section `touched` 脏标记；删除各 tab 独立保存按钮；底部一个 `Reset to Defaults`（`variant="destructive"`）+ 一个 `Save`。`Save` 提交：数据目录始终写 localStorage；服务器 section 仅已编辑者进 `SettingsPatch`（未触碰保持服务器原值，避免误清）。`Reset` 置所有字段为默认并将各 section 标脏（点 Save 才落盘）。打开时以统一 `getSettings()` 数据 + store 目录设置种 draft。
- **`demo/router.ts`**：替换 4 个 section 模拟为单一 `GET /api/settings`。

## 验证

- 后端全套：`node --test test/*.test.js` → 471 pass / 2 fail；2 fail 均为 `test/registry.test.js` 对**真实 HOME** 的适配器集合断言（本机 `~/.agentlray/platforms/co-mind.js` 自定义平台泄漏所致，与本次改动无关，预存在）。
- 端到端冒烟（临时 HOME + 旧 5 文件）：启动后旧文件删除、`settings.json` 生成；`GET /api/settings` 全量返回且 `llm` 不泄漏 `sk-smoke`；`PUT` 仅 `kanban` 不触碰 `ui`/`cliBins`/`status`；兼容端点 `GET /api/settings/cli-bins` 返回迁移后的 codex bin。
- 前端 `tsc -b && vite build` 通过。

## 破坏性变更

- 删除 HTTP 端点：`GET/PUT /api/settings/ui`、`/status`、`/kanban`、`/llm` → 前端新端点 / 兼容只读 `GET /api/settings/cli-bins`。
- 删除服务端独立文件：`ui-settings.json`/`cli-bins.json`/`status-config.json`/`kanban-config.json`/`llm.json` → `~/.agentlray/settings.json`（首启自动迁移，无需手工）。
- 移除导出：`lib/config-store.js`（`createConfigStore`/`settingsResult`）、`LLM_CONFIG_FILE`/`CLI_BINS_FILE`/`STATUS_CONFIG_FILE`/`KANBAN_CONFIG_FILE`/`UI_SETTINGS_FILE` 常量。
- `lib/llm.js` 不再自身原子写（统一走 `lib/settings.js` 原子写）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 单一 `settings.json` + 五 section | ✅ 已实现 | `lib/settings.js` |
| `GET/PUT /api/settings` | ✅ 已实现 | `lib/routes/settings.js` |
| 公用 Save/Reset | ✅ 已实现 | `frontend/src/components/SettingsDialog.tsx` |

