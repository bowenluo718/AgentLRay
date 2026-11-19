# 平台目录/名词解耦到平台文件 —— 设计

> 状态：**Accepted**（2026-11-08，grill 决策 R1–Q1~Q6 全收敛）
> 关联：`design-platform-equivalence.zh-CN.md`（平台三来源与全表面等价）、`design-platform-mount.zh-CN.md`（v1，已取代）、`adr-0003-windows-compat.zh-CN.md`（D1 被本设计修订）
> 代码库现状：本设计已实现（本工作区），验证见文末。

## 目标

把平台专属名词（目录常量、点目录名、环境变量名、内部子路径）从顶层 `lib/config.js` **彻底解耦到平台文件**，消除"平台知识散落顶层"与多份重复真源，同时保证 Windows 跨平台路径正确。

## 动机（grill 决策）

- 目录/env 的真源原本集中在 `lib/config.js`；平台适配器 `defaultDir()` 只"引用"这些常量，真源未下沉。
- 平台文件内部已有"半解耦但旁路 config"的硬编码（claude-code 的 `~/.claude/history.jsonl`、`.claude.json` 用裸 `os.homedir()` 直拼），与会话目录口径不一致。
- 顶层 `lib/library.js` 手写 `INSTALL_TARGETS`（`.claude/commands`/`.codex/prompts`/`.omp/agent/commands`）+ 平台目录引用 + `.claude/history.jsonl`，是第二份平台知识。
- 前端 `SessionsView.tsx` 有 `PLATFORM_DEFAULT_PATHS` 第三份默认路径重复真源。

**决策**：平台目录真源下沉各平台文件，顶层 config.js 只持非平台目录；非平台代码经平台 adapter/声明取目录；前端默认路径由服务端下发。

## 目录声明结构（grill Q1=A + Q6=B）

每个平台文件（`<id>/dirs.js`）导出**分段声明**，由 `lib/platforms/shared/config.js` 的 `resolveDirs(decl)` 统一解析为绝对路径：

```js
// 声明字段
{ root?: 'agentlray' | 'home', env?: string, altEnv?: string, segments?: string[] }
```

- `root: 'agentlray'`（默认）：基座 `AGENTLRAY_HOME || os.homedir()` —— 平台独占会话目录，与既有 config `HOME` 语义一致。
- `root: 'home'`：基座 `os.homedir()` —— CLI 自身文件（`~/.claude/*`、`~/.codex/prompts`、`~/.omp/agent/commands`），**刻意不挂 AGENTLRAY_HOME**（Q6=B：这些是 claude/codex/omp CLI 自己的文件，非 agentlray 数据；修订 ADR-0003 D1 把它落成正式规则）。
- `env`：优先读该环境变量（字节保留既有 `OPENCLAW_DIR`/`CODEX_DIR`/… 契约）；非法/非绝对/含 `..` → 回退默认段（Windows 安全护栏）。
- `altEnv`：env 缺失时的次级源，拼入 segments（`DSH_HOME` 情形：DSH_HOME 指 dsh 家目录，会话目录在其 `/sessions` 下）。

**Windows 安全**：分段 + `path.join` + `path.isAbsolute` 校验是结构性保证，杜绝 `~`/`/` 字面量路径在 Windows 坏掉。`resolveDirs` 集中拼路径，非平台代码只取"已拼好的绝对路径"。

## 解析器

`lib/platforms/shared/config.js` 新增 `resolveDirs(decl)` 与 `AGENTLRAY_HOME`；保留非平台工具透传（`HOME`/`resolveDir`/`isArchivedFile`/`isSessionLogFile`/`ensureDirectory`/`readAgents`，`readAgents` 去除 `DATA_DIR` 缺省，baseDir 必填）。内置与项目/自定义平台统一经 `@agentlray/shared/config` 访问。

## 平台文件目录声明清单

| 平台 | 声明文件 | session | 散点 |
| --- | --- | --- | --- |
| openclaw | `lib/platforms/builtin/openclaw/dirs.js` | `OPENCLAW_DIR`→`~/.openclaw/agents` | `hermesHome`（spawn 树读 hermes 库，`HERMES_DIR`→`~/.hermes`） |
| codex | `lib/platforms/builtin/codex/dirs.js` | `CODEX_DIR`→`~/.codex/sessions` | `prompts`（库安装目标，`~/.codex/prompts`） |
| claude-code | `lib/platforms/builtin/claude-code/dirs.js` | `CLAUDE_CODE_DIR`→`~/.claude/projects` | `historyFile`/`claudeJson`/`commands`（均为 CLI 自身文件，root `home`） |
| omp | `lib/platforms/builtin/omp/dirs.js` | `OMP_DIR`→`~/.omp/agent/sessions` | `commands`（库安装目标，`~/.omp/agent/commands`） |
| dsh | `platforms/dsh/dirs.js` | `DSH_DIR`→`DSH_HOME`→`~/.dsh/sessions`（altEnv） | — |
| gemini | `platforms/gemini/dirs.js` | `GEMINI_DIR`→`~/.gemini/tmp` | `<hash>/chats/` 由 adapter 内部自拼，不额外声明 |
| hermes | `platforms/hermes/dirs.js` | `HERMES_DIR`→`~/.hermes` | `state.db` 由 `shared/hermes-db.js` 声明（随 hermes 家目录） |

## config.js 精简

删除 7 个平台目录常量与导出（`DATA_DIR`/`CODEX_DIR`/`CLAUDE_CODE_DIR`/`HERMES_DIR`/`OMP_DIR`/`DSH_DIR`/`GEMINI_DIR`）；保留非平台：`HOME`/`ANALYSIS_DIR`/`LIBRARY_DIR`/`ARCHIVE_DIR` + 正则/缓存/工具函数。`readAgents` 去掉 `DATA_DIR` 缺省。

## 非平台代码取值（grill Q3=A）

- `lib/routes/sessions.js`：openclaw 专属路由（`/api/agents*`、`/api/spawn-*`）的 `DATA_DIR` → 新增 `openclawDefaultDir()`（`PLATFORMS.openclaw.defaultDir()`），5 处替换。
- `lib/library.js`：`INSTALL_TARGETS` 改从 claude-code/codex/omp 的 dirs 声明取目录（key `claude`/`codex`/`omp` 公开 API 不变）；`computeLibraryUsage` 的平台会话目录改声明源；`~/.claude/history.jsonl` 改 `claudeDirs.historyFile`。
- `lib/platforms/shared/hermes-db.js`：去 `lib/config` 的 `HERMES_DIR` 依赖，改从 `resolveDirs` 声明缺省（与 hermes 平台一致）。
- `lib/platforms/shared/index.js`：删除 `DSH_DIR`/`GEMINI_DIR`/`HERMES_DIR` re-export（平台自声明）。

## 前端（grill Q2=A）

- `lib/platforms/index.js` `listPlatformInfo` 下发 `defaultDir`（mounted 平台的 `defaultDir()` 绝对路径，broken/未挂载为 null）。
- `SessionsView.tsx` 删 `PLATFORM_DEFAULT_PATHS` 硬编码表，`AllEmptyState` 从 store 的 platforms（服务端下发 `defaultDir`）派生展示。
- `api/types.ts` `PlatformInfo` 加 `defaultDir`；`store.ts` fallback 平台表与 `demo/router.ts` 补 `defaultDir` 字段。
- `public/`（legacy 冻结快照）的 placeholder 占位不改（非功能面）。

## 决策摘要（grill）

| 问 | 决策 |
| --- | --- |
| Q1 | A：分段声明 + 共享解析器（Windows 安全结构性保证） |
| Q2 | A：前端默认路径服务端下发绝对路径，前端只展示不拼 |
| Q3 | A：平台目录知识留平台层，非平台代码 `PLATFORMS[id].defaultDir()` |
| Q4 | B：claude-code 散点（history.jsonl/.claude.json/commands）也收进平台目录声明 |
| Q5 | A：生成物与断言跨平台（`thinAdapterSource` 薄适配器不自含路径，天然满足） |
| Q6 | B：散点声明 root `home`（锚定 `os.homedir()`），不并入 AGENTLRAY_HOME |

> Q4=B 修订 ADR-0003 D1 的"散点独立于 agentlray home"表述——不是推翻"用 `os.homedir()` 拼"，而是把它落成"声明对象 + root `home`"的正式规则，语义保持一致（Q6=B）。

## 验证

- `npm test` 全量（577+）。
- `frontend npm run build` 通过。
- `/api/platforms` 实际下发 `defaultDir`（openclaw/claude-code/omp/dsh 等 mounted 平台返回绝对路径；disabled 平台为 null）。
- `lib/config` / `lib/platforms` require 冒烟通过。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 各平台 `dirs.js` 声明 | ✅ 已实现 | `lib/platforms/builtin/*/dirs.js`、`platforms/*/dirs.js` |
| `resolveDirs` 统一拼路径 | ✅ 已实现 | `lib/platforms/shared/config.js` |
| 目录配置服务端化 | ✅ 已实现 | `lib/dirs-config.js`、`lib/routes/settings.js` |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
