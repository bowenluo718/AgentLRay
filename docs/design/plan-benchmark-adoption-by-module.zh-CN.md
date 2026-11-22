# 对标借鉴实施清单（按模块 · 功能优先）

- **文档类型**：任务计划（按模块罗列借鉴项 + 实施顺序）
- **日期**：2026-11-22
- **上游对象**：`plugharness-go`（dsh-Go）
- **来源合并**：
  - `docs/.local/analysis-plugharness-go-benchmark.zh-CN.md`（过程稿，未随代码提交；契约机器化 / 漂移自动化 / 失败显式化 / 验证分级化）
  - 本次三轮对标分析：远程连接（relay + ssh + 状态机）、引擎后台常驻、PRoot 打包、鉴权模型、SSE 补拉、i18n、首启时序、发布工程、分享码
- **排序原则**：**先修直接影响用户使用的功能**（网络稳定性、数据不丢、安全、可解释的失败），工程化门禁类（CI、构建可复现、契约 schema、发布流水线）统一降到 P3，除非它直接堵住功能缺陷。
- **状态**：🟢 批次一（A-1/A-2/A-3/B-1/C-1）与批次二（A-4/A-5/A-6/D-1/D-2）**已实现**（2026-11-22，分支 `fix/dsh-review-2026-11-22`）；批次三～四仍为计划。进度与代码证据见 [§13](#13-实施进度与代码证据批次一)。
- **文档真源**：本文件（`docs/design/`）为正式副本，随代码提交；`docs/.local/` 保留同名过程稿。

---

## 0. 优先级定义

| 级别 | 含义 | 判断标准 |
| --- | --- | --- |
| **P0** | 直接影响用户：连不上、断线不恢复、丢数据、安全暴露 | 用户能感知，且当前无替代路径 |
| **P1** | 显著影响体验：慢、状态不明、恢复靠手工 | 用户能感知，有绕过手段 |
| **P2** | 特定场景才触发：SSH 用户、升级丢配置、首次安装 | 分众，非全量 |
| **P3** | 不直接影响使用：CI 门禁、构建可复现、契约 schema、发布流水线 | 开发期收益，用户不可见 |

> 上一份 `analysis-plugharness-go-benchmark` 的 P0 是「漂移检查进 CI」等工程化项。**本清单按用户影响重排**：这些整体降到 P3。

---

## 1. 模块 A：远程连接稳定性（最高优先）

> 影响面：全部移动端用户、全部远端查看场景。当前缺口见 `lib/hosts.js`（状态只有 `connecting/connected/disconnected/error` + 中文 error 文本）、`lib/dsh/client.js`（无健康探测）、`frontend/src/views/sessions/useSessionSse.ts`（SSE 断线不补拉）。

### A-1 链路状态机 + 错误分类（P0）

**上游证据**：`app/lib/remote/link_status.dart`（`HostLinkPhase{idle,connecting,connected,reconnecting,failed}`、`HostLinkStep`、`HostLinkError{kind,message,detail,retryable,diagnosticCode}`）；`relay/dsh_remote_backend.dart:472-510` 把上游失败码映射成 `retryable`。

**现状**：`lib/hosts.js` 运行时 entry 只有 `status` + `error` 字符串；`lib/routes/hosts.js` 原样透出；`frontend/src/lib/host-status.ts` 只有四态配色。

**动作**：
1. runtime entry 增 `phase`（`connecting|connected|reconnecting|failed`）、`attempt`、`nextRetryAt`、`error:{code,message,retryable}`。
2. 新增 `lib/dsh/errors.js`：稳定错误码枚举 `HOST_OFFLINE / DSH_AUTH_REQUIRED（已有）/ KEY_CHANGED / VERSION_INCOMPATIBLE / TUNNEL_TIMEOUT / TUNNEL_REFUSED / UNREACHABLE`，每项带 `retryable`。
3. `retryable=false` 直接 `failed`，不进重试循环。
4. 前端 `host-status.ts` 扩到五态；`HostConnectingView` 按 `code` 给「重试 / 重新登录 / 升级远端 / 删除信任记录」不同动作。

**验收**：`test/hosts-reconnect.test.js` 新增用例——注入 mock 隧道，杀链路 → `phase` 迁移 `connected→reconnecting→connected`；`KEY_CHANGED` 不重试、`retryable=false`。

**成本/风险**：1 天。风险：错误码一旦对外暴露不能改，命名先定稿。

---

### A-2 假 connected 探测 + 链路保活（P0）

**上游证据**：`ssh_link.dart` `keepAliveInterval=15s`、`_ping` 连续 2 次失败判死；`_probeDsh()` 在 mux 处于 `connecting/reconnecting` 时开一条到远端端口的 channel，超时即判「隧道背后服务已死」。

**现状**：dsh 通道断开后 `entry.status` 仍可能是 `connected`，直到 `proxy.js` 转发 502（`lib/routes/hosts.js:170`）。ssh 分支靠 `ServerAliveInterval=30/CountMax=3`（`lib/transport.js:43-47`）。

**动作**：
1. 已连接主机每 15s 探 `baseUrl/api/version`（复用 `probeVersion`）；连续 2 次失败 → 触发 A-1 的 `reconnecting`。
2. ssh 分支：`child.on('exit')` 从「仅置 disconnected」升级为触发重连（受 A-1 的 `retryable` 约束）。
3. 探测定时器随 `closeHost` 清理，不泄漏。

**验收**：断网后 ≤30s `/api/hosts` 显示 `reconnecting`；恢复后自动回 `connected`；进程退出无残留定时器（`test/hosts.test.js` 已有 shutdown 用例扩展）。

**成本/风险**：0.5–1 天。风险：探测频率过高会增加中继负载，15s 与上游一致。

---

### A-3 断线重连退避（P0）

**上游证据**：`link_status.dart` `Backoff(initial=1s, max=30s, maxAttempts=8)`，半固定半抖动；`InterruptibleDelay` 可被网络事件打断；`dsh_remote_backend.dart:73-84` `retryCaps=[0.5,1,2,4,8,15,30,60]s`。

**现状**：`lib/hosts.js` 无重连；`NodeRuntimeManager.kt:318-319` 是固定 `1s/2s/4s`、最多 3 次（这是 Node 子进程重启，不是链路重连）。

**动作**：`lib/hosts.js` 增加重连循环：指数退避 1→60s（上限），**无限重试**（手机长时间后台场景不能因次数耗尽而永久 failed），失败态保留最近错误与 `nextRetryAt`；用户手动「重试」可跳过退避。

**验收**：断开 5 分钟后回前台，无需手动操作即恢复；`/api/hosts` 的 `attempt` 与 `nextRetryAt` 单调递增。

**成本/风险**：0.5 天。风险：无限重试需配合 A-2 探测，否则会形成无效重试风暴。

---

### A-4 网络切换触发重连（P1）

**上游证据**：`app/lib/remote/network_watch.dart`（`onConnectivityChanged` + `AppLifecycleListener(onResume)` → `kick()`）；`ssh_link.dart kick()`：connected 时 5s ping 探活，reconnecting 时跳过退避，failed(retryable) 时重试。

**现状**：PRoot 与宿主共享网络栈，Wi-Fi↔蜂窝切换后旧 socket 已死，只能等 A-2 的下一个探测周期（≤30s）。

**动作**：
1. Android：`registerDefaultNetworkCallback` 的 `onAvailable/onLost` → 调薄服务 `POST /api/hosts/:id/kick`。
2. Node：`kick` 立即 ping（5s 超时），失败即进 `reconnecting` 并跳过当前退避等待。
3. `onLinkPropertiesChanged` 复用同一回调（同时服务 A-6 DNS）。

**验收**：Wi-Fi→4G 切换后 ≤5s 恢复 `connected`（当前需 ≤30s）。

**成本/风险**：1 天。风险：需要薄服务新增一个本地路由，注意加入 `proxy.js` 的 `LOCAL_ONLY_RE`。

---

### A-5 稳定本地端口（P1）

**上游证据**：`ssh/local_forward.dart`——监听器独立于 SSH 连接存活，端口在 link 生命周期内不变；断线期间 `accept()` 挂起等重连；`dropConnections()` 立刻掐断让客户端感知。

**现状**：`lib/transport.js` 每次连接 `findFreePort()`；`lib/dsh/loopback-client.js` 每次 `http.createServer()` 随机端口。重连后 `baseUrl` 变化。

**动作**：dsh loopback listener 与 ssh `localPort` 在 host 生命周期内复用（连接失败时回退随机端口）。`baseUrl` 稳定后，前端缓存与 SSE 重连语义都简化。

**验收**：断线重连前后 `/api/hosts` 的 `baseUrl` 不变。

**成本/风险**：1 天。风险：端口被外部占用时需回退逻辑（已有 `findFreePort` 可复用）。

---

### A-6 dsh 主机身份 pin 的显式策略（P1）

**上游证据**：`client.js` 首次连接弹 `confirmNewHost`，之后 pin；身份变化报 `PEER_IDENTITY_MISMATCH` **fail-closed**；`docs/testing/remote-connection-history.md` 记录该策略的验收。

**现状**：`lib/dsh/client.js:195-205` 已做 pin（`trustedPeer` / `trustPeer`），公钥变化直接拒绝——**骨架已具备**；缺的是：
- 错误码未进 A-1 的稳定枚举；
- 没有「忘记此主机」的 UI 入口（错误文案让用户「删除信任记录」，但前端没有对应按钮）。

**动作**：`KEY_CHANGED` 错误码 + 前端「忘记此主机」动作（调 `DELETE /api/hosts/:id/trust` 或等价）。

**验收**：公钥变化 → 稳定错误码 + 一键清除信任后重连成功。

**成本/风险**：0.5 天。风险：清除入口要防误触（二次确认）。

---

## 2. 模块 B：数据不丢（SSE 与实时尾随）

### B-1 SSE 断线补拉（P0）

**上游证据**：`docs/architecture.md` 日志通道 seq + 快照 + 批次去重；`docs/testing/remote-connection-history.md`「不重放有副作用的调用」。

**现状**：`frontend/src/views/sessions/useSessionSse.ts:87-88`——`error` 只 `setStatus('error')`，依赖 `EventSource` 自动重连；服务端 `lib/platforms/shared/watch.js:246-249` 只有 `: ping` 保活，**不发 `id:`**。重连期间新写入的消息丢失。

**动作**（二选一，推荐 B）：
- **A（最小）**：`es.addEventListener('open')` 时触发一次 `invalidateQueries(['session', platform, id])` 全量重拉。
- **B（推荐）**：服务端 SSE 事件加 `id: <byteOffset>`；前端记录 `lastEventId`；重连时用 `?after=<offset>` 让服务端从偏移续读。`watch.js` 本来就是按文件字节偏移尾随，天然支持。

**验收**：断网 10s → 远端写入 3 条 → 恢复后前端出现全部 3 条，不重复。

**成本/风险**：A 半天；B 1–1.5 天。风险：B 需要处理「文件被轮转/截断」（偏移回退检测）。

---

## 3. 模块 C：安全（本机接口暴露）

### C-1 薄服务 / 完整实例的本机鉴权（P0）

**上游证据**：`packages/dsh_client/lib/src/connection.dart:1-3,142-152,266-280`——启动 token 只接受一次 `GET /?token=`，换 `HttpOnly; SameSite=Strict` cookie；Host 校验 `Host` 头、拒绝跨源 `Origin` 与 `sec-fetch-site: cross-site`；客户端永不发送 `Origin`。

**现状（改动前基线）**：`lib/csrf.js:6-8` 明确「无 Origin 头（非浏览器客户端）直接放行」→ 任何本机进程可读写全部会话数据（含工具输出 `details`）。Android 上 `127.0.0.1:3801` 不是 app 私有（`design-android-mobile-app` §11 D1–D4）。
**2026-11-22 进展**：本机令牌鉴权已实现（见 §13 C-1）——本机直连无令牌一律 401；Android 侧原生壳生成/持久化令牌，实现已完成、需重新打包 APK 生效（§13.1）。

**动作**：
1. 原生生成随机 token → **经 env 传给 Node**（`AGENTLRAY_UI_TOKEN`），不走 TCP。
2. WebView 通过 URL fragment 携带 token；`GET /?token=` 换 HttpOnly cookie（`SameSite=Strict`）。
3. `/api/*` 校验 cookie；非浏览器客户端（桌面 CLI、测试）允许 `X-AgentLRay-Token` 头。
4. SSE 依赖同源 cookie 自动携带（无需 URL 泄露 token）。
5. `lib/csrf.js` 补「有 Origin 时必须等于 Host」。

**验收**：`curl 127.0.0.1:3801/api/sessions`（无 cookie/token）→ 401；WebView 正常；SSE 正常；桌面 `npm start` 缺省**不再零配置**——令牌自动生成并在启动日志打印 `GET /?token=` 地址（`AGENTLRAY_NO_AUTH=1` 可显式关闭，见 §13.1）。

**成本/风险**：1.5 天。风险：桌面开发体验受影响 → 提供显式关闭开关并写文档；token 不能进日志（`lib/logging.js` 脱敏需覆盖）。

---

## 4. 模块 D：失败可解释（用户能看懂并自救）

### D-1 系统网络阻断与 DNS 变化的可观测性（P1）

**上游证据**：
- `app/android/.../runtime/NetworkAccess.kt`：`onBlockedStatusChanged` → 一行日志「the system blocked this app's network」；启动时打印 `policyLine(batteryExempt, dataSaverStatus, notifications)`。
- `RuntimeController.refreshDns()`：默认网络变化时**重写 guest `/etc/resolv.conf`**；`DnsConfigLog` 只记 `ns1=`/`errno=`、去重、不记主机名。

**现状**：
- `android/.../ResolvConf.kt` 只在 `spawnAndAwait()` 调一次（`NodeRuntimeManager.kt:110`）→ Wi-Fi→蜂窝后 guest 用旧 DNS，表现为 `EAI_AGAIN`。
- 无 `onBlockedStatusChanged`，系统掐网时 guest 只看到超时。

**动作**：
1. `registerDefaultNetworkCallback` → `onLinkPropertiesChanged` 时重写 `resolv.conf`（加 `source=start|network` 日志、去重）。
2. `onBlockedStatusChanged` → 写 `RuntimeLogRing`；`/api/mode` capabilities 增 `networkBlocked`，前端顶部横幅提示。
3. 启动时打印 `policyLine`（电池优化豁免 / Data Saver / 通知权限）。

**验收**：Wi-Fi→4G 后 logcat 出现 `resolv.conf: source=network`；guest 内 `getent hosts dsh.r2049.cn` 成功；开启 Data Saver 时错误屏出现「系统阻断网络」。

**成本/风险**：1 天。风险：`resolv.conf` 写入与 spawn 并发（用现有 `@Synchronized`/串行 executor 保证）。

---

### D-2 首启进度可见（P1）

**上游证据**：`docs/design/onboarding-parallel-setup.md`（底部固定玻璃胶囊 `◔ 运行环境 42%`、点开是进度/剩余时间/日志/失败三动作）；`docs/design/runtime-cold-start.md`（原生与 UI 并行拉起引擎，App 侧 490ms→160ms）。

**现状**：`android/www/index.html` 只有一行「正在启动本地薄服务…」；`RootfsInstaller` 已记录条目数与耗时（`logger()`），**数据在但没送到 UI**。

**动作**：
1. `RootfsInstaller` 每 N 条目回调 `(done, total)` → 原生注入占位页（`loadUrl("javascript:setProgress(...)")`）。
2. 占位页显示百分比 + 剩余时间估算（已解压字节/总字节 × 实测速率）。
3. 失败态给三动作：重试 / 查看日志 / 清除运行时重装。

**验收**：首启可见百分比与剩余时间；失败时三个按钮均可用。

**成本/风险**：1 天。风险：WebView 未加载完成时注入无效 → 用轮询兜底。

---

## 5. 模块 E：SSH 传输（分众，P2）

> 当前 Android 首版关闭（`AGENTLRAY_DISABLE_SSH=1`），桌面 thin 可用。以下为放开或改进的前置项。

### E-1 Host key 显式确认（P2）

**上游证据**：`ssh_link.dart` `checkHostKey` 三态 `trusted/unknown/mismatch`；unknown → UI 弹指纹 → 用户确认才 pin；mismatch fail-closed；`fetchHostKey` 用「假密码 + 验证器返回 false」只读指纹、**不发送凭据**。

**现状**：`lib/transport.js:50` 用 `StrictHostKeyChecking=accept-new` —— 首次静默信任，等于放弃中间人防护。

**动作**：首次连接展示指纹（`ssh-keyscan` 或解析 stderr）→ 用户确认 → 写入 `known_hosts`；变化时拒绝并提示。

**验收**：首次连接弹指纹；改动 `known_hosts` 中记录后连接失败。

**成本/风险**：1 天。风险：非交互场景（CLI 自动连接）需保留 `accept-new` 作为显式开关。

---

### E-2 SSH 远端自举（P2，按需）

**上游证据**：`app/lib/remote/ssh/remote_bootstrap.dart`——`~/.dsh-app-remote/{web.pid,web.log,web.cmd}`（`umask 077` + `chmod 700`）；`nohup <cmd> --host 127.0.0.1 --port 0 --no-open`；从日志抓 `?token=`；pid 用 `/proc/PID/stat` 第 22 字段（进程启动时间）绑定防复用；`DSHAPP ` 前缀防 banner 污染；`web.cmd` 变化才重启。

**现状**：`lib/hosts.js` 假定远端 AgentLRay 已在跑，无自举。

**动作**：仅在「远端不一定常驻服务」场景做（如用户希望手机连上即启动远端实例）。**先确认产品是否需要**，否则不做。

**验收**：远端无服务时，连接后自动启动并可复用；断开重连不重启远端服务。

**成本/风险**：2–3 天。风险：远端副作用（启动进程）需用户明确知情。

---

### E-3 Android 放开 SSH 传输（P2）

**现状**：`AGENTLRAY_DISABLE_SSH=1` 三重守卫（`lib/hosts.js`）；rootfs 未装 `openssh-client`。

**动作**：rootfs 加 `openssh-client`；放开守卫；`/api/mode` 的 `transports` 增 `ssh`。依赖 E-1 先完成。

**验收**：Android 新建主机可选 ssh；首次连接弹指纹。

**成本/风险**：1 天（含 rootfs 体积 +~10MB）。风险：密码认证无实现（`design-ssh-password.zh-CN.md` 未实现），首版只支持私钥。

---

## 6. 模块 F：升级不丢配置（P2）

### F-1 app-bundle 事务化替换（P2）

**上游证据**：`EngineUpgrade.kt`——`app.prepare → app.upgrade` journal → 逐条 rename → `app.done`；`recover()` 幂等、跨 APK 版本可续。

**现状**：`RootfsInstaller.extractLayer` 是 `tmp → 校验哨兵 → deleteRecursively(target) → renameTo`；中断在删除与 rename 之间 → 靠哨兵自愈 = 全量重解（app-bundle 5.1MB 每版本必变）。

**动作**：先只对 app-bundle 实现事务化（rootfs 保持现状）；`app.prepare/app.upgrade/app.done` + 启动前 `recover()`。

**验收**：解压中途杀进程 → 重启后不重解、直接完成（日志 `app upgrade recovered`）。

**成本/风险**：1.5 天。风险：journal 状态机需覆盖「新 APK 版本恢复旧事务」。

---

### F-2 rootfs 引擎层白名单 + baseId（P2）

**上游证据**：`EngineUpgrade.kt:15` 的 15 条 `ENGINE_PATHS`；`rtbuild.py:44` `baseId = sha256([abi, base_sha, deb_shas, python_sha])`（不含 DSH/Node/patch/时间）。

**现状**：`RootfsInstaller.buildVersionTag()` = `versionName-versionCode-abi`，版本一变即整体重建 → rootfs 内用户装的包（如未来 `openssh-client`）与配置丢失。

**动作**：rootfs 内写 `baseId`；manifest 与 `baseId` 一致时只换 `opt/agentlray` + `usr/local/bin/node` 等白名单路径；不一致才整体重建。

**验收**：只改 `versionName` 时 rootfs 目录 mtime 不变、用户 apt 包保留。

**成本/风险**：2 天。风险：路径白名单需与打包脚本保持一致（单一真源）。

---

## 7. 模块 G：发布与自更新（P3，用户影响间接）

### G-1 构建号自动生成（P3）

**上游证据**：`docs/release.md`「构建号」——`versionCode` 由构建时间生成（`10251234`），脚本强制；`apksigner verify` v1/v2/v3 全 `true` + 证书 SHA-256 与上一版一致，失败不产出 `dist/`。

**现状**：`android/android/app/build.gradle` 手写 `versionCode 2` / `versionName "0.1.1"`；`build-apk.sh` 不注入构建号。

**动作**：`build-apk.sh` 按构建时间（或 `git rev-list --count`）生成 `-PversionCode`；发布前固定 `apksigner verify` 检查清单。

**验收**：连续两次构建 versionCode 递增；签名检查失败时不产出产物。

**成本/风险**：0.5 天。

---

### G-2 增量更新 / 自更新（P3，按需）

**上游证据**：`docs/design/delta-update.md`（`DSHDLT01` COPY/DATA/END，只发 <60% 的补丁，先自应用验 SHA-256）、`self-update-installation.md`（回执 journal、不自动重试、不重建路径）。

**判定**：**当前不做**。企业内网/MDM 分发，96MB 整包走内网；补丁链维护成本远超收益。记录为设计输入。

---

## 8. 模块 H：工程化与门禁（P3，统一降级）

> 以下来自上一份对标分析，对用户不可见，但与功能修复的「可回归性」相关。功能批次完成后集中做。

### H-1 生成物 / 借码漂移检查进 CI（P3）

**上游证据**：`sdk/plugin-kit/scripts/sync-bridge.mjs --check` + `git diff --exit-code`；`.github/workflows/ci.yml` 的「Generated files are in sync」步骤；`docs/LOCAL_VS_CI.md` 的三态约定（`–` 不等于 `✓`）。

**现状**：`scripts/build-diagnostics.mjs` 已有 `--check` 且 `test/inspect.test.js:278` 会跑；但 `.github/workflows/` 只有 `pages.yml`，**无 PR 测试 CI**。`scripts/claims-receipts.mjs` 头注释声称有 `claims.yml`，实际不存在。

**动作**：
1. 新增 `.github/workflows/test.yml`：`npm ci` → `npm test` → `build:ui` → `build-diagnostics --check` → claims 复算 → `git diff --exit-code`。
2. `dorny/paths-filter` 按改动面分流（前端 / 后端 / dsh vendor / 文档）。
3. 修正 `claims-receipts.mjs` 头注释或补 `claims.yml`（二选一）。
4. `AGENTS.md` 增「本机 vs CI」一节（借鉴 `docs/LOCAL_VS_CI.md` 表格与三态）。

**验收**：故意改生成物不重新生成 → CI 红；故意改 `vendor/src` 不更新 pins → CI 红。

---

### H-2 借码层补丁 pin（P3）

**上游证据**：`runtime/patches/pins.json` 的 `before`/`after` sha256；`build-runtime.sh` 应用前校验 `before`，不匹配即失败；补丁文件名 `z` 前缀控制顺序。

**现状**：`lib/dsh/vendor/README.md` 记录了上游 commit 与裁剪清单，但无哈希清单、无「应用/校验」脚本、无「上游升级时哪些补丁可撤」的矩阵。

**动作**：新增 `lib/dsh/vendor/pins.json`（**只钉 `src/`**）+ `scripts/verify-vendor.mjs`（`--check`）；`dist/` 用「重编译 + `git diff --exit-code`」而非哈希。

**验收**：手改 `vendor/src` 未登记 → CI 红。

---

### H-3 适配器契约机器化（P3）

**上游证据**：`sdk/plugin-kit/schema/*.schema.json`、`lib/check.js` 复用真实解析器、JSON Pointer 错误、退出码语义（0/1/2/3）、双语 `WORDS`。

**现状**：`lib/platforms/loader.js` 的 `validateAdapter()` 已复用真实加载器（做对了），但无 schema 文件、错误是中文自然语言、无字段路径、`bin/platform.js validate` 退出码只有 0/1。

**动作**：`schema/platform-adapter.schema.json` + 错误对象增 `{code, path, message}`；文档字段表由 schema 生成或 CI 校验一致。

**验收**：`agentlray platform validate` 对缺字段适配器给出 `{code:'platform.adapter.missingFunction', path:'/getSession'}`。

---

### H-4 构建可复现（P3）

**上游证据**：`runtime/build-runtime.sh` 的 gpgv → `Packages.xz` → deb 哈希链 + `locks/*.json` + `runtimeVersion = hash(所有输入)`。

**现状**：`android/scripts/build-rootfs.sh` 直接 `debootstrap` + `apt-get`，无锁文件、无签名校验链、无输入哈希 → 两次构建不可比。

**动作**：deb 锁文件 + SHA256SUMS pin 比对；manifest 增 `inputsSha256` 作为 `runtimeVersion` 组成部分。

**验收**：同输入两次构建 `runtimeVersion` 相同。

---

### H-5 契约文档层（P3）

**上游证据**：`docs/maintenance/*-contract.md`（40+ 篇）——「基底 commit + 不变量 + 边界（不覆盖什么）+ 反证清单 + 未验证」。

**现状**：`docs/design/` 设计文档质量好，但缺「某个具体并发/竞态不变量」粒度。

**动作**：`docs/maintenance/` 下按 `<问题>-contract.md` 记录；首篇 `ensure-single-flight-contract.md`（对应已修的 `RootfsInstaller.ensure()` 双跑竞态）。

---

## 9. 明确不借鉴

| 项 | 理由 |
| --- | --- |
| WebRTC / P2P / TURN 多阶段回退 | 需引入 `werift` 栈；中继满足主场景；上游自己也承认「模拟器成功不能代替真机跨网验收」 |
| 插件体系（贡献点 / 市场 / 签名校验） | 我们的「平台适配器」是日志解析器，不是 UI 注入运行时；信任模型相反 |
| 手机操控 / 无障碍 overlay | 与「读日志看板」定位无关 |
| 自更新 + Shizuku/ADB privileged 安装 | 企业内网分发，`PackageInstaller` 默认路径足够；引入会增加权限面而不增可靠性 |
| 安全模式 + LKG + 插件 profile 回滚 | 无插件系统；薄服务失败面只有「隧道/DNS/端口/版本」 |
| Flutter golden / MethodChannel / APK flavor | 我们是 PRoot + WebView 套壳，无 Flutter 渲染层 |
| 81KB 多上游版本补丁矩阵 | 只跟踪一个 commit 时是过度设计 |
| `DirectLaunch`（绕开 proot） | 薄服务无启动放大；seccomp 风险与 Android 版本强相关 |
| i18n 增量 / ARB 体系 | 当前中文为主；若出海再按「输入 + 生成 + CI 校验」三件套做 |

---

## 10. 实施顺序（按用户影响）

### 批次一：网络稳定性与数据不丢（P0，约 5–6 天）✅ 已实现

1. **A-1** 链路状态机 + 错误分类 ✅
2. **A-2** 假 connected 探测 + 保活 ✅
3. **A-3** 断线重连退避 ✅
4. **B-1** SSE 断线补拉 ✅
5. **C-1** 本机鉴权 ✅（按计划独立分支原意拆开评审；本次落在同一分支，便于端到端验证）

> 批次一的四项（A-1/A-2/A-3/B-1）共用同一套状态与探测，建议同一分支完成；C-1 独立分支。
> **验收**：断网/切网/杀链路三类场景全部自动恢复；期间写入的消息不丢；未鉴权请求 401。

### 批次二：体验与自救（P1，约 3–4 天）✅ 已实现

1. **A-4** 网络切换触发重连 ✅（壳上报 `/api/network/status` → 服务端统一 kick）
2. **A-5** 稳定本地端口 ✅（ssh / dsh loopback 复用期望端口，占用时回退）
3. **A-6** 身份 pin 的 UI 入口 ✅（占位页 + 主机弹框的「忘记此主机」，二次确认）
4. **D-1** 系统网络阻断 + DNS 随网变化 ✅（`NetworkWatch` + `networkBlocked` 横幅 + 启动策略行）
5. **D-2** 首启进度可见 ✅（解压进度注入占位页；失败态三动作）

> **验收状态**：切网 ≤5s 恢复由服务端 kick（立即探活 + 跳过退避）保证，Node 侧有自动化用例；
> Android 真机断网/切网未在本机实测（无 SDK/gradle 环境），见 §13.2 偏差。

### 批次三：分众与升级（P2，约 4–5 天）

1. **E-1** Host key 显式确认
2. **F-1** app-bundle 事务化
3. **F-2** rootfs 引擎层白名单
4. **E-3** Android 放开 SSH（依赖 E-1）
5. **E-2** SSH 远端自举（先确认产品需求）

### 批次四：工程化（P3，功能批次完成后）

1. **H-1** CI 门禁
2. **H-2** vendor pin
3. **H-4** 构建可复现
4. **H-3** 适配器 schema
5. **H-5** 契约文档
6. **G-1** 构建号自动生成

---

## 11. 与既有文档的关系

| 文档 | 关系 |
| --- | --- |
| `docs/.local/analysis-plugharness-go-benchmark.zh-CN.md`（过程稿，未随代码提交） | 上游证据与逐条论证的**详细来源**；本文是其**按模块重排 + 功能优先**的实施清单 |
| [design-android-mobile-app.zh-CN.md](../design/design-android-mobile-app.zh-CN.md) | 本文 A-4/C-1/D-1/D-2/E-3/F-1/F-2 均为其 §5/§7/§11 的细化落地 |
| [design-dsh-host-connection.zh-CN.md](../design/design-dsh-host-connection.zh-CN.md) | 本文 A-1/A-2/A-6 的协议基础 |
| [design-multi-host.zh-CN.md](../design/design-multi-host.zh-CN.md) | 本文 A-5/B-1 的宿主层基础 |
| [design-inbound-peers.zh-CN.md](../design/design-inbound-peers.zh-CN.md) | 本文 A-2 的心跳语义参考 |
| `docs/.local/design-ssh-password.zh-CN.md`（过程稿，未随代码提交） | E-3 放开 SSH 时的密码认证前置（未实现） |

---

## 12. 证据索引（AgentLRay 侧改动前基线；实施结果见 §13）

| 主题 | 文件 | 关键行 |
| --- | --- | --- |
| 主机状态机 | `lib/hosts.js` | runtime entry `status/error`；`tunnelAndProbe` / `dshTunnelAndProbe` |
| 隧道构造 | `lib/transport.js` | `buildSshArgs`（`ServerAlive*`、`accept-new`）、`findFreePort` |
| dsh 客户端 | `lib/dsh/client.js` | `openDshTunnel`、身份 pin、`forceRelay` |
| dsh 被连接方 | `lib/dsh/host.js` | `startDshHostService`、`PEER_SYNC_INTERVAL_MS` |
| loopback | `lib/dsh/loopback-client.js` / `loopback.js` | 随机端口、`toForwardHeaders` |
| 网关转发 | `lib/routes/proxy.js` | `LOCAL_ONLY_RE`、`proxyTo` |
| CSRF | `lib/csrf.js` | 无 Origin 放行 |
| SSE | `lib/platforms/shared/watch.js` | `: ping` 15s、无 `id:` |
| SSE 前端 | `frontend/src/views/sessions/useSessionSse.ts` | `error` 仅置状态 |
| 主机状态展示 | `frontend/src/lib/host-status.ts` | 四态映射 |
| Android 运行时 | `android/android/app/src/main/java/com/agentlray/app/{App,MainActivity,NodeRuntimeManager,RootfsInstaller,ResolvConf}.kt` | 生命周期、spawn、解压、DNS |
| 占位页 | `android/www/index.html` | 单行启动提示 |
| 版本标记 | `android/android/app/build.gradle` | `versionCode 2` 手写 |
| 生成物 | `scripts/build-diagnostics.mjs`、`lib/generated/diagnostics.cjs` | `--check` 已有，CI 未接 |
| CI | `.github/workflows/pages.yml` | 唯一 workflow |
| 公开数字 | `claims.json`、`scripts/claims-receipts.mjs` | 头注释声称的 `claims.yml` 不存在 |

---

## 13. 实施进度与代码证据（批次一）

> 分支 `fix/dsh-review-2026-11-22`；验证（2026-11-22 复审修复后）：`npm test` 878 项 / 37 suites 全通过（含新增 4 个测试文件）、`tsc -b frontend` 与 `npm run build:ui` 通过、真实服务鉴权冒烟（无令牌 401 / 带令牌 200 / `?token=` 302+cookie 200 / 未知远端 id 401）。
> `npm run lint` 在本机因 Biome 二进制依赖 GLIBC ≥ 2.29 无法运行（环境限制，非代码问题），提交前请在 CI/本地兼容环境补跑。

| 编号 | 状态 | 代码证据 | 测试证据 |
| --- | --- | --- | --- |
| A-1 链路状态机 + 错误分类 | ✅ 已实现 | `lib/dsh/errors.js`（9 个稳定码 + `retryable` + `linkError/normalizeLinkError`，消息/errno 规则单一真源）；`lib/hosts.js` `createEntry/setPhase/PHASE_STATUS`（phase `connecting/connected/reconnecting/failed/disconnected`，`status` 保留旧字符串）；`lib/dsh/client.js` 为自环/不可见/非主机/密钥变化/离线挂稳定码；`lib/routes/hosts.js` `publicHost` 增 `phase/errorCode/errorRetryable/attempt/nextRetryAt`，`error` 仍为字符串；前端 `api/types.ts`、`lib/host-status.ts`（五态 + 错误码文案/建议）、`HostConnectingView.tsx`、`HostsDialog.tsx`、`store.ts`（`hostErrorCode/hostReadyErrorCode/hostReadyErrorRetryable`）。 | `test/hosts-reconnect.test.js`（错误分类/可重试性） |
| A-2 假 connected 探测 + 保活 | ✅ 已实现 | `lib/hosts.js` `startHealthProbe/healthTick`：每 15s `GET baseUrl/api/version`（`AGENTLRAY_HOST_PROBE_MS` 可调，默认 15s；单次超时 3s），连续 2 次失败 → `linkLost` → `reconnecting`；`markConnected` 启动探测、`closeHost`/`closeTunnelResources` 清理定时器（`unref`，不阻止进程退出）。 | `test/hosts-reconnect.test.js`「探活判死 → reconnecting → 自动重连恢复」 |
| A-3 断线重连退避 | ✅ 已实现（复审后修复「退避形同固定」） | `lib/hosts.js` `backoffDelay`（1→2→4→8→15→30→60s，±20% 抖动，无限重试；`AGENTLRAY_HOST_BACKOFF_MS` 可调）、`scheduleReconnect/reconnectNow/cancelReconnect`；`openHost` 手动连接取消退避并归零；不可重试错误（`KEY_CHANGED/DSH_AUTH_REQUIRED/...`）直接 `failed` 不重连。**跨 entry 继承**：`createEntry(id, prev)` 承接 `attempt/reconnectFn`，`tunnelAndProbe`/`dshTunnelAndProbe`/`finalizeFailure` 在重连路径传 `prev`，使指数退避真正生效；`nextRetryAt` 统一为 **epoch ms**（与 `api/types.ts` 的 `number` 一致）。前端：`useHostStatePoller`（占位页可见期间 2s 轮询 `GET /api/hosts`）把 `reconnecting → connected` 收敛为页面就绪；**薄服务失败不置 `hostReady`**（`store.ts` `setHostLinkFailed`），`App.tsx` 保持占位页并交给轮询 + `adoptThinHost` 收敛；占位页「重试连接」幂等守卫改为 `id === cur && hostReady`。 | `test/hosts-reconnect.test.js`「真实重连路径：每次重连都新建 entry，但 attempt 必须接续递增（指数退避生效）」（attempt 序列 `[1,2,3,4]`）、「不可重试失败（KEY_CHANGED）在重连途中终止循环」、「closeHost：健康探测与重连定时器都被清理」 |
| B-1 SSE 断线补拉 | ✅ 已实现（复审后补齐元数据与 401 处理） | `lib/platforms/shared/watch.js`：`sseInit` 写 `id: <byteOffset>`；`resumeOffset` 读 `?after=` 或 `Last-Event-ID`；续读跳过全量基线、连接后立即补发断线批次，且补发事件的 `session` 携带本批次解析出的元数据与 `status`（含显式结束标记 `noteEnded`+`resolveAllPending`）；`after=0` 视为全量基线；文件轮转/截断（偏移 > 当前大小）回落全量基线。前端 `useSessionSse.ts`：记录 `lastEventId`、断线主动关闭并按 1s→15s 退避重连（带 `after`）、按消息 id 去重、重连成功后 invalidate 对账；**重连前 `probeAuth()`**（fetch 只看 status）区分三态：401 且 `cachedUiToken()` 仍在 → 自动 `/?token=<缓存>&next=<当前路径>` 重新兑换 cookie（不清缓存）；cookie 与缓存皆无才停止重连并回调 `onAuthLost`（`SessionsView` 提示重新打开页面）；`api/client.ts` `watchUrl` 增 `after`。 | `test/watch-resume.test.js`（断线写 3 条 → 重连只补 3 条不重复、`Last-Event-ID` 等价、截断回落、`after=0` 不补发全量） |
| C-1 本机令牌鉴权 | ✅ 已实现（复审后语义收紧） | `lib/auth.js`：**按请求目标判定**——`LOCAL_ONLY_RE`（`hosts/inbound/dsh/mode`）恒需令牌，`targetHostId(req)`=`X-Host-Id` > `?host=` > `local`，local 需令牌，已配置远端目标放行（链路认证：ssh 私钥 / dsh 设备身份），未知 id fail-closed；`resolveUiToken()` env `AGENTLRAY_UI_TOKEN` 优先、否则读/生成 `~/.agentlray/ui-token`（0600，tmp+rename）；`AGENTLRAY_NO_AUTH=1` 才关闭（缺省启用）。`apiAuthGuard({token,isRemoteHost})` 为 async 中间件，挂在 `mountProxyRoutes` 之前；隧道可信标记 `X-AgentLRay-Tunnel`=`tunnelSecret()`（`lib/tunnel-headers.js`，进程内随机、不落盘、出站剥除）使 dsh 入站免令牌。`proxy.js` 转发前剥除 `x-agentlray-token`/`cookie`/隧道头；`lib/hosts.js reportPeer` 不再发令牌。`server.js`/`bin/thin-server.js` 启动打印 `/?token=` 地址。Android：`NodeRuntimeManager.kt` 令牌持久化 `filesDir/ui-token`、`MainActivity.kt` 记录已兑换令牌避免重复导航。 | `test/local-auth.test.js`（令牌生成/0600/复用、`requiresLocalToken` async 矩阵、远端目标非 401、`/api/hosts` 带远端头仍 401、伪造隧道密钥 401、自动生成令牌端到端、`NO_AUTH=1` 关闭）；`test/dsh-transport.test.js`（loopback 宿主注入 `TUNNEL_HEADER`；真实 app 挂 unix socket 时 loopback 请求 200、同 app 的 TCP 端口仍 401）；`test/inbound-socket.test.js`（socket/目录权限、socket 免令牌而 TCP 401、陈旧 socket 清理与占用拒绝、`/api/version` 通告路径、streamlocal 参数）；`test/local-auth.test.js`（长效 cookie 的 `Max-Age`/`Expires`、302 到 `/#token=`、头与 cookie 任一有效即放行） |

### 13.1 与计划的偏差与后续

- **A-1 的「错误分类」不做错误码翻译层**：对外仍是中文 `error` 字符串 + 稳定 `errorCode`，前端按码给建议文案；历史消费方零改动。
- **鉴权语义（2026-11-22 复审拍板）**：令牌只保护**本机直连**。远端目标放行、由链路认证保护——本机 cookie 对远端无意义，若在 proxy 转发前校验本机令牌，会同时把本机 cookie 泄给远端。每主机独立令牌方案已被否。
- **ssh 入站：信任锚下移到传输层，接收方 0 配置**（2026-11-22 二次复审）。`ssh -L` 到 TCP 端口后请求源就是 127.0.0.1，HTTP 层的任何「连接方自证」（上报密钥 / challenge）本机任意进程都能走一遍，等于关掉令牌——已废弃该草案。现方案：`lib/inbound-socket.js` 在 `~/.agentlray/inbound.sock`（0600/目录 0700）上再听同一个 app，能连上的即同用户进程（内核按文件权限判定）；路径经公开 `/api/version.inboundSocket` 与 dsh `harness.transport.describe.inboundSocket` 通告，连接方 ssh 先建 TCP 隧道读 `/api/version` 再改走 `ssh -L <port>:<远端 socket>`，dsh 直接把 loopback 目标设为该路径；取不到路径退回 TCP。
- **`AGENTLRAY_NO_AUTH=1` 成为测试/脚本基线**：`test/helpers.js` 的 `serverEnv()` 默认关闭鉴权（`AGENTLRAY_UI_TOKEN: ''`），直接 `spawn(server.js)` 的 4 处测试也显式带上；`scripts/build-demo-fixtures.mjs` 同。桌面 `npm start` 不再零配置——令牌缺省自动生成并打印 `/?token=` 地址。
- **`nextRetryAt` 为 epoch ms**（原先误用 ISO 字符串，与前端 `number` 类型不符）。
- **令牌缓存长效化（2026-11-22）**：cookie 原为会话级（无 `Max-Age`，浏览器/WebView 重启即丢，Android 侧还会因 `exchangedToken` 已持久化而不再重新导航 → 永久 401）。现改为一年长效 cookie（同名同 `Path` 自动覆盖），302 目标改为 `/#token=<t>`（fragment 不进服务端日志），前端 `frontend/src/api/ui-token.ts` 把令牌写入 `localStorage` 并在每个同源请求附 `X-AgentLRay-Token`，新令牌自动覆盖旧缓存；`requestTokens` 同时接受头与 cookie（任一有效即放行），旧缓存不会顶掉新 cookie。Android 在导航后与 `onStop` 调 `CookieManager.flush()` 保证 cookie 落盘。
- **A-6（删除信任记录的 UI 入口）已在批次二补齐**：`KEY_CHANGED` 现在在连接占位页与主机弹框提供「忘记此主机」（二次确认，清 client/probe 两个信任库），见 §13.2。
- **C-1 在 Android 上需重新打包 APK 才能生效**（原生侧生成/持久化令牌）；Web 桌面端行为已变：未配置令牌时自动生成并要求本机带令牌（`AGENTLRAY_NO_AUTH=1` 可显式关闭）。
- **未做真机/断网实测**：A-1～A-3 用 mock 远端 + 毫秒级探活/退避验证状态迁移；B-1 用真实 SSE 服务验证补拉；C-1 用真实服务验证 401/放行。断网/切网真机场景留待批次二 A-4 一并联调。

### 13.2 批次二实施进度（体验与自救）

> 验证（2026-11-22）：`npm test` **891 项 / 37 suites 全通过**（批次一基线 878 + 新增 13）、`npx tsc -b frontend` 与 `npm run build:ui` 通过。
> **Android（Kotlin）改动已本机编译通过**（`gradle --offline :app:compileDebugKotlin`，JDK 21 / Gradle 8.11 / SDK 35）；**未做真机冒烟**（无设备），见 §13.2 待验证清单。

| 编号 | 状态 | 代码证据 | 测试证据 |
| --- | --- | --- | --- |
| A-4 网络切换触发重连 | ✅ 已实现 | `lib/hosts.js` `kickHost`（connected → 立即探活，5s 超时 `AGENTLRAY_HOST_KICK_TIMEOUT_MS`；失败 `linkLost` 后 `kickReconnectNow` 清掉 `reconnectTimer/nextRetryAt` 立即重连；`reconnecting/failed+retryable` → 跳过退避）、`kickAllHosts`；`lib/routes/hosts.js` `POST /api/hosts/:id/kick`；`lib/routes/network.js` `POST/GET /api/network/status`（transport 白名单、`dnsChanged \|\| transportChanged` → `kickAllHosts`）；`lib/auth.js` `LOCAL_ONLY_RE` 增 `/network`（proxy 同源 403）；`server.js` 与 `bin/thin-server.js` 均挂载。Android `NetworkWatch.kt`：`registerDefaultNetworkCallback` → `POST /api/network/status`（带 `X-AgentLRay-Token`），运行时就绪后 `reportCurrent()` 补报。 | `test/hosts-batch2.test.js`「A-4 kick：链路健康时只探活」「链路已死时跳过 60s 退避立即重连」（<2.5s 断言）「kickAllHosts」「未运行主机不建链」；「D-1 路由：POST /api/network/status 首次上报不 kick，切网 / DNS 变化触发 kickAllHosts」 |
| A-5 稳定本地端口 | ✅ 已实现 | `lib/transport.js` `isPortFree/pickLocalPort`（期望端口可用则复用，否则 `findFreePort` 回退）；`lib/hosts.js` `createEntry(id, prev)` 继承 `localPort`，ssh `launch` 用 `pickLocalPort(entry.localPort)`，dsh `openDshTunnel({ localPort })` 并回写实际端口；`lib/dsh/client.js` 透传 `localPort` 并返回 `localPort`；`lib/dsh/loopback-client.js` `createLoopbackEndpoint(..., { localPort })` 优先监听期望端口，占用时回退随机一次。 | `test/hosts-batch2.test.js`「A-5 pickLocalPort：复用空闲期望端口 / 占用回退」「loopback 端点复用期望端口，被占用回退且不报错」「ssh 重连前后 `baseUrl` 不变（真实 ssh-mock + 杀链路 + kick）」 |
| A-6 身份 pin 的 UI 入口 | ✅ 已实现 | `lib/hosts.js` `forgetHostTrust(id)`（仅 dsh；对 `client` 与 `probe` 两个身份库 `loadPeers → revokePeer`，返回 `{id, deviceId, removed}`；`not-found`/`unsupported`）；`lib/routes/hosts.js` `DELETE /api/hosts/:id/trust`（404/400/500 映射 + 写操作日志只记动作与 id）；前端 `api/client.ts` `forgetHostTrust`；`HostConnectingView.tsx`（`KEY_CHANGED` → 二次确认「确认清除并重连」）；`HostsDialog.tsx`（行内「忘记此主机」，`window.confirm` 二次确认）。 | `test/hosts-batch2.test.js`「forgetHostTrust：清除 client/probe 钉扎」「未知主机 not-found、ssh 主机 unsupported」「路由：DELETE /api/hosts/:id/trust」 |
| D-1 系统网络阻断与 DNS 变化 | ✅ 已实现 | Android `NetworkWatch.kt`：`onAvailable/onLost/onLinkPropertiesChanged` → `ResolvConf.apply(source="network")`（内容相同跳过写盘）+ 上报；`onBlockedStatusChanged` → `RuntimeLogRing` + 上报 `blocked`；启动打印 `policyLine`（电池优化豁免 / Data Saver / 通知权限）。`ResolvConf.apply(context, rootfs, source)` 新增来源日志与去重；`NodeRuntimeManager` 注入 `source="start"`。服务端 `lib/routes/mode.js` 薄服务 capabilities 增 `networkBlocked`（由 `/api/network/status` 内存态派生，10 分钟未刷新视为过期，避免壳退出后残留）；前端 `ModeCapabilities` 增字段、新增 `components/NetworkStatusBanner.tsx`（thin 下 15s 轮询，仅 true 且新鲜时显示）、`App.tsx` 挂载。 | `test/thin-android-guards.test.js`「mode capabilities：原生壳上报网络阻断后 networkBlocked=true（D-1）」（含恢复 false 与无上报 null）；`test/hosts-batch2.test.js` network 路由用例 |
| D-2 首启进度可见 | ✅ 已实现 | `RootfsInstaller.kt`：`Progress(layer, entries, bytesDone, bytesTotal, elapsedMs)` + `fraction/etaMs`，`CountingInputStream` 统计压缩字节，每 64 条目或 500ms 回调一次（`bytesTotal` 取 manifest `size`，缺失则降级）；`lastLayout` 供网络回调复用。`App.kt` 写入日志环并转发 `runtime.onProgress`；`MainActivity.kt` `renderProgress` → 占位页 `window.__agentlrayProgress(done,total,etaMs)`；失败弹框改为三动作「重试 / 查看日志（尾部 500 行，可选中复制）/ 清除运行时并重装（删 rootfs+app，保留 `.agentlray` 数据）」；`android/www/index.html` 增进度条与百分比/剩余时间（无总量时只报条目数）。 | `test/thin-android-guards.test.js`「D-2 占位页：`window.__agentlrayProgress` 百分比/剩余时间与无总量降级」（最小 DOM 桩执行页面脚本） |

**Android 侧待验证清单**（Kotlin 已编译通过；需真机/CI 补做）：
- Wi-Fi ↔ 4G 切换后 ≤5s 恢复 `connected`（观察 `NetworkWatch` 日志 `transportChanged=true` 与服务端 `network status` 日志）；
- 公钥变化 → `KEY_CHANGED` → 「忘记此主机」→ 重连成功；
- 首启解压进度百分比/剩余时间显示，以及「清除运行时并重装」自救路径；
- 系统 Data Saver / 后台数据限制下 `blocked=true` 横幅与 `policyLine` 输出。
