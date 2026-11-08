# 自定义平台扩展（Custom Platform Adapters）方案设计

> 状态：已定稿（本会话经 grill-with-docs 逐轮确认：Q1 机制=A；Q2 术语/Q3 集成面/Q4 发现加载信任/Q5 契约/Q6 id/Q7 目录/Q8 resume/Q9 DX/Q11 启停/Q12 文档 均按推荐；Q10 前端范围=B）。
> 对应词表：`glossary.zh-CN.md` 已增补「内置平台 / 自定义平台 / 平台适配器 / 注册表」。
> 决策记录：`adr-custom-platform-adapter.zh-CN.md`。
> 对应代码基线：当前工作区（未提交的会话状态/openclaw 全 agent 改动之后）。

## 1. 背景与目标

AgentLRay 聚合 7 个内置平台（openclaw / codex / claude-code / hermes / omp / dsh / gemini）到统一数据模型。平台注册表 `lib/platforms/index.js` 的 `PLATFORMS` 目前是**静态对象**：

- 所有 generic 表面（会话路由 / watch SSE / search / prompts / tool-audit / OTLP / Markdown&HTML export / ui-settings 白名单 / CLI `sessions`）都经注册表解析；
- 前端（React `frontend/src/api/types.ts` 与 legacy `public/js/app.js`）则**两处硬编码**平台列表。

目标：**用户无需改 AgentLRay 源码，即可投入自定义平台**——写一个平台适配器 JS 文件放进 `~/.agentlray/platforms/`，启动并入注册表，按能力位自动接入各 surface。

## 2. 决策摘要

| # | 决策 | 结论 |
| --- | --- | --- |
| Q1 | 扩展机制 | 运行时 JS 平台适配器（CommonJS 单文件，投递至 `~/.agentlray/platforms/`） |
| Q2 | 术语 | 平台适配器（Platform adapter）/ 注册表（Platform registry）/ 自定义平台 / 内置平台，入词表 |
| Q3 | 集成面 | 按能力位自动纳入（缺能力静默缺位、不报错）；`inspect` 仅内置；`resume` opt-in |
| Q4 | 发现/加载/信任 | 启动加载、每文件 try/catch 隔离、`AGENTLRAY_NO_PLUGINS` 逃生、全信任、零第三方依赖 |
| Q5 | 契约字段 | 必需 `id/label/defaultDir/list/parse/getSession`；可选 `find/collectFiles/watchParse/needsAgent/resume/version` |
| Q6 | 平台 id | 正则 `^[a-z0-9][a-z0-9-]*$`；与既有 id 冲突 → 该文件 marked broken |
| Q7 | 每平台目录 | 适配器自行 `defaultDir()`（可读自身 env）；通用 `?dir=`/`--dir` 覆盖天然生效；不新增每平台配置 |
| Q8 | resume | 适配器可选 `resume = { bin, args(id, opts) => [...] }` opt-in 进 CLI；未声明则报「无原生续跑」 |
| Q9 | DX | 新增 `agentlray platform list` / `agentlray platform validate <file>`，共用同一加载器 |
| Q10 | 前端范围 | `GET /api/platforms` + React 主前端改服务端驱动 + legacy 最小侵入（内置表 + 追加自定义）；不加交互启停 |
| Q11 | 启停语义 | 不做 per-platform 开关：文件存在 = 启用，卸载 = 删/移走文件；broken 可见带错误 |
| Q12 | 文档 | 本文 + 一份 ADR + 词表增补，登记 `docs/.local/README.md` |

## 3. 适配器契约（Platform adapter contract）

### 3.1 文件与格式

- 位置：`~/.agentlray/platforms/*.js`；文件名即无序，加载顺序按字母序确定。
- 格式：CommonJS，`module.exports = <adapter>`；单文件单适配器。
- 依赖约束：仅 Node 内置模块 + `lib/platforms/shared.js` 导出（`withMetadataCache / makeMessage / sortSessionsByTimestampDesc / topToolsOf / captureLastMessage`），**零第三方依赖**（不引包，保证无安装步骤、无版本冲突）。
- 信任：适配器以用户自身权限执行任意 JS（等同手动跑脚本）；文档明示「只放可信代码」。

### 3.2 字段与能力位

**必需**（注册并出现在列表/详情的最小读取端）：

| 字段 | 签名 | 说明 |
| --- | --- | --- |
| `id` | `string` | 注册表键；正则 `^[a-z0-9][a-z0-9-]*$`；与内置或先前加载的自定义 id 冲突 → 该文件 broken |
| `label` | `string` | 人类可读名（boot log / 前端） |
| `defaultDir()` | `() => string` | 会话根目录；适配器内可读自身 env（如 `MY_COPILOT_DIR`） |
| `list(dir)` | `async (dir) => SessionSummary[]` | 会话摘要，最新在前。**必须复用现有摘要形状**：至少 `id / timestamp / lastActivity / mtimeMs`（状态推导依赖，见 §5.2）；建议含 `cwd / messageCount / tail / firstUserMessage` |
| `parse(file)` | `async (filePath) => { session, messages }` | 归一化消息。`messages` 复用 `makeMessage` 11 字段，**不自造新造型** |
| `getSession(dir, id)` | `async (dir, sessionId) => { session, messages } \| null` | 详情按 id。文件类适配器可直接用 `fileBasedGetSession(find, parse)` 助手 |

**可选**（能力位，缺谁谁缺位、不报错）：

| 字段 | 触发表面 |
| --- | --- |
| `find(dir, sessionId, opts?)` | `watch`（与 `watchParse` 一起）、`OTLP`（与 `parse` 一起） |
| `collectFiles(dir, opts?)` | `search` / `prompts` / `tool-audit` / 批量扫描 |
| `watchParse(rec, line?)` | SSE 实时尾随（与 `find` 一起；缺位则无实时尾随，状态仍由列表轮询推导） |
| `needsAgent` | openclaw 式按 agent 平台（置 true 时详情/列表需 `agent`，且不进入 OTLP） |
| `resume` | CLI `sessions resume`，见 §6 |
| `version` | 契约版本（v1 起始，为将来演进预留） |

> 推荐：状态精确性需要 `list` 摘要携带 `tail`（用 `shared.js` / `tail-state.js` 的 `createTailState→finishTail` 维护）。不携带也能工作——`deriveStatus` 对无 tail 会话退化为按 `lastActivity/mtimeMs` 时间窗判定（更粗糙）。

### 3.3 能力位 → 表面映射（服务端，全经注册表）

| 表面 | 所需能力 | 现状消费点 |
| --- | --- | --- |
| `GET /api/:platform/sessions` | `list` | `lib/routes/sessions.js` |
| `GET /api/:platform/sessions/:id` 详情 | `getSession` | `lib/routes/sessions.js` |
| `GET /api/sessions` 聚合 | `list` | `lib/session-list.js` |
| `GET /api/search` | `collectFiles` | `lib/search.js` |
| `GET /api/prompts` | `collectFiles` | `lib/prompts.js` |
| `GET /api/tools/audit` | `collectFiles` | `lib/tool-audit.js` |
| Markdown/HTML export | `getSession` | `lib/export.js`（`EXPORT_PLATFORMS`） |
| OTLP export | `find` + `parse` 且 `!needsAgent` | `lib/otlp.js`（`OTLP_PLATFORMS`） |
| SSE `GET /api/watch` | `find` + `watchParse`（缺任一应 400，见 §5.3） | `lib/routes/watch.js` |
| 设置白名单 `PUT /api/settings/ui` | 注册表存在即入白名单 | `lib/routes/ui-settings.js` |
| CLI `sessions list/show` | `list` / `getSession` | `bin/sessions.js` |
| CLI `sessions resume` | `resume`（opt-in，见 §6） | `bin/sessions.js` |
| 状态推导 | 平台中立（`tail` 证据 + 时间窗） | `lib/status.js` |

**明确不做**：
- `inspect` 离线诊断（`lib/inspect.js` / `lib/inspect-detail.js` 仅 omp/codex/claude-code，维护成本高，自定义平台不扩）。
- resume 默认支持（内置三平台 `RESUME_BINS` 原样保留为回退）。

## 4. 加载器（lib/platforms/loader.js）

新增 `lib/platforms/loader.js`：

- 导出 `loadPlatformAdapters(registry)`：读 `~/.agentlray/platforms/*.js`，逐文件 `require` 并校验，成功则 `registry[custom.id] = adapter`（`list` 保持 null 语义同内置），失败则记入 `broken`。
- 调用点：`lib/platforms/index.js` 模块初始化末尾（构建好内置 `PLATFORMS` 后立即并入）。因 `bin/sessions.js` 与 `server.js` 都 require 该模块，服务端与 CLI **天然共享同一份插件视图**。
- 校验：导出须为对象；`id` 满足 `^[a-z0-9][a-z0-9-]*$`；`label` 为字符串；必需函数存在。任一不满足/抛错 → broken，`{ file, id?, error }`。
- 冲突：`id` 与内置或先前加载的自定义 id 重复 → 该文件 broken，错误信息「id 已被占用」，不覆盖不串位。
- 逃生开关：`process.env.AGENTLRAY_NO_PLUGINS === '1'`（或 CLI `--no-plugins`，写入同名 env）→ 跳过加载，`broken` 注入一条说明。
- 每文件 try/catch 隔离：单文件 `require` 抛错 / 某个 `list()` 运行不打断启动或其余插件。

导出给复用方：`{ customAdapters, brokenAdapters }`；`agentlray platform list` 与 `GET /api/platforms` 都从这份元信息取数（同源）。

## 5. 表面集成要点

### 5.1 服务端路由

- `/api/:platform/sessions` 与 `/api/:platform/sessions/:id` 已通用，自定义平台**零改动**接入（`PLATFORMS[id]` 命中即走）。
- 新增 `GET /api/platforms`（挂 `lib/routes/platforms.js`，`server.js` 挂载）：

```json
[
  { "id": "openclaw", "label": "OpenClaw", "builtin": true, "capabilities": { "list": true, "find": true, "parse": true, "getSession": true, "collectFiles": true, "watchParse": true, "needsAgent": true }, "broken": false },
  { "id": "my-copilot", "label": "My Copilot", "builtin": false, "capabilities": { "list": true, "getSession": true }, "broken": false },
  { "id": "bad-one", "label": null, "builtin": false, "capabilities": {}, "broken": true, "error": "id 'bad-one' conflicts..." }
]
```

### 5.2 状态推导

`lib/status.js` 平台中立：`sortSessionsByStatusGroups` 对每条摘要 `deriveStatus(s.tail, s, nowMs)`。自定义平台的 `list` 产出符合摘要形状即自动获得四态分组与排序；无 `tail` 时退化为时间窗近似。**无需改动 status 逻辑**。

### 5.3 watch 守卫（必须加）

现状 `lib/routes/watch.js` 直接 `platform.find(...)` + `parseWatchLines(platform, lines)`（内部调 `platform.watchParse`）。自定义平台 `watchParse` 缺失时会在连接阶段炸。改造：进入 watch 前校验 `platform.watchParse` 存在，否则 `400 { error: "平台不支持实时尾随" }`。

### 5.4 OTLP / 导出

`OTLP_PLATFORMS` / `EXPORT_PLATFORMS` 均从注册表派生，自定义平台按能力位（`find+parse`、`getSession`）自动进入。**无需改动**。

## 6. resume opt-in

适配器可选：

```js
resume: {
  bin: 'my-copilot',            // 默认命令名
  args: (sessionId, opts) => ['--resume', sessionId],
}
```

- CLI `bin/sessions.js`：`RESUME_BINS` 保留为内置回退；未命中时查 `platform.resume`，命中则 `resolveCliBin()` 解析可执行名（默认 `resume.bin`，可由 `~/.agentlray/cli-bins.json` 的 `<id>` 键覆盖）。
- 未声明 `resume` 的平台 resume 报「该平台无原生续跑」（现状四平台语义）。
- 内置三平台行为不变（`RESUME_BINS` 原样）。

## 7. CLI platform 子命令

- `bin/agentlray.js` 增加分发：`argv[0] === 'platform'` → `require('./platform').main(...)`。
- `agentlray platform list`：与 `GET /api/platforms` 同源输出内置 + 自定义 + broken（含加载错误）。
- `agentlray platform validate <file>`：干式加载单个适配器（同一套校验），校验后调用 `list(defaultDir())` 取前若干条摘要打印计数与首条 id，错误即报。**验证通过 = 真机可用**（共用同一加载器）。
- 输出约定沿用 CLI 既有：`--json` 输出 `{schemaVersion:1,…}`，错误 `{kind:'error',error:{code,message}}`。

## 8. 前端改造（Q10=B）

### 8.1 React 主前端（`frontend/`）

- `src/api/types.ts`：`Platform` 联合类型与 `PLATFORMS`/`PLATFORM_LABELS` 静态枚举改为 **服务端驱动**——新增 `PlatformInfo = { id, label, builtin, capabilities, broken, error }`；运行时经 `GET /api/platforms` 拉取；类型上 `Platform` 退化为 `string & {}`（或 `string`），页面所有 API 路径拼 `/api/${id}/...`。
- 新增取数函数（`src/api/client.ts`）+ 查询（`queries.ts` 或 `store.ts`），列表/详情/聚合请求的 platform 以运行时列表为准。
- 消费点改造：`Sidebar.tsx`（平台选择/多选）、`SettingsDialog.tsx`(平台数据目录 tab 每平台行、平台 CLI 命令 tab)、`store.ts`（`dirForPlatform` 等）。broken 平台显示徽标 + 错误，不参与会话查询；不可交互启停（§Q11）。
- 构建期再跑一次静态检查：确认无残留 `PLATFORMS` 常量依赖。

### 8.2 legacy `public/js/app.js`（最小侵入）

- `platforms` 数组（~459 行）保留内置表，启动时 `GET /api/platforms` 把 `builtin:false` 且未 broken 的自定义平台追加进展示数组。
- 9 处 per-platform 硬编码分发（列表 4278–4330、探活 probes 421–429、首启候选 5041–5048）补一条「非内置 → 通用 `/api/:platform/sessions[?agent=]` / `/api/:platform/sessions/:id`」兜底分支。
- watch 启动（SSE）：自定义平台仅当能力含 `watchParse` 才发 `/api/watch`（服务端 400 兜底）。
- broken 徽标在平台栏显示（读取 `/api/platforms` 的 `broken/error`）。

## 9. 信任与安全边界

- 适配器 = 用户全权限代码（同用户手动执行）；文档与 `platform validate` 输出都明示信任边界。
- 不新增网络/沙箱/签名机制（内网工具，自配置即信任）。
- `AGENTLRAY_NO_PLUGINS=1` 为全局逃生；`agentlray platform list` 可见加载失败原因便于排查。

## 10. 验证方案

| 事项 | 验证方式 |
| --- | --- |
| 加载器隔离 | 放一个抛错的适配器 + 一个正常适配器，启动 server 与 `agentlray platform list`，确认 broken 有记录、正常平台可列可查、boot log 不中断 |
| id 冲突 | 投一个 `id: 'codex'` 的适配器，确认 broken 且 `codex` 仍为内置 |
| 归一化形状 | 用 `platform validate` 对样例适配器校验，再经 `GET /api/:platform/sessions` 与 CLI `sessions show` 走通 |
| 能力位缺位 | 无 `collectFiles` 的适配器：search/prompts/audit 缺位不报错；无 `watchParse`：watch 返回 400 |
| 前端 | React + legacy 各起一次：自定义平台出现在平台栏，可查列表/详情，broken 徽标可见 |
| resume opt-in | 声明 `resume` 的自定义平台 `sessions resume --run` spawn 对应 bin；未声明报「无原生续跑」 |
| 逃生 | `AGENTLRAY_NO_PLUGINS=1` 启动，`platform list` 显示自定义全部缺席 |

## 11. 实现任务切分

- **P0 契约与加载器**：`lib/platforms/loader.js`（校验/隔离/broken/`AGENTLRAY_NO_PLUGINS`/冲突）+ `index.js` 接入 + 单元测试（id 正则、冲突、broken、逃生）。
- **P1 服务端**：`GET /api/platforms` 路由挂载（`capabilities`/`broken`/`error`）+ watch `watchParse` 守卫 + 测试（自定义平台走通列表/详情/export/OTLP、能力缺位、watch 400、`/api/settings/ui` 白名单）。
- **P2 CLI**：`bin/platform.js`（`list` / `validate`）+ `bin/agentlray.js` 分发 + `cli-usage.md` 更新 + 测试。
- **P3 resume opt-in**：`bin/sessions.js` 泛化 `RESUME_BINS` 解析 + 测试（声明/未声明/内置三平合回退）。
- **P4 React 前端**：types/client/store/queries/Sidebar/SettingsDialog 改服务端驱动 + broken 徽标。
- **P5 legacy 前端**：`app.js` 追加自定义 + 通用分发兜底 + broken 徽标 + watch 能力判断。
- **P6 收尾**：样例适配器文档（模板）+ `docs/usage*` 章节 + 词表/ADR/本文档登记核对。

> 与既有约定一致：中间文档入 `docs/.local/` 并按 `README.md` 登记；破坏性变更（前端静态枚举移除）在 PR 说明中标注。
