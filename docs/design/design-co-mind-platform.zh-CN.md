# co-mind 自定义平台接入设计

> grill-with-docs 设计会话产出；决策仅来自当面收敛的问答（非猜测）。适配器规范源：
> [`platforms/co-mind.js`](platforms/co-mind.js)（已安装副本 `~/.agentlray/platforms/co-mind.js`）。
> 以下所有命令输出均为**真实执行结果**，非示意。
>
> **2026-11-08 修订**：实现从「自包含单文件」改为「薄适配器复用内置 claude-code」，与
> 项目级平台（`<repo>/platforms/` 下的 dsh/gemini/hermes）同形态。修订依据 ADR-0005 D10
> ——`AGENTLRAY_PKG_ROOT` 包根注入 + `@agentlray/shared` 全局别名使自定义适配器可引用
> 包内模块，ADR-0002 的「薄适配器 require 内部模块不可行」结论作废。详见 §4 与
> [adr-0002](adr-0002-co-mind-platform.zh-CN.md)。

## 1. 背景与目标

**co-mind** 是 Claude Code 的二次开发 agent：命令名 `co-mind` 替代 `claude`，其余能力与
claude-code 基本一致。运行元数据：

| 项 | 值 |
| --- | --- |
| 二进制 | `~/.local/bin/co-mind`（v3.1.10，`co-mind --version`） |
| 数据目录（会话根） | `~/.icodemate/cli/projects` |
| 子命令 | `-r/--resume <id>`、`-c/--continue`、`--cwd` 等（与 claude 同族） |

目标：把 co-mind 接入 AgentLRay，视为一个平台（会话列表 / 详情 / 实时尾随 / 导出 /
工具体检 / 终端续跑可达），其余能力与内置平台"完全对齐"。

## 2. 事实核实（agent 自查，非待决）

- **数据与 claude-code 逐字段同构**：实测 `~/.icodemate/cli/projects/<项目slug>/<sessionId>.jsonl`，
  记录含 `type: user|assistant|system`、`message.content` 块、`cwd / sessionId / gitBranch /
  permissionMode / version / isSidechain`；`~/.icodemate/cli/sessions/` 为空；
  `<项目slug>/memory/` 子目录同 claude。→ **claude-code 适配器逻辑可原样复用，只换目录**。
- **自定义平台机制**：写 JS 适配器投递 `~/.agentlray/platforms/*.js`，启动时校验并入注册表；
  generic 表面（list / 详情 / export / OTLP / watch / search / prompts / tool-audit / CLI）按
  **能力位**自动接入；resume 需适配器声明 `resume`。见
  [`design-custom-platforms.zh-CN.md`](design-custom-platforms.zh-CN.md)。
- **薄适配器 + 组根解析**：`platform export <id>` 生成的薄适配器经 `AGENTLRAY_PKG_ROOT`
  require 包内实现；`@agentlray/shared` 裸名别名由 `lib/platforms/index.js` 顶层全局注册。
  co-mind 与 claude-code 逐字段同构，故复用**内置 claude-code 适配器本体**最省且全表面对齐
  （ADR-0005 D10 / [guide-custom-platforms.zh-CN.md §0.1](guide-custom-platforms.zh-CN.md)）。
- **resume bin 解析**：`AGENTLRAY_CO_MIND_BIN`（env）> `~/.agentlray/settings.json` 的 `cliBins` section
  `co-mind` 键 > 适配器默认 `bin`。

## 3. 决策（grill-with-docs 收敛 + 修订）

| # | 决策 | 结论 |
| --- | --- | --- |
| R1-Q1 | 平台载体 | **B 薄适配器复用内置 claude-code**（2026-11-08 修订）：`module.exports = {...claude, 覆写}`，经 `AGENTLRAY_PKG_ROOT` require 包内 `lib/platforms/builtin/claude-code/index.js`。原决策 A「自包含单文件」被 ADR-0005 D10 修订；仍零改 AgentLRay 源码、不内置（公司专属路径不入库、不扩散 fork 全体） |
| R1-Q2 | 命名 | `id = co-mind`，`label = Co-Mind`（URL `/api/co-mind/sessions`、`--platform co-mind`、env `AGENTLRAY_CO_MIND_BIN`） |
| R1-Q3 | 会话根 | `defaultDir() = env CO_MIND_DIR 缺省 <homedir>/.icodemate/cli/projects`，`dirSettingKey=coMindDir` / `dirParam=dirCoMind`（homedir 相对，换机不破；设置面板可配目录） |
| R1-Q4 | 能力面 | **全开**：复用 claude-code 的 `list/find/parse/getSession/collectFiles/watchParse/subagents（listChildren/getChild）/prompts/extractPromptsFromFile/inspect` + `resume/create`；不开 `needsAgent`（非按 agent 平台）。`searchSupplement` 显式置 null（co-mind 无 `~/.claude/history.jsonl` 来源） |
| R1-Q5 | resume | `{ bin: 'co-mind', args: (id) => ['--dangerously-skip-permissions', '--resume', id] }`——带免确认 flag，与内置 claude-code resume 对齐（该 fork 缺省 `bypassPermissions`） |
| R2-Q1 | 子会话 | 保留 `subagents/` 扫描（复用 claude-code `listChildren/getChild`，与之一致） |
| R2-Q2 | 归置 | 规范源 `co-mind.js` + 安装副本 `~/.agentlray/platforms/co-mind.js`；仓库零改动（含不新增已追踪源码） |

## 4. 适配器实现

`co-mind.js`（~80 行薄适配器，零第三方依赖，仅 Node 内置模块
`path`/`os` + `AGENTLRAY_PKG_ROOT` 注入）。

**薄适配器复用**：co-mind 与 claude-code 逐字段同构，因此不复制任何解析逻辑，直接：

```js
const claude = require(path.join(process.env.AGENTLRAY_PKG_ROOT,
  'lib/platforms/builtin/claude-code/index.js'));
module.exports = { ...claude, id: 'co-mind', label: 'Co-Mind',
  defaultDir: sessionsDir, dirSettingKey: 'coMindDir', dirParam: 'dirCoMind',
  resume: { bin: 'co-mind', ... }, create: { bin: 'co-mind', ... },
  bin: 'co-mind', searchSupplement: null };
```

- **为何可行**（ADR-0002 曾判定「薄适配器 require 内部模块不可行」）：`lib/platforms/loader.js`
  在加载任何项目/用户适配器前设置 `AGENTLRAY_PKG_ROOT`；`@agentlray/shared` 裸名别名是
  `Module._resolveFilename` 全局钩子（`lib/platforms/index.js` 顶层注册）。server 与
  `bin/platform.js`（含 `validate`）都先 require `lib/platforms`，故 co-mind 复用 claude-code
  后其内部 `require('@agentlray/shared/...')` 与 `require('./parse')` 均可解析。
- **全表面继承**：`list/find/parse/getSession/collectFiles/watchParse/listChildren/getChild/
  extractPromptsFromFile/inspect` 全部随 claude-code 对齐——含 `deriveStatus` 四态推导
  （普通 `list` 复用 claude-code 的 `sortSessionsByStatusGroups`，状态窗口与内置完全一致）、
  tail 证据、title 回退首条用户消息、`getSession` 详情。**不再**自产 status / 自读
  `status-config.json`（原自包含版的窗口对齐负担已消除）。
- **差异覆写**：`id`/`label`/`defaultDir`/`dirSettingKey`/`dirParam`/`color`/`resume`/`create`/
  `bin`；`searchSupplement` 置 null（claude-code 该 hook 读 `~/.claude/history.jsonl` 做
  retention 兜底，co-mind 无此来源，且 `lib/search.js` 只对 `typeof === 'function'` 执行）。
- **版本一致性**：薄适配器随包升级自动跟随 claude-code 新实现（含状态机/解析修复），零
  镜像漂移——这是相对原自包含版的最大收益。

## 5. 验证证据（真实输出）

```text
$ node bin/agentlray.js platform validate ~/.agentlray/platforms/co-mind.js --json
{"schemaVersion":1,"kind":"platform-validate","ok":true,"platform":{"id":"co-mind","label":"Co-Mind"},"sessionCount":24,"firstId":"9b1e3120-…","note":"…"}

$ node bin/agentlray.js platform list --json
# co-mind → Custom，builtin:false；capabilities：list/find/parse/getSession/collectFiles/
# watchParse/children/prompts/inspect/resume/create 全 true；searchSupplement 置 null
# dirSettingKey=coMindDir、dirParam=dirCoMind、defaultDir=/home/…/.icodemate/cli/projects

冒烟驱动（安装副本）：list 24 会话（status/tail/title 推导正确）、getSession 93 消息、
collectFiles 24 文件。
```

## 6. 能力面对照

复用内置 claude-code 后，co-mind 获得与其**完全一致**的全表面能力（不再受「自定义平台
机制源码缺位」限制）：

| 表面 | 现状 |
| --- | --- |
| 会话列表/详情/SSE watch/OTLP 导出/工具体检 | 随 claude-code 全部可用（`list/find+watchParse/parse/getSession/collectFiles`） |
| children / subagents | 可用（复用 `listChildren/getChild`） |
| prompts | 可用（复用 claude-code `extractPromptsFromFile`，即 content-block 专用提取器） |
| search | 主搜索随 claude-code（collectFiles + 默认 `searchJsonlFile`）；`searchSupplement` 已置 null（无 claude history 来源） |
| inspect 离线诊断 | 可用（复用 claude-code `inspect`；`adapterFiles` 指向内置 claude-code 源文件，语义即「实现=claude-code」） |
| resume / create | 可用（命令名 `co-mind`） |

## 7. 使用与回滚

- **启用**：文件在 `~/.agentlray/platforms/co-mind.js` 即启用；改 `defaultDir` 环境变量
  `CO_MIND_DIR` 或通用 `?dir=` / `--dir` / 设置面板 `coMindDir` 覆盖。
- **回滚**：删除/移走该文件即卸载；全局逃生 `AGENTLRAY_NO_PLUGINS=1`。
- **升级适配器**：薄适配器随包升级自动跟随内置 claude-code；仅当需改身份/目录/命令时
  编辑 `co-mind.js` 后重新 `cp` 到 `~/.agentlray/platforms/`，重启
  服务/重跑 CLI 生效。
- **校验**：`node bin/agentlray.js platform validate ~/.agentlray/platforms/co-mind.js --json`。

---

## 实现进度（代码核对：2026-11-19，基线 `c7fdb8f`）

**状态：已实现（薄适配器）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 薄适配器接入 | ✅ 已实现 | `co-mind.js` |
| 安装副本 | ✅ 已实现 | `~/.agentlray/platforms/co-mind.js`（运行环境，不入库） |
| 全表面等价 + resume | ✅ 已实现 | 适配器 `resume` 声明复用内置 claude-code |

