# 自定义平台适配器样例（custom-platform-example）

> 为「自定义平台扩展」计划 P6 收尾产出。契约与命令行为**已对照落地代码实测**（`lib/platforms/loader.js`、`lib/platforms/index.js`、`bin/platform.js`、`bin/sessions.js`、`lib/cli-bins.js`），下文所有输出均为真实命令结果，非示意。
> 设计依据：[`design-custom-platforms.zh-CN.md`](design-custom-platforms.zh-CN.md)（§3 契约、§6 resume、§7 CLI、§9 信任）+ [`adr-0001-custom-platform-adapter.zh-CN.md`](adr-0001-custom-platform-adapter.zh-CN.md) + 词表 `glossary.zh-CN.md`。

## 1. 背景

AgentLRay 内置 7 平台（openclaw / codex / claude-code / hermes / omp / dsh / gemini）。若想接入一个不在其中的新平台，**无需修改 AgentLRay 源码**：写一个 CommonJS 的**平台适配器**文件，投递到 `~/.agentlray/platforms/`，启动时加载器校验通过即并入平台注册表；此后会话列表 / 详情 / 搜索 / prompts / 工具体检 / SSE watch / 导出 / CLI `sessions` 等全部 generic 表面按**能力位**自动接入。本文给出契约速查与一个完整最小可运行的「扁平 JSONL 平台」样例。

## 2. 适配器契约速查

### 2.1 必需字段（加载器校验，违反 → 该文件 marked broken）

| 字段 | 签名 | 说明 |
| --- | --- | --- |
| `id` | `string` | 注册表键。正则 `^[a-z0-9][a-z0-9-]*$`（小写字母/数字开头，仅小写字母、数字、连字符）；与内置或先前加载的自定义 id 冲突 → 该文件 broken、绝不覆盖 |
| `label` | `string` | 人类可读名（boot log / 前端平台栏） |
| `defaultDir()` | `() => string` | 会话根目录；适配器内可读自身 env，可取相对路径（读到什么就用什么） |
| `parse(file)` | `async (filePath) => { session, messages }` | 归一化消息。`messages` 复用统一 11 字段消息形状，**不自造新造型** |
| `getSession(dir, id)` | `async (dir, sessionId) => { session, messages } \| null` | 详情按 id；文件类适配器可用 `fileBasedGetSession(find, parse)` 助手 |

> `list(dir)`：会话摘要列表（最新在前），**推荐但加载器不强制**——`list` 可为 `null`（同 openclaw.list 的既有语义），缺少时平台不参与列表类 surface 但加载不失败。`agentlray platform validate` 会要求 `list` 存在（枚举会话计数用）。
> 摘要形状：**至少含 `id / timestamp / lastActivity / mtimeMs`**（状态推导依赖），建议含 `cwd / messageCount / tail / firstUserMessage`。tail 是精确四态判定的证据（可用 `@agentlray/shared/tail-state`（`createTailState → finishTail`）/ `lib/status.js` 维护）；不携带也能工作——`deriveStatus` 对无 tail 会话退化为按 `lastActivity/mtimeMs` 时间窗判定。

### 2.2 可选能力位（缺谁谁缺位，不报错）

| 字段 | 触发表面 |
| --- | --- |
| `find(dir, sessionId, opts?)` | `watch` 实时尾随（与 `watchParse` 一起）、`OTLP` 导出（与 `parse` 一起） |
| `collectFiles(dir, opts?)` | `search` / `prompts` / `tool-audit` 批量扫描 |
| `watchParse(rec, line?)` | SSE 实时尾随（与 `find` 一起；缺位时 `/api/watch` 返回 `400 {"error":"平台不支持实时尾随"}`） |
| `needsAgent` | openclaw 式按 agent 平台（置 `true` 时详情/列表需 `agent`，且不进入 OTLP） |
| `resume` | CLI `sessions resume`，见 §5 |
| `version` | 契约版本（v1 起始，为将来演进预留） |

### 2.3 能力位 → 表面映射

| 表面 | 所需能力 |
| --- | --- |
| `GET /api/:platform/sessions`、详情 | `list` / `getSession` |
| `GET /api/sessions` 聚合 | `list` |
| `GET /api/search`、`/api/prompts`、`/api/tools/audit` | `collectFiles` |
| Markdown/HTML export | `getSession` |
| OTLP export | `find` + `parse` 且 `!needsAgent` |
| SSE `GET /api/watch` | `find` + `watchParse`（缺任一 → 400） |
| 设置白名单 `PUT /api/settings` 的 `ui` section | 注册表存在即入白名单 |
| CLI `sessions list/show` | `list` / `getSession` |
| CLI `sessions resume` | `resume`（opt-in） |
| `inspect` 离线诊断 | **明确不做**（仅 omp/codex/claude-code 内置） |

## 3. 完整最小可运行样例：扁平 JSONL 平台

会话布局：`<dir>/` 下每个 `<id>.jsonl` 是一段对话，每行一个 JSON 对象 `{"type":"user|assistant","content":"...","timestamp":"ISO 字符串"}`。适配器自包含（仅 Node 内置模块 `os/fs/path`，无第三方依赖），直接存放即可运行。

```js
'use strict';
// 扁平 JSONL 平台适配器样例（id: flat-logs）。
// 会话目录 <dir>/ 下每个 <id>.jsonl 是一段对话：每行一个 JSON 对象，形如
//   {"type":"user|assistant","content":"...","timestamp":"2026-10-27T08:00:00.000Z"}
// 适配器仅使用 Node 内置模块（os/fs/path），零第三方依赖，可直接运行。
const fs = require('fs');
const os = require('os');
const path = require('path');

// defaultDir()：会话根目录。适配器内可读自身 env（此处 FLAT_LOGS_DIR），未设置
// 时回退到 ~/.flat-logs/sessions；通用 ?dir= / --dir 覆盖在注册表层天然生效。
function sessionsDir() {
  return process.env.FLAT_LOGS_DIR || path.join(os.homedir(), '.flat-logs', 'sessions');
}
function sessionFile(dir, sessionId) {
  return path.join(dir, `${sessionId}.jsonl`);
}
// 读取一个会话文件的全部记录（容忍文件缺失/不可读 → []）。
function readRecords(file) {
  let lines = [];
  try {
    lines = fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
  const recs = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      recs.push(JSON.parse(line));
    } catch {
      /* 跳过坏行 */
    }
  }
  return recs;
}
// 归一化一条消息为 AgentLRay 的 11 字段消息形状（与 @agentlray/shared/helpers 的
// makeMessage 同构；正式适配器也可直接 require('@agentlray/shared/helpers').makeMessage 复用）。
function normalize(rec) {
  return {
    id: rec.id || null,
    timestamp: rec.timestamp || null,
    role: rec.type === 'user' ? 'user' : 'assistant',
    content: typeof rec.content === 'string' ? [{ type: 'text', text: rec.content }] : [],
    usage: null,
    model: null,
    provider: null,
    toolCallId: null,
    toolName: null,
    details: null,
    isError: false,
  };
}

module.exports = {
  // --- 必需 ---
  id: 'flat-logs', // 注册表键：必须匹配 ^[a-z0-9][a-z0-9-]*$；与内置/先前自定义冲突 → 本文件 broken
  label: 'Flat Logs', // 人类可读名（boot log / 前端平台栏）
  defaultDir: sessionsDir, // 会话根目录
  list: async (dir) => { // 会话摘要，最新在前；摘要至少含 id/timestamp/lastActivity/mtimeMs（状态推导依赖）
    const sessions = [];
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort();
    } catch {
      return sessions; // 目录不存在/不可读 → 空列表（不会抛错打断启动）
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const recs = readRecords(file);
      const last = recs[recs.length - 1];
      const firstUser = recs.find((r) => r.type === 'user');
      let mtime = 0;
      try {
        mtime = fs.statSync(file).mtimeMs;
      } catch {
        /* 文件恰在读取间隙被删 */
      }
      sessions.push({
        id: name.replace(/\.jsonl$/, ''),
        timestamp: last ? last.timestamp : null,
        lastActivity: last ? last.timestamp : null,
        mtimeMs: mtime,
        messageCount: recs.length,
        cwd: dir,
        firstUserMessage: firstUser ? firstUser.content : null,
        tail: null, // 推荐用 tail-state 维护精确四态；无 tail 时状态按时间窗退化
      });
    }
    return sessions.sort(
      (a, b) => (Date.parse(b.timestamp) || 0) - (Date.parse(a.timestamp) || 0)
    );
  },
  parse: async (filePath) => { // 归一化消息：{ session, messages }
    const messages = readRecords(filePath).map(normalize);
    const id = path.basename(filePath).replace(/\.jsonl$/, '');
    return {
      session: {
        id,
        cwd: path.dirname(filePath),
        timestamp: messages[0] ? messages[0].timestamp : null,
      },
      messages,
    };
  },
  getSession: async (dir, sessionId) => { // 详情按 id；文件型直接 fileBasedGetSession(find, parse) 亦可
    const file = sessionFile(dir, sessionId);
    try {
      fs.statSync(file);
    } catch {
      return null; // 不存在 → null（区别于 parse 抛错）
    }
    return module.exports.parse(file);
  },

  // --- 可选能力位（缺谁谁缺位、不报错） ---
  find: async (dir, sessionId) => { // watch 实时尾随 与 OTLP 导出的文件定位
    const file = sessionFile(dir, sessionId);
    try {
      fs.statSync(file);
      return file;
    } catch {
      return null;
    }
  },
  collectFiles: async (dir) => { // search / prompts / tool-audit 批量扫描
    const files = [];
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
    } catch {
      return files;
    }
    for (const name of names) {
      files.push({
        path: path.join(dir, name),
        file: name,
        sessionId: name.replace(/\.jsonl$/, ''),
      });
    }
    return files;
  },
  watchParse: (rec) => { // SSE 实时尾随的增量行归一化（与 find 一起才生效）
    if (rec && rec.type === 'session') {
      return { session: { id: rec.id, cwd: rec.cwd || null, timestamp: rec.timestamp || null } };
    }
    if (rec && (rec.type === 'user' || rec.type === 'assistant')) {
      return { messages: [normalize(rec)] };
    }
    return null;
  },
  needsAgent: false, // openclaw 式按 agent 平台才置 true（详情/列表需 agent、不进入 OTLP）
  version: 1, // 契约版本（v1 起始，为将来演进预留）
  // resume: 见 §5「续跑（resume）示例块」（opt-in，不声明则 CLI resume 报无原生续跑）
};
```

依赖约束：**仅 Node 内置模块 + `@agentlray/shared/*` 共享层**（裸名经 `lib/platforms/shared-alias.js` 解析到 `lib/platforms/shared/`；如 `@agentlray/shared/helpers` 的 `withMetadataCache / makeMessage / fileBasedGetSession / sortSessionsByTimestampDesc / topToolsOf / captureLastMessage`），零第三方依赖——保证无安装步骤、无版本冲突。样例以上面单独手写为准（自包含、可直接照抄）；正式适配器可改用 `@agentlray/shared/helpers` 的 `withMetadataCache` 缓存元数据、`sortSessionsByTimestampDesc` 排序。

## 4. 启用方式

`~/.agentlray/platforms/`（或 `<repo>/platforms/` 项目目录）内放入即默认挂载；v2 起可用 `agentlray platform mount <id> / unmount <id>` 做 per-platform 启停（写 `settings.replaced/displaced`，重启生效），卸载也可用删/移走文件。细节：

- **加载顺序按文件名字母序**（先内置插入序，再项目/自定义字母序，broken 字母序，见 `platform list`）。
- **id 冲突**：与内置（如 `codex`）或先前已加载的自定义重复 → 该文件 marked broken，错误 `id 已被占用：<id>`，不覆盖不串位；**同 id 覆盖包内置**需先声明 `replaced`（`agentlray platform export/replace <id>`）。
- **单文件隔离**：任一文件 require 抛错 / 校验失败只影响自身，不打断启动、不影响其余。
- **逃生开关**：`AGENTLRAY_NO_PLUGINS=1`（跳过项目+用户来源，只留包内置），`platform list` 里自定义缺席、仅一条「自定义平台已禁用（AGENTLRAY_NO_PLUGINS=1）」的逃生 broken 说明。
- 启用后**重启服务 / 重新跑 CLI** 生效（加载发生在进程启动的模块 require 期）。

### 4.1 薄适配器（`platform export` / `AGENTLRAY_PKG_ROOT`）

`agentlray platform export <id>` 生成薄适配器：`module.exports = require(path.join(process.env.AGENTLRAY_PKG_ROOT, 'lib/platforms/builtin/<id>.js'))`。若你要包一层内置实现做局部定制，同样用 `AGENTLRAY_PKG_ROOT` 解析包内路径（勿用相对路径）：

```js
const path = require('path');
const root = process.env.AGENTLRAY_PKG_ROOT;
if (!root) throw new Error('AGENTLRAY_PKG_ROOT is not set; load this adapter through AgentLRay.');
const base = require(path.join(root, 'lib/platforms/codex.js'));
module.exports = { ...base, label: 'My Codex Wrapper' }; // 覆盖字段
```



## 5. 验证命令

把 §3 样例存成 `~/.agentlray/platforms/flat-logs.js`（或任意临时文件）：

```bash
# 干式校验单个适配器：与加载器同一套校验（导出对象 / id 正则 / label 字符串 /
# 必需函数 defaultDir、parse、getSession【list 可 null】/ id 不冲突），
# 通过后再调真实 list(defaultDir()) 报会话计数与首条 id。dry-run，不写 registry。
agentlray platform validate ~/.agentlray/platforms/flat-logs.js --json
```

配合真实数据（`FLAT_LOGS_DIR` 指向含 `<id>.jsonl` 的目录）实测输出：

```json
{"schemaVersion":1,"kind":"platform-validate","ok":true,"platform":{"id":"flat-logs","label":"Flat Logs"},"sessionCount":1,"firstId":"a","note":"平台适配器会以你的用户权限执行其任意代码：只投递可信的适配器文件。"}
```

纯文本模式为单行 `platform validate: ok — id=flat-logs label=Flat Logs sessions=1 firstId=a`，stderr 附信任提示。会话不可读（`defaultDir` 抛错 / 缺 `list` / `list` 抛错 / 非数组）时报 `适配器校验通过但会话不可读：...`（`code:"validate-sessions"`），退出码 1。

```bash
# 列出全部平台（内置 + 自定义 + broken），与 GET /api/platforms 同源
agentlray platform list
```

一个既有自定义、又有坏文件的真实输出（坏文件 `10-broken.js` 在 require 阶段抛错）：

```text
Builtin   openclaw    OpenClaw
Builtin   codex    Codex
Builtin   claude-code    Claude Code
Builtin   omp    OMP
Builtin   dsh    DeepSeek Harness
Builtin   gemini    Gemini CLI
Builtin   hermes    Hermes
Custom   flat-logs    Flat Logs
Broken   (unnamed)    broken 示例：require 阶段抛错
```

`list --json` 为 `{schemaVersion:1, kind:"platforms", platforms:[…]}`；`platforms` 顺序即内置 → 自定义 → broken，自定义条目标 `builtin:false` + `capabilities` 布尔集，broken 条目标 `broken:true` + `error`（`label:null`）。

## 6. 续跑（resume）示例块

`resume` 是 **opt-in**：适配器不声明时，`sessions resume` 对该平台报错（下为实测）：

```json
{"schemaVersion":1,"kind":"error","error":{"code":"usage","message":"Platform 'flat-logs' has no native resume command. Only codex / claude-code / omp are supported."}}
```

声明方式——在 §3 的 `module.exports` 之后追加：

```js
// 为平台声明原生续跑命令（opt-in）。
// bin 为默认命令名，实际可执行名由 resolveCliBin() 解析：
//   环境变量 AGENTLRAY_FLAT_LOGS_BIN > ~/.agentlray/settings.json 的 cliBins section "flat-logs" 键 > bin 默认名
//   （env 名推导规则：平台 id 非字母数字 → '_' 后大写，如 my-copilot → AGENTLRAY_MY_COPILOT_BIN）
module.exports.resume = {
  bin: 'flat-cli',                              // 默认命令名（如 PATH 上的 flat-cli）
  args: (sessionId, opts) => ['--resume', sessionId], // 续跑参数；--message 由 CLI 统一追加
};
```

实测 `agentlray sessions resume --platform flat-logs --id a --json`（未 `--run`，只打印）：

```json
{"schemaVersion":1,"kind":"resume","platform":"flat-logs","id":"a","cwd":"/tmp/flat-logs-data","bin":"flat-cli","args":["--resume","a"],"command":"cd '/tmp/flat-logs-data' && flat-cli --resume a","livePid":null,"note":null,"terminated":false,"executed":false}
```

加 `--run` 才 spawn 对应 bin 执行并透传 stdin/stdout 与退出码。内置 codex / claude-code / omp 的原生续跑（`RESUME_BINS`）保持原样，不受影响。

## 7. 信任边界

- 适配器是**用户全权限代码**——与你自己手动执行该脚本等价（`require` 即执行、可访问一切）。文档与 `platform validate` 输出都明示：**只投递可信的适配器文件**。
- 不新增网络 / 沙箱 / 签名机制（内网工具，自配置即信任）。
- 出问题时的逃生：`AGENTLRAY_NO_PLUGINS=1` 全局禁用；`agentlray platform list` 可见每个文件的加载失败原因便于排查；删掉文件即卸载。

## 8. 能力缺位语义（速查）

| 缺位能力 | 行为 |
| --- | --- |
| `collectFiles` | search / prompts / tool-audit 对该平台不检索，不报错 |
| `watchParse`（或 `find`） | 无 SSE 实时尾随；`GET /api/watch` 返回 `400 {"error":"平台不支持实时尾随"}`；状态仍由列表轮询的时间窗推导 |
| `find` | 不参与 OTLP export（需 `find + parse`） |
| `needsAgent:false` | 列表/详情不需要 `agent` 参数（openclaw 需） |
| `resume` 未声明 | CLI resume 报「无原生续跑」（§6） |
| `list` 为 `null` | 该平台不出现于列表类 surface，但可正常加载（detail / watch 等仍可用） |
| `version` 缺失 | 视为 v1 契约 |

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：参考文档，与当前实现一致**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 样例适配器契约与验证命令 | ✅ 已实现 | `bin/platform.js validate/list` |

