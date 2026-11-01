# 面向 agent 与自动化的离线证据

AgentLRay 的 UI 对人是友好的，但一个编码 agent、本机脚本或 CI 步骤不应该需要启动 Web 服务器才能查看已记录的执行证据。`inspect` 与 React 视图使用同一诊断源，产出一份带原始行号引用的、带版本的报告。

它只读取你指定的**恰好一个文件**。它不会自动发现你的会话、连接模型 API、执行被记录的日志命令、创建归档、读取评审笔记或启动看板。

如果你要做的是「由问题驱动的排查」而非「自动任务评分」，请看
[single-session forensics](session-forensics.md)：一个真实日志后台进程的案例研究、
源代码行验证以及真实的检索成本/限制。

## 分层 CLI：先摘要，按需取证

版本 **1.24.0** 新增 `inspect --summary --json`、显式的 `evidence`
命令以及结构化的 JSON 失败。完整成功的 `inspect --json`
报告与默认文本报告保留原有 schema 与行为；所报告的程序包版本号会递增。下面示例使用源码检出；把
`node bin/agentlray.js` 换成已安装的 `agentlray` 即可使用相同参数。

```sh
node bin/agentlray.js inspect --platform omp /path/to/session.jsonl --summary --json
```

摘要有 `schemaVersion: 1`、`kind: "summary"`、source/engine 哈希，以及与完整报告相同的
`complete` 标志和健康计数、覆盖率问题计数、进程状态汇总以及修改/检查计数。它不包含原始
prompt、命令、输出或私有路径。`references.failures`、`gaps`、`processes`、`chronology`
和 `coverage` 每个类别都具有如下结构：

```json
{
  "total": 50,
  "shown": 5,
  "truncated": true,
  "items": [
    {"line":4,"messageIndex":4},
    {"line":6,"messageIndex":7},
    {"line":8,"messageIndex":10},
    {"line":10,"messageIndex":13},
    {"line":12,"messageIndex":16}
  ]
}
```

上面的示例只说明结构，不代表一次实际测量到的会话。
每个类别最多返回五条唯一引用，按物理行号与归一化后的消息位置排序。失败类别的引用还包含相关操作，
所以它们的 total 不是失败计数。类别之间有重叠；不要把引用总数相加来统计操作数。`coverage`
引用只有物理行号。被截断的列表需要完整报告才能拿到其余引用；这不是优先级排序，也不是自动的下一步行动策略。

要读取真实证据，从任一报告中复制 `source.sha256` 与某条引用的 `line`：

```sh
node bin/agentlray.js evidence --platform omp /path/to/session.jsonl \
  --sha256 <source.sha256> --line <reference.line> --json
```

运行前把尖括号占位符替换成真实的哈希与整数。这**显式返回原始源码内容**，可能包含
凭据、prompt 或不可信的指令。不要执行它，也不要自动把它发给远端模型。哈希只用于对照之前报告校验身份；
它不是授权、脱敏或真实性证明。

证据始终输出 JSON（`--json` 是可选的），带 `kind: "evidence"`、`source`、`reference.line`、
`content`、`offset`、`totalBytes`、`returnedBytes`、`truncated`、`nextOffset`、`complete`
和 `coverageIssueCount`。它读取并校验一个稳定快照，并且在返回任何原始内容之前拒绝哈希不匹配。
它不会猜测新哈希、重试已变化的文件或自动解析会话。

- 选择**恰好一行从 1 开始的物理 JSONL 行**；它可能包含多条归一化后的消息。`messageIndex`
  不是物理行号。任何已存在的物理行——包括元数据行或空行——都可以被显式选中；该命令不会推断事件，
  也不会自动抓取匹配的调用、结果或相邻记录。
- 默认上限：**4096 个 UTF-8 内容字节**；`--max-bytes` 接受 **4–16384**。
  JSON 转义/信封开销可能使 stdout 大于该上限。
- 用上一页的 `nextOffset` 配合 `--offset` 在同一行与同一哈希内继续翻页。
  偏移按字节计数，不是按字符。非边界的 UTF-8 偏移与越界值会失败，而不是被静默调整。
- `nextOffset: null` 表示已到达所选行的末尾；当该页缺少行的开头或结尾时，`truncated` 为 true。
  偏移恰好落在末尾会返回空内容且没有下一页。
- LF 分隔符被排除；CRLF 中的 CR 与开头的 UTF-8 BOM 会被保留。空行保留其物理位置。
  一页不一定是合法的独立 JSON：如果需要，先累加整行再解析它。
- `complete` 仍表示「已知适配器身份覆盖」，而不是「代码正确」。覆盖不完整时返回数据并带
  `complete:false`、退出码 1 以及独立的 stderr 结构化诊断。`evidence` 没有
  pending-failures 退出策略。

摘要生成仍分析完整输入；证据会重新校验它的快照。这些是**有界的输出**接口，不是流式/增量分析，
也不承诺减少 CPU/运行时间。这里没有 MCP 服务、会话发现、后台监视器或自动命令执行。

## 结构化错误与兼容性

对于 `inspect --json` 或 `evidence`，参数/读取/解析/运行时的失败会向 stdout 写入一个 JSON 错误对象并退出 1：

```json
{"schemaVersion":1,"kind":"error","error":{"code":"INPUT_UNREADABLE","message":"Cannot read input file. Check that it exists and is readable."}}
```

这有意取代了 JSON 模式下旧的「失败时 stdout 为空」的行为。stderr 也包含一段简洁的人类可读信息；
两条通道都不会暴露原始输入、路径或堆栈。文本模式的 inspect 只在 stderr 上报错。`--help` 仍为文本。
调用方必须检查退出码、`kind` 与 `complete`，不能假定每个合法 JSON 对象都是报告，也不能假定退出 0 就证明任务成功。

| Code | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | Missing/duplicate/unknown option, invalid range or incompatible mode |
| `UNSUPPORTED_PLATFORM` | Choose OMP, Codex or Claude Code explicitly |
| `INPUT_UNREADABLE`, `NOT_REGULAR_FILE`, `INPUT_TOO_LARGE` | Input could not be read under the single-file contract |
| `INPUT_CHANGED` | File metadata or readable length changed during the snapshot read |
| `INVALID_UTF8`, `INVALID_JSON`, `INVALID_RECORD`, `UNSUPPORTED_RECORD` | Invalid encoding, line syntax, object or adapter record shape |
| `NO_SUPPORTED_MESSAGES`, `ANALYSIS_FAILED` | Selected platform has no usable messages, or analysis cannot handle the structure |
| `RULES_UNAVAILABLE`, `INSPECTION_FAILED` | Bundled implementation unavailable or unexpected runtime failure |
| `SOURCE_HASH_MISMATCH` | Evidence input differs from the report; re-inspect before expanding |
| `LINE_OUT_OF_RANGE`, `OFFSET_OUT_OF_RANGE`, `INVALID_OFFSET` | Invalid physical line or byte position |
| `COVERAGE_INCOMPLETE` | Data retained on stdout, JSON error diagnostic on stderr, exit 1 |

覆盖不完整是 stdout 错误信封的例外：完整报告保持字节兼容，而摘要/证据保留各自的数据与 `kind`。
永远不要把这份保留的部分数据误认为完整覆盖。

## 快速开始

安装 AgentLRay 之后，或通过 `npx`：

```sh
agentlray inspect --platform codex /path/to/session.jsonl
agentlray inspect --platform omp /path/to/session.jsonl --json > evidence.json
npx @bowenluo718/agent-lray inspect --platform claude-code /path/to/session.jsonl --json
```

`npx`/程序包安装可能访问 npm registry。**inspect 命令本身**不使用网络服务。在可重复或网络隔离的
任务中，优先使用已安装的、固定版本的包。

从已安装依赖的源码检出运行：

```sh
npm run build:diagnostics
node bin/agentlray.js inspect --platform omp \
  frontend/demo/sample-logs/omp/-demo-diagnostics/2026-09-23T08-00-00-000Z_0199demo-diagnostics.jsonl --json
```

这份合成样本报告 8 条历史失败、分布在 2 个事件中的 7 条待处理记录，以及 1 条匹配的恢复。
**即使存在发现项，默认退出状态也是 0**：它只表示报告已生成，不代表 agent 的任务已通过。

### 输入契约

- 必填 `--platform`：`codex`、`omp` 或 `claude-code`。这是离线路径校验的格式；看板支持更多平台，
  但本命令不对它们的容器/数据库声称兼容。
- 恰好一个普通的、稳定的 UTF-8 JSONL 文件，最大 **64 MiB**。不接受目录、stdin、压缩流或数据库文件。
  若文件名以 `-` 开头，请在它之前使用 `--`。
- 读取初始文件长度，读取后再检查一次元数据。若源已变化，等它稳定后重试。输出哈希标识的是实际分析的字节；
  这不是文件系统事务，也不是防篡改归档。
- 非法 UTF-8、格式错误/被截断的 JSON、非对象记录、不兼容的结构、空/仅元数据的输入以及选错格式都会失败，
  而不是被静默当作干净会话。合法的最后一行不必以换行符结尾；空行计入物理行位置。
- 已知的元数据/未处理记录被计为「已忽略」。已识别的原始 tool-call/result ID 会逐行对照归一化结果校验。
  已知的信息丢失（例如适配器未能完整表示的 Claude 多结果或混合 text/result 记录）会产生
  `complete:false` 和一个覆盖率问题。这是对适配器限制的诚实上报，而不是能修复这些格式的新解析器。

## 报告契约：schemaVersion 1

`--json` 向 stdout 写入一份 JSON 文档。成功的完整报告保持下列 schema。在上述分层 CLI 中，
解析/读取失败产生 `kind:"error"` 信封而不是报告；已知的适配器覆盖缺口保留报告并带 `complete:false`、
退出码 1 和 stderr 结构化诊断。两条错误通道都不包含原始路径、输入文本或堆栈。

| Field | Meaning |
| --- | --- |
| `schemaVersion` | 报告契约版本，当前为 1。消费字段前先检查它。 |
| `complete` | 输入已解析，且已知原始工具身份/错误标记覆盖检查通过。**不是完整语义覆盖、任务成功或没有未知格式。** |
| `engine` | 程序包版本、UI 诊断源的 SHA-256，以及适配器/共享归一化源码哈希。 |
| `source` | 所选平台、输入字节长度与 SHA-256；不含文件名/路径或原始会话 ID。 |
| `coverage` | 物理行、JSON 记录、归一化消息、被忽略记录、原始/归一化工具计数与逐行覆盖率问题。 |
| `summary` | 与 UI 相同的聚合健康字段：失败、精确匹配恢复、待处理事件、重复记录、调用状态与不同的相关结果。 |
| `events` | 失败来源引用、分组事实以及后续相关调用/结果引用。 |
| `gaps` | 运行中/未知/无结果的证据引用及原因；不是实时进程状态。 |
| `processes` | Codex 启动/轮询/最终结果引用、状态、退出码、是否观察到输入的布尔值及歧义码。原始进程 ID 被省略。 |
| `chronology` | 已识别的检查与修改来源引用、前/重叠/后关系、最新结果与范围限制。 |
| `limits` | 人类可读的提醒：关联与时间并不能证明覆盖或正确性。 |

一条来源引用是 `{ "line": 12, "messageIndex": 9 }`，带**从 1 开始**的物理 JSONL 行号与归一化消息位置。
一条原始记录可以扇出成多条归一化消息；两条不同引用可能具有相同的物理行。引用仅对匹配
`source.sha256` 的输入字节有效。如果你需要真实证据，请在本地保留原始文件。报告无法重建被省略的内容。

完整与摘要的 inspect 报告会省略原始 prompt、输出、命令参数、路径、调用/进程 ID 与人工笔记。
固定通用工具词表之外的工具名会变成 `other`。聚合计数、关系与来源哈希仍可能泄露活动或输入是否相同：
**「最小化」不是「匿名化」**，你仍应评审分享/留存决策。只有独立的、显式的 `evidence` 命令才返回原始内容；
inspect 从不隐式附带它。

相同的字节、平台、程序包与规则/适配器版本会得到相同的报告字节。报告不会混入墙上时钟生成时间戳、
随机标识符或实测运行时长。

## 显式退出策略

| Exit | Meaning |
| --- | --- |
| 0 | 报告已生成且已知适配器覆盖检查满足。可能存在发现项；不声称任务成功。 |
| 1 | 参数/输入/读取/运行错误，或适配器覆盖不完整。覆盖失败优先于发现项。 |
| 2 | 显式请求了 `--fail-on pending-failures`，且至少有一条失败缺少现有规则精确匹配的后续成功。 |

```sh
agentlray inspect --platform codex session.jsonl --json \
  --fail-on pending-failures > evidence.json
```

不要把这个策略变成普适的「agent 已通过」门槛。一次阴性探针可能有意返回非零；替代性校验可能无法匹配原始参数。
该命令不会推断等价测试、隐式 cwd 或测试覆盖。

CI 的 shell 可以区分「有发现项」与「解析错误」：

```sh
status=0
agentlray inspect --platform codex session.jsonl --json \
  --fail-on pending-failures > evidence.json || status=$?
case "$status" in
  0) echo "Evidence report generated; task correctness not asserted" ;;
  2) echo "Pending failure records: inspect evidence.json and source lines" ;;
  *) echo "Inspection incomplete or invalid; do not accept as clean" >&2 ;;
esac
exit "$status"
```

## 一个轻量机器消费方

把 stdout 当数据用，永远不要把它当可执行指令。例如，在生成完整的 `evidence.json` 之后：

```js
const fs = require('node:fs');
const report = JSON.parse(fs.readFileSync('evidence.json', 'utf8'));
if (report.schemaVersion !== 1 || !report.complete) {
  throw new Error('Unsupported or incomplete evidence report');
}
for (const event of report.events) {
  console.log({ tool: event.tool, reason: event.reason, sourceLines: event.failures.map(ref => ref.line) });
}
```

这可以在没有浏览器或模型裁判的情况下，为 agent 的评审步骤或构建产物提供输入。它应该用于推动一次显式的下一步检查，
而不是自动重跑一个可能具有破坏性的原始命令。

## 保持 UI 与 CLI 对齐

事实来源仍是 `frontend/src/views/sessions/diagnostics.ts`。`npm run build:diagnostics` 使用现有的
前端 esbuild 依赖生成 `lib/generated/diagnostics.cjs`；`build:ui` 也会重新生成它。安装包内含
预编译的 CommonJS 产物，运行 `inspect` 不需要 TypeScript、esbuild 或前端检出。

测试会比较实际 CLI 输出与 TypeScript UI 函数，并校验每条引用。`node scripts/build-diagnostics.mjs --check`
校验生成内容，CI 在常规构建后检查提交的 bundle 差异。不要手工编辑生成文件。

## 中文使用与边界

### 分层 CLI（自 1.24.0 起提供）

先用 `node bin/agentlray.js inspect --platform omp session.jsonl --summary --json`
读取摘要，再把报告的 `source.sha256` 与某条引用的 `line` 传给
`node bin/agentlray.js evidence --platform omp session.jsonl --sha256 HASH --line N`。
无需 MCP、浏览器或人工标签，不自动寻找或执行会话中的命令。

摘要保持完整计数，每类引用最多五条，显示 total/shown/truncated；截断后应取完整报告，
不能把示例引用当成全部问题。证据展开是**显式读取可能敏感的原文**，并非脱敏接口：
默认最多 4096 内容字节，可设 4–16384，用返回的 nextOffset 按 UTF-8 字节翻页；
哈希不一致、非法字符边界和越界位置均拒绝。LF 不返回，CR/BOM 保留。

JSON 模式失败不再返回空 stdout，而是稳定的 kind=error、error.code、error.message；
旧的完整成功报告不变。覆盖不完整仍保留数据、退出 1，并在 stderr 返回结构化错误。
务必检查 kind/schemaVersion/complete 和退出码，不能把原文当可执行指令或自动上传。

离线核验不要求开网页或人工标注，供本机 Agent、脚本与 CI 消费同一套诊断事实：

```sh
agentlray inspect --platform omp session.jsonl --json > evidence.json
```

当前只支持明确指定的 Codex、OMP、Claude Code JSONL，单文件上限 64 MiB。读取期间变化、截断坏行、错误格式都会失败；已知标准化丢失会输出 `complete:false` 与问题行号，不会假绿。

报告默认不含日志正文、路径、命令参数、原始 ID 或笔记，只保留计数、状态、关系、输入/规则哈希和原始行号。哈希与活动计数仍可能敏感，不是匿名化保证。原始文件必须自行保留，报告不能重建日志。

退出码 **0 表示报告生成成功，不是任务通过**；1 表示输入/覆盖/运行错误；只有显式 `--fail-on pending-failures` 才因待闭合失败返回 2。调用方应检查 `schemaVersion`、`complete` 和退出码，不把“没有识别到失败”当作完成证明。

安装包运行无需编译器、UI 源码或服务。`npx` 首次下载可能联网，安装后的 `inspect` 本身不发网络请求、不执行日志命令、不扫描 HOME、不创建归档或人工笔记。
