# AgentLRay Windows 兼容设计

> 类型：方案设计
> 状态：**已评审收敛（grill-with-docs R1–R3，2026-10-29），待实现**
> 关联：`adr-0003-windows-compat.zh-CN.md`（决策记录）、`progress-windows-compat-grill-2026-10-29.md`（grilling 会话进展）
> 目标代码基线：master `72dee90`（含未提交的自定义平台 P0–P5）

## 背景与目标

AgentLRay 目前只在 Linux/macOS 上可用，Windows 上因 `lib/config.js` 硬编码 `process.env.HOME` 回退 `/root`、平台默认目录为 Linux 约定、命令串为 POSIX 语法、CLI spawn 裸命令名等问题，无法正常运行。

**目标**：AgentLRay 在 Windows 上完整可用——看板只读、`sessions resume` 续跑、状态四态、搜索/导出/备份/LLM 等全部能力。

**范围约束**：
- 不改平台默认目录为 Windows 硬编码映射表（依赖环境变量 + 文档声明）
- omp 进程管理在 Windows 上**能力降级 + 提示**，不做完整 tasklist 实现（独立工作项）
- 不处理 `experiments/`（不属 npm 发布范围）
- `README.zh-CN.md` 暂不改

## 问题清单（已核实，含行号）

见 `progress-windows-compat-grill-2026-10-29.md`「已确认事实」表。核心五类：

1. **HOME 根因**：`lib/config.js:4` `process.env.HOME || '/root'`
2. **进程管理**：`bin/sessions.js` `/proc` + SIGTERM/SIGKILL（omp 专属）
3. **命令串**：`lib/resume.js:73` + 前端 `lib.ts:380` POSIX 串
4. **CLI 探测/spawn**：`lib/llm.js:50-82` `X_OK` 裸名；spawn/execFile 裸名
5. **HOME 散点**：`~/.claude.json`、`~/.claude/history.jsonl`、INSTALL_TARGETS

## 方案（P0–P4）

### P0：HOME 修正（底座）

- `lib/config.js:4`：`const HOME = process.env.AGENTLRAY_HOME || os.homedir();`
  - 引入 `os.homedir()`（跨 Win/macOS/Linux 权威 API），替换 `process.env.HOME || '/root'`
  - 保留 `AGENTLRAY_HOME` 覆盖（便携部署/测试隔离）
  - 顺带修复 macOS 无 HOME 的隐患
- 散点独立改造（Q6=A，不走 config.js HOME，语义不同）：
  - `lib/tool-audit.js:177` → `path.join(os.homedir(), '.claude.json')`
  - `lib/search.js:178`、`lib/library.js:443`、`lib/backup.js:69` → `path.join(os.homedir(), '.claude', 'history.jsonl')`
  - `lib/library.js:15-17` INSTALL_TARGETS → `os.homedir()` 基准
- **平台默认目录不改逻辑**（Q7=A）：`os.homedir()` 修好后，多数跨平台 CLI（claude-code/codex/gemini 等）在 Windows 把点目录放 `%USERPROFILE%` 下，开箱即用；不一致的靠已有环境变量（`OPENCLAW_DIR`/`CODEX_DIR`/`CLAUDE_CODE_DIR`/`HERMES_DIR`/`OMP_DIR`/`DSH_DIR`/`GEMINI_DIR`）覆盖，P4 文档标注。

**验证**：Windows 上 `node server.js` 启动日志显示各平台目录落在 `%USERPROFILE%` 下；`node -e "console.log(require('./lib/config').HOME)"` 输出正确家目录。

### P1：命令串与 CLI spawn

- `lib/resume.js` `buildResumeCommand`（:73）：按 `process.platform === 'win32'` 输出 PowerShell 语法（Q9=B、Q12=A）：
  - POSIX（现行为）：`cd 'cwd' && bin args`
  - PowerShell：`Set-Location 'cwd'; & bin args`（无 cwd 时省略 Set-Location）
  - 统一经 `shellQuote`/`shellToken` 适配引号（Windows 用双引号/单引号规则）
- 前端 `SessionSummary.tsx:143` + `lib.ts:369-381`（Q8=服务端下发、Q11=A）：
  - 内置平台也统一走 `GET /api/:platform/sessions/:id/resume-command`（服务端 `buildResumeCommand` 已返回 `command` 串）
  - 废弃前端本地 `resumeCommand`，命令串单一真源彻底收拢到 `lib/resume.js`
- `lib/llm.js` `findClaudeCli`（:50-70）：Windows 上 `.cmd` 探测
  - 候选名加 `.cmd`/`.exe` 后缀扫描；`X_OK` 在 Windows 语义弱，改为 `fs.accessSync(candidate)`（存在性）或按 `process.platform` 分支
  - `runClaudeCli`（:74）`execFile(CLAUDE_BIN, ...)` → 加 `shell: process.platform === 'win32'` 或解析 `.cmd` 全路径
- spawn/execFile 统一加 `shell: process.platform === 'win32'`（Q10=A）：
  - `lib/library.js:148`（git）、`bin/sessions.js:541`（runChild）、`lib/resume.js` 相关
  - 数组参数 + 非用户输入拼接 → 注入风险可控
- 前端 `frontend/src/views/sessions/diagnostics.ts:630`：绝对路径判定改跨平台
  - `/^\//`（POSIX）→ 同时识别 `/^[A-Za-z]:[\\/]/`（Windows 盘符）与 `/^\\\\/`（UNC）

**验证**：Windows 上 `sessions resume` 输出 PowerShell 命令串可粘贴执行；`findClaudeCli` 能探测到 `claude.cmd`；LLM 功能可用。

### P2：omp 进程管理降级（能力降级 + 提示，非完整实现）

实现已迁入 `lib/platforms/builtin/omp/resume.js`（`createOmpResumeHooks`）：

- `liveOmpPidForSession`：非 Linux 时（`return null`）**显式打印提示**「Windows 暂不支持检测运行中的 omp 持有实例」而非静默失效
- `terminateOmpHolder`：Windows 上 `--run` 遇到需终止场景时，打印「Windows 暂不支持自动终止 omp 持有实例，请手动结束」，不执行 `process.kill`，返回 `false`
- `terminateOmpHolder`：Linux 分支保留 `/proc/stat` 僵尸判定；`process.kill(pid,0)` 存活探测跨平台可用
- **降级语义（保证任务执行）**：`prepare` 在「无法判断激活状态（非 Linux 无 /proc 检测）」或「无法自动终止持有实例」时**不再抛错阻塞续跑**，降级为直接执行续跑并如实提示（`terminated=false`、`livePid=null`），由 `after` 继续做派生兜底校验——避免激活状态判断/进程关闭失败阻断任务执行
- `findOmpFork`：**不改**（纯 JSONL 扫描，跨平台）

**验证**：Windows 上 `sessions resume --run` 对非空闲 omp 会话给出明确降级提示、直接续跑不阻塞；无法终止时降级续跑（`terminated=false`）而非抛错。

### P3：测试

- 类 1（Linux 硬依赖，skip）：`test/session-cli.test.js` 中依赖 `#!/bin/sh` 假 CLI（:50）、`/proc/<pid>/stat`（:87）、`spawn('bash', ...)`（:603/:642/:672）的用例，用 `{ skip: process.platform === 'win32' }` 跳过（omp 持有/终止组，Windows 无等价信号语义）
- 类 2（改跨平台）：`makeFakeBin` 假 CLI 改 `node -e` 脚本（非 `#!/bin/sh`）；`isAlive` 去掉 `/proc/stat` 僵尸分支，仅用 `process.kill(pid,0)`
- 类 3（新增跨平台测试）：
  - `os.homedir()` HOME 解析（含 `AGENTLRAY_HOME` 覆盖）
  - `lib/resume.js` 在 win32/posix 下的命令串（PowerShell vs POSIX）
  - `findClaudeCli` 的 `.cmd` 探测
  - `shell: win32` 的 spawn 参数

**验证**：Windows 上 `npm test` 绿色（跳过类 1，其余通过）。

### P4：文档

- `docs/usage.zh-CN.md` 默认目录表（:143-153）加「Windows 提示」列，标注不一致平台需设环境变量
- 本 design + ADR 登记 `docs/.local/README.md` 索引
- glossary 增补术语
- **README.zh-CN.md 不改**（用户确认）

**验证**：文档可追溯、结论可执行。

## 依赖与风险

- `lib/routes/watch.js:84-99` fs.watch 监听 SQLite `-wal` 文件：Windows 上 WAL 删重建可能监听失效 —— **待评估，非阻塞**（hermes 平台；后续单独验证）
- 各平台 Windows 目录事实不全：P4 文档声明「若不一致设环境变量」，不写死映射表（Q7）
- `shell: true` 注入面：仅 win32 生效、数组参数、非用户输入拼接，风险可控（Q10 已确认）
- 测试 skip 可能掩盖回归：类 2 尽量真改跨平台，类 1 仅限确实依赖信号语义的 omp 组（Q13）

## 实施顺序建议

P0 → P1 → P2 → P3 → P4（P0/P1 无强依赖，可并行但建议串行便于独立验证）。每阶段独立可验证（见各阶段「验证」）。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（文档内「待实现」为历史状态）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| HOME / 目录解析 | ✅ 已实现 | `lib/config.js:5`、`lib/platforms/shared/config.js` |
| 命令串单一真源 + `shell: win32` | ✅ 已实现 | `lib/resume.js:43`、`lib/new.js`、`lib/transport.js:19` |
| 测试跨平台拆分 | ✅ 已实现 | `test/` 中 `win32` skip/branch |

> 本文档已从 `docs/.local/` 迁移至正式文档目录，随代码提交；`docs/.local/` 保留同名过程稿。后续实现变更请同步更新本节与 `docs/.local/README.md` 的进度索引。
