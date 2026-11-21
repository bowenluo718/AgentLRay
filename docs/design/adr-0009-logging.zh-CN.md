# ADR-0009：AgentLRay 日志能力（复用 SafeLogger + 家目录 logs 三类按天 + additive 接入）

> 类型：决策记录（ADR）　｜　日期：2026-11-21　｜　状态：**accepted（已实现，2026-11-21）**
> 方法：`grill-with-docs`（grilling + domain-modeling 收敛，R1–R3）+ 评审修订（R4）
> 前置文档：`design-logging`（本 ADR 的设计文档）
> 修订：R4（评审采纳——不引入 pino、install 降级 first-run、错误接入点改 catch/handleError、require 零副作用、脱敏白名单、目录 0700、DIR 优先级、access 只记本机）

## 1. 背景与问题

AgentLRay 无集中日志设施，全项目 `console.*` 直接输出，进程退出即失，无法回溯安装/启动/运行历史。用户诉求：添加日志能力（安装/启动/运行日志），用户目录下 `logs` 文件夹，默认按天区分。

本 ADR 记录该能力的**关键架构决策**（基础设施、目录与文件划分、接入策略、脱敏、配置落点）。ADR-0008 之后编号 +1。

## 2. 决策（grill R1–R3 + 评审 R4 收敛）

| 决策点 | 结论 |
| --- | --- |
| **基础设施** | **复用既有 `SafeLogger` 的脱敏规则与接口契约，不引入 pino 依赖**（评审 R4）。**决策理由**：dsh 子系统已在用 `lib/dsh/host.js:77-85` 的 `vendor.logging.SafeLogger`（约 40 行脱敏 sink，字段黑名单正则），项目依赖极简（express/ws/zod/@noble/*），需求（三类文件按天/脱敏/级别过滤）手写分流即可满足；`lib/logging.js` 独立封装为日志唯一入口，**照搬其 `LogSink`/`redact` 规则本地实现、不 require dsh vendor**（vendor 懒加载可缺失，见 `lib/dsh/vendor.js:10`，日志不得强依赖它），后续若需切换依赖实现（如 pino）仅替换内部适配层、对外接口不变。 |
| **目录基准** | `~/.agentlray/logs/`（`AGENTLRAY_HOME || os.homedir()` + `.agentlray/logs`），与既有 `analysis/`/`settings.json` 同基准，测试可隔离。 |
| **文件划分** | **三类文件**各自按天：`boot-*.log`（每次启动）/ `app-*.log`（运行事件）/ `access-*.log`（HTTP 访问）。**install 降级为 boot 内一条 first-run 标记**（评审 R4），不单列文件。 |
| **安装语义** | **bootstrap**（首次运行引导），**非** npm `postinstall`——安装过程是 npm 生命周期、与 AgentLRay 用户数据目录解耦；引导时机在服务 boot，以 first-run 标记表达。 |
| **接入策略** | **additive**：不动现有 `console.*`，仅新增 logger 调用点。避免大范围重写回归；遗留 stdout 保留（前台交互首选）。 |
| **脱敏** | **写盘前脱敏**，复用 `lib/secret` 边界；访问日志 query 强制脱敏（`token`/`password`/`key`/`secret`/`code` 值 → `***`），无「不脱敏」开关。**写操作采用白名单：只记「动作 + 资源 id + 变更字段名」，不记字段值**（评审 R4，防 `llm.apiKey`/hosts `identityKey` 泄密）。 |
| **按天切换** | 每次写入检查跨天换文件（**无后台定时器**，零常驻开销）；默认保留 **30 天**（`AGENTLRAY_LOG_KEEP_DAYS`），启动清理过期。**已知限制**：长期不重启实例会堆积过期文件（零常驻代价，不引入后台清理）。 |
| **访问日志字段** | `method / path(query 脱敏) / status / 耗时ms / 来源 host`；**只记本机入口请求，proxy 转发不重复记**（评审 R4）。 |
| **配置落点** | **仅环境变量**（`AGENTLRAY_LOG_LEVEL` / `AGENTLRAY_LOG_KEEP_DAYS` / `AGENTLRAY_LOG_DIR`），**不进 `settings.json`**——日志属运维诊断面，非功能设置，与 `AGENTLRAY_HOME` 覆盖哲学一致，零 UI 成本。`AGENTLRAY_LOG_DIR` **优先于默认跟随 HOME**（评审 R4）。 |
| **初始化入口** | **full（server.js）+ thin（thin-server.js）** 都初始化并写 boot 日志；**CLI 离线命令不初始化**（保持只读零副作用）。**require 期零副作用、首次 `log.*` 才懒初始化**（评审 R4，配合测试隔离）。 |
| **运行事件接入点** | **events_plus**：boot/dsh host 状态/host 连接断开隧道/退出兜底/未捕获异常/未处理 rejection + 各 `lib/routes` 的 **catch/handleError 分支**（代码库无集中错误中间件；仅记非预期异常）+ 写操作（settings/hosts 变更，白名单）。 |
| **依赖影响** | **无新增运行时/开发依赖**（评审 R4 取消 pino/pino-pretty）。 |

## 3. 考虑过的替代方案

- **引入 pino（`^9`）+ pino-pretty**：**被否决（评审 R4）**——项目依赖极简，dsh 已有内置脱敏的 SafeLogger；需求以三类文件分流+脱敏为主，自封装即可满足，无需引入通用日志框架。`lib/logging.js` 保留适配层，后续若需再切 pino 成本可控。
- **直接 require dsh vendor 的 `SafeLogger`**：**被否决（评审 R4）**——`lib/dsh/vendor.js:10` 明确 vendor 懒加载、可缺失；日志是横切基础设施，不得强依赖一个"只在用 dsh 时才加载"的包（否则 vendor 损坏时连诊断日志都起不来）。改为照搬其 `LogSink`/`redact` 规则在 `lib/logging.js` 自包含实现，行为对齐、零耦合。
- **零封装直接 console 写文件**：被否决——无级别过滤/脱敏/统一接口，与既有 SafeLogger 先例不一致。
- **单文件不分三类**：被否决——启动/运行/访问诉求不同、排查定位粒度不同，三类各自按天更清晰。
- **全面替换 `console.*`**：被否决——改动面大、回归风险高；本次选 additive 增量接入，后续可迁移。
- **后台定时器轮转**：被否决——引入常驻开销；每次写入检查日期足够（低写入频率下零成本）。
- **配置进 `settings.json`**：被否决——日志为诊断面非功能面，环境变量足够。

## 4. 后果

- **正向**：持久化启动/运行/访问日志，按天可回溯、可清理；脱敏防凭据明文落盘；additive 降低回归风险；**无新增依赖**。
- **代价/注意**：
  - 既有 `console.*` 与日志文件并存一段时间（additive），后续可增量迁移。
  - 访问日志 query 强制脱敏，排查时敏感 query 无法从日志还原（设计取舍）。
  - 写操作只记字段名不记值，变更明细无法从日志还原（白名单取舍）。
  - 长期不重启实例堆积过期文件（零常驻的已知限制）。
  - 实现期 `lib/logging.js` 照搬 SafeLogger 脱敏规则自包含实现（含适配层，不 require dsh vendor），对外暴露 `log.boot()/app()/access()`，隔离实现细节。
  - **require 期必须零副作用**，首次调用才懒初始化，避免破坏测试隔离（`test/setup-env.cjs` 不得设 `AGENTLRAY_HOME`/改 `HOME`）。

## 5. 状态

**accepted（已实现，2026-11-21）**。实现证据见 `design-logging.zh-CN.md` §8（`lib/logging.js`、`lib/routes/log-helper.js`、`server.js`/`bin/thin-server.js`/`lib/hosts.js`/`lib/dsh/host.js` 接入、`test/logging.test.js` 12 例、`npm test` 769/769）。
