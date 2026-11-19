# 设计：会话续跑扩展到全内置平台 + 自定义平台（resume 多平台化）

> 状态：已定稿。2026-10-30 经 grill-with-docs 确认，Q1–Q6 均按推荐采纳（Q6 = 本次 2026-10-31 用户实测定稿：dsh 真实续跑为 pi-tui，非 headless）。
> 范围：**仅「续跑」**；「新建任务」另起一轮。openclaw 不纳入（无独立续跑 CLI 语义）。

## 决策摘要

| 决策 | 结论 |
|---|---|
| Q1 范围-平台 | 内置 resume 从 codex / claude-code / omp 扩到 **dsh / gemini / hermes**（其余三个具备原生续跑 CLI 的内置平台）；openclaw 不做 |
| Q2 范围-新建任务 | 本次仅续跑；「新建任务」另起 |
| Q3 内置机制 | **原生参数硬编码进 `RESUME_BINS`**，与既有三平台完全同构；不引入通用命令模板抽象（无真实需求，避免过度设计） |
| Q4 自定义机制 | 维持适配器 `resume: { bin, args(id, opts) }` opt-in（ADR-0001 既有决策与实现），本次只补文档/测试证明端到端 |
| Q5 无交互旗标 | 各平台带等价「跳过权限确认」旗标：gemini `--approval-mode=yolo`（`-y` 已弃用）、hermes `--yolo`；dsh 为交互式 TUI 续跑，权限在 TUI 内交互处理，无需无交互旗标 |
| Q6 dsh 语义 | dsh 走 **pi-tui 交互式续跑**（2026-10-31 用户实测）：`dsh --profile pi-tui --preset standard --resume <id>`。`--preset standard` 在 resume 路径**不生效**（dsh-pi-tui 后端用会话自身记录的 preset）；dsh-pi-tui 官方可复制命令为 `dsh --profile pi-tui --resume <id>`。**headless `--session-id` 不认 web 界面创建的会话**（`session-<uuid>` 是 dsh-session store 格式）；`dsh tui --resume` 仍为死路径（无 `tui` 模板/profile）。用户侧曾就 headless 版主张后实测驳回（web 创建的会话 headless 不认），落后代码需留意 |

## 现状（事实）

- `lib/resume.js` `RESUME_BINS` 仅含 codex / claude-code / omp；`hasResumeContract()` 对其余内置返回 false，
  `sessions resume` 与 web「复制恢复命令」（`GET /api/:platform/sessions/:id/resume-command`）均报「无原生续跑」。
- 自定义平台续跑**已实现**（`097949b`，ADR-0001）：适配器声明 `resume` 字段即 opt-in；命令串与 web 端点同源（`lib/resume.js` 单一真源）。
- 三个待补平台的续跑命令**已核实**：
  - **dsh**：真实原生续跑在 **pi-tui**（用户 2026-10-31 实测）= `dsh --profile pi-tui --preset standard --resume session-<id>`，TUI 交互式重开持久化会话（web 界面创建的 `session-<uuid>` 会话）。已核对源码 `dsh-pi-tui`：`parseArgs` 认 `--resume/-r`、`--preset/-p`；`resumeCommand()` 官方可复制命令为 `dsh --profile pi-tui --resume <id>`；resume 路径用会话自身记录的 preset（`persistedPreset`），`--preset` 不生效。**headless `--session-id` 不认 web 创建的会话**；`dsh tui --resume` 仍为死路径（无 `tui` 模板 / 本机无该 profile，`--resume` 仅启动器透传不被消费）。
  - **gemini**：`gemini -r <session-id>`（官方 cli-reference `--resume/-r` 支持按 id 续跑）。
  - **hermes**：`hermes --resume <SESSION>`，可加 `--yolo`（`hermes --help`）。

## 目标形态

### RESUME_BINS 六平台原生续跑参数

| 平台 | 默认 bin | args(id) | env 变量 | 说明 |
|---|---|---|---|---|
| codex | `codex` | `['resume', id, '--yolo']` | `AGENTLRAY_CODEX_BIN` | 既有 |
| claude-code | `claude` | `['--dangerously-skip-permissions', '--resume', id]` | `AGENTLRAY_CLAUDE_CODE_BIN` | 既有 |
| omp | `omp` | `['--auto-approve', `--resume=${id}`]` | `AGENTLRAY_OMP_BIN` | 既有 |
| dsh | `dsh` | `['--profile', 'pi-tui', '--preset', 'standard', '--resume', id]` | `AGENTLRAY_DSH_BIN` | 新增；pi-tui 交互式 TUI 续跑（web 创建的 `session-<uuid>` 会话；`--preset` 在 resume 路径不生效，随用户实测定格） |
| gemini | `gemini` | `['-r', id, '--approval-mode=yolo']` | `AGENTLRAY_GEMINI_BIN` | 新增；`-y` 已弃用走 `--approval-mode=yolo` |
| hermes | `hermes` | `['--resume', id, '--yolo']` | `AGENTLRAY_HERMES_BIN` | 新增 |

> 可执行名解析优先序不变：环境变量 > `~/.agentlray/settings.json` 的 `cliBins` section > 默认命令名（`lib/cli-bins.js`）。

### Resume id 语义（实现时核对，命令构建纯拼串不依赖会话存在）

- dsh：session id = 会话目录名（`session-<uuid>`，dsh-session store 格式，与适配器 `sessionId` 一致）；`dsh --profile pi-tui --preset standard --resume <id>` 在 TUI 重开会话（CLI `--run` 前先 `getSession` 校验存在，既有语义）。
- gemini：session id = 日志元数据 `sessionId`；`gemini -r <id>`。—— 官方 option 备注「latest/索引号」与 cheatsheet「按 id」存在出入，实现时以本机实测为准（若 `-r <metadata sessionId>` 不认，回退方案：`gemini -r latest` 不可定位指定会话，需改文档明确边界）。
- hermes：session id = `hermes.db` 的 `session_id`；`hermes --resume <id> --yolo`。
- openclaw：不做（Q1）。

## 实现清单

后端：

- `lib/resume.js`：`RESUME_BINS` 增 dsh / gemini / hermes 三条；`buildResumeCommand` 与 `hasResumeContract` 无结构改动（既循 id 查表）；错误文案「Only codex / claude-code / omp …」扩为六平台 + 自定义契约。
- `lib/cli-bins.js`：`CLI_BIN_DEFAULTS`、`CLI_BIN_ENV` 各增 dsh / gemini / hermes（默认名 `dsh`/`gemini`/`hermes`，env `AGENTLRAY_{DSH,GEMINI,HERMES}_BIN`）。
- `lib/config.js`：补 `DSH_BIN` / `GEMINI_BIN` / `HERMES_BIN` 常量（与 `CODEX_BIN` 等一致，仅作 envVarFor 依据/文档对照；如无消费者且会造成歧义，则不改并修正注释）。
- `bin/sessions.js`：`resumeSession` 的「无原生续跑」错误文案同步六平台。
- `lib/routes/sessions.js`、`lib/routes/cli-bins.js`：无改动——端点经 `buildResumeCommand`/`CLI_BIN_DEFAULTS` 自动扩展。
- `lib/platforms/index.js`、`GET /api/platforms`：无改动——`hasResumeContract` 对新增内置自动返回 true。

前端（React 是唯一功能开发面；legacy `public/` 冻结快照**不落新功能**）：

- `frontend/src/views/sessions/lib.ts` `resumeCommand`：本地参数拼串扩到六平台（与后端 `RESUME_BINS` 形状一致）。
- `frontend/src/views/sessions/SessionSummary.tsx` `RESUME_BUILTIN_IDS`：扩到六平台。
- `frontend/src/components/SettingsDialog.tsx` `RESUME_BUILTIN_IDS`：扩到六平台（「平台 CLI 命令」分区出现 dsh/gemini/hermes 配置行）。
- `frontend/src/store.ts` `FALLBACK_PLATFORM_INFOS`：dsh / gemini / hermes 的 `resume` 标志改 true。
- legacy `public/js/app.js`：**不改**（冻结快照，resume 维持原三平台；`GET /api/settings/cli-bins` 兼容端点自动多返回三条，legacy 忽略未知键即可）。

文档：

- `docs/usage.zh-CN.md` / `docs/usage.md`：Resume 命令、平台 CLI 命令配置段落（codex/claude-code/omp → 六平台；新增各平台原生续跑命令示例）。
- `docs/design/guide-custom-platforms.zh-CN.md`：resume 未声明时的错误文案引用随代码更新。
- 本项目索引 `AGENTS.md`「代码库现状提示」对应表格行（平台 CLI 命令可配置一条）增补涉及平台。
- 本设计文档登记 `docs/design/README.md`。

## 验证

- `test/api.test.js`（resume-command 端点 + `GET /api/platforms` resume 标志）：
  - 新增 dsh / gemini / hermes 返回命令串断言；hermes 从 `supported:false` 翻转为 `true`；platforms 上 hermes/dsh/gemini `resume:true`。
- `test/session-cli.test.js`（`sessions resume`）：hermes 从「无原生续跑」翻转；新增六平台命令形状断言。
- 前端无既有单测目录则实测：`npm run build` 后起服务，打开 dsh/gemini/hermes 会话详情点「复制恢复命令」，核对复制出的命令串与 CLI `--json` 输出一致。
- 冒烟：`node test/…` 最小集跑通过 + 真实对 dsh 夹具会话执行 `agentlray sessions resume --platform dsh --id <id> --json --run`（若本机可行）观察 spawn 结果。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（后续方案有变更，见下）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 内置平台 resume 契约（当前 5 平台：codex / claude-code / omp / gemini / hermes） | ✅ 已实现 | 各平台 `index.js` 的 `resume`；`lib/resume.js` |
| CLI `--run` / 复制恢复命令 | ✅ 已实现 | `bin/sessions.js`、`lib/routes/sessions.js` |
| 自定义平台 resume opt-in | ✅ 已实现 | `lib/platforms/loader.js`、`lib/resume.js` |

**后续变更（2026-11-10，`0c38d61`）**：dsh 不再支持续跑/新建（交互式 TUI），本设计新增的 dsh `resume` 已被移出，resume 收敛为五平台；同时 `RESUME_BINS` 模块级表已删除，改为各适配器 `resume: { bin, args(id, opts) }` 内联声明、由 `bin/sessions.js` 的 `RESUME_PLATFORMS` 在 require 期从注册表动态收敛。本文档 §目标形态/§实现清单中的 dsh 条目与 `RESUME_BINS` 为当时方案的历史记录。

