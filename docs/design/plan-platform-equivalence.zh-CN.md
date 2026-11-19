# 实施计划：平台来源统一与全表面等价（platform equivalence v2）

> 设计依据：[design-platform-equivalence.zh-CN.md](design-platform-equivalence.zh-CN.md)（D1–D10）。
> 基线：当前工作区（含自定义平台 P0–P5、会话状态、openclaw 全 agent、新建会话等已合入改动）。
> 原则：
> - 每阶段先跑该阶段的**特征化测试**与最小回归，再进下一阶段；
> - 默认空配置行为零回归；内置平台命令串逐字不变；
> - **不修改** `public/js/app.js`（legacy 冻结快照）与 `src/generated/`；
> - 所有写设置/平台的测试使用临时 `AGENTLRAY_HOME`，禁止触碰真实 `~/.agentlray`；
> - 严格按设计的模块规则拆 `*-impl.js`，避免 require 环。

---

## 阶段总览

| 阶段 | 目标 | 主要风险 | 完成标志 |
| --- | --- | --- | --- |
| P0 | 来源模型、catalog、disabled/replaced、控制面、默认平台、测试隔离 | require 期同步读、守卫数据源 | 空配置零回归；mount/unmount REST/CLI 可用 |
| P1 | 7 个内置 adapter 文件化 + 声明字段 + contracts + 模块拆分脚手架 | require 环、命令串漂移 | 旧表删除后 `npm test` 全绿 |
| P2 | 会话核心面：列表/详情/聚合/agents/children/spawn/watch | openclaw/hermes 语义 | 核心代码无内置 id 特判（除兼容别名） |
| P3 | 分析与导出面：search/insights/prompts/tool-audit/OTLP/backup/inspect | 特征化回归 | 各表面内置/自定义同一路径 |
| P4 | 项目来源 + `platform export` 迁移 | 覆盖/替代语义、包根解析 | 双向迁移端到端可用 |
| P5 | 前端全量等价：动态平台/目录/能力/设置面板 | 状态收敛、重启语义 | build/lint/demo 通过 |
| P6 | 文档、ADR、legacy 回归、全量测试 | 文档漂移 | 全量 `npm test` + 人工冒烟 |

> P0–P1 可以先合并（行为保持）；P2–P3 是最大重构，建议分开评审；P4–P5 依赖 P0–P3；P6 收尾。

---

## P0 — 来源模型与配置基础（行为保持）

### 目标

建立三来源加载、catalog、disabled/replaced、控制面、默认平台、测试隔离；此阶段**不改变任何表面行为**（空配置下等价于现状）。

### 任务

1. **`lib/platform-config.js`**（新增）
   - `readPlatformStateSync()`：`fs.readFileSync(SETTINGS_FILE)` + `JSON.parse`，取 `platforms.disabled/replaced`，按 `ID_RE` 过滤、去重、容错缺失/损坏 → `{ disabled: [], replaced: [] }`；这是 registry 唯一 require 期同步读。
   - `loadPlatformSection()`（async）/ `savePlatformSection(section)`（`saveSections`）。
   - `setPlatformMounted(id, mounted, catalog)`：校验 id ∈ catalog → 更新 disabled → 守卫（`catalog − (disabled ∪ {id})` 至少 1 个可查询平台）→ 落盘 → 返回 `{ id, mounted, restart: true }`。
   - `setPlatformReplaced(id, replaced, catalog)`：更新 `replaced`。
   - 不 require `lib/platforms`（catalog 由参数传入），避免环。
2. **`lib/platforms/contracts.js`**（新增）
   - `hasResumeContract(p)` / `hasCreateContract(p)` / `capabilityBits(p)`；从 `lib/resume.js`、`lib/new.js`、`lib/platforms/index.js` 抽出。
   - `resolveCliBin` 相关默认名逻辑留在 `cli-bins.js`。
3. **`lib/platforms/loader.js`** 扩展
   - 支持三类来源：package（由 index 传入）、project（`AGENTLRAY_PROJECT_PLATFORMS_DIR` 或 `<repo>/platforms`）、user（`AGENTLRAY_PLATFORMS_DIR` 或 `~/.agentlray/platforms`）。
   - 加载前设置 `process.env.AGENTLRAY_PKG_ROOT = path.resolve(__dirname, '..', '..')`。
   - `loadPlatformSources({ packageAdapters, disabled, replaced })` → `{ catalog, broken }`：
     - 按 §2.2/§2.3 处理同 id：新 id 加入；同来源重复 broken；project/user 覆盖 package 仅当 `replaced.has(id)`；user 覆盖 project 允许；
     - 记录 `origin`、`overrides`、`replacementPending`；
     - `AGENTLRAY_NO_PLUGINS=1` 跳过 project+user，只保留 package；
     - 单文件 try/catch 隔离。
   - `validateAdapter(adapter, catalog, { replaced })`：放宽 `parse` 可为 null；同 id 规则支持 replaced；错误文案包含“先 export/replace”提示。
4. **`lib/platforms/index.js`** 重构
   - 包内置数组（本阶段仍内联，P1 再迁移）→ `readPlatformStateSync()` → `loadPlatformSources` → `PLATFORMS`（过滤 disabled）→ 导出 `ALL_PLATFORMS`、`PLATFORMS`、`BROKEN`、`isMounted`、`defaultPlatformId`、`listPlatformInfo(options)`。
   - `listPlatformInfo` **遍历 catalog**（含 disabled），计算 `mounted`/`configuredMounted`/`restartRequired`；broken 追加。
   - `collectSessionFiles` 不变。
5. **`lib/routes/platforms.js`**
   - `GET /api/platforms`：读取最新 `platforms` section → `listPlatformInfo({ configured: true })`。
   - `PUT/DELETE /api/platforms/:id/mount` → `setPlatformMounted`；422 守卫；404 未知 id。
   - 可选 `PUT/DELETE /api/platforms/:id/replace`。
6. **`bin/platform.js`**
   - `list` 输出来源（Builtin/Project/Custom）+ mounted/configured；`--json` 加字段。
   - 新增 `mount/unmount/replace/unreplace` 子命令；复用 `setPlatformMounted` / `setPlatformReplaced`；输出“重启后生效”。
   - `validate` 使用新 `validateAdapter` 签名。
7. **`lib/routes/sessions.js`、`lib/routes/prompts.js`、`lib/routes/insights.js`、`lib/routes/watch.js`**
   - 所有 `req.query.platform || 'openclaw'` 改为 `defaultPlatformId()`；`GET /api/sessions` 缺省可用 `all` 或首个可查询平台。
   - `lib/routes/settings.js` 的 ui 白名单改为 catalog（含 disabled），避免禁用平台后 PUT 静默 400；`GET /api/settings` 增加 `platforms`（只读）。
8. **测试隔离**
   - 新增 `test/setup-env.cjs`：在测试进程启动时设置 `AGENTLRAY_HOME` 到临时目录、`AGENTLRAY_PROJECT_PLATFORMS_DIR` 到空目录、`AGENTLRAY_PLATFORMS_DIR` 到空目录（或复用 `test/fixtures/home`）。
   - `package.json` 的 `test` 脚本改为 `node --require ./test/setup-env.cjs --test test/*.test.js`。
   - `test/helpers.js` 的 `serverEnv` 补 `AGENTLRAY_PROJECT_PLATFORMS_DIR` / `AGENTLRAY_PLATFORMS_DIR`（指向临时目录）。
9. **新增测试**
   - `test/platform-config.test.js`：缺失/损坏/非法 id、round-trip、守卫（连续 unmount 仍拒）、disabled/replaced 优先级。
   - `test/platform-loader.test.js`：三类来源、同 id、replaced、replacementPending、broken 隔离、`AGENTLRAY_NO_PLUGINS`。
   - `test/platform-mount.api.test.js`：预写 disabled/replaced → 三态字段、路由 404、聚合不含 disabled、PUT/DELETE 落盘、同进程仍旧状态、重启后生效。
   - `test/platform-default.test.js`：禁用 openclaw 后缺省路由回退。

### 验证

```bash
npm test
AGENTLRAY_HOME=$(mktemp -d) node server.js   # 手工 curl /api/platforms、PUT/DELETE mount
```

空配置下 `PLATFORMS` 仍为 7 平台、顺序不变；`registry.test.js` 通过；mount/unmount 只在重启后改变 `PLATFORMS`。

---

## P1 — 内置 adapter 文件化与声明

### 目标

把 7 个内置平台拆到 `lib/platforms/builtin/*.js`，补齐声明字段；删除 `RESUME_BINS`/`NEW_BINS`/`CLI_BIN_DEFAULTS`/`CLI_BIN_ENV`；建立 `*-impl.js` 模块边界。行为保持。

### 任务

1. **`lib/platforms/builtin/*.js` ×7**
   - 逐字搬迁 `lib/platforms/index.js` 的 adapter 对象；openclaw 的 `needsAgent`/collectFiles/watchParse；hermes 的 SQLite 能力。
   - 新增声明：
     - `resume`：从 `lib/resume.js` 的 `RESUME_BINS` 平移（codex / claude-code / omp / dsh / gemini / hermes；openclaw 不声明）；
     - `create`：从 `lib/new.js` 的 `NEW_BINS` 平移（codex / claude-code / omp / gemini / hermes；dsh 不声明）；
     - `bin`：codex→`codex`、claude-code→`claude`、omp→`omp`、dsh→`dsh`、gemini→`gemini`、hermes→`hermes`、openclaw→`null`；
     - `dirSettingKey` / `dirSettingLabel` / `dirSettingHint` / `dirParam`：按现网映射（`claude-code` 的 `dirParam` 必须是 `dirClaude`）；
     - `color`：可选，取前端现有色值（CmdkDialog map）。
   - args 一律内联在 adapter 文件，禁止 require `resume.js`/`new.js`/`cli-bins.js`/`index.js`。
2. **`lib/platforms/index.js`**
   - 改为 require builtin ×7 + 组装 catalog；删除内联对象与 `fileBasedGetSession`（移到 `shared.js`）。
   - `PLATFORMS` 插入序保持 openclaw, codex, claude-code, omp, dsh, gemini, hermes。
   - 扩展 `capabilityBits(p)`：除现有 `list/find/parse/getSession/collectFiles/watch` 外，映射 `listForAgent/listAllAgents/listAgents/children/spawn/watch/search/insights/prompts/toolAudit/backup/inspect/otlp`（存在对应 hook 即为 true）；`PlatformInfo.capabilities` 统一由此生成，前端只读能力位、不猜 id。
3. **`lib/resume.js` / `lib/new.js`**
   - 删除 `RESUME_BINS`/`NEW_BINS`；`hasResumeContract`/`hasCreateContract` 改从 `contracts.js`；`buildResumeCommand`/`buildNewCommand` 统一走 adapter 声明；错误文案数据驱动。
4. **`lib/cli-bins.js`**
   - 删除 `CLI_BIN_DEFAULTS`/`CLI_BIN_ENV`；新增 `cliBinDefaults()` 遍历已挂载 `PLATFORMS` 的 `p.bin`（null 跳过）；`loadCliBins`/`saveCliBins`/`resolveCliBin` 适配。
   - `resolveCliBin(platformId, fallbackDefault)`：fallback 优先 `platform.bin`、其次 `resume/create.bin`。
5. **`lib/routes/settings.js` / `lib/routes/cli-bins.js`**
   - 改遍历 `cliBinDefaults()`；响应 `default` 用 `p.bin`。
6. **模块边界（P3 的前置脚手架）**
   - 建空/迁移 `lib/platforms/search-impl.js`、`prompts-impl.js`、`insights-impl.js`、`tool-audit-impl.js`、`backup-impl.js`、`inspect-impl.js`；本阶段只做“函数搬家 + 原模块 re-export”，不改行为。
   - 校验 `*-impl.js` 不 require registry。
7. **测试**
   - `test/platform-adapter-contracts.test.js`：7 个内置 adapter 的 resume/create/bin/dir 与旧表逐字对齐；插入序一致；capabilityBits 正确。
   - `test/new.test.js`：删除 `NEW_BINS` import，命令串断言逐字保留。
   - `test/cli-bins.test.js`（若有）：改 import。
   - `test/registry.test.js`：确认 `PLATFORMS` 7 平台、能力位不变。
8. **子进程 require 环测试**
   - `node -e "require('./lib/platforms'); require('./lib/resume'); require('./lib/new'); require('./lib/cli-bins'); require('./lib/export'); require('./lib/otlp'); require('./lib/tool-audit'); require('./lib/search'); require('./lib/prompts'); require('./lib/insights'); require('./lib/backup'); require('./lib/inspect')"` 必须成功。

### 验证

```bash
npm test
node -e "..."   # 环测试
node bin/agentlray.js platform list
```

命令串逐字不变；`platform list` 输出仍为 7 平台。

---

## P2 — 会话核心面泛化

### 目标

让列表/详情/聚合/agents/children/spawn/watch 全部走 adapter hook；核心代码只剩 openclaw 兼容别名 shim。

### 任务

1. **`lib/platforms/builtin/openclaw.js`**
   - 声明 `needsAgent: true`、`listForAgent`、`listAllAgents`、`listAgents`、`getSession`、`getSessionAcrossAgents`、`find`、`parse`、`collectFiles`、`watchParse`。
   - `listAllAgents` 的合并/排序逻辑从 `lib/session-list.js::listOpenclawSessionsFlat` 迁入（可复用 `lib/status.js` 的 `sortSessionsByStatusGroups`）。
2. **`lib/platforms/builtin/omp.js` / `claude-code.js`**
   - 新增 `listChildren` / `getChild`，把 `lib/routes/sessions.js` 的两条 children 路由体迁入（`parseOmpSessionMetadata`/`findOmpSpawnDir`、`parseClaudeCodeSessionMetadata`/`findClaudeSpawnDir` 等）。
3. **`lib/platforms/builtin/openclaw.js`**
   - 新增 `spawnMap` / `spawnTree`，把 `buildSpawnMap`/`buildSpawnTree` 从 `lib/platforms/openclaw.js` 包装进来。
   - 新增 `listAgents`（`readAgents`）。
4. **`lib/platforms/builtin/hermes.js`**
   - 新增 `watch(req, res, ctx)`：把 `lib/routes/watch.js::watchHermes` 整体迁入（或抽到 `lib/platforms/watch-impl.js` 再包装）。
5. **`lib/routes/sessions.js`**
   - 通用 `/api/:platform/sessions`、`/api/:platform/sessions/:id`：按 `platform.needsAgent` + hooks 分支；不再出现 `'openclaw'` 字符串。
   - 新增通用 `/api/:platform/agents`、`/api/:platform/agents/:name/sessions`、`/api/:platform/agents/:name/sessions/:id`（capability `listAgents`/`listForAgent`）。
   - 新增通用 `/api/:platform/sessions/:id/children`、`/children/:name`（capability `children`）。
   - 新增通用 `/api/:platform/spawn-map`、`/api/:platform/spawn-tree`、`/api/:platform/spawn-tree/:id`（capability `spawn`）。
   - 保留顶层 `/api/agents*`、`/api/spawn-*` 作为兼容别名：仅当 `PLATFORMS.openclaw` 存在时挂载，内部委托 openclaw hooks。
   - 删除 `PER_PLATFORM_DIR_PARAM`，按 `dirParam` 收集 query。
6. **`lib/session-list.js`**
   - `listPlatformSessions` 的 openclaw 分支改为 `platform.needsAgent` + `listForAgent`/`listAllAgents`；删除 `id === 'openclaw'`。
   - `listOpenclawSessionsFlat` 保留为兼容导出（委托 `PLATFORMS.openclaw.listAllAgents` 或 openclaw adapter），或标记废弃并更新调用方。
7. **`lib/routes/watch.js`**
   - 平台解析后：`if (platform.watch) return platform.watch(req,res,ctx)`；否则 `find + watchParse` 通用文件尾随；删除 `platformId === 'hermes'` 分支。
8. **`bin/sessions.js`**
   - `listSinglePlatform` 的 `id === 'openclaw'` → `platform.needsAgent` + `listAllAgents`/`listForAgent`。
   - resume 的 omp 专属逻辑改为 `platform.resumeHooks?.prepare/after`；把 `liveOmpPidForSession`/`terminateOmpHolder`/`findOmpFork` 迁入 `lib/platforms/omp-resume-impl.js` 或 builtin/omp.js。
   - 缺省平台用 `defaultPlatformId()`。
9. **测试**
   - `test/platform-extra-routes.test.js`：children/spawn/agents 通用路由；禁用 omp/openclaw 后 404；顶层别名随 openclaw 卸载消失。
   - `test/session-cli.test.js`：omp resume 守卫行为不变。
   - `test/registry.test.js`：openclaw 能力位新增 hooks。

### 验证

```bash
npm test
node bin/agentlray.js sessions list --platform all
node -e "grep 断言：lib/routes/sessions.js、lib/session-list.js 中不应再出现 'openclaw'"
```

---

## P3 — 分析与导出面泛化

### 目标

search/insights/prompts/tool-audit/OTLP/backup/inspect 全部按 hook 驱动；内置/自定义同一路径。

### 任务

1. **`lib/platforms/search-impl.js`**
   - 从 `lib/search.js` 迁出 `searchJsonlFile`/`searchDshFile`/`searchGeminiFile`/`searchHermesSessions`/`searchClaudeHistory` 等纯函数。
   - `lib/search.js` 只保留编排：按 `dirParam` 取目录；`platform.search` 优先；否则 `collectFiles` + `platform.searchFile || searchJsonlFile`；`platform.searchSupplement` 追加；`all` 按 `PLATFORMS` 顺序。
   - 删除 `DIR_PARAMS` 与 hermes/claude id 分支。
2. **`lib/platforms/insights-impl.js`**
   - 迁出 `scanFileForInsights`、`openHermesDb`、`scanHermesSessionForInsights`、`buildInsightsResponse` 等纯函数。
   - `lib/insights.js`：`platform.computeInsights` 优先；否则 `collectFiles` + `platform.insightsScanFile || scanFileForInsights`；删除 `platform === 'hermes'` 分支。
3. **`lib/platforms/prompts-impl.js`**
   - 迁出 `extractOpenClawPrompts`/`extractCodexPrompts`/`extractClaudeCodePrompts`/`extractOmpPrompts`/`extractDshPrompts`/`extractGeminiPrompts`/`extractGenericJsonlPrompts`/`extractHermesPromptGroups`。
   - `lib/prompts.js`：`platform.extractPrompts` 优先；否则 `collectFiles` + `platform.extractPromptsFromFile || extractGenericJsonlPrompts`；删除 id switch。
   - 各 builtin adapter 引用对应 extractor（通过 `extractPromptsFromFile` 或 `extractPrompts`）。
4. **`lib/platforms/tool-audit-impl.js`**
   - 迁出 `scanFileForToolAudit` 等纯函数。
   - `lib/tool-audit.js`：`TOOL_AUDIT_PLATFORMS` = 已挂载且（`collectFiles` 或 `computeToolAudit`）的平台；`platform.computeToolAudit` 优先；否则 `collectFiles` + `platform.scanToolAuditFile || scanFileForToolAudit`。
5. **`lib/otlp.js`**
   - `OTLP_PLATFORMS` = 已挂载且（`otlpSession` 或 `find+parse && !needsAgent`）。
   - 路由优先 `platform.otlpSession`；否则现有 find+parse。
   - Hermes 若实现 `otlpSession` 则纳入；不实现则能力位 false（与现状一致）。
6. **`lib/export.js`**
   - 已是 registry getSession；确认无 id 分支；`EXPORT_PLATFORMS` 只含 `getSession` 的已挂载平台。
7. **`lib/platforms/backup-impl.js`**
   - 迁出 `backupCodex`/`backupClaudeCode`/`backupOmp`/`backupDsh`/`backupGemini` 的文件枚举/复制逻辑。
   - `lib/backup.js`：遍历已挂载且声明 `backupFiles` 的平台，复制到 `<ARCHIVE_DIR>/<id>/<rel>`；`byPlatform` 键动态；删除固定 5 平台表。
   - openclaw/hermes 不声明 `backupFiles`（与现状一致：不备份）。
8. **`lib/platforms/inspect-impl.js` + `lib/inspect.js`**
   - 迁出 `rawToolEntries` 的 id 分支与 `normalizers` 表；每个 builtin adapter 声明 `inspect: { normalizeRecord, rawToolEntries, adapterFiles }`（omp 的 `adapterFiles` 含 `omp.js`/`omp-outcome.js`）。
   - `lib/inspect.js`：从 registry 解析 `PLATFORMS[platform]`，要求 `inspect` hook；删除 `PLATFORMS = ['omp','codex','claude-code']` 与 normalizer 表。
   - `lib/inspect-detail.js` 同步改为从 registry 解析。
   - `bin/inspect.js` 帮助文案改为“任意已挂载且声明 inspect 的平台”。
9. **`bin/sessions.js`**：resume/create 错误文案已数据驱动；确认无 id 分支。
10. **特征化测试（先于重构）**
    - 用 `test/fixtures/home` 的内置平台数据，固定输入，记录 search/insights/prompts/tool-audit/inspect 的现有输出（快照/逐字断言）。
    - 重构后逐字对齐；新增 `test/platform-analyze-surfaces.test.js` 验证自定义 adapter（可用测试用自定义平台）走同一路径。
11. **测试**
    - `test/search.test.js`、`test/prompts.test.js`、`test/insights.test.js`、`test/tool-audit.test.js`、`test/inspect.test.js`（若存在）全绿。
    - `test/backup.test.js`（若有）：byPlatform 动态键。

### 验证

```bash
npm test
node bin/agentlray.js inspect --platform omp <fixture>
curl /api/search?platform=all&q=...
curl /api/insights?platform=all
```

---

## P4 — 项目来源与迁移

### 目标

让 `<repo>/platforms/` 与 `platform export` 端到端可用；完成双向迁移。

### 任务

1. **项目目录**
   - 确认 P0 的 `AGENTLRAY_PROJECT_PLATFORMS_DIR` 加载逻辑；新增 `<repo>/platforms/README.md`（信任边界、文件格式、manifest 说明）。
   - `package.json` 的 `files` 增加 `"platforms"`。
   - `platforms/manifest.json` 可选 `{ "replaces": ["codex"] }`；loader 读取并与 settings.replaced 合并。
2. **`platform export`**
   - 解析 catalog 有效适配器；仅允许 `origin: package|project`。
   - 生成薄适配器（§6.5 模板）；`--out`/`--force`/`--no-replace`。
   - 默认：
     - 写文件到 `~/.agentlray/platforms/<id>.js`；
     - `settings.replaced` 加入 id；
     - `settings.disabled` 移出 id；
     - 输出信任提示 + “重启后生效”。
   - 文件写入与 settings 写入的顺序：先写临时文件 → 写 settings → rename；失败回滚/提示。
3. **`platform replace/unreplace`**
   - `replace`：settings.replaced 加入 id；`unreplace`：移出；若同 id 用户文件仍存在，提示下次加载会 broken。
4. **用户/项目覆盖语义验证**
   - 同 id 未声明 replaced → broken，错误含 `export/replace` 提示；
   - 声明 replaced + 文件存在 → 覆盖生效，`origin` 正确；
   - 声明 replaced + 文件损坏 → 回退包内置，`replacementPending:true` + broken 条目；
   - disabled + replaced → disabled 优先；
   - user 覆盖 project → user 生效。
5. **测试**
   - `test/platform-export.test.js`：导出内容/包根、自动 replace、`--no-replace`、重复导出、`--force`。
   - `test/platform-project.test.js`：临时项目目录加载、默认挂载、可禁用、manifest replaces。
   - `test/platform-migration.api.test.js`：export codex → 重启 → `/api/platforms` origin=user、`/api/codex/sessions` 可用、`/api/platforms` 显示 overrides=package；删除导出文件 → 回退包内置。
6. **文档**
   - `docs/usage.md` / `docs/usage.zh-CN.md` / `docs/.local/cli-usage.md` 增加 `platform mount/unmount/export/replace`。

### 验证

```bash
tmp=$(mktemp -d); AGENTLRAY_HOME=$tmp node bin/agentlray.js platform export codex --out $tmp/.agentlray/platforms
AGENTLRAY_HOME=$tmp node bin/agentlray.js platform list
AGENTLRAY_HOME=$tmp node server.js  # curl /api/platforms
```

---

## P5 — 前端全量等价

### 目标

前端完全由 `/api/platforms` + capabilities 驱动；动态目录、平台启停、children/spawn/agents 通用化。

### 任务

1. **`frontend/src/api/types.ts`**
   - `PlatformInfo` 增加 `origin/mounted/configuredMounted/restartRequired/overrides/replacementPending/dirSettingKey/dirSettingLabel/dirSettingHint/dirParam/color`；`PlatformCapabilities` 增加 `listForAgent/listAllAgents/listAgents/children/spawn/watch/search/insights/prompts/toolAudit/backup/inspect/otlp`。
2. **`frontend/src/store.ts`**
   - `FALLBACK_PLATFORM_INFOS` 补新字段（`origin:'package'`、`mounted:true`、`dir*`、`color`）；
   - `selectablePlatforms/Ids` 过滤 `mounted !== false`；
   - 删除 `dirForPlatform`，新增 `dirBySettingKey(settings, info)`；
   - `EMPTY_SETTINGS`/`loadPersisted`/`persistState` 支持 `Record<string,string>`（保留内置键，复制所有字符串值）。
3. **`frontend/src/api/client.ts`**
   - 删除 `ALL_DIR_PARAMS`；`getSessionsAll({ platforms, dirsByPlatform, ... })` 按 `dirParam` 组参数；
   - `getSessions/getSessionDetail` 去掉 openclaw 特判，统一 `/api/:platform/sessions?agent=`；
   - `getAgents(platform, dir)` → `/api/:platform/agents`；
   - `getSessionChildren/getSessionChild` → 通用路径；
   - `getSpawnMap(platform, dir)` / `getSpawnTree(platform, sessionId, dir)` → `/api/:platform/spawn-*`；
   - 新增 `setPlatformMounted(id, mounted)`、`setPlatformReplaced(id, replaced)`。
4. **`frontend/src/views/sessions/queries.ts`**
   - `usePlatforms` 解析新字段；`dirsByPlatform` 由 store.platforms + settings 构造；
   - `getSessionsAll` 调用签名更新。
5. **`frontend/src/hooks/usePlatformProbe.ts`**
   - 统一 `getSessions(p, { dir: dirBySettingKey(...) })`；删除 openclaw 分支。
6. **`frontend/src/components/SettingsDialog.tsx`**
   - 删除 `DIR_FIELD_BY_ID` 与 `RESUME_BUILTIN_IDS`；
   - 数据目录 tab 遍历已挂载且有 `dirSettingKey` 的平台；
   - 新增“平台”tab：catalog 行、来源徽标、启停开关、`restartRequired` 角标、broken 错误；
   - 开关 mutation 后 invalidate `['platforms']`；不改统一 draft；
   - `PUT /api/settings` 不再发送 `platforms`。
7. **`frontend/src/views/trace/childAgents.ts`**
   - `hasChildAgents` → `capabilities.children`；删除 `ChildPlatform`；
   - `childAgentLabel` → `description || agentType || name`；
   - `useSessionDetailQuery` 的 openclaw `agent` 条件改为 `capabilities.needsAgent && !agent`（或按能力）；
   - children/spawn 路径参数化。
8. **其余 `dirForPlatform` 调用点**
   - `SessionsView.tsx`、`useSessionSse.ts`、`SessionSummary.tsx`、`PromptsView.tsx`、`SessionInsights.tsx`、`GlobalInsights.tsx`、`SessionFiltersDialog.tsx`、`queries.ts` 全部改 `dirBySettingKey`；
   - `SessionFiltersDialog` 的目录提示用 `dirSettingHint`。
9. **`frontend/src/views/insights/GlobalInsights.tsx` / `CmdkDialog.tsx`**
   - openclaw agent 判断改 `capabilities.needsAgent`；
   - 颜色改 `PlatformInfo.color`，缺省色兜底。
10. **`frontend/demo/router.ts`**
    - `/api/platforms` stub 补新字段；新增 `/api/:platform/agents`、children、spawn、mount/replace stub（demo 可用）。
11. **测试/构建**
    - `npm run build:ui`（tsc）+ `npm run lint`；
    - demo 人工验证：默认平台栏顺序不变；禁用/启用显示“重启后生效”；动态目录字段；children/spawn 按能力显示；自定义平台出现在平台栏。

### 验证

```bash
npm run build:ui
npm run lint
# demo/本地起服务人工冒烟
```

---

## P6 — 文档、ADR、回归收尾

### 任务

1. **ADR-0005**：记录三来源、replaced、全表面 hook、单一写入口、重启生效；声明取代 ADR-0001 的 Q11“不做启停开关”。
2. **文档更新**
   - `docs/.local/README.md` 登记新设计/计划/评审；
   - `docs/usage.md` / `docs/usage.zh-CN.md` / `cli-usage.md`：`platform mount/unmount/export/replace`、`AGENTLRAY_PKG_ROOT`、项目目录；
   - `docs/.local/guide-custom-platforms.zh-CN.md`：新增 hook 契约表与薄包装示例；
   - `docs/.local/custom-platform-example.zh-CN.md`：补 `AGENTLRAY_PKG_ROOT` 包装示例；
   - `docs/.local/glossary.zh-CN.md`：平台来源、项目平台、替代（replaced）、薄适配器、能力 hook。
3. **旧文档标注**：`design-platform-mount.zh-CN.md` / `plan-platform-mount.zh-CN.md` 顶部加“已被 v2 取代”链接。
4. **全量回归**
   - `npm test`；
   - `npm run build:ui` + `npm run lint`；
   - `node -e` 环测试；
   - 人工冒烟：默认 7 平台顺序/行为不变；自定义平台加载；项目平台加载；export 迁移；禁用 openclaw 缺省回退；legacy `/legacy` 可用。

---

## 测试矩阵（汇总）

| 类别 | 用例 | 阶段 |
| --- | --- | --- |
| 配置 | 缺失/损坏/非法 id；round-trip；disabled/replaced；守卫连续 unmount | P0 |
| 来源 | package/project/user；同 id 规则；replaced；replacementPending；broken 隔离；NO_PLUGINS | P0/P4 |
| 注册表 | catalog 遍历、mounted/configuredMounted/restartRequired；7 平台顺序 | P0/P1 |
| 契约 | 7 内置 resume/create/bin/dir 与旧表逐字对齐；capabilityBits | P1 |
| 会话 | 列表/详情/聚合/agents/children/spawn/watch；openclaw 禁用回退；hermes watch | P2 |
| 分析 | search/insights/prompts/tool-audit/OTLP/backup/inspect 特征化对齐；自定义 adapter 同路径 | P3 |
| 迁移 | export 薄适配器、包根解析、自动 replace、回退包内置、删除文件回退 | P4 |
| API | `/api/platforms` 三态；mount/replace 端点；422/404；重启生效 | P0/P4 |
| 前端 | build/lint；demo；动态目录；平台开关；children/spawn 能力；离线降级 | P5 |
| 兼容 | 命令串逐字；legacy 端点；`/legacy` UI；自定义适配器旧契约 | P1/P6 |

---

## 关键坑（实现时自查）

1. **守卫数据源**：必须用 `catalog − (disabled ∪ {id})`，不能用进程内 `PLATFORMS`；否则连续 unmount 可全部禁掉。
2. **require 期同步读**：`readSettings` 是 async；`readPlatformStateSync()` 必须 `fs.readFileSync(SETTINGS_FILE)`，否则 disabled/replaced 静默空转。
3. **require 环**：`platform-config` 不 require registry；`*-impl.js` 不 require 编排模块；builtin adapter 不 require `resume/new/cli-bins/index`；`index.js` 不 require `cli-bins`。
4. **假泛化**：`routes/sessions.js`/`session-list.js` 的条件换成 `needsAgent` 还不够，分支体必须调用 adapter hook；否则自定义 agent 平台仍不可用。
5. **目录参数**：`claude-code` 的 `dirParam` 是 `dirClaude`，不能按 `dirSettingKey` 首字母推导；四份映射全部收敛。
6. **listPlatformInfo 数据源**：必须遍历 catalog，否则 disabled 内置无法在设置面板重新启用。
7. **测试隔离**：`npm test` 必须统一临时 HOME/项目/用户平台目录；写测试禁止触碰真实 `~/.agentlray`。
8. **重启语义**：同进程内 PUT mount 后 `PLATFORMS` 不变；`/api/platforms` 用 `mounted` vs `configuredMounted` 表达差异，测试要锁死。
9. **替代回退**：replaced 声明但文件缺失/损坏 → 回退包内置并标记 `replacementPending`，不要让平台直接消失。
10. **legacy 别名**：顶层 `/api/agents*`、`/api/spawn-*` 只在 openclaw 挂载时提供；禁用后 404，避免半卸载。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（P0–P6）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| P0 来源模型/catalog/控制面 | ✅ 已实现 | `lib/platforms/`、`lib/platform-config.js` |
| P1 builtin 文件化 + 契约 | ✅ 已实现 | `lib/platforms/builtin/<id>/`、`lib/platforms/shared/contracts.js` |
| P2–P4 会话/分析/导出面泛化 | ✅ 已实现 | `lib/platforms/shared/*`、`bin/platform.js` |
| P5–P6 前端与文档/回归 | ✅ 已实现 | `frontend/src/components/Sidebar.tsx`、`SettingsDialog.tsx` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
