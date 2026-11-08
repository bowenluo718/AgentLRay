# 设计：平台来源统一与全表面等价（platform equivalence v2）

> 状态：重设计稿（待评审）。本稿按 [review-platform-mount.zh-CN.md](review-platform-mount.zh-CN.md) 的评审意见重写，取代
> [design-platform-mount.zh-CN.md](design-platform-mount.zh-CN.md)。
>
> 关联：
> - 旧方案：[design-platform-mount.zh-CN.md](design-platform-mount.zh-CN.md)（历史记录）、[plan-platform-mount.zh-CN.md](plan-platform-mount.zh-CN.md)（历史记录）
> - 自定义平台：[design-custom-platforms.zh-CN.md](design-custom-platforms.zh-CN.md)、[adr-0001-custom-platform-adapter.zh-CN.md](adr-0001-custom-platform-adapter.zh-CN.md)
> - 既有决策：[adr-0002-co-mind-platform.zh-CN.md](adr-0002-co-mind-platform.zh-CN.md)（薄适配器 require 内部模块问题）
>
> 已确认决策（本轮问答）：
> 1. “项目内”指 **AgentLRay 仓库根 `platforms/`**；
> 2. 内置迁移导出为 **薄适配器 + 包根解析**；
> 3. 同 id 覆盖 **仅允许覆盖已声明替代（replaced）的包内置**；
> 4. 生效方式 **重启生效**（CLI 新进程即时）；
> 5. 等价范围 **全表面严格等价**（含 children / spawn / inspect / backup / agent 管理）；
> 6. 仓库 `platforms/` **随 npm 包分发且可禁用**；
> 7. 自定义/项目平台 **支持在 Web 设置面板配置目录**。

---

## 1. 目标与非目标

### 1.1 目标

1. **三类来源统一**：包内置（`lib/platforms/builtin/`）、项目平台（`<repo>/platforms/`）、用户平台（`~/.agentlray/platforms/`）走同一 adapter 契约、同一加载器、同一展示/启停模型。
2. **双向等价**：
   - 自定义/项目适配器可被当作内置平台使用（默认挂载、出现在平台栏、可被其它平台逻辑同等对待）；
   - 内置平台可导出到用户目录作为自定义平台继续使用（`platform export`）。
3. **全表面严格等价**：任何平台专属行为都必须由 adapter 的可选能力（hook）声明，**核心代码中不再出现内置平台 id 的特判**。自定义平台只要实现对应 hook，就能获得与内置平台相同的能力；未实现则能力位为 false，相关 UI/接口按能力缺位处理。
4. **现有能力完全兼容**：空配置零回归；内置平台默认行为、命令串、API 形状、legacy 端点保持不变；现有自定义适配器继续可用。

### 1.2 非目标

- **热生效**：mount/unmount 仍为重启生效（CLI 每次新进程自然即时）。
- **legacy 前端新功能**：`public/` 是冻结快照，仅接受安全修复；禁用平台在 legacy 中仍显示（既定降级）。
- **提示词库安装目标**（`lib/routes/library.js` 的 `claude|codex|omp`）是独立的产品枚举，不属于本次平台注册/挂载模型；如需平台化，单独立项。
- **消息渲染风格**（如 `MessageList` 的 codex 分组）属于归一化消息的展示细节，不纳入“平台表面”范围；自定义平台使用通用渲染。
- 认证/信任模型不变：适配器仍以用户权限执行任意 JS，只投递可信文件。

---

## 2. 核心模型

### 2.1 三类来源

| 来源 | 目录 | origin | 是否随包分发 | 默认挂载 | 可禁用 |
| --- | --- | --- | --- | --- | --- |
| 包内置 | `lib/platforms/builtin/*.js` | `package` | 是（本包） | 是 | 是 |
| 项目平台 | `<repo>/platforms/*.js` | `project` | 是（加入 `package.json` 的 `files`） | 是 | 是 |
| 用户平台 | `~/.agentlray/platforms/*.js` | `user` | 否 | 是 | 是 |

目录可通过环境变量覆盖（主要用于测试隔离）：

- `AGENTLRAY_PROJECT_PLATFORMS_DIR`：默认 `<repo>/platforms`；
- `AGENTLRAY_PLATFORMS_DIR`：默认 `~/.agentlray/platforms`（替代 loader 里写死的 `PLATFORM_DIR`）；
- `AGENTLRAY_NO_PLUGINS=1`：跳过 **项目 + 用户** 两类来源，只保留包内置（逃生/测试）。

项目目录中的平台与包内置一样，默认出现在平台栏、默认挂载、可被 `platform unmount` 禁用。项目目录建议包含一个 `README.md` 说明信任边界；如需替换包内置，见 §2.3。

### 2.2 加载顺序与同 id 规则

加载顺序固定为：

```
package builtins  →  project/*.js（字母序）  →  user/*.js（字母序）
```

规则：

1. **新 id**：直接加入 catalog。
2. **同来源重复 id**（同一目录内两个文件同 id）：后加载者 broken，先加载者保留（沿用现有 loader 语义）。
3. **project 覆盖 package**：仅当该包内置 id 在“替代声明集合”中（见 §2.3）；否则 broken，错误提示“id 已被内置占用，请先 `agentlray platform export <id>` 或 `platform replace <id>`”。
4. **user 覆盖 project**：允许，user 更本地，后加载者生效；catalog 记录 `overrides: 'project'`。
5. **user 覆盖 package**：同规则 3，必须已声明替代。
6. **broken 隔离**：单个文件 require/校验失败不影响其它文件，broken 条目在 `/api/platforms` 与 `platform list` 可见。

### 2.3 替代声明（replaced）

“仅覆盖已禁用内置”落实为**来源级替代声明**，而不是让同 id 的用户文件静默顶包：

- 设置：`~/.agentlray/settings.json` 的 `platforms.replaced: string[]`；
- 项目清单：`<repo>/platforms/manifest.json` 的 `{ "replaces": ["codex"] }`（随仓库分发，表达“本项目有意替换包内置”）；
- 生效集合 = `settings.replaced ∪ manifest.replaces`；
- `agentlray platform export <id>` 默认把 id 写入 `settings.replaced`（可用 `--no-replace` 关闭）；
- `agentlray platform replace <id>` / `unreplace <id>` 用于手工放置文件后声明/撤销替代。

替代声明的解析：

- 声明了替代且存在同 id 的项目/用户适配器 → 该适配器挂载，catalog 的 `origin` 为 `project|user`，`overrides: 'package'`；
- 声明了替代但同 id 适配器不存在/损坏 → **回退到包内置**（`replacementPending: true`），并把损坏文件列为 broken，避免迁移文件损坏导致平台直接消失；
- 未声明替代 → 同 id 的项目/用户适配器 broken，绝不静默顶包。

### 2.4 停用（disabled）

`platforms.disabled: string[]` 是 **id 级停用**：只要 id 在 disabled 中，无论来源如何都不挂载。

- `platform unmount <id>`：加入 disabled；
- `platform mount <id>`：移出 disabled；
- 若 id 同时出现在 `disabled` 与 `replaced`：**disabled 优先**（完全停用）；
- 若要“停用包内置但保留用户替代”，不要用 disabled，应使用 replaced（export 的默认行为）；
- 若要完全停用某个平台（包括替代文件），用 disabled；也可删除替代文件后依赖 replaced 回退到包内置。

### 2.5 catalog / PLATFORMS / listPlatformInfo

- `ALL_PLATFORMS`（catalog）：Map，包含 **全部有效条目**（含 disabled、含被替代的包内置、含 replacementPending），按“包内置固定顺序 → 项目新增 → 用户新增”排列。被替代的包内置不单独占一行，catalog 中该 id 的条目就是有效来源（`origin` 为 project/user）。
- `PLATFORMS`：进程内已挂载的最终单例（`catalog` 过滤 `disabled` 后）。保持 `Object.keys(PLATFORMS)` 的顺序 = 平台栏/页签顺序。
- `BROKEN`：加载/校验失败的条目，最后追加。
- `listPlatformInfo(options)`：
  - 默认使用 require 期快照（`state.disabled` / `state.replaced`）；
  - `options.configured`（或传入最新 disabled/replaced）用于计算 `configuredMounted`；
  - 每条字段见 §7.2；
  - **必须遍历 catalog**，不能从 `Object.values(PLATFORMS)` 派生，否则 disabled 的包内置无法在设置面板重新启用。

### 2.6 守卫与默认平台

**守卫**：任何 unmount 之后，**已挂载且可查询的平台数必须 ≥ 1**。

- 计算基于 `catalog − (disabled ∪ {目标 id})`，**不能**基于进程内 `PLATFORMS` 快照（否则连续 unmount 可把平台全部禁掉）；
- “可查询”谓词：`typeof list === 'function' || typeof listForAgent === 'function' || typeof listAllAgents === 'function'`；
- 守卫失败 → HTTP 422 / CLI 退出码 1，错误码 `last-platform`；
- 并发：`setPlatformMounted` 写入前重读设置，写入后复算守卫；两个并发写至少保证不会同时越过守卫（读-改-写窗口内做一次校验）。

**默认平台**：新增 `defaultPlatformId()`，按 `PLATFORMS` 顺序返回第一个可查询平台。

所有缺省平台回退统一改用它：

- `GET /api/sessions`（缺省 `platform`）；
- `GET /api/prompts`、`GET /api/insights`、`GET /api/watch`；
- `bin/sessions.js` 的 ui 缺省回退；
- 前端 `setPlatforms` 的回退（前端已有 openclaw 优先逻辑，保留；服务端以 `defaultPlatformId()` 为准）。

这样禁用 openclaw 后，缺省请求不会 400/空。

---

## 3. 适配器契约 v2

适配器仍是 CommonJS 单文件/单对象，但能力从“仅会话读取”扩展为“全表面可选能力”。**所有 hook 均可选**；内置 adapter 实现自己拥有的能力，自定义/项目 adapter 按需实现。

### 3.1 身份、目录与 UI 元数据

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | `^[a-z0-9][a-z0-9-]*$`，catalog 键 |
| `label` | `string` | 展示名 |
| `version?` | `string` | 契约版本（v1 起，保留） |
| `defaultDir()` | `() => string` | 默认会话根目录 |
| `dirSettingKey?` | `string` | 设置面板持久化键（如 `codexDir`）；为空则不提供目录配置 |
| `dirSettingLabel?` | `string` | 设置面板标签（缺省用 `dirSettingKey`） |
| `dirSettingHint?` | `string` | 设置面板提示（缺省空） |
| `dirParam?` | `string` | 聚合/搜索/洞察请求的 query 参数名（如 `dirClaude`）；为空则只支持单请求 `?dir=` |
| `color?` | `string` | 前端平台标识色（缺省使用默认色） |
| `needsAgent?` | `boolean` | 平台按 agent 维度组织（openclaw 式） |

> `dirParam` 必须显式声明，不能从 `dirSettingKey` 派生：`claudeCodeDir` 的现网参数是 `dirClaude` 而非 `dirClaudeCode`。

### 3.2 会话读取

| hook | 签名 | 说明 |
| --- | --- | --- |
| `list?` | `async (dir) => SessionSummary[]` | 平台全部会话（非 agent 维度） |
| `listForAgent?` | `async (dir, agent, includeArchived) => SessionSummary[]` | 单 agent 会话 |
| `listAllAgents?` | `async (dir, opts) => SessionSummary[]` | 跨全部 agents 合并（每条带 `agent`） |
| `listAgents?` | `async (dir) => string[]` | agent 列表（agent 选择器） |
| `find?` | `async (dir, sessionId, opts) => string \| null` | 会话文件定位 |
| `parse?` | `async (filePath) => { session, messages }` | 文件归一化；可为 null（SQLite 平台） |
| `getSession?` | `async (dir, sessionId, opts) => { session, messages } \| null` | 详情；agent 平台用 `opts.agent` |
| `getSessionAcrossAgents?` | `async (dir, sessionId) => payload \| null` | 跨 agent 详情 |
| `collectFiles?` | `async (dir, opts) => [{path,file,sessionId,agent?}]` | 批量扫描 |
| `watchParse?` | `(rec, line?) => {messages?,session?} \| null` | SSE 追加行归一化 |
| `watch?` | `(req, res, ctx) => void` | 非文件平台的完整 SSE 处理器（hermes） |
| `needsAgent` 规则 | — | 声明 `needsAgent` 时，若提供上述 agent hook 则按 agent 工作；否则退化为 `list`/`getSession`（忽略 agent），并在 capabilities 中如实反映 |

### 3.3 子代理 / spawn / agent 管理

| hook | 签名 | 说明 |
| --- | --- | --- |
| `listChildren?` | `async (dir, sessionId) => ChildAgentSummary[]` | 子代理列表 |
| `getChild?` | `async (dir, sessionId, name) => payload` | 子代理详情 |
| `spawnMap?` | `async (dir) => SpawnLink[]` | spawn 关系图 |
| `spawnTree?` | `async (dir) => SpawnTree` | spawn 树 |
| `listAgents?` | 见上 | agent 管理端点 |
| `listForAgent?` / `getSessionAcrossAgents?` | 见上 | agent 会话端点 |

### 3.4 分析 / 检索 / 导出 / 备份 / inspect

| hook | 签名 | 说明 |
| --- | --- | --- |
| `search?` | `async (dir, keywords, opts) => hits[]` | 整平台搜索（hermes 等非文件/特殊格式）；存在时优先于通用文件扫描 |
| `searchFile?` | `async (fileEntry, keywords) => hit \| null` | 单文件搜索器（dsh/gemini 的折叠格式）；缺省用通用 JSONL 搜索 |
| `searchSupplement?` | `async (dir, keywords, max) => hits[]` | 额外来源（claude-code 的 history.jsonl 兜底） |
| `computeInsights?` | `async (dir, opts) => data \| null` | 整平台分析（hermes SQLite） |
| `insightsScanFile?` | `async (filePath, sessionId) => data \| null` | 单文件分析；缺省用通用扫描 |
| `extractPrompts?` | `async (dir, opts) => groups \| null` | 整平台 prompt 提取（hermes） |
| `extractPromptsFromFile?` | `async (filePath) => result \| null` | 单文件提取；缺省用通用 JSONL 提取器 |
| `computeToolAudit?` | `async (dir, opts) => data \| null` | 整平台工具审计（非文件平台） |
| `scanToolAuditFile?` | `async (filePath) => perFile` | 单文件审计；缺省用通用扫描 |
| `otlpSession?` | `async (dir, sessionId) => payload \| null` | OTLP 导出；缺省走 `find+parse`（且 `!needsAgent`） |
| `backupFiles?` | `async (dir) => [{ path, rel }]` | 备份文件枚举；缺省不参与备份（能力位 false） |
| `inspect?` | `{ normalizeRecord(record), rawToolEntries(record), adapterFiles: string[] }` | 离线 inspect；缺省不参与 |

### 3.5 CLI 能力与 resume 守卫

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `bin?` | `string \| null` | CLI 默认可执行名；openclaw 为 null |
| `resume?` | `{ bin, args(id, opts) => string[] }` | 原生续跑；args 内联在 adapter 文件，禁止 require `resume.js` |
| `create?` | `{ bin, args(opts) => string[] }` | 原生新建；dsh 不声明 |
| `resumeHooks?` | `{ prepare(ctx), after(ctx) }` | 续跑前后的平台专属治理（omp 运行中实例检测/终止/派生检查）；缺省无 |

### 3.6 校验规则

- 必需：`id`、`label`、`defaultDir`、`getSession`（`parse` 可为 null，hermes 兼容）；
- `id` 不合法、label 非字符串、必需函数缺失 → broken；
- 同 id 冲突按 §2.2/§2.3 处理；
- `needsAgent` 缺 hook 不判 broken（能力位如实为 false）；
- 适配器不得 require `lib/platforms/index.js`、`lib/resume.js`、`lib/new.js`、`lib/cli-bins.js`（防环）；
- 内置 adapter 可 require 包内纯实现模块（`lib/platforms/*-impl.js`、解析库、`lib/config`）；
- 用户/项目 adapter 若要做薄包装，通过 `AGENTLRAY_PKG_ROOT` 解析包内路径（§7.5），不要用相对路径。

---

## 4. 表面 → hook 映射（去硬编码）

| 表面 | 现状硬编码 | v2 驱动方式 | 编排模块 |
| --- | --- | --- | --- |
| 会话列表/详情/聚合 | `routes/sessions.js` openclaw 分支、`session-list.js` `id==='openclaw'` | `list` / `getSession` / `listForAgent` / `listAllAgents` / `needsAgent` | `lib/routes/sessions.js`、`lib/session-list.js` |
| agent 管理 | 顶层 `/api/agents*` 固定 openclaw | `listAgents` / `listForAgent` / `getSession({agent})`；顶层旧端点作为 openclaw 挂载时的兼容别名 | `lib/routes/sessions.js` |
| children | omp/claude-code 两条硬编码路由 | `listChildren` / `getChild`（capability `children`） | `lib/routes/sessions.js` |
| spawn | 顶层 `/api/spawn-*` 固定 openclaw | `spawnMap` / `spawnTree`（capability `spawn`）；顶层旧端点作为兼容别名 | `lib/routes/sessions.js` |
| watch | `platformId === 'hermes'` 专用分支 | `watch(req,res,ctx)` 优先；否则 `find+watchParse` 通用文件尾随 | `lib/routes/watch.js` |
| search | `DIR_PARAMS`、hermes 分支、claude history 分支、dsh/gemini 分文件搜索器 | `dirParam` + `search`/`searchFile`/`searchSupplement` | `lib/search.js` |
| insights | `platform === 'hermes'` | `computeInsights` / `insightsScanFile` | `lib/insights.js` |
| prompts | 7 个 id 的提取器 switch | `extractPrompts` / `extractPromptsFromFile` | `lib/prompts.js` |
| tool audit | `collectFiles` 过滤 | `computeToolAudit` / `scanToolAuditFile` | `lib/tool-audit.js` |
| export | registry getSession（已通用） | 无新 hook | `lib/export.js` |
| OTLP | `find && parse && !needsAgent` | `otlpSession` 优先；否则同上 | `lib/otlp.js` |
| backup | 固定 5 个内置备份函数 | `backupFiles`（capability `backup`） | `lib/backup.js` |
| inspect | 固定 `['omp','codex','claude-code']` | `inspect` hook；`lib/inspect.js` 从 registry 解析 | `lib/inspect.js`、`lib/inspect-detail.js` |
| resume/create | `RESUME_BINS` / `NEW_BINS` | `resume` / `create` | `lib/resume.js`、`lib/new.js` |
| resume 守卫 | `platform.id === 'omp'` | `resumeHooks.prepare/after` | `bin/sessions.js` |
| CLI 可执行名 | `CLI_BIN_DEFAULTS` / `CLI_BIN_ENV` | `bin` + `envVarFor` 通用推导 | `lib/cli-bins.js` |
| 目录参数 | 4 份映射（routes/search/insights/frontend） | `dirParam` 单一声明 | 上述编排 + 前端 |
| 设置 ui 白名单 | `PLATFORMS[ui.platform]` | catalog 白名单（含 disabled，避免静默失败） | `lib/routes/settings.js` |
| 缺省平台 | 多处 `'openclaw'` | `defaultPlatformId()` | 各路由 + CLI |
| 平台清单 | `listPlatformInfo` 从 PLATFORMS 派生 | 遍历 catalog + `configuredMounted` | `lib/platforms/index.js`、`lib/routes/platforms.js` |
| 前端平台/目录/颜色/能力 | `FALLBACK_PLATFORM_INFOS`、`dirForPlatform`、`ALL_DIR_PARAMS`、`DIR_FIELD_BY_ID`、`RESUME_BUILTIN_IDS`、`childAgents` id 判断 | `PlatformInfo`（origin/mounted/dir*/capabilities/color）+ 通用推导 | 前端 |

**验收标准**：在 `lib/`、`bin/`、`server.js`（不含 legacy `public/`）中 grep 内置平台 id，除以下位置外应无命中：

- 包内置 adapter 文件自身（`lib/platforms/builtin/*.js` 中的 `id/label/defaultDir`）；
- 内置解析库（`lib/platforms/codex.js` 等）内部的记录类型判断；
- 兼容别名（顶层 `/api/agents*`、`/api/spawn-*`）中“仅当 openclaw 挂载时委托”的 shim；
- 测试/文档/示例。

---

## 5. 模块拆分（防 require 环）

严格等价要求 adapter 能引用平台专属实现，而编排模块又依赖注册表；必须把“纯实现”下沉到不依赖注册表的模块：

```text
lib/platforms/
├── index.js                 # 组装：package builtins → project → user → disabled 过滤
├── loader.js                # 来源加载/校验/覆盖规则；注入 AGENTLRAY_PKG_ROOT
├── contracts.js             # hasResumeContract/hasCreateContract/capabilityBits（纯函数）
├── shared.js                # 归一化消息/缓存等共享 helper（既有）
├── builtin/
│   ├── openclaw.js
│   ├── codex.js
│   ├── claude-code.js
│   ├── omp.js
│   ├── dsh.js
│   ├── gemini.js
│   └── hermes.js
├── search-impl.js           # 纯搜索器（jsonl/dsh/gemini/hermes/claude history）
├── prompts-impl.js          # 纯 prompt 提取器
├── insights-impl.js         # 纯 insights 扫描器
├── tool-audit-impl.js       # 纯 tool-audit 扫描器
├── backup-impl.js           # 纯备份文件枚举/复制
├── inspect-impl.js          # rawToolEntries/normalizers
└── （既有解析库保持不变：codex.js/claude.js/omp.js/dsh.js/gemini.js/hermes.js/openclaw.js）
```

规则：

1. `*-impl.js` **禁止** require `lib/platforms/index.js`、`lib/search.js`、`lib/prompts.js`、`lib/insights.js`、`lib/tool-audit.js`、`lib/backup.js`、`lib/inspect.js`；
2. 编排模块 `lib/search.js` 等只依赖 registry + 对应 `*-impl.js` + adapter hook；
3. builtin adapter 依赖 `*-impl.js` + 既有解析库 + `lib/config`；**禁止** require `resume.js`/`new.js`/`cli-bins.js`/`index.js`；
4. `lib/resume.js`/`lib/new.js` 只依赖 `contracts.js` + `cli-bins.js`；
5. `lib/cli-bins.js` 可依赖 registry（`cliBinDefaults()` 遍历已挂载 `p.bin`），但 `index.js` 不得 require `cli-bins.js`；
6. `platform-config.js` 只依赖 `lib/settings`（`SETTINGS_FILE`）/`lib/config`，**不得**依赖 registry；`setPlatformMounted` 的 catalog 由调用方传入。

---

## 6. 数据 / 接口契约

### 6.1 settings 新 section

```jsonc
{
  "platforms": {
    "disabled": ["hermes"],   // id 级停用
    "replaced": ["codex"]     // 包内置来源被同 id 项目/用户适配器替代
  }
}
```

- 缺省/缺失/损坏 → `{ disabled: [], replaced: [] }`；
- 只读入口 `readPlatformStateSync()`：`fs.readFileSync(SETTINGS_FILE)` + `JSON.parse`，过滤非法 id；这是 registry 唯一的 require 期同步读；
- 写入统一走 `saveSections({ platforms })`（与 `lib/settings.js` 同一原子写）；
- `PUT /api/settings` **不接受** `platforms` section（单一写入口 = mount/replace 端点/CLI），避免与统一设置 draft 冲突；`GET /api/settings` 返回 `platforms` 供展示/调试。

### 6.2 `GET /api/platforms`

每条 `PlatformInfo`：

```jsonc
{
  "id": "codex",
  "label": "Codex",
  "origin": "package | project | user",
  "builtin": true,                 // 兼容字段：origin !== 'user'（被用户替代时 false）
  "overrides": "package | project",// 可选：当前适配器覆盖了哪类来源
  "replacementPending": false,     // 声明替代但替代文件缺失/损坏，回退包内置
  "mounted": true,                 // 当前进程实际挂载
  "configuredMounted": true,       // 按最新 settings 重启后是否挂载
  "restartRequired": false,        // mounted !== configuredMounted
  "capabilities": { "list": true, "getSession": true, "children": false, "spawn": false, "inspect": true, "...": true },
  "resume": true,
  "create": true,
  "bin": "codex",
  "dirSettingKey": "codexDir",
  "dirSettingLabel": "Codex 会话目录",
  "dirSettingHint": "Codex 会话日志目录",
  "dirParam": "dirCodex",
  "color": "#...",                 // 可选
  "broken": false
}
```

broken 条目追加：`{ id?, file, origin, broken: true, error, mounted: false }`。

- `GET /api/platforms` 读取最新 `platforms` section 计算 `configuredMounted`（异步路由层完成，`listPlatformInfo` 保持同步）；
- `bin/platform.js list` 使用 require 期快照，输出 `Builtin/Project/Custom` + `mounted/unmounted`。

### 6.3 控制端点

| 方法 | 路径 | 语义 |
| --- | --- | --- |
| `PUT` | `/api/platforms/:id/mount` | 移出 disabled；守卫；返回 `{ id, mounted: configuredMounted, currentMounted, restart: true }` |
| `DELETE` | `/api/platforms/:id/mount` | 加入 disabled；守卫；同上 |
| `PUT` | `/api/platforms/:id/replace` | 加入 settings.replaced（可选，供设置面板/脚本使用） |
| `DELETE` | `/api/platforms/:id/replace` | 移出 settings.replaced |

- 守卫失败 → 422 `{ error, code: 'last-platform' }`；
- 未知 id → 404；
- 写操作受 `csrfGuard` 保护（已覆盖 PUT/DELETE）。

### 6.4 CLI

```text
agentlray platform list [--json]
agentlray platform validate <file> [--json]
agentlray platform mount <id> [--json]
agentlray platform unmount <id> [--json]
agentlray platform replace <id> [--json]
agentlray platform unreplace <id> [--json]
agentlray platform export <id> [--out <dir>] [--force] [--no-replace] [--json]
```

- `mount/unmount`：复用 `setPlatformMounted`，输出“重启后生效”；`--json` 沿用 `{schemaVersion:1}`；
- `export`：
  1. 解析 catalog 的有效适配器；仅允许 `origin: package|project`（`user` 已是自定义，报错）；
  2. 生成薄适配器到 `--out` 或 `~/.agentlray/platforms/<id>.js`（已存在且无 `--force` → 报错）；
  3. 默认把 id 写入 `settings.replaced`（`--no-replace` 关闭）；
  4. 若 id 在 `disabled` 中，移出（迁移语义）；
  5. 输出信任提示与“重启后生效”；
- `replace/unreplace`：手工放置同 id 文件后声明/撤销替代；`unreplace` 后同 id 文件会在下次加载时 broken，输出警告；
- `validate`：使用与加载器同一套规则；同 id 文件只有在 `replaced` 集合中才通过，否则提示先 `export/replace`。

### 6.5 薄适配器与包根解析

`loader.js` 在加载任何项目/用户文件前设置：

```js
process.env.AGENTLRAY_PKG_ROOT = path.resolve(__dirname, '..', '..'); // 包根
```

`platform export` 生成：

```js
'use strict';
// Generated by `agentlray platform export <id>`. Load through AgentLRay.
const path = require('path');
const root = process.env.AGENTLRAY_PKG_ROOT;
if (!root) throw new Error('AGENTLRAY_PKG_ROOT is not set; load this adapter through AgentLRay.');
module.exports = require(path.join(root, 'lib/platforms/builtin', '<id>.js'));
```

- 项目平台导出时路径为 `path.join(root, 'platforms', '<id>.js')`；
- 包升级后导出文件自动跟随新实现（薄适配器语义）；如需冻结实现，后续可增加 `--self-contained`（本次不做）；
- `AGENTLRAY_PKG_ROOT` 是内部环境变量，`bin/platform.js`（含 `validate`）通过 require `lib/platforms` 自动设置；
- 信任边界不变。

---

## 7. 前端设计

### 7.1 平台列表与能力

- `PlatformInfo` 增加 `origin`、`mounted`、`configuredMounted`、`restartRequired`、`overrides`、`dirSettingKey/dirSettingLabel/dirSettingHint/dirParam`、`color`、扩展 `capabilities`；
- `selectablePlatforms/Ids` 过滤 `!broken && mounted !== false`；
- `FALLBACK_PLATFORM_INFOS` 仅离线降级用，恒列全部包内置且 `mounted:true`、补 `origin:'package'`、`dir*` 字段；
- `usePlatformProbe`：统一用 `getSessions(platform, { dir })` 探活；不再对 openclaw 特判（openclaw 的通用列表接口已合并全部 agents）；
- `platformLabel/capabilitiesOf` 已通用，保留。

### 7.2 动态目录配置

- `DirSettings` 改为 `Record<string, string>`；持久化时复制所有字符串值（向后兼容旧 `openclawDir` 等键）；
- `dirForPlatform(settings, platform)` 删除，替换为 `dirBySettingKey(settings, info)`；
- `SettingsDialog` 删除 `DIR_FIELD_BY_ID` 硬编码，遍历 **已挂载且有 `dirSettingKey`** 的平台，渲染 `dirSettingLabel`/`dirSettingHint`；
- `getSessionsAll` 签名改为 `{ platforms, dirsByPlatform, ... }`，按 `dirParam` 组装 `dirXxx`；`client.ts` 删除 `ALL_DIR_PARAMS`；
- 所有 `dirForPlatform` 调用点（SessionsView、useSessionSse、queries、SessionSummary、PromptsView、SessionInsights、GlobalInsights、SessionFiltersDialog、childAgents）统一改 `dirBySettingKey`；
- `SessionFiltersDialog` 的目录提示改为 `PlatformInfo.dirSettingHint`（缺省 `defaultDir` 不可知，回退空）。

### 7.3 设置面板“平台”页签与重启语义

- 新增“平台”页签：遍历 `/api/platforms`（含 disabled/broken），每行显示 `label`、`id`、来源徽标（内置/项目/自定义/替代内置）、当前 `mounted`、`restartRequired`、启停开关；broken 行显示错误。
- 开关走 `PUT/DELETE /api/platforms/:id/mount`，成功后 invalidate `['platforms']`；服务端同时返回 `mounted` 与 `configuredMounted`，UI 显示“重启后生效”角标。
- **该页签不纳入统一设置 draft**：平台启停是进程控制，不是文本设置；统一 Save/Reset 只作用于数据目录/LLM/状态/看板/CLI 命令。此例外写入设计说明。
- `GET /api/settings` 的 `platforms` section 只读展示，`PUT /api/settings` 忽略该 section（单一写入口）。

### 7.4 children / spawn / agents

- `hasChildAgents` → `capabilities.children`；`ChildPlatform` 类型删除，改用 `Platform`；
- `childAgentLabel` → `description || agentType || name`（通用）；
- `getSessionChildren/getSessionChild` 路径改为 `/api/:platform/sessions/:id/children...`；
- `getSpawnMap/getSpawnTree` 增加 platform 参数，使用 `/api/:platform/spawn-*`；
- `getAgents(platform, dir)` 使用 `/api/:platform/agents`；
- 旧顶层端点保留为 openclaw 挂载时的兼容别名，legacy 不受影响。

### 7.5 离线降级

- `/api/platforms` 不可达 → `FALLBACK_PLATFORM_INFOS`（全部包内置、全挂载、无 project/user 平台）；
- 降级表不参与运行时过滤，正常链路以 `/api/platforms` 的 `mounted` 为准（与旧设计 D8 一致）。

---

## 8. 兼容与发布影响

| 项 | 结论 | 说明 |
| --- | --- | --- |
| 空 `platforms` section | 零回归 | 全部包内置+项目平台默认挂载；`registry.test.js` 的 7 平台断言保持（测试环境无项目平台） |
| `RESUME_BINS` / `NEW_BINS` | 命令串逐字不变 | 平移到 adapter 内联 args；`test/new.test.js` 改 import，断言保留 |
| `CLI_BIN_DEFAULTS` / `CLI_BIN_ENV` | 删除 | `bin` 声明 + `envVarFor` 通用推导；`routes/settings.js`、`routes/cli-bins.js` 改遍历已挂载 adapter |
| `GET /api/platforms` | 向后兼容 | 只增字段；`builtin` 保留 |
| 顶层 `/api/agents*`、`/api/spawn-*` | 兼容别名 | 仅 openclaw 挂载时可用；legacy 行为保持 |
| 现有自定义适配器 | 兼容 | 新 hook 全部可选；`parse` 放宽为可 null；加载顺序/冲突规则基本不变（同 id 需 replaced） |
| legacy 前端 | 兼容（降级） | 冻结快照；禁用平台仍显示、探活 0/err |
| 测试 | 必须隔离 | `npm test` 统一 `AGENTLRAY_HOME`/`AGENTLRAY_PROJECT_PLATFORMS_DIR`，写测试只用临时目录 |
| ADR | 新增 | ADR-0005 记录“平台来源/替代/全表面 hook”决策，并说明取代 ADR-0001 的 Q11“不做启停开关” |

**无数据库/元数据变更**；无插件/运行态兼容性风险（非运行态平台，不涉及插件扩展点）。

---

## 9. 风险与边界

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| 分析/检索面大重构 | search/insights/prompts/tool-audit/inspect 回归 | 先写 characterization 测试（固定夹具输入 → 现有输出快照），重构后逐字对齐；分阶段合并 |
| require 环 | 启动失败/半初始化 | 严格执行 §5 模块规则；用 `node -e require` 子进程测试各入口 |
| `AGENTLRAY_PKG_ROOT` 耦合 | 薄导出适配器随包升级行为变化 | 文档明示；后续可加 `--self-contained` |
| 项目平台随包分发 | 信任边界扩大 | `platforms/README.md` 明示；`AGENTLRAY_NO_PLUGINS=1` 跳过；`platform list` 标注来源 |
| 全表面 hook 数量多 | 契约复杂、学习成本 | 契约表 + `platform validate` 报能力位；内置适配器作为最佳样例 |
| 重启生效与 UI 状态 | 开关“弹回” | `mounted`/`configuredMounted`/`restartRequired` 三态展示 |
| 测试污染真实 HOME | 开发者数据被改 | 统一测试 setup + 临时目录；写操作测试强制 tmp HOME |

---

## 10. 测试策略

### 10.1 单元/契约

- `test/platform-config.test.js`：缺失/损坏/非法 id、round-trip、disabled/replaced 校验、守卫（含连续 unmount）；
- `test/platform-loader.test.js`：三类来源、同 id 规则、replaced、replacementPending、broken 隔离、`AGENTLRAY_NO_PLUGINS`；
- `test/platform-adapter-contracts.test.js`：7 个内置 adapter 的 resume/create/bin/dir/hook 形状与旧表逐字对齐；`capabilityBits` 正确；
- `test/platform-export.test.js`：导出薄适配器、包根解析、自动 replace/移出 disabled、重复导出、`--no-replace`；
- `test/platform-extra-routes.test.js`：children/spawn/agents 通用路由与 capability 缺位；legacy 别名随 openclaw 卸载 404；
- `test/platform-analyze-surfaces.test.js`：search/insights/prompts/tool-audit/backup/inspect 在内置与自定义 adapter 上的等价输出；
- 既有 `test/registry.test.js`、`test/new.test.js`、`test/platforms-loader.test.js`、`test/platform-cli.test.js` 适配新 import。

### 10.2 API/集成

- `test/platform-mount.api.test.js`：预写 disabled/replaced → `/api/platforms` 三态字段、路由 404、聚合不含 disabled、PUT/DELETE 落盘、重启后生效；
- openclaw 禁用：`GET /api/sessions`（无 platform）、`/api/prompts`、`/api/watch` 回退首个可查询平台；
- 项目目录：临时 `AGENTLRAY_PROJECT_PLATFORMS_DIR` 加载项目平台，默认挂载、可禁用、可被用户覆盖；
- 导出迁移：export → 用户目录加载 → 包内置来源 replaced → 重启后同 id 由用户 adapter 提供，list/detail/children 等表面保持可用。

### 10.3 前端

- `npm run build:ui` + `npm run lint`；
- demo：`/api/platforms` stub 含新字段；设置面板平台启停/重启角标；动态目录字段；children/spawn 按能力显示；
- 人工冒烟：默认配置平台栏/页签顺序不变；禁用 openclaw 后缺省请求正常；导入项目平台后出现在平台栏。

---

## 11. 已确认决策汇总

| # | 决策 | 结论 |
| --- | --- | --- |
| D1 | 项目平台位置 | AgentLRay 仓库根 `platforms/`，随包分发，默认挂载、可禁用 |
| D2 | 内置迁移形态 | 薄适配器 + `AGENTLRAY_PKG_ROOT` 包根解析 |
| D3 | 同 id 覆盖 | 仅允许已声明 `replaced` 的包内置；未声明一律 broken |
| D4 | 生效方式 | 重启生效；CLI 新进程即时 |
| D5 | 等价范围 | 全表面严格等价（含 children/spawn/inspect/backup/agent 管理） |
| D6 | 自定义目录配置 | 支持 `dirSettingKey/dirParam`，设置面板动态渲染 |
| D7 | 平台列表数据源 | catalog 遍历 + `mounted/configuredMounted/restartRequired` |
| D8 | 守卫 | `catalog − (disabled ∪ {id})`，至少 1 个可查询平台 |
| D9 | 单一写入口 | `platforms` 只由 mount/replace 端点/CLI 写；`PUT /api/settings` 忽略 |
| D10 | legacy | 冻结；仅保留 openclaw 兼容别名，不新增功能 |
