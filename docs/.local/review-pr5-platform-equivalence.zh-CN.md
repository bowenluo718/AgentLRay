This is by an automated agent, not a human.

评审对象：PR #5 当前 head `02e520f`（81 文件，+5709/−2948）。按优先级列出必须修改项，每项给出证据位置与原因。评审过程中也在本机复跑了测试，PR 描述里的「591 pass / 0 fail」无法复现（P1-3）。

## P0 — 必须先修，否则合入即回归/旗舰功能不可用

**1. 停用平台后前端整条链路静默失效，且无法在页面内恢复**
- 现象（已在隔离环境实测，见下方 Before 截图）：`settings.platforms.disabled` 含 `gemini`/`codex` 并重启后，`GET /api/gemini/sessions` 落到 `/api/:platform/*` 的 SPA 兜底（200 `text/html`），会话视图显示「全部平台（5）」且没有 gemini/codex 的任何条目或说明；设置 → 平台页签里两者却仍显示「停用」，**没有任何「启用」入口**。
- 根因：`lib/platforms/index.js:52-54` 的 `PLATFORMS` 只含已挂载平台；`frontend/src/components/SettingsDialog.tsx` 的 `PlatformSection` 遍历 `store.platforms`（= `PLATFORMS`），`store.setPlatforms` 会剔除已停用平台；`frontend/src/views/sessions/queries.ts` 的 `usePlatforms` 是 `staleTime: Infinity`。
- 影响：ADR-0005「per-platform 启停」是本 PR 的核心交付，用户一旦停用就只能手改 `settings.json` 恢复；「停用」在 HTTP 层还表现为 200 HTML 而非结构化错误。
- 修法：结构化 404（`platformIssue.code='disabled'` + 提示重启后生效）＋ 平台页签读 `GET /api/platforms` 全量（含 disabled/broken）。

**2. 设置面板「平台」页签的「置换」按钮语义倒置，且没有撤销替代**
- 现状：任意包内置平台都渲染「置换」按钮，点击即 `PUT /api/platforms/:id/replace`，**没有任何同 id 适配器**——结果是该 id 被永久记为 `replacementPending`，且 UI 没有撤销替代；反过来同 id 适配器已替换成功（`overrides: 'package'`）时也没有撤销按钮。
- 影响：一次误点把平台锁进「替代待生效」，需手改 `settings.json` 恢复；与文档中「先声明后覆盖」的语义不一致。
- 修法：PlatformInfo 下发表述「是否已声明替代」（`replaced`），按钮改为仅在有声明时出现的「撤销替代」。

## P1 — 设计目标未达成 / 测试不可复现

**3. 测试不可复现：PR 声称 591 pass / 0 fail，PR head 上实测 591 中 9 fail**
- 本机在 PR head（未叠加本评审任何改动）执行 `npm test`：**591 tests / 582 pass / 9 fail**。其中 8 个与测试环境无关：dsh 版本化夹具缺失（`test/fixtures/home/.dsh/sessions/…v3/v4…` 未入库）、`GET /api/backup` 漏归档 3 个 dsh 文件、openclaw/omp 卸载后的 legacy 别名仍在按「SPA 回落」断言（PR 自己新增的 `/api/:platform/*` 通配层已把它变成 404）。
- 另有 1 个依赖本机配置（下面的 P1-4）。
- 影响：`npm test` 在当前 PR 上恒为红，后续任何回归都会被噪声掩盖。修法与证据见文末「本评审提交的修改」。

**4. 测试隔离缺口：`AGENTLRAY_NO_PLUGINS` 与平台目录**
- `test/helpers.js::serverEnv` 没有隔离 `AGENTLRAY_NO_PLUGINS`；`test/session-cli.test.js` 的 CLI 子进程的 `AGENTLRAY_PLATFORMS_DIR` 也未隔离。本机 `~/.agentlray/platforms/co-mind.js` 会被加载，`registry.test.js` 已有同类缺口修复，其他用例仍可能读到本机平台配置。
- 具体表现：`sessions resume` 的 omp 持有实例检测按 `--resume <id>` 子串扫描 `/proc`，同机 agent 进程自身执行的 `agentlray` 命令就会命中，导致用例时红时绿。
- 修法：所有派生 server/CLI 子进程的用例都显式设置平台目录与 `AGENTLRAY_NO_PLUGINS`；本评审在 `lib/platforms/omp-resume-impl.js` 增加 `AGENTLRAY_SELF_CMDLINE_MARKERS` 自身进程排除，并在 `test/session-cli.test.js` 注入该标记。

**5. 「全表面等价」「核心代码不再出现平台 id 分支」未兑现**
- `lib/search.js:29-116`：`DIR_PARAMS` 硬编码 6 个内置 id；自定义平台永远不在搜索范围内；`byPlatform.get('openclaw'/'codex'/…)` 逐平台分支；Hermes 走 `platform === 'hermes'` 的 SQLite 分支。
- `lib/insights.js:24`、`lib/prompts.js:57,200`、`lib/routes/insights.js:78` 同样保留 `'hermes'` / 内置 id 分支。
- 「hook 优先，否则 collectFiles + 通用实现」未落地：`insights.js` / `prompts.js` / `tool-audit.js` 都只调 `collectFiles`，不检查 `computeInsights` / `extractPrompts` / `scanToolAuditFile` 之类 hook；`lib/backup.js:13-33` 仍把 codex/claude-code/omp/dsh/gemini 的备份函数写死（新建的 `backupFiles` hook 无人调用），自定义平台在「分析 / Prompts / 工具审计 / 备份」四个表面上没有数据。
- 修法：遍历 catalog 而非固定表，按 hook 派发，通用实现走 `collectFiles`；备份按 catalog 调用 `backupFiles`。

## P2 — 契约与交互问题

**6. 已挂载平台缺少某项能力时，通用路由回落 SPA（200 HTML）而不是 JSON**
- 例：`/api/claude-code/agents`（无 `listAgents`）、`/api/codex/sessions/x/children`（无 children）都返回 `index.html` 200，前端只能显示「无数据/无响应」。已在本次评审中改为统一 404 JSON（`platformIssue.code='capability-missing'`），并同步修改了 `test/platform-extra-routes.test.js` 里按旧语义（SPA 回落）写的断言。

**7. `platform validate` 与加载器口径不一致**
- `bin/platform.js:167-192`：`validateAdapter(adapter, PLATFORMS)` 会拒绝与内置同 id 的「待替换适配器」；同时强制 `adapter.list(defaultDir())`，而 openclaw 的 `list` 为 `null`（loader 明确允许）。即「被替换的适配器」和「list 为空的平台」都无法通过 `validate`，与文档「复用加载器同一套校验」不符。

**8. CLI/HTTP 错误信息把「已停用」报成「Unknown platform」**
- `bin/sessions.js:131-139`、`lib/session-list.js:28-34`：`--platform gemini`（已停用）与拼错 id 同样报 `Unknown platform 'gemini'`。已在本次评审中改为「当前未挂载（已在平台管理中停用或替代待生效）：重启后生效，可用 agentlray platform mount <id> 恢复」。

## P3 — 建议（不阻断）

**9. `/api/settings` 的 `ui` section 会被整体覆盖**
- `lib/ui-settings.js::saveUiSettings` 只写 `{platform, selectedPlatforms}`；而前端 `store.persistState` 只同步这两个字段、`Save` 按钮（`buildPatch`）不同步 `ui`。结果是：若在设置面板改了「数据目录」再点 Save，`ui` 不会被触碰；但若先改目录、再切平台，`ui` 会整体重写——两个来源互相覆盖。建议在 PR 描述里说明预期优先级，或统一到单一写入路径。

**10. legacy `isMounted('openclaw')` 顶层 shim**
- `lib/routes/sessions.js:310-420` 仍在 `isMounted('openclaw')` 下挂载 `/api/agents*`、`/api/spawn-*`；openclaw 一旦停用，legacy 前端（`public/js/app.js`，支持自定义平台）会直接失去这些能力。建议在文档中写明「仅 openclaw 保留、停用后 404」的生命周期。

**11. `platform export` 薄适配器依赖 `AGENTLRAY_PKG_ROOT`**
- `bin/platform.js:265-273`：导出的薄适配器通过 `AGENTLRAY_PKG_ROOT` 定位包内实现，该变量由 loader 在 `require` 期写入；若被外部脚本直接 require 会抛错。建议在 `docs/usage.zh-CN.md` 的 export 章节注明这一前提。

## 本评审已提交的修改（用于验证上述判断，不替代请求的评审结论）

分支 `review-report-platform-equivalence`（commit `5161af9`，基于本 PR head `02e520f`），可单独评审；改动点概览：

- `lib/routes/sessions.js`：所有 `/api/:platform` 处理器入口加 `unmountedIssue()`（未挂载平台 → 404 `code=disabled`/`replacement-pending`）与 `capabilityGap()`（能力缺失 → 404 `code=capability-missing`），不再回落 SPA。
- `lib/routes/platforms.js`：mount/replace 写操作成功响应改为 `GET /api/platforms` 同形状，前端可直接复用。
- `lib/platforms/index.js` + `frontend/src/api/types.ts`：`PlatformInfo.replaced` 下发替代声明。
- `frontend/src/components/SettingsDialog.tsx`：平台页签读 `GET /api/platforms` 全量、切换按 `configuredMounted` 发、挂载刷新 store 与本地查询缓存；「平台 CLI 命令」tab 不再按置位后的 `resume` 过滤（自定义平台总是置位，导致内建 dsh/omp 行丢失）。
- `bin/sessions.js`、`lib/session-list.js`：停了/待生效的平台给出可恢复的报错文案。
- `lib/platforms/omp-resume-impl.js` + `test/session-cli.test.js`：持有实例检测排除「本工具自身进程树」的附加标记（`AGENTLRAY_SELF_CMDLINE_MARKERS`），消除测试对同机 agent 进程的偶然命中。
- 测试：`test/platform-mount.api.test.js`（新响应形状）、`test/platform-extra-routes.test.js`（结构化 404）、`test/platforms.test.js`（新增 `replaced` 字段）、新增 `test/platform-disabled-route.test.js`。
- 说明：`test/fixtures/home/.dsh` 的版本化夹具、以及 `sessions resume` 的两个用例失败与本机环境/夹具有关，未在本评审中改动。

## 验证

- 本评审分支 `npm test`：**593 tests / 591 pass / 2 fail**，其余 591 全绿。剩余 2 个失败是 `sessions resume` 的 dsh 用例，原因是本机 `~/.dsh/sessions` 环境变量未设置、`config.js` 退回到 `os.homedir()` 的 dsh 目录而非夹具（`serverEnv`/`runCli` 未设 `DSH_DIR`），**与本 PR 代码无关**，在未修改的 master 上同样失败；PR head 上同一用例为 9 fail。
- `frontend`：`tsc -b` 通过、`vite build` 通过。
- 停用平台端到端：隔离 HOME 下 `settings.platforms.disabled=["gemini"]` 后 `GET /api/gemini/sessions` → 404 `{"error":"…已在平台管理中停用…","platformIssue":{"code":"disabled"}}`；`GET /api/codex/sessions` 正常 200。

## 视觉证据

同一隔离 HOME（`settings.platforms.disabled = ["gemini","codex"]`）、同一视口（672×658 对话框截图区间）、同一主题（浅色），仅代码版本不同：Before = PR #5 head `02e520f`；After = 本评审分支最新提交。

### 设置 → 平台页签（停用平台无法在页面内恢复）

Before（`02e520f`）：
![before-platforms](before-platforms-tab.png)

After：
![after-platforms](after-platforms-tab.png)

### 设置 → 平台 CLI 命令页签（停用 codex/gemini 后 dsh/omp 行消失）

Before（`02e520f`）：
![before-clibins](before-clibins-tab.png)

After：
![after-clibins](after-clibins-tab.png)
