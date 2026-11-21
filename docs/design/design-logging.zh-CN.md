# 设计：AgentLRay 日志能力（安装/启动/运行日志）

> 类型：方案设计　｜　日期：2026-11-21　｜　状态：**accepted（已实现，2026-11-21）**
> 方法：`grill-with-docs`（grilling + domain-modeling 收敛，R1–R3）+ 评审修订（R4）
> 关联：ADR-0009（决策记录）、glossary「日志」条目
> 实现进度：**已实现**（代码证据见 §8；`npm test` 769/769 通过）

## 1. 背景与问题

AgentLRay 当前**无集中日志设施**：全项目以 `console.*` 直接输出（`server.js` 5 处、`bin/thin-server.js` 6 处、`lib/dsh/host.js` 4 处、`bin/agentlray.js` 3 处等），日志只进 stdout/stderr，进程退出即失、无法回溯安装/启动/运行历史。`~/.gitignore` 已有 `*.log` 规则，但仓库内无任何日志落地实现。

用户诉求：**添加日志能力，包括安装、启动、运行日志；在用户目录下添加 `logs` 文件夹存放；默认按天区分。**

### 1.1 核心张力

- **可回溯 vs 零运维**：需要持久化日志便于排查，但不应引入常驻后台进程/定时器增加运行时开销。
- **additive vs 全面接管**：本会话定 **additive**——不动现有 `console.*`，仅新增 logger 调用点。既避免大范围重写回归风险，又满足「有日志可查」的核心诉求；遗留 `console.*` 保留（stdout 仍是交互式前台的首选输出）。
- **分文件 vs 单文件**：启动/运行/访问三类诉求 + 运行又分「事件/访问」两子类，定 **三类文件**（§3.2，install 降级为 boot 的 first-run 标记，评审 R4），各自按天，互不混淆。

## 2. 决策汇总（grill R1–R3 + 评审 R4 收敛）

| 决策点 | 结论 |
| --- | --- |
| **R1 范围** | **仅设计**（ADR + glossary + 设计文档），实现另行排期。 |
| **R1 基础设施** | **复用既有 `SafeLogger` 的脱敏规则与接口契约，不引入 pino 依赖**（评审 R4 修订）。`lib/logging.js` 独立封装为日志唯一入口，照搬 SafeLogger 的 `LogSink`/`redact` 规则本地实现（**不 require dsh vendor**，因 vendor 懒加载可缺失）；后续如需切换依赖实现（如 pino）只需替换内部适配，对外接口不变。 |
| **R1 目录基准** | `~/.agentlray/logs/`（`AGENTLRAY_HOME || os.homedir()` + `.agentlray/logs`），与既有 `analysis/`、`settings.json` 同基准，测试可用 `AGENTLRAY_HOME` 隔离。 |
| **R1 分文件按天** | **三类文件**各自按天切分：boot / app / access（§3.2）；install 降级为 boot 内一条 first-run 标记（评审 R4）。 |
| **R1 级别** | 带级别 `info/warn/error`，统一格式，可用 `AGENTLRAY_LOG_LEVEL` 过滤。 |
| **R1 安装语义** | **bootstrap**（首次运行引导：初始化 logs/ 并记录版本/平台目录/启动事件）；**非** npm `postinstall`。首次引导以 boot 内 first-run 标记表达，不单列文件（评审 R4）。 |
| **R1 运行语义** | **运行事件 + HTTP 访问**两类（§3.2 的 app 与 access）。 |
| **R1 additive** | 不动现有 `console.*`，仅新增 logger 调用点。 |
| **R2 脱敏** | **写盘前脱敏**，复用 `lib/secret` 边界（AES-256-GCM 的敏感值边界），避免 secret/密码/token 明文落盘。写操作日志采用**白名单**（只记动作 + 资源 id + 变更字段名，不记字段值）（评审 R4）。 |
| **R2 文件划分** | **三类文件**：`boot-*.log`（每次启动，含 first-run 标记）、`app-*.log`（运行事件）、`access-*.log`（HTTP 访问）。 |
| **R2 初始化入口** | **完整服务（server.js）+ 薄服务（thin-server.js）** 都初始化 logs/ 并写 boot 日志；**CLI 离线命令不初始化**。 |
| **R3 按天切换** | **每次写入检查跨天即换文件**（无后台定时器，零常驻开销）；默认保留 **30 天**，启动时清理过期文件。 |
| **R3 访问日志** | 字段 `method / path（query 脱敏）/ status / 耗时ms / 来源 host`；path 含 query 时对敏感 query 脱敏（访问日志是脱敏重点，避免 `?token=` 明文）。**只记本机入口请求，proxy 转发的远端请求不重复记**（评审 R4）。 |
| **R3 配置落点** | **仅环境变量**，不进 `settings.json`：`AGENTLRAY_LOG_LEVEL` / `AGENTLRAY_LOG_KEEP_DAYS` / `AGENTLRAY_LOG_DIR`（`AGENTLRAY_LOG_DIR` 优先于默认跟随 HOME，评审 R4）。 |
| **R3 运行事件接入点** | **events_plus**：server boot、thin boot、dsh host 状态、host 连接/断开/隧道、进程退出兜底、未捕获异常/未处理 rejection，外加各 `lib/routes` 的 catch/handleError 分支与写操作（settings/hosts 变更）。**代码库无集中错误中间件（无 4 参 handler），接入点落在各 route 的 catch / handleError，且仅记录非预期异常、预期 4xx 不逐条覆盖**（评审 R4）。 |

## 3. 详细设计

### 3.1 基础设施：复用 SafeLogger 与多目标输出

- 新增 `lib/logging.js` 作为**日志唯一入口**（单一真源），封装 logger 创建与三类文件分流。
- **复用既有 `SafeLogger` 的脱敏规则与接口契约，但自包含实现，不 require dsh vendor**（评审 R4 精确化）：SafeLogger（`lib/dsh/vendor/src/plugin/logging.ts`，`lib/dsh/host.js:77-85` 已在用）是约 40 行的脱敏 sink（级别过滤 + 字段黑名单正则 `authorization|cookie|token|secret|password|...`）。`lib/logging.js` **照搬其 `LogSink` 契约与 `redact` 规则**在本地实现，**不 `require('lib/dsh/vendor')`**。理由：`lib/dsh/vendor.js:10` 明确 vendor 是**懒加载、可缺失**（"仅在真正使用 dsh 时才 require —— vendor 缺失或损坏"不影响非 dsh 路径）；日志是横切基础设施，若强依赖 vendor，vendor 出问题时连诊断日志都起不来，违背日志初衷。此实现也真正满足"独立封装、可快速切换"。
- 外部只暴露 `log.boot()` / `log.app()` / `log.access()` 三组方法（调用方不感知底层实现）。
- **可快速切换**：`lib/logging.js` 把「日志实现适配」隔离在一个内部适配层；后续若需切换依赖实现（如引入 pino），仅替换该适配层，调用方接口不变（评审 R4）。
- 写入**文件流**（`fs.createWriteStream` 到 `~/.agentlray/logs/` 按天文件）；保留**控制台**输出。additive 下控制台输出与现有 `console.*` 并存。
- 级别：`AGENTLRAY_LOG_LEVEL` 覆盖默认（建议默认 `info`）。
- **不引入后台轮转**：按天切换由「每次写入时检查日期」实现（§3.3），无需轮转插件。

> **统一格式定义（评审 R4 落定）**：生产日志即日志实现输出的结构化/半结构化行，字段含 `ts / level / category / message`（category 区分 boot/app/access），不引入 pretty 格式化工具；实现期在 `lib/logging.js` 内固化此格式，供验证判定。

### 3.2 三类文件与写入面

| 类别 | 文件名（按天） | 语义 | 写入面（additive 接入点） |
| --- | --- | --- | --- |
| **boot** | `boot-YYYY-MM-DD.log` | 每次启动 | `server.js` / `bin/thin-server.js` 启动：`SERVER_BOOT_ID`、`pkg.version`、`HOST:PORT`、平台目录列表、dsh host 启动/失败。**首次引导**（目录首次创建）时追加一条 `first-run` 标记（含版本、平台目录、首次引导时间），不单列 install 文件（评审 R4）。 |
| **app** | `app-YYYY-MM-DD.log` | 运行事件 | dsh host 状态、host 连接/断开/隧道、进程退出兜底、未捕获异常/未处理 rejection、各 `lib/routes` 的 catch/handleError 分支（仅非预期异常）、写操作（settings/hosts 变更，白名单，评审 R4）。 |
| **access** | `access-YYYY-MM-DD.log` | HTTP 访问 | express 中间件记录 method/path/status/耗时/来源 host，query 脱敏；只记本机入口请求（评审 R4）。 |

三类**共用同一 `logs/` 目录**，仅文件名前缀区分；各自独立按天切分（§3.3）。**install 不再单列文件**，首次引导信息并入 boot 的 first-run 标记。

### 3.3 按天切分与保留

- **切换机制**：每次写入时取当前本地日期，若与当前打开文件流日期不同则关闭旧流、以新日期文件名重开。零常驻定时器；跨天首条写入自然触发切换。
- **跨天竞态（评审 R4）**：午夜瞬间可能有两笔写入短暂并存于新旧两流。用**单流 + 切换标记**处理（进入切换临界区时串行化、标记后仅新流可写），低危、实现期收敛。
- **保留策略**：默认保留 **30 天**（`AGENTLRAY_LOG_KEEP_DAYS` 覆盖）；**启动时**清理超过保留期的文件（仅清 `~/.agentlray/logs/` 下三类前缀文件，不误删用户其它文件）。
- **长期不重启堆积（评审 R4 已知限制）**：清理仅启动时执行，长期运行的实例会堆积过期文件。属「零常驻」的已知代价，明确记为限制，不引入后台清理。
- **命名时区**：按**本地时区**日期命名（运维习惯），跨平台由 `os.homedir()` 同源解析。

### 3.4 脱敏

- **复用 `lib/secret` 边界**：`lib/secret.js` 管理的敏感值（`passwordEnc` 解密值、dsh token、ssh 密码等）在写入日志前**一律脱敏**（如 `***`），不得明文落盘。
- **访问日志 query 脱敏**：`access-*.log` 的 `path` 含 query 时，对敏感参数（`token`/`password`/`key`/`secret`/`code` 等）值替换为 `***`。
- **写操作白名单（评审 R4 落定）**：settings/hosts 写操作日志**只记「动作 + 资源 id + 变更字段名」**，不记字段值。因 `lib/secret.js` 只做加解密、不含字段级脱敏，若把请求 body 整体落日志，`llm.apiKey`、hosts `identityKey` 等即泄密；故以**白名单（只允许安全字段）而非黑名单**约束，从源头不落敏感值。
- 实现期收敛一个 `redact` 辅助（可放 `lib/logging.js` 内部），供 app/access 两路共用。

### 3.5 配置（仅环境变量）

| 变量 | 默认 | 语义 |
| --- | --- | --- |
| `AGENTLRAY_LOG_LEVEL` | `info` | 日志级别过滤（trace/debug/info/warn/error） |
| `AGENTLRAY_LOG_KEEP_DAYS` | `30` | 按天文件保留天数 |
| `AGENTLRAY_LOG_DIR` | `~/.agentlray/logs` | 日志目录覆盖；**优先于默认跟随 `AGENTLRAY_HOME`**（两者同设时以 `AGENTLRAY_LOG_DIR` 为准，评审 R4） |
| `AGENTLRAY_LOG_CONSOLE` | `1` | 控制台多目标输出开关（`0` 关闭）。仅 `app` 类镜像控制台（boot 由既有 `console.*` 保留、access 不刷屏）；测试/嵌入可关闭。 |

**不进 `settings.json`**：日志属于运维/诊断面，非用户可配置的功能设置；环境变量足够且零 UI 成本（与 `AGENTLRAY_HOME` 覆盖哲学一致）。

### 3.6 初始化入口（Q11）与测试隔离

- **`server.js`（full）**：boot 前初始化 `lib/logging.js`（建 logs/、写 boot 首次引导 first-run 标记 + 启动日志）。
- **`bin/thin-server.js`（thin）**：同样初始化并写 boot 日志（薄服务是独立进程，应有独立启动记录）。
- **CLI 离线命令（inspect/sessions/platform）**：**不初始化**，保持零副作用（只读查询不产生磁盘日志）。
- **require 期零副作用（评审 R4，测试隔离硬约束）**：`lib/logging.js` **require 时不建目录、不开文件流、不解析 HOME**；首次 `log.*` 调用才**懒初始化**。`test/setup-env.cjs` 明令不得设置 `AGENTLRAY_HOME`/改 `HOME`（AGENTS.md），且既有测试自建隔离家目录——若 require 期就写盘会污染其它测试。此约束写入实现清单。
- **目录权限（评审 R4）**：logs/ 目录用 **0700**（与 `~/.agentlray/secret` 同级思路），文件 0600。

## 4. 边界与取舍

- **additive 不清理既有 `console.*`**：遗留 stdout 输出保留（前台交互首选）；`console.*` 与日志文件并存，避免大范围回归。后续可增量迁移，本次不扩范围。
- **多主机/远端**：每个实例（本机 full、远端 full、thin）各自写自己的 `~/.agentlray/logs/`；访问日志按「来源 host」字段区分连接方，不跨主机合并日志。
- **脱敏是硬边界**：宁可少记也不明文落凭据；访问日志 query 强制脱敏，不提供「不脱敏」开关；写操作只记字段名不记值（白名单）。
- **仅环境变量**：不新增 settings 写面，日志诊断与功能设置解耦，测试零 UI 依赖。

## 5. 接入点清单（additive events_plus，Q17，评审 R4 修订）

实现期在下列位置**新增** logger 调用（不改写既有 `console.*`）：

1. `server.js`：boot 前初始化、启动成功（HOST:PORT/平台目录/dsh host 状态）、首次引导 first-run 标记。
2. `bin/thin-server.js`：boot 前初始化、启动成功、自动连接结果。
3. `lib/dsh/host.js`：host 服务启动/失败/状态变化。
4. `lib/hosts.js`：host 连接/断开/隧道建立/失败。
5. `server.js` + `bin/thin-server.js`：进程退出兜底（SIGTERM/SIGINT/exit）与**未捕获异常 / 未处理 rejection**（统一 error 落 app 日志）。
6. 各 `lib/routes/*` 的 **catch / handleError 分支**：请求处理非预期异常（error 级别）。**代码库无集中错误中间件**（`lib/routes/platforms.js:34` 等为局部 `handleError`，全库 68 处 try/catch）；**仅记录非预期异常，预期 4xx 不逐条覆盖**，避免噪音与范围失控（评审 R4）。
7. 写操作：`lib/routes/settings.js`、`lib/routes/hosts.js` 的写路径（settings/hosts 变更事件，info 级别；**白名单：只记动作 + 资源 id + 变更字段名**，评审 R4）。
8. 访问日志：新增 express 前置中间件（access 日志，位于 `mountProxyRoutes` 之后、路由之前）。**只记落到本实例的请求**——被 proxy 转发的远端请求不会再走到后续中间件，故 access 为本机入口记录，不重复记转发（评审 R4）；耗时/status 用 `res.on('finish')` 采集。

## 6. 涉及文件（实现期预估）

- 新增：`lib/logging.js`（日志唯一入口 + 三类分流 + 按天切换 + 脱敏辅助 + SafeLogger 适配层）、`test/logging.test.js`。
- 修改：`server.js`、`bin/thin-server.js`、`lib/dsh/host.js`、`lib/hosts.js`、`lib/routes/*` 的 catch/handleError 分支、`lib/routes/settings.js`、`lib/routes/hosts.js`。
- 依赖：**无新增运行时依赖**（照搬 SafeLogger 的脱敏规则在 `lib/logging.js` 自包含实现、**不 require dsh vendor**；评审 R4 取消 pino/pino-pretty 引入）。
- 文档：`docs/.local/README.md` 登记；实现完成后迁移 `docs/design/` 并更新进度。

## 7. 验证方式（实现期）

- `npm test`：新增 `test/logging.test.js`（隔离 `AGENTLRAY_HOME`，且验证 require 期零副作用）覆盖——三类文件生成、first-run 标记、按天切换、保留清理、脱敏（含访问日志 query 与写操作白名单）。
- 手动：启动 full/thin 各一次，检查 `~/.agentlray/logs/` 下 boot/app/access 文件内容与级别过滤；首次启动含 first-run 标记。
- 检查点：日志文件权限（目录 0700 / 文件 0600）；`AGENTLRAY_LOG_LEVEL` / `KEEP_DAYS` / `DIR` 三变量生效（`DIR` 优先于 HOME）。

## 8. 实现进度

**状态：已实现（2026-11-21）。** 代码证据（`npm test` 769/769 通过）：

- **`lib/logging.js`（日志唯一入口）**：三类文件 `boot/app/access-YYYY-MM-DD.log` 各自按天；懒初始化（require 期零副作用，首次 `log.*` 才建目录/开门）；写盘前脱敏（字段黑名单，含 `identityKey`）+ 访问 query 强制脱敏；`createAccessMiddleware()` 记录 method/path(query 脱敏)/status/耗时/来源 host；级别过滤 `AGENTLRAY_LOG_LEVEL`；保留 `AGENTLRAY_LOG_KEEP_DAYS`（启动清理，默认 30，仅清三类前缀）；`AGENTLRAY_LOG_DIR` 优先于 `AGENTLRAY_HOME`；目录 0700 / 文件 0600；同步 fd 写入保证退出前落盘。
- **`server.js`**：boot 前 `log.init`；boot / listening（HOST:PORT/平台目录）/ dsh host 启动日志；access 中间件挂在 `mountProxyRoutes` 之后（只记本机入口）；`exit`/SIGTERM/SIGINT 兜底 + 未捕获异常/未处理 rejection（error 落 app 后按默认语义退出码 1）。
- **`bin/thin-server.js`**：薄服务独立进程同样初始化并写 boot 日志（平台目录为空）、boot 自动连接结果落日志、退出/未捕获兜底。
- **`lib/dsh/host.js`**：host 启动/角色跳过/登录失效/停止。
- **`lib/hosts.js`**：host 连接/断开/隧道建立/失败（ssh + dsh）。
- **`lib/routes/*` catch/handleError**：新增 `lib/routes/log-helper.js`（`logAndFail` 统一 500 记录、`logWrite` 白名单），替换全部 `res.status(500)` 分支（cli-bins/dsh/export/hosts/insights/platforms/prompts/search/sessions/settings/watch）；预期 4xx 不落日志。
- **写操作白名单**：`lib/routes/settings.js`（section 名）、`hosts.js`（create/update/delete/connect/disconnect）、`platforms.js`（mount/replace），只记动作 + target + id + 字段名。
- **测试**：`test/logging.test.js` 12 例（require 零副作用、三类文件 + first-run + 行格式、非首次不重复 first-run、级别过滤、跨天切换、保留清理、字段脱敏、query 脱敏、写白名单、DIR 优先、权限、access 中间件端到端）。
- **手动验证**：full（`server.js`）与 thin（`bin/thin-server.js`）各起一次，`~/.agentlray/logs` 生成三类文件、first-run 标记、访问 query `token=***`、SIGTERM 记录 `process exit`。
- **实现偏差**：写实现采用同步 fd（`openSync`/`writeSync`）而非 `fs.createWriteStream`，以保证进程退出前落盘且测试写入后可即时读取；隔离在 `appendLine` 适配层，对外接口不变。控制台多目标输出仅镜像 `app` 类（boot 由既有 `console.*` 保留，access 不刷屏），`AGENTLRAY_LOG_CONSOLE=0` 可关闭（测试/嵌入用）。
- **已知限制（同设计）**：保留清理仅在启动时执行，长期不重启实例会堆积过期文件。
