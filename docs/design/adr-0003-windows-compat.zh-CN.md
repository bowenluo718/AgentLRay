# ADR-0003：AgentLRay Windows 兼容方案

> 状态：**Accepted**（2026-10-29，grill-with-docs R1–R3 收敛）
> 关联：`design-windows-compat.zh-CN.md`（完整设计）、`progress-windows-compat-grill-2026-10-29.md`（决策过程）

## 背景

AgentLRay 在 Windows 上因 HOME 硬编码、POSIX 命令串、裸命令 spawn、`/proc` 依赖等无法正常运行。目标是在 Windows 上完整可用。

## 决策

### D1：HOME 解析用 `os.homedir()`

`lib/config.js` 的 `const HOME = process.env.HOME || '/root'` 改为 `const HOME = process.env.AGENTLRAY_HOME || os.homedir()`。

- **为何**：`process.env.HOME` 在 Windows 不存在（应为 `USERPROFILE`），回退 `/root` 导致所有默认目录/配置指向不存在的路径。`os.homedir()` 是 Node 跨平台权威 API（Win/macOS/Linux 全对），顺带修 macOS 无 HOME 隐患。
- **为何保留 `AGENTLRAY_HOME`**：支持便携部署与测试隔离。
- **为何散点（~/.claude.json 等）不用 config.js 的 HOME**：`~/.claude/*` 是 claude CLI 自身文件，与 agentlray 数据目录（`~/.agentlray/`）语义不同，各自独立 `os.homedir()` 更符合各自语义，避免把不同归属的路径混在一个「agentlray 家目录」下。
  - **修订（design-platform-dir-decl，2026-11-08）**：平台目录/名词已解耦到各平台文件的 `dirs.js` 分段声明（root `home` 即本条的 `os.homedir()` 语义，root `agentlray` 即 `AGENTLRAY_HOME`），经 `@agentlray/shared/config` 的 `resolveDirs` 统一解析；`lib/config.js` 不再持有平台目录。本条"D1 散点独立于 agentlray home"保留为正式规则（root `home`），claude 的散点同时收进平台目录声明。

### D2：平台默认目录不建 Windows 映射表

7 平台默认目录保持 `~/.xxx` 约定，只保证 `os.homedir()` 正确 + 文档声明不一致时设环境变量。

- **为何**：多数跨平台 CLI（claude-code/codex/gemini）在 Windows 把点目录放 `%USERPROFILE%`（与 Linux 一致），`os.homedir()` 修好后开箱即用。我们没有各平台 Windows 目录的可靠事实，写死映射表风险高（可能反而错）。
- **环境变量已全平台就位**：`OPENCLAW_DIR`/`CODEX_DIR`/`CLAUDE_CODE_DIR`/`HERMES_DIR`/`OMP_DIR`/`DSH_DIR`/`GEMINI_DIR`。

### D3：resume 命令串按 `process.platform` 单一真源

`lib/resume.js` `buildResumeCommand` 是命令串唯一生成点，按 `process.platform === 'win32'` 输出 PowerShell 语法（`Set-Location 'cwd'; & bin args`），否则 POSIX（`cd 'cwd' && bin args`）。

- **为何**：前端 `SessionSummary.tsx` 内置平台原本本地拼 POSIX 串（`lib.ts resumeCommand`），自定义平台已走服务端 `resume-command`。Q8 定「服务端下发」后，内置平台统一走服务端接口、废弃前端本地生成，命令串单一真源彻底收拢。
- **为何按 `process.platform` 而非前端 UA**：本机看板场景下，web 服务与用户粘贴命令的终端在同一台机器，`process.platform` 即用户环境，无额外契约。
- **为何 PowerShell 而非 cmd**：Windows 11 默认终端是 PowerShell，复制粘贴最顺（Q9=B）。

### D4：spawn/execFile 加 `shell: process.platform === 'win32'`

`lib/resume.js`/`bin/sessions.js`/`lib/library.js` 的 spawn/execFile 裸命令名（`codex`/`claude`/`omp`/`git`）统一加 `shell: process.platform === 'win32'`；`lib/llm.js` `findClaudeCli` 单独补 `.cmd` 探测。

- **为何**：Windows 上这些工具是 `.cmd`/`.exe` 包装，裸名 spawn 找不到；`shell:true`（仅 win32）让 cmd.exe 解析，最小且统一。
- **为何注入风险可控**：数组参数（非字符串拼接）、非用户输入注入、仅 win32 生效。命令内容来自平台适配器 `args` 函数与服务端配置，非攻击面。
- **为何 `findClaudeCli` 单独修**：它用 `X_OK` 扫描 PATH（非 spawn），Windows 上 `.cmd` 存在性判定需补后缀。

### D5：omp 进程管理 Windows 上能力降级

Windows 上跳过 omp 持有检测/自动终止，`--run` 时打印明确提示，不执行 `process.kill`；`findOmpFork`（纯 JSONL 扫描）保留。不做完整 tasklist/taskkill 实现。

- **为何**：omp 相对小众，Windows 上先「明确降级 + 提示」比硬实现 `tasklist` 更务实（与 Q5=A 一致）。完整实现（tasklist/taskkill）列为独立工作项。
- **为何 `findOmpFork` 保留**：它跨平台可用，是「派生会话提醒」的可靠兜底。

### D6：测试策略为「平台条件跳过 + 改跨平台 + 新增」

- 类 1（真 Linux 硬依赖：`#!/bin/sh` 假 CLI、`/proc/stat`、`spawn('bash')`）：`{ skip: process.platform === 'win32' }` 跳过（omp 持有/终止组，Windows 无等价信号语义）。
- 类 2（能改跨平台就真改）：假 CLI 改 `node -e` 脚本、`isAlive` 去 `/proc/stat` 僵尸分支。
- 类 3（新增跨平台测试）：`os.homedir()` HOME、`buildResumeCommand` 双语法、`findClaudeCli` `.cmd` 探测、`shell: win32` spawn。

- **为何**：目标是「Windows CI 也能绿」，不是把 Linux 专属测试硬改跨平台。尽量真改（类 2）避免 skip 掩盖回归，仅信号语义依赖组 skip（类 1）。

## 后果

- **正面**：Windows 上完整可用；命令串单一真源降低 web/CLI 不一致；测试跨平台覆盖新增。
- **负面/权衡**：omp 在 Windows 上无持有检测/自动终止（降级提示）；各平台目录差异靠环境变量而非自动；`shell:true` 引入轻量子 shell（仅 win32）。
- **风险**：`lib/routes/watch.js` fs.watch 监听 SQLite WAL 在 Windows 可能失效（hermes 平台，待评估）；各平台 Windows 目录事实不全（依赖文档 + 环境变量）。

## 备选方案（已否决）

- **Q1-B/C**：仅 `USERPROFILE||HOME` 或多级兜底 —— 不如 `os.homedir()` 权威全面。
- **Q2-B**：Windows 平台目录映射表 —— 无可靠事实，写死风险高。
- **Q4-B/C**：统一 POSIX 或跨平台 cmd 语法 —— 不匹配用户终端。
- **Q5-B**：Windows 完整实现 omp 检测（tasklist）—— 投入大、omp 小众。
- **Q8-B/C**：前端 UA 检测本地拼 / 前端同时展示两种 —— 未解决单一真源或增加复杂度。
- **Q12-B/C**：`?shell=` 参数 / 双命令串 —— 本机场景无必要，增加契约。
