# agentlray sessions —— 终端会话查询与续跑 CLI 设计

> **类型**：方案设计
> **对应代码**：`bin/sessions.js`（新增）、`bin/agentlray.js`（路由接入；`agentxray` 旧入口已移除）、`test/session-cli.test.js`（新增）
> **日期**：2026-10-23

## 背景与目标

AgentLRay 此前是纯查看器：Web 仪表盘读 7 个平台的会话日志，前端"复制续跑命令"仅覆盖 `codex` / `claude-code` / `omp`。本次为 `bin` 增加终端命令：

1. **list** —— 按条件查询会话列表；
2. **show** —— 查看指定会话详细信息（元信息 + 归一化消息时间线）；
3. **resume** —— 在会话上继续发消息、往下执行任务（默认只打印续跑命令，`--run` 才真正执行）。

## 用户决策（本轮确认）

- `resume` **默认仅打印命令**，加 `--run` 才真实 spawn 平台 CLI 执行；防止误触自动批准（`--yolo` / `--dangerously-skip-permissions` / `--auto-approve`）。
- `resume` 平台范围**仅 codex / claude-code / omp**（三者有原生续跑契约）；其余平台明确报 `no native resume`，不伪造执行。`list` / `show` 仍支持全部 7 平台。

## CLI 表面

```
agentlray sessions list   --platform <p> [--agent NAME] [--dir PATH]
                          [--status <s,…>] [--match TEXT] [--since ISO] [--until ISO]
                          [--limit N] [--offset N] [--json]
agentlray sessions show   --platform <p> --id <ID> [--agent NAME] [--dir PATH]
                          [--tail N] [--full] [--json]
agentlray sessions resume --platform <codex|claude-code|omp> --id <ID>
                          [--dir PATH] [--cwd PATH] [--message TEXT] [--run] [--json]
agentlray sessions help
```

各子命令复用元素：

| 参数 | 含义 | 备注 |
| --- | --- | --- |
| `--platform` | 平台 id | 全部 7 平台；openclaw 未配 `--agent` 时默认全部 agents 合并（list 展平为一份、show 跨全部 agents 查找该 id），配了则限定单 agent |
| `--id` | 会话 id | `show` / `resume` 必填 |
| `--dir` | 覆盖平台默认数据目录 | 复用 `config.resolveDir`（须绝对路径） |
| `--status` | 状态过滤 | `awaiting-input\|working\|waiting\|stopped`，逗号多值 |
| `--match` | 子串匹配 | 对 `title` / `firstUserMessage` / `lastMessage.text` / `id`，忽略大小写 |
| `--since`/`--until` | 时间过滤 | 按 `lastActivity`（缺省回退 `timestamp`） |
| `--limit`/`--offset` | 分页 | 在过滤之后应用 |
| `--tail` | 只打最后 N 条消息 | `show`；`--full` 关闭文本截断（默认每条 2000 字符） |
| `--cwd` | 续跑目录 | 默认取会话记录 `cwd` |
| `--message` | 续发消息 | 作为提示词参数传给平台 CLI |
| `--run` | 真实执行 | 默认只打印命令 |
| `--json` | JSON 输出 | 与 `inspect.js` 同约定：`{schemaVersion:1,…}` |

## 关键设计

### 复用不重造
- **平台注册表** `lib/platforms/index.js`：`list(dir)` / `getSession(dir, id, {agent})` 与统一归一化消息形状，`list` / `show` 全部经注册表解析，新增平台自动生效。
- **统一四态** `lib/status.js`：各平台 `list*` 已写回 `session.status`（`sortSessionsByStatusGroups`），`--status` 直接过滤，取证口径与 UI 完全一致。
- **续跑命令与前端同源**：`bin/sessions.js` 的 `RESUME_BINS` 与前端 `frontend/src/views/sessions/lib.ts#resumeCommand` 保持一致（`codex resume <id> --yolo`、`claude --dangerously-skip-permissions --resume <id>`、`omp --auto-approve --resume=<id>`）。

### 列表内容：lastMessage 字段
`list` 每条会话除既有 `firstUserMessage`（首条真实用户 prompt）外，新增 **`lastMessage = { role, text }`**（最后一条 user/assistant 真实消息文本）：
- 数据来源在 7 个平台的元数据解析器（`lib/platforms/*` 的 `_parse*MetadataRaw`；hermes 为 SQLite 列表查询），共享口径统一为 `shared.js#captureLastMessage`——只认 user/assistant 的**真实文本**，忽略工具回执 / 推理（reasoning）/ 注入噪音；空文本保留更早的有效消息。
- 两个字段均返回**完整文本、不截断**（`firstUserMessage` 与 `lastMessage` 都是完整内容）：因此 `list` 的 JSON 输出自动携带完整字段（与 Web API 列表一致），纯文本表新增「首条用户消息」「最后消息」两列（不截断，超宽依赖终端换行/滚动），`--match` 也覆盖 `lastMessage.text`。

### resume 的执行语义
- 默认打印 shell 命令：`cd '<cwd>' && <bin> <args>`。token 仅当含空格/引号等特殊字符时才用 POSIX 单引号转义（`shellToken`），命令可读、可直接粘贴执行。
- **续跑语义（统一：同 id 续跑，不接受派生，2026-10-26 定稿）**：`codex resume <id>` / `claude --resume <id>` 原生在同一 session id 上继续、消息追加进原会话。omp 的派生与否由 OMP 内置逻辑决定（二进制 `requireIdle → fork the session`）：目标会话若被"运行中的 omp 实例"持有（非空闲）则派生新会话，与其文件尾是否有 `session_exit` **无关**——早前"先追加 `session_exit` 收尾"方案实证无效（非空闲是进程级状态，外部写文件不改变）。根因实证：仍打开的会话续跑派生 `01a175e1`（parentSession=01a175db），dispose 后同命令原地续写。
  - **持有检测**：`--run` 前 `liveOmpPidForSession(sessionFilePath, sessionId)` 扫 `/proc/*/cmdline`，命中 `omp` + `--resume` + (会话文件路径 | id) 的进程即持有者（排除本工具自身进程树）。
  - **自动终止**：检出持有者时，`--run` 先 `terminateOmpHolder(pid)` 自动结束该实例（SIGTERM → 等待退出 → SIGKILL 兜底；僵尸视为已退出），确认不再持有后再以原 id 续跑；终止失败（仍持有）则报错不续跑（避免派生）。打印（非 `--run`）模式只提示"`--run` 将自动终止该实例后再同 id 续跑"，不改动任何进程；`--json` 输出 `livePid/note/terminated/forked` 字段。
  - **兜底检测**：续跑 spawn 结束后，`findOmpFork` 在 slug 目录检查本次运行期间是否仍冒出新且 `parentSession=目标 id` 的派生会话（极端并发写入场景），若有则 stderr 明确报警，不掩盖。
  - 风险说明：自动终止会结束持有该会话的运行中 omp 实例（同 id 接管语义的题中之义），使用者需确认该实例已无未保存工作；SIGTERM 让 OMP 有机会收尾，SIGKILL 兜底。
- `--run`：`spawn(bin, args, {cwd, stdio:'inherit'})`，不经过 shell（参数数组直接传，天然避免注入）；stdin/stdout/stderr 继承（交互续跑），退出码透传为 CLI 退出码；`--json` 额外输出 `executed:true` 与 `exitCode`。
- `--dir` 供会话文件不在默认目录时定位；`--cwd` 可覆盖会话记录的工作目录；`--run` 前校验工作目录存在（缺失时明确报错，避免误导性 `spawn ENOENT`）。

### 输出与错误约定
- 与 `bin/inspect.js` 一致：JSON 错误为 `{schemaVersion:1, kind:'error', error:{code,message}}`；退出码 `0`=命令成功完成（对 resume 表示已生成/已执行，非任务成功），`1`=参数或运行时错误。
- 用法类错误（未知参数/子命令/缺值）附带打印 `HELP`；运行期错误（会话不存在、平台不支持等）只写 stderr。

## 验证

- `test/session-cli.test.js`（31 个用例，全部通过；`TMPDIR` 指向 `os.tmpdir()`，磁盘不足时可用 `/dev/shm` 等 tmpfs 运行）：list 的平台/状态/match/since/until/limit、openclaw 缺省合并全部 agents（含文本 agent 列）与 `--agent` 限定单 agent、show 跨全部 agents 查找并标注 `agent`、未知平台错误、纯文本表头、show 的归一化消息角色（含 claude `tool_use` 内嵌块）、resume 默认打印与消息转义、`--run` spawn 假平台 CLI 的参数/工作目录/退出码透传与 cwd 校验、被持有 omp 会话 `--run` 自动终止持有实例后续跑、持有实例忽略 SIGTERM 时 SIGKILL 兜底、打印模式检出持有者仅提示不终止、平台缺失报错、未知子命令。
- 既有 `test/cli.test.js` / `test/api.test.js` 通过；`experiments/prospective-study/` 的脱敏/凭据测试需本机安装 `gitleaks`（`SCANNER_UNAVAILABLE`，与 sessions 无关）。
- 冒烟输出（对临时 HOME 的真实夹具）：list 表、show 时间线、codex/omp resume 命令均符合预期。

## 边界与限制

- resume 只能续跑**日志所对应平台的原生 CLI**，AgentLRay 自身不写会话文件、不驱动 agent 进程；`--run` 自动批准工具调用，属高风险操作，需使用者确认平台与工作目录后再执行。
- 未支持平台的 resume 明确报错（不伪造命令）。
- `bin/inspect.js` / `bin/evidence` 的离线报告与 `sessions` 组相互独立。

## 后续

- README / `docs/usage*.md` 的 CLI 章节可补命令示例（本次未扩展，`--help` 已自文档化）。
- biome 在本机因 GLIBC 2.29 缺失无法运行（环境限制），已按仓库既有风格手工核对。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| `sessions list/show/resume` | ✅ 已实现 | `bin/sessions.js` |
| 统一四态与平台注册表复用 | ✅ 已实现 | `lib/status.js`、`lib/platforms/index.js` |

