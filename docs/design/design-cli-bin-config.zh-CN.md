# 平台 CLI 命令可配置（web 设置面板 + 环境变量 + 默认名）

> 类型：方案设计 · 日期：2026-10-26 · 关联：`bin/sessions.js resume --run`、`lib/config.js`、设置面板 `SettingsDialog.tsx`

## 背景

`agentlray sessions resume --run` 会 spawn 各平台原生 CLI（codex / claude / omp）续跑会话。此前可执行命令名硬编码在 `bin/sessions.js` 的 `RESUME_BINS`，唯一覆盖手段是 `AGENTLRAY_*_BIN` 环境变量。当 CLI 不在 `PATH`（如 nvm 安装的 claude）时无法便捷配置，web 界面也无入口。

## 目标

1. web 设置面板新增「平台 CLI 命令」分区，可配置 codex / claude-code / omp 的可执行命令（绝对路径）。
2. 解析优先级：**环境变量 > 服务端配置文件（web 面板写入）> 默认命令名**。
3. 配置存服务端 `~/.agentlray/cli-bins.json`（仿 `ui-settings.json` / `llm.json`），CLI 与 web 后端共享，保证终端续跑与页面视角一致。

## 改动

### 后端

- **`lib/cli-bins.js`（新）**：`CLI_BIN_DEFAULTS`（平台→默认命令名）、`CLI_BIN_ENV`（平台→环境变量名）、`CLI_BINS_FILE`；`loadCliBins()`/`saveCliBins()`（白名单过滤、空串=清除）、`resolveCliBin(platformId)`（env → file → default）。
- **`lib/routes/cli-bins.js`（新）**：`GET/PUT /api/settings/cli-bins`。GET 返回 `{platform:{bin,configured,default}}`；PUT 白名单过滤后落盘，空串=清除。
- **`server.js`**：挂载 `mountCliBinsRoutes(app)`。
- **`bin/sessions.js`**：`RESUME_BINS` 去掉静态 `bin`，只留 `args` 生成器；`resumeSession()` 内 `const bin = await resolveCliBin(platform.id)`，所有 `spec.bin` 引用改用 `bin`。

### 前端

- **`frontend/src/api/client.ts`**：新增 `CliBinSetting`/`CliBins` 类型、`getCliBins()`/`saveCliBins()`。
- **`frontend/src/components/SettingsDialog.tsx`**：新增 `CliBinsSection`（三个输入框 + 默认名/已配置标记 + 保存，独立 draft/save，存服务端）。
- **`frontend/src/views/sessions/lib.ts`**：`resumeCommand` 新增可选 `bin` 参数（配置后命令名），未传回退默认命令名。
- **`frontend/src/views/sessions/SessionSummary.tsx`**：`ResumeButton` 用 `useQuery` 读 `getCliBins()`，取 `cliBins[platform]?.bin` 传给 `resumeCommand`——复制恢复命令使用配置后的命令。
- **`public/js/app.js`**（legacy）：`resumeCmdBtn` 点击时 `fetch('/api/settings/cli-bins')` 取配置 bin，失败回退默认命令名。
- **`frontend/src/demo/router.ts`**：加 `/api/settings/cli-bins` DEMO 兜底。

## 验证

- `test/api.test.js` 新增 `cli-bins settings persist`：GET 默认、PUT 落盘 + 白名单过滤 + 空串清除、非白名单/非字符串忽略（37 pass）。
- `test/session-cli.test.js` 新增「读取 web 面板写入的 cli-bins.json」：无环境变量读文件、omp 未配置回退默认、环境变量优先（25 pass）。
- 全量测试逐文件 429 例全过。
- 端到端冒烟：真实 server `PUT /api/settings/cli-bins` → 同一 HOME 的 CLI `resume --json` 输出 `bin` 为配置值。
- 前端 `tsc -b` 与 `vite build` 通过。

## 边界

- 仅 codex / claude-code / omp（有原生 resume 契约的平台）可配置；其余平台在 `saveCliBins` 白名单外被忽略。
- 前端（React `ResumeButton` 与 legacy `resumeCmdBtn`）的「复制恢复命令」均读取配置后的命令名；读取失败或未配置时回退默认命令名，与后端 `resolveCliBin` 优先级一致。
- `lib/platforms/openclaw.js` 中 `codex `/`claude ` 字样是扫描用户日志做 spawn 关系推断的启发式字符串，非命令生成，未改动。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（后续并入 settings.json `cliBins` section）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| CLI 命令可配置 | ✅ 已实现 | `lib/cli-bins.js`、`lib/routes/cli-bins.js` |
| 解析优先级 env > 配置 > 默认名 | ✅ 已实现 | `lib/cli-bins.js` |
| 设置面板入口 | ✅ 已实现 | `frontend/src/components/SettingsDialog.tsx` |

**后续演进（与本文档 §边界 的差异）**：

- 白名单不再是「仅 codex / claude-code / omp」：`saveCliBins` 只接受**已挂载且声明了 `bin` 的平台**（内置 codex / claude-code / omp / gemini / hermes；dsh 无 resume/create 故不声明 `bin`；自定义平台按自身声明自动纳入）。
- 默认命令名不再有模块级 `CLI_BIN_DEFAULTS` 常量表，改由已挂载平台的 `bin` 声明推导（`cliBinDefaults()`）。
- 独立 `GET/PUT /api/settings/cli-bins` 已并入统一 `/api/settings`（`cliBins` section）；`~/.agentlray/cli-bins.json` 已迁移进 `~/.agentlray/settings.json`。仅保留 `GET /api/settings/cli-bins` 只读兼容端点。
- legacy 前端（`public/js/app.js`）已于 2026-11-08（`f7c446f`）移除。

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
