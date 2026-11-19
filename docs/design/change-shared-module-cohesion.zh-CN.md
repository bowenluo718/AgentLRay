# 共享模块内聚到平台内部

> 变更记录（2026-11-09）：(1) openclaw 内置平台不再读取 hermes 会话库（`~/.hermes/state.db`）来归并 hermes 子代理会话，原 `lib/platforms/shared/hermes-db.js` 迁入 `platforms/hermes/db.js`；(2) `foldGeminiRecords` 迁入 `platforms/gemini/format.js`，`stringifyToolResult` 因共享通用扫描器依赖保留在 `lib/platforms/shared/tool-result.js`。

## 背景

此前 openclaw 的 `buildSpawnTree` 会补读 hermes 会话库（`openHermesDb`），把带 `parent_session_id` 的 hermes 会话挂进 openclaw 的 spawn 树，作为 openclaw 拉起的子代理。同时 `@agentlray/shared/hermes-db` 被 openclaw（内置）与 hermes（项目平台）共用。

本次变更：**不再考虑 openclaw 的 hermes 子代理**，移除 openclaw 对 hermes 会话库的全部读取及相关功能；由于 openclaw 移除后 hermes 会话库访问的唯一消费方只剩 hermes 平台自身，故把该共享模块迁入 hermes 平台内部。

## 变更内容

### 1. openclaw 内置平台移除 hermes 读取

- `lib/platforms/builtin/openclaw/parse.js`：
  - 删除 `require('@agentlray/shared/hermes-db')` 的 `openHermesDb`/`unixToIso` 导入；
  - `buildSpawnTree` 中删除「Add Hermes sessions with parent_session_id」整段（约 40 行）：不再打开 `~/.hermes/state.db`、不再把 hermes 会话并入 `sessionInfo`、不再按 `parent_session_id` 挂子节点；
  - 「Rebuild roots with Hermes data included」注释改为「Rebuild roots」。
- `lib/platforms/builtin/openclaw/dirs.js`：删除 `hermesHome` 声明（`HERMES_DIR` → `~/.hermes`）及对应注释。

### 2. hermes 会话库访问内聚到 hermes 平台

- 新增 `platforms/hermes/db.js`（原 `lib/platforms/shared/hermes-db.js` 迁移）：`getHermesDbPath`/`openHermesDb`/`openHermesDbForWatch`/`unixToIso` 四个函数；缺省家目录改从 hermes 平台自身 `./dirs` 的 `session`（`HERMES_DIR` → `~/.hermes`）取，不再重复声明。
- `platforms/hermes/parse.js`：导入从 `@agentlray/shared/hermes-db` 改为本地 `./db`（并移除「与 openclaw 共享」注释）。
- `lib/platforms/shared/index.js`：删除 hermes 会话库访问四个函数的转发导出。
- 删除 `lib/platforms/shared/hermes-db.js`。

### 3. gemini 记录格式内聚到 gemini 平台

- 新增 `platforms/gemini/format.js`（原 `lib/platforms/shared/gemini-format.js` 的部分内容）：`foldGeminiRecords`（记录流折叠，处理 `$rewindTo`/`$set`/`id` 覆盖）。
- `platforms/gemini/parse.js`：`foldGeminiRecords` 改从本地 `./format` 取（导出区同步重导出本地实现）；`stringifyToolResult` 仍从 `@agentlray/shared/tool-result` 取。
- `platforms/gemini/prompts.js`、`platforms/gemini/search.js`：`foldGeminiRecords` 改从本地 `./format` 取。
- `lib/platforms/shared/gemini-format.js` 重命名为 `lib/platforms/shared/tool-result.js`：移除 `foldGeminiRecords`，仅保留 `stringifyToolResult`。
- `lib/platforms/shared/index.js`：移除 `foldGeminiRecords` 转发导出，保留 `stringifyToolResult`（来源更新为 `./tool-result`）。
- `lib/platforms/shared/insights.js`：`stringifyToolResult` 来源从 `./gemini-format` 更新为 `./tool-result`。

### 4. 文件名统一为通用名

为不把模块绑定到具体平台名，避免平台内模块以平台名重复命名、及共享层保留模块以平台名命名造成的语义误导，统一命名为通用描述性名：

- `platforms/hermes/hermes-db.js` → `platforms/hermes/db.js`
- `platforms/gemini/gemini-format.js` → `platforms/gemini/format.js`
- `lib/platforms/shared/gemini-format.js` → `lib/platforms/shared/tool-result.js`
- 变更文档：`change-openclaw-drop-hermes.zh-CN.md` → `change-shared-module-cohesion.zh-CN.md`

平台目录（`platforms/hermes/`、`platforms/gemini/`）已承载归属语义，模块文件名用通用职责名（`db`/`format`）表达。

## 理由

- openclaw 不再关心 hermes 子代理 → 移除读取，spawn 树只反映 openclaw 自身 `sessions_spawn`/`exec` 子代理关系。
- openclaw 移除后 hermes 会话库访问的唯一消费方是 hermes 平台 → 该机制不再是「跨平台共享」，应随单一平台内聚，符合 `shared/index.js` 头部「共享代码不随单一平台迁移」的清单管理原则（此前是唯一例外）。
- gemini 记录格式 **部分内聚**：`foldGeminiRecords` 仅 gemini 平台消费（parse/prompts/search）→ 迁入平台；`stringifyToolResult` 被共享通用扫描器 `shared/insights.js`（`scanFileForInsights` 的 gemini 记录分支，claude/codex/omp 等多平台共用的缺省 hook）依赖 → **必须留在 shared**，否则形成 shared→平台 反向依赖。
- 通用命名：平台内模块与共享层保留模块均不体现具体平台名，职责名自解释，归属由所在目录决定。

## 共享模块归属排查（2026-11-09）

对 `lib/platforms/shared/` 全部模块逐一核对消费方，判断是否归属于单一/双专属平台：

| 模块 | 归属判断 |
| --- | --- |
| `config.js` | 目录解析，跨所有平台，通用 |
| `contracts.js` | resume/create 契约，跨平台，通用 |
| `helpers.js` | 适配器骨架，跨平台，通用 |
| `insights.js` | 通用扫描器（多平台缺省 hook）；内嵌 gemini 分支（`stringifyToolResult`，已处理）与 dsh 分支（`readDshSessionLines`） |
| `inspect.js` | 通用实现，平台专属已内聚各 `builtin/<id>/inspect.js` |
| `search.js` | 通用 JSONL 搜索（openclaw/codex/claude-code/omp 等多平台），通用 |
| `status.js` / `text-utils.js` | `lib/status`、`lib/text-utils` 的别名窗口，通用 |
| `tail-state.js` | 平台无关的会话尾部证据状态机，通用 |
| `tool-audit.js` | 通用扫描器，claude-code 专属 `readClaudeMcpServers` 已内聚 `builtin/claude-code/tool-audit.js` |
| `tool-result.js` | 通用 `stringifyToolResult`（随本变更从 `gemini-format.js` 改名），通用 |
| `watch.js` | 通用 SSE 尾随；内嵌 dsh 分支（`scanZstdFrames`/`decompressDshLog`） |
| **`zstd.js`** | **dsh 专属 zstd 会话日志格式工具**（`scanZstdFrames`/`decompressDshLog`/`readDshSessionLines`）——唯一剩余的单平台专属模块 |

**`zstd.js` 结论（暂不处理，仅记录）**：与已处理的 `foldGeminiRecords` 同构——消费方仅 dsh 平台（`platforms/dsh/{parse,prompts,search,index}.js`）+ 共享通用扫描器 `shared/insights.js`、`shared/watch.js`（`filePath.endsWith('.zstd')` 分支，dsh 未声明专属 `insightsScanFile`/watch hook，走共享缺省）。因此无法整体迁入 dsh 平台（否则 shared → dsh 反向依赖）。完整迁移需把两处共享扫描器的 dsh 分支抽成 dsh 平台专属 hook（类比 hermes 的 `platforms/hermes/insights.js`），改动面大，**本轮仅记录、不执行**。

## 验证

- `node --require ./test/setup-env.cjs --test test/hermes.test.js test/openclaw.test.js`：12/12 通过。
- `node --require ./test/setup-env.cjs --test test/gemini.test.js test/insights.test.js`：17/17 通过。
- 全量 `npm test`（`node --require ./test/setup-env.cjs --test test/*.test.js`）：581/581 通过。
- `@agentlray/shared/hermes-db` 裸名引用已清零（原仅 openclaw parse、hermes parse 两处，均已改）；`@agentlray/shared/gemini-format` 裸名已改 `@agentlray/shared/tool-result`，仅剩 `stringifyToolResult` 引用（gemini parse）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| hermes 会话库内聚 | ✅ 已实现 | `platforms/hermes/db.js` |
| gemini 记录折叠内聚 | ✅ 已实现 | `platforms/gemini/format.js` |
| `stringifyToolResult` 保留共享 | ✅ 已实现 | `lib/platforms/shared/tool-result.js` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
