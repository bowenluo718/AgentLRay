# 新建会话任务（create）方案设计

> 状态：已定稿（本会话经 grill-with-docs 逐轮确认，R1–R5 全按推荐）。设计树各分支闭合，无残留假设。
> 对应词表：`glossary.zh-CN.md` 已增补「新建会话（create 契约）」。
> 决策记录：`adr-0004-new-session-create.zh-CN.md`。
> 实现基线：当前工作区（未提交的自定义平台扩展 + co-mind 之后）。

## 1. 背景与目标

AgentLRay 现状只有「观察 + 续跑」能力（看板/CLI 列会话、看详情、复制续跑命令），**没有任何「新建会话」能力**（代码里仅 library 有「新建 Prompt」）。需求：**新建会话任务，支持自定义平台**——即 spawn 平台 CLI 开启一个**全新**会话（带提示词 + 工作目录），且该能力对内置与自定义平台都可用。

## 2. 决策摘要（grill R1–R5）

| # | 决策 | 结论 |
| --- | --- | --- |
| R1-Q1 | 「报告」语义 | 「支持」自定义平台（非汇报/上报） |
| R1-Q2 | 新建语义 | spawn 全新会话命令，与 resume 对称（非仅生成命令，非新建后注册跟踪） |
| R1-Q3 | 平台范围 | 全部平台：内置（NEW_BINS）+ 自定义（create opt-in） |
| R2-Q4 | 自定义契约 | `create: { bin, args(opts) }`，与 resume 对称 |
| R2-Q5 | 输入 | prompt + cwd 都可选 |
| R2-Q6 | 界面 | CLI `sessions new` + web 任务看板头部「新建任务」按钮（弹窗：提示词、cwd 项目路径可手动输入、平台选择；默认选中当前会话所属项目与平台） |
| R3-Q7 | 参数模型 | 框架追加提示词为末位裸参，与 resume 的 message 一致 |
| R3-Q8/Q9 | web 执行 | web 后台调用 CLI 能力（后端 spawn），不直接处理输出 |
| R3-Q9b | CLI 执行 | 默认打印命令，`--run` 可选 spawn |
| R3-Q10 | dsh | **不支持新建**（六平台唯一交互式，无法 headless 传提示词） |
| R3-Q11 | 内置命令核实时机 | 实现时用各平台 `--help` 实测定格（omp 已有用户锚点） |
| R4-Q12 | web 执行链路 | 后端新增 POST 路由，复用 CLI spawn 逻辑（抽取到 lib/ 共享） |
| R4-Q13 | spawn 治理 | fire-and-forget：输出丢弃/日志、不跟踪进程、不阻塞 HTTP |
| R4-Q14 | 新建后刷新 | 触发成功后提示 + 刷新看板列表（复用既有轮询/刷新） |
| R4-Q15 | 能力位 | PlatformInfo 加 `create` 标志；弹窗「支持的平台」只列 create=true |
| R5-Q16 | CLI 命名 | `sessions new` |
| R5-Q17 | CLI 参数 | `new [message...] --platform <id> [--dir <cwd>] [--run]` |
| R5-Q18 | 文档 | 词表增补 + 一份 ADR（adr-0004） |

## 3. 契约（create）

### 3.1 自定义平台

适配器可选字段，与 `resume` 同构：

```js
create: {
  bin: 'my-copilot',          // 默认命令名（resolveCliBin 解析：env > cliBins > 此值）
  args: (opts) => ['--new'], // opts = { cwd, message }；返回前置参数数组
}
```

- 未声明 `create` 的平台 → 无新建能力，`sessions new` 与 web「新建任务」报「该平台不支持新建会话」。
- 框架把提示词 `message`（非空时）追加为**末位裸参**（与 resume 一致）。

### 3.2 内置平台（NEW_BINS）

| 平台 | 新建命令（推断形态，实现时 `--help` 实测定格） | 可建 |
| --- | --- | --- |
| codex | `codex exec --full-auto --cd '<cwd>' '<prompt>'` | ✅ |
| claude-code | `claude --dangerously-skip-permissions -p '<prompt>'` | ✅ |
| omp | `omp --auto-approve '<prompt>'`（用户权威锚点） | ✅ |
| gemini | `gemini -p '<prompt>' --approval-mode=yolo` | ✅ |
| hermes | `hermes --yolo '<prompt>'` | ✅ |
| dsh | —（交互式 TUI，无法 headless 传提示词） | ❌ |

cwd 用 `cd '<cwd>' &&`（POSIX）/ `Set-Location`（PowerShell）前缀；提示词空 = 开交互式会话（对 headless 平台即无提示词裸启）。

> **实测校正（P4 收尾，2026-11-03）**：上表形态在实现时按各平台 `--help` 核定，仅限本机已安装者：
> - **omp v18.8.4** → `omp --auto-approve '<prompt>'`（位置参数 `MESSAGES` + `--auto-approve`），与用户锚点一致；
> - **Claude Code 2.1.282** → `claude --dangerously-skip-permissions -p '<prompt>'`（`-p/--print` 是**布尔开关**，提示词走位置参数）；
> - **hermes** → `hermes --yolo -z '<prompt>'`（提示词**不是**位置参，裸位置参被 argparse 判 `invalid choice`；headless 提示词须用 `-z/--oneshot`）；
> - **codex / gemini 未实测**（本机未安装该 CLI）→ 沿用上表推断形态，待有真实 CLI 时校正。
> - 无提示词时 claude-code / hermes 回落交互式形态（`claude --dangerously-skip-permissions` / `hermes --yolo`），其余平台沿用上表形态。
> - **dsh 的一个观察（不改决策，待决）**：dsh `--help` 暴露了 `dsh headless "run the tests"`（"answer one task, print the result, and exit"）子命令，即 dsh 本身并非「完全无法 headless」。P4 仍按 R3-Q10 保持 **dsh 不可建**（该形态的语义/会话落盘与 dsh 的 profile 体系未核实，且超出本次校正范围），但「dsh 唯一交互式」这一理由已不准确，后续若要为 dsh 开放新建需重新评估。

### 3.3 命令串单一真源

新增 `lib/new.js`（或扩 `lib/resume.js` 为 `lib/session-command.js`）：`NEW_BINS` + `hasCreateContract(platform)` + `buildNewCommand(platform, opts)`，CLI 与 web 共用；内部经 `resolveCliBin()` 解析可执行名。与既有 `lib/resume.js` 完全对称。

## 4. CLI `sessions new`

```
agentlray sessions new [message...] --platform <id> [--dir <cwd>] [--run]
```

- `message...`：提示词（位置参数，可空=开交互式）
- `--platform <id>`：单平台；缺省用持久化平台数据（与既有 list/show/resume 缺省逻辑一致）
- `--dir <cwd>`：覆盖工作目录；空则平台默认目录
- `--run`：真正 spawn；默认只打印命令串（与 `resume --run` 对称）
- 输出/退出码沿用 `{schemaVersion:1,…}` 约定

## 5. web 任务看板「新建任务」

- **入口**：任务看板头部「新建任务」按钮。
- **弹窗**：提示词输入、cwd 项目路径（可手动输入）、平台选择下拉（**只列 create=true 平台**）。
- **默认值**：选中当前会话所属项目（cwd）与平台。
- **执行链路**：前端调后端 `POST /api/:platform/sessions/new`（body：`{ message?, cwd? }`）→ 后端复用 CLI spawn 逻辑（抽取到 `lib/`）spawn 平台 CLI → fire-and-forget（输出丢弃/日志、不跟踪进程、立即返回「已触发」）→ 前端提示成功 + 刷新看板列表。
- **能力位**：`GET /api/platforms` 的 `PlatformInfo` 增加 `create` 标志，弹窗据此过滤平台；未声明 create 的平台不可选。

## 6. 信任与安全边界

- spawn 的是平台**原生 CLI**（用户信任的既有命令，与 resume 同信任级），不引入新进程治理。
- web fire-and-forget：不展示 spawn 输出、不提供查询/终止（进程生命周期管理明确不做），用户需在终端/平台侧自行观察结果——如实标注此取舍。
- dsh 如实降级：六平台唯一不可建，不误报。

## 7. 验证方案

| 事项 | 验证方式 |
| --- | --- |
| 命令串单一真源 | CLI `sessions new` 与 web 弹窗生成的命令串逐字符一致（复用 lib 共享） |
| 自定义 create opt-in | 声明 create 的自定义平台 `sessions new --run` spawn 对应 bin；未声明报「该平台不支持新建会话」 |
| 内置新建 | 各平台 `--help` 实测校正 NEW_BINS（codex/claude/gemini/hermes） |
| dsh 降级 | dsh `sessions new` 与 web 弹窗均报「不支持新建」且不可选 |
| prompt 末位裸参 | `omp --auto-approve '<prompt>'` 提示词落在末位；空 prompt 无提示词参数 |
| web 链路 | 弹窗默认当前会话项目/平台、只列 create 平台；点确定后端 spawn、前端提示 + 刷新 |
| CLI --run | `--run` 实际 spawn；默认只打印 |

> **验证结果（P4 收尾，2026-11-03）**：
>
> | §7 事项 | 结论 | 证据 |
> | --- | --- | --- |
> | 命令串单一真源 | 达成 | CLI `sessions new` 与 web 弹窗生成的命令串逐字符一致（均经 `lib/new.js` `buildNewCommand`），my-newplat / omp / hermes 三平台比对一致 |
> | 自定义 create opt-in | 达成 | 临时 HOME 下声明 `create:{bin,args}` 的自定义平台 `my-newplat` 生成命令且 `--run` 真实 spawn 假 bin（传入 cwd）；未声明 create 的平台报「该平台不支持新建会话」 |
> | 内置新建 | 部分达成 | omp v18.8.4 / Claude Code 2.1.282 / hermes 按 `--help` 实测定格；**codex / gemini 未实测**（本机未装 CLI），沿用推断形态并标注「未实测」 |
> | dsh 降级 | 达成 | CLI `sessions new --platform dsh` 退出 1（"no native create command"）；web 弹窗平台下拉不列 dsh |
> | prompt 末位裸参 | 达成 | 各平台生成命令串中提示词均落在末位（如 `omp --auto-approve 'm'`）；空 prompt 无提示词参数 |
> | web 链路 | 达成 | 浏览器 fetch 拦截记录 `POST /api/codex/sessions/new` 后紧跟 `GET /api/sessions?platform=all`（触发后看板列表刷新）；弹窗默认当前会话平台+cwd、平台下拉只列 5 个 create 平台（P3 已证） |
> | CLI --run | 达成 | 假 codex 与假 my-newbin 均收到真实 spawn（cwd 传入）；默认只打印命令串 |

## 8. 实现任务切分

- **P0 契约与共享层**：`lib/new.js`（或扩 `lib/resume.js`）`NEW_BINS` + `hasCreateContract` + `buildNewCommand` + `resolveCliBin` 复用；抽 CLI spawn 逻辑到 `lib/` 共享；单测。
- **P1 CLI**：`bin/sessions.js` 加 `new` 子命令（`--platform`/`--dir`/`--run`/缺省平台）+ `cli-usage.md` + 测试。
- **P2 服务端**：`POST /api/:platform/sessions/new` 路由（复用共享 spawn）+ `GET /api/platforms` 加 `create` 标志 + 测试。
- **P3 React 前端**：任务看板头部「新建任务」按钮 + 弹窗（提示词/cwd/平台选择、默认当前会话项目平台、只列 create 平台）+ 触发后刷新；`types.ts`/`client.ts`/`store.ts` 增 create 能力位与新建调用。
- **P4 收尾**：内置 `--help` 实测校正、`docs/usage*` 章节、词表/ADR/本文档登记核对。

> 与既有约定一致：中间文档入 `docs/.local/` 并按 `README.md` 登记；`frontend/` 是唯一功能开发面，legacy `public/` 冻结快照只接安全修复，**新功能不落 legacy**。
