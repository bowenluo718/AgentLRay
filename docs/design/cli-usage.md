# AgentLRay bin 命令使用说明

> 本文件整理 `bin/` 下各 CLI 子命令入口的完整使用说明（inspect/evidence、sessions、platform 及服务启动主入口），与当前代码保持一致。
> 溯源：`bin/agentlray.js`、`bin/inspect.js`（HELP）、`bin/sessions.js`（HELP）、`bin/platform.js`（HELP）。

---

## 1. 主入口 `bin/agentlray.js`

`package.json` 中注册了两个 bin 别名：`agentlray` 与 `agent-lray`，指向同一入口。

```text
Usage: agentlray [--port <port>] [--host <host>] [--version]
Offline evidence: agentlray inspect --help
Explicit raw evidence: agentlray evidence --help
Session queries/resume: agentlray sessions --help
Platform queries: agentlray platform --help
```

参数：

| 参数 | 别名 | 说明 |
| --- | --- | --- |
| `--port <port>` | `-p` | 服务端口，缺省读环境变量 `PORT` |
| `--host <host>` | `-H` | 监听地址，缺省读环境变量 `HOST` |
| `--version` | `-v` | 打印 `package.json` 的 `version` 后退出（`0`） |
| `--help` | `-h` | 打印上述用法并退出（`0`） |

子命令路由：首参为 `inspect`/`evidence` → 转发 `bin/inspect.js`；`sessions` → 转发 `bin/sessions.js`；`platform` → 转发 `bin/platform.js`。未知选项报错到 stderr 并以退出码 `1` 结束。

---

## 2. 离线 inspect `bin/inspect.js`

### 2.1 子命令与语法

```text
Usage: agentlray inspect --platform <omp|codex|claude-code> <file.jsonl> [--json] [--summary] [--fail-on pending-failures]
       agentlray evidence --platform <omp|codex|claude-code> <file.jsonl> --sha256 <hash> --line <number> [--offset <bytes>] [--max-bytes <4..16384>] [--json]
```

### 2.2 说明

- 只读**一个**稳定的常规 UTF-8 JSONL 文件（最大 64 MiB），**不启动服务器**。
- `inspect`：默认输出完整报告。
  - `--summary`：需配合 `--json`，以引用为界输出，不输出聚合计数。
  - `--fail-on pending-failures`：发现 pending 失败记录时退出码 `2`。
- `evidence`：显式输出**原始**内容（可能敏感），始终 JSON、sha256 校验，默认 content 上限 `4096` 字节。
- 引用行号：基于物理行的**一-based** 行号。
- 字节分页保持 UTF-8 安全：用 `--offset` 传入，响应中的 `nextOffset` 可继续翻页。
- 退出码：`0` = 报告完整（**不是**任务成功）；`1` = 输入/运行时/覆盖错误；`2` = 仅 `inspect --fail-on pending-failures` 发现 pending 失败记录。
- JSON 失败输出：`{schemaVersion:1, kind:"error", error:{code, message}}` 写到 **stdout**。
- 覆盖不完整时：**stdout 仍保留报告数据**，同时在 **stderr** 报告 `COVERAGE_INCOMPLETE`。

---

## 3. 会话查询/续跑 `bin/sessions.js`

### 3.1 子命令语法

```text
agentlray sessions list   [--platform <p|p1,p2|all>] [--agent NAME] [--dir PATH]
                          [--status <s,...>] [--match TEXT]
                          [--since ISO] [--until ISO] [--limit N] [--offset N] [--json]
agentlray sessions show   [--platform <p>] --id <SESSION_ID> [--agent NAME] [--dir PATH]
                          [--tail N] [--full] [--json]
agentlray sessions resume [--platform <codex|claude-code|omp>] --id <SESSION_ID>
                          [--dir PATH] [--cwd PATH] [--message TEXT] [--run] [--json]
agentlray sessions new    [message...] [--platform <p>] [--dir PATH] [--run] [--json]
```

### 3.2 子命令语义

| 子命令 | 说明 |
| --- | --- |
| `list` | 按条件查询会话列表，支持全部 7 平台（openclaw/codex/claude-code/hermes/omp/dsh/gemini）；**支持一次查询多个平台**：`--platform` 逗号分隔多值（如 `omp,codex`）或 `all`（全部 7 平台）。openclaw 未传 `--agent` 时默认查询该平台**全部 agents 的合并会话**：单平台展平为一份（每条带来源 `agent`，纯文本行首含 agent 列，JSON 带 `allAgents:true`），多平台聚合每个 agent 一段；传 `--agent` 则限定单 agent。结果按各平台既有分组排序（状态组内时间降序）；每条含 `firstUserMessage` 首条用户消息与 `lastMessage`（最后一条 user/assistant 内容）。JSON 单平台输出 `{platform, agent, total, offset, limit, sessions}`；多平台输出 `{platform, all, platformIds, total, offset, limit, platforms:[{platform, agent, total, offset, limit, sessions}]}`（过滤/分页逐平台独立）。纯文本以 `== platform [/agent] ==` 分段。 |
| `show` | 查看单个会话的元信息与归一化消息时间线（openclaw 未传 `--agent` 时跨全部 agents 查找该 id，JSON 含 `agent` 归属）。 |
| `resume` | 生成该会话在原 CLI 中的续跑命令（`codex resume` / `claude --resume` / `omp --resume=`）。仅 codex/claude-code/omp 有原生续跑契约，其余平台明确报错。默认只打印命令不执行；加 `--run` 才真正 `spawn` 平台 CLI 执行，并透传 stdin/stdout 与退出码。 |
| `new` | 生成并（可选）执行「新建会话」命令（`codex exec --full-auto` / `claude --dangerously-skip-permissions -p` / `omp --auto-approve` / `gemini -p --approval-mode=yolo` / `hermes --yolo -z`）。内置 codex / claude-code / omp / gemini / hermes 可建；**dsh 是交互式 TUI、无法 headless 传提示词 → 不支持新建**（明确报错）。自定义平台需适配器声明 `create`（bin + args(opts)），缺省则 new 报错。提示词 = `new` 后剩余位置参数 `join(' ')`，可空（空 = 无提示词裸启/开交互式）。默认只打印命令不执行；加 `--run` 才真正 **fire-and-forget** spawn（输出丢弃、不跟踪进程、不等待退出，进程生命周期管理明确不做——需在平台 CLI 侧自行观察结果）。 |

> `--platform` **非必填**：缺省使用**页面持久化的平台数据**——web 看板把平台选择同步到后端
> `GET/PUT /api/settings/ui`，落盘 `~/.agentlray/ui-settings.json`，CLI 读取同一文件，保证终端与
> 页面视角一致。`list` 用持久化的多选集合（单平台模式用 `platform`；未持久化或全选时 = `all`）；
> `show`/`resume`/`new` 用持久化的单平台，无该数据则报错要求显式指定 `--platform`。

### 3.3 参数说明

| 参数 | 适用范围 | 说明 |
| --- | --- | --- |
| `--platform <p>` | list/show/resume/new | **可选**。平台 id；list/show 支持逗号分隔多值或 `all`（全部平台），resume 仅 `codex\|claude-code\|omp`，new 仅 `codex\|claude-code\|omp\|gemini\|hermes`（或声明了对应契约的自定义平台）。缺省用页面持久化的平台选择（见 3.2 末尾） |
| `--id <ID>` | show/resume | 会话 id |
| `--agent <name>` | list/show | openclaw 下可选；缺省 = 该平台**全部 agents**（list 合并/展平，show 跨全部 agents 查找该 id），传则限定单 agent；其他平台忽略 |
| `--dir <path>` | list/show/resume/new | 覆盖该平台默认数据目录（绝对路径）；**仅单平台查询有效**，多平台查询会报错；new 另作执行目录 cwd（缺省取平台默认目录 `defaultDir()`） |
| `--status <s,…>` | list | 按状态过滤：`awaiting-input\|working\|waiting\|stopped`，可逗号多值 |
| `--match <text>` | list | 按 title / 首条用户消息 / 最后一条消息 / 会话 id 子串匹配（忽略大小写） |
| `--since <ISO>` | list | 只保留 lastActivity（缺省回退 timestamp）≥ 该时刻的会话 |
| `--until <ISO>` | list | 只保留 lastActivity（缺省回退 timestamp）≤ 该时刻的会话 |
| `--limit <N>` | list | 最多输出 N 条（过滤后分页；默认不限） |
| `--offset <N>` | list | 跳过前 N 条（过滤后分页；默认 0） |
| `--tail <N>` | show | 只打印最后 N 条消息 |
| `--full` | show | 输出完整消息文本（默认每条文本截断到 2000 字符） |
| `--cwd <path>` | resume | 执行目录（默认取会话记录 cwd） |
| `--message <txt>` | resume | 追加的续发消息（作为提示词参数传给平台 CLI） |
| `message...` | new | 提示词（位置参数 `join(' ')`，可空 = 无提示词裸启/开交互式）；由框架追加为平台 CLI 参数末位裸参 |
| `--run` | resume/new | 真正执行，而非只打印命令；new 为 fire-and-forget spawn（不跟踪进程/退出码） |
| `--json` | 全部 | 机器可读 JSON 输出；错误为 `{schemaVersion:1, kind:"error", error:{code,message}}` |

### 3.4 输出与退出码

与 `inspect.js` 相同的约定：`--json` 输出 `{schemaVersion:1, …}`，错误为 `{schemaVersion:1, kind:"error", error:{code,message}}`；退出码 `0` = 命令成功完成（对 `resume`/`new` 指命令已生成/已执行，**非**任务成功），`1` = 参数或运行时错误（含 `new` 平台无 create 契约、spawn 失败）。

`new` 输出：
- 打印模式（无 `--run`）：非 json 直接打印 `command`；`--json` 输出 `{schemaVersion:1, kind:"new", platform, message, cwd, bin, args, command, executed:false}`。
- `--run`：fire-and-forget spawn 触发后立即返回；`--json` 输出 `{…, executed:true, exitCode:null}`（不跟踪退出码），非 json 打印「已触发新建会话：<command>」并提示输出在平台 CLI 侧、本工具不跟踪该进程。

> **各平台新建命令形态的实测来源（P4 实测校正）**——仅在本机安装了对应 CLI 的平台做 `--help` 核定：
>
> | 平台 | 形态 | 实测依据 |
> | --- | --- | --- |
> | omp | `omp --auto-approve '<prompt>'` | omp v18.8.4 `--help`：位置参数 `MESSAGES` + `--auto-approve`（Auto-approve all tool calls）；与用户权威锚点一致 |
> | claude-code | `claude --dangerously-skip-permissions -p '<prompt>'` | Claude Code 2.1.282 `--help`：Usage `claude [options] [command] [prompt]`；`-p, --print` 为**布尔开关**（"Print response and exit"，提示词走位置参数）、`--dangerously-skip-permissions` = "Bypass all permission checks"；无 `--cwd`（用进程 CWD，与 `cd` 前缀一致） |
> | hermes | `hermes --yolo -z '<prompt>'` | hermes `--help`：提示词**不是**位置参数（裸位置参被 argparse 判为 `invalid choice`），headless 提示词须用 `-z/--oneshot PROMPT`（One-shot mode，面向 scripts/pipes）；`--yolo` = Bypass all dangerous command approval prompts |
> | codex | `codex exec --full-auto '<prompt>'` | **未实测**（本机未安装 codex CLI）——沿用设计文档 §3.2 推断形态 |
> | gemini | `gemini -p --approval-mode=yolo '<prompt>'` | **未实测**（本机未安装 gemini CLI）——沿用设计文档 §3.2 推断形态 |
>
> 由此产生的两条语义校正：① hermes 的提示词改走 `-z/--oneshot`（裸位置参形态 `hermes --yolo '<prompt>'` 实测直接报错退出）；② 无提示词时 claude-code 与 hermes 回落**交互式**形态（`claude --dangerously-skip-permissions` / `hermes --yolo`）——claude 的 `-p` 省略即 "starts an interactive session by default"，hermes 的 `-z` 必须带值（"expected one argument"）故不能保留。

---

## 4. 平台清单/校验 `bin/platform.js`

### 4.1 子命令语法

```text
agentlray platform list              [--json]
agentlray platform validate <file>   [--json]
agentlray platform mount <id>        [--json]     # 挂载/启用
agentlray platform unmount <id>      [--json]     # 停用
agentlray platform replace <id>      [--json]     # 声明替代包内置
agentlray platform unreplace <id>    [--json]     # 撤销替代
agentlray platform export <id>       [--out <dir>] [--force] [--no-replace] [--json]
```

### 4.2 子命令语义

| 子命令 | 说明 |
| --- | --- |
| `list [--json]` | 列出全部平台：内置（builtin）→ 项目/自定义 → broken，顺序与 `GET /api/platforms` 完全一致（单一真源 `lib/platforms.listPlatformInfo()`）。每条含 `id/label/origin/mounted/configuredMounted/restartRequired/capabilities/broken`；broken 条目无 label、`error` 附带加载/校验失败原因（便于排查 `~/.agentlray/platforms/` 下的坏适配器）。`AGENTLRAY_NO_PLUGINS=1` 时自定义平台缺席、仅一条「已禁用」逃生 broken 说明。 |
| `validate <file>` | 对单个适配器文件做**与加载器同一套**校验（复用 `loader.validateAdapter`）：导出对象 / `id` 匹配 `^[a-z0-9][a-z0-9-]*$` / `label` 字符串 / 必需函数 `defaultDir`、`parse`、`getSession` 存在（`list` 可为 `null`，与 loader 语义一致）/ `id` 与既有平台不冲突。通过后再调**真实** `list(defaultDir())` 取会话计数与首条 id（`defaultDir` 允许相对路径，读到什么就是什么）。**dry-run**：不写 registry、不改 `PLATFORMS`、不持久化任何状态。 |
| `mount <id>` / `unmount <id>` | 挂载/停用平台——写 `settings.platforms.disabled`，重启后生效（`mount` 移出、`unmount` 加入）。停用**最后一个可查询平台** → 退出码 `1` + `last-platform`。 |
| `replace <id>` / `unreplace <id>` | 声明/撤销对包内置的替代——写 `settings.platforms.replaced`，重启后生效。`unreplace` 若同 id 的 project/user 文件仍存在会附加「下次加载会 broken」提示。 |
| `export <id>` | 把**包内置（package）或项目（project）**平台导出为用户**薄适配器**，写入 `--out <dir>` 或缺省 `~/.agentlray/platforms`（可由 `AGENTLRAY_PLATFORMS_DIR` 覆盖）下的 `<id>.js`。默认把 id 加入 `settings.replaced`（`--no-replace` 关闭）、若在 `settings.disabled` 中则移出。`--force` 覆盖已存在文件。来源已为 `user` 拒绝（`export-user-origin`）；文件冲突无 `--force` 报 `export-exists`。生成的薄适配器经 `AGENTLRAY_PKG_ROOT`（加载器设置的包根）解析包内实现，包升级自动跟随。 |

`validate` 失败三型，均退出码 `1` 且 `kind:"error"`：

- `code:"validate"` — 结构校验失败（文件不存在 / `require` 抛错 / 导出非对象 / `id` 非法 / 缺必需函数 / `label` 非字符串 / id 冲突）；
- `code:"validate-sessions"` — 适配器结构校验通过但**会话不可读**：`defaultDir()` 抛错、未提供 `list` 函数（loader 允许 `list` 为 `null`）、`list()` 抛错（如目录不存在）或未返回数组；
- `code:"usage"` — 参数错误（未知子命令/选项、缺少 `<file>`）。

### 4.3 参数与输出

| 参数 | 说明 |
| --- | --- |
| `<file>` | validate 的适配器文件路径（相对/绝对均可，按真实执行目录解析） |
| `<id>` | mount/unmount/replace/unreplace/export 的平台 id |
| `--out <dir>` | export 的目标目录（缺省 `~/.agentlray/platforms` 或 `AGENTLRAY_PLATFORMS_DIR`） |
| `--force` | export 覆盖已存在文件 |
| `--no-replace` | export 不写 `settings.replaced` |
| `--json` | 机器可读输出写 **stdout** |

- `list --json`：`{schemaVersion:1, kind:"platforms", platforms:[…]}`（`platforms` 即 `listPlatformInfo()` 结果）。
- `validate --json` 成功：`{schemaVersion:1, kind:"platform-validate", ok:true, platform:{id,label}, sessionCount, firstId, note}`（`firstId` 为 `list()` 首条摘要的 id，无会话时为 `null`；`note` 为信任边界提示）。
- `validate` 纯文本成功：单行 `platform validate: ok — id=… label=… sessions=N firstId=…`，stderr 另附信任提示。
- `mount/unmount/replace/unreplace --json`：`{schemaVersion:1, kind:"platform-<cmd>", id, …payload, restart:true}`；`export --json`：`{schemaVersion:1, kind:"platform-export", id, file, origin, replaced, removedFromDisabled, restart:true, note}`。错误一律 `{schemaVersion:1, kind:"error", error:{code,message}}`。
- **信任边界**：平台适配器会以你的用户权限执行其任意代码——只投递可信的适配器文件（validate / export 输出会明示）。

### 4.4 退出码

`0` = 成功（validate 指结构校验通过**且**会话可读）；`1` = 参数/运行时/校验错误。错误 JSON 写 **stdout**，人类可读信息写 **stderr**。

---

## 5. 验证方式

```bash
# 主入口帮助
node bin/agentlray.js --help
node bin/agentlray.js --version

# 子命令帮助
node bin/agentlray.js inspect --help
node bin/agentlray.js sessions --help
node bin/agentlray.js platform --help

# 平台清单（内置 + 项目 + 自定义 + broken）与适配器干式校验
node bin/agentlray.js platform list --json
node bin/agentlray.js platform validate ~/.agentlray/platforms/my-copilot.js --json

# 停用/声明替代/迁移到用户薄适配器（均重启后生效）
node bin/agentlray.js platform unmount omp --json
node bin/agentlray.js platform replace codex --json
node bin/agentlray.js platform export codex --out ~/.agentlray/platforms --json

# 环境变量：AGENTLRAY_PKG_ROOT（包根，供 export 薄适配器解析）、AGENTLRAY_PROJECT_PLATFORMS_DIR（项目平台目录）
AGENTLRAY_PROJECT_PLATFORMS_DIR=/path/to/repo/platforms node bin/agentlray.js platform list --json

# 实际运行示例（会话列表，限定 3 条）
node bin/agentlray.js sessions list --platform codex --limit 3 --json

# 新建会话：默认打印命令，--run 才真正 fire-and-forget spawn
node bin/agentlray.js sessions new "修 bug" --platform codex --dir /tmp/x
node bin/agentlray.js sessions new "建个会话" --platform codex --dir /tmp/x --run
node bin/agentlray.js sessions new --platform dsh --json   # 退出 1：dsh 不支持新建
```

---

## 6. API：多平台会话列表聚合端点

`GET /api/sessions?platform=all|a,b|omp[&agent=][&dirXxx=][&status=][&match=][&since=][&until=][&offset=][&limit=]`

- 既有的 `GET /api/:platform/sessions`（单平台裸数组）保持不变；本端点是其多平台聚合形态，与 CLI `sessions list` 共享 `lib/session-list.js`（过滤/分页/平台选择语义一致）。
- OpenClaw 平台新增专用于"全部 agent"的两个端点（挂在本机看板的 React 前端默认视图）：
  - `GET /api/openclaw/sessions[?agent=&include_archived=&dir=]` → flat `SessionSummary[]`，缺省合并全部 agents（每条带来源 `agent`），`?agent=` 限定单 agent；
  - `GET /api/openclaw/sessions/:id[?dir=]` → `{ session, messages, agent }`，跨全部 agents 查找并标注归属。
- 返回 `{ all, platformIds, total, offset, limit, platforms:[{platform, agent, total, offset, limit, sessions}] }`：
  - `platform=all` → 全部 7 平台；`platform=a,b` → 指定平台子集；`platform=omp` → 单平台。
  - openclaw 不带 `agent` → 每个 agent 一块（来源可见）；带 `agent` → 限该 agent。
  - 每个平台块的 `sessions` 各按该平台既有分组排序（状态组内时间降序）、独立过滤/分页。
  - 目录覆盖用 `dirOpenclaw`/`dirCodex`/`dirClaude`/`dirHermes`/`dirOmp`/`dirDsh`/`dirGemini`。
- 前端多平台视图（PlatformBar 可勾选多个平台 +「全部」一次全选）即此端点：`GET /api/sessions?platform=<逗号子集|all>`，列表按平台分组渲染，点击某平台会话自动切到该平台加载详情。
- `agentlray sessions list --platform all --json` 与 `GET /api/sessions?platform=all` 数据同源、shape 对齐。

