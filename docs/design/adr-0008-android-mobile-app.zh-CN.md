# ADR-0008：Android 移动端 App —— PRoot + Ubuntu + Node 承载 dsh-only 薄服务 + Capacitor WebView 套壳

> 类型：决策记录（ADR）　｜　日期：2026-11-21　｜　状态：**proposed（设计收敛，尚未实现）**
> 需求来源：`todo.md` #17「开发移动端 APP，用于远程连接」（ADR-0007 Q5/Q6 的 Android 落地）
> 前置文档：`design-thin-service`（ADR-0007，薄服务已实现）、`design-multi-host`、`design-dsh-host-connection`、`design-dsh-login-methods`
> 方法：`grill-with-docs`（grilling + domain-modeling 收敛，R1–R6）
> 修订：**2026-11-21 R2 承载由 nodejs-mobile 改为 PRoot**（原方案受 Node 18 限制无法运行 dsh 栈，详见 §1.2 修订说明与 §3）

## 1. 背景与问题

ADR-0007 确立了**薄服务（thin service）**：独立进程、只做远程连接、去除系统配置，作为移动端 APP 的 HTTP 后端（Q5），并约定「移动端 Web 起步，后续演进到原生壳 + web 内核」（Q6）。

本 ADR 回答 ADR-0007 Q6 未决的关键问题：**移动端原生壳如何在 Android 上承载薄服务？** 用户诉求：基于 thin 薄终端，开发 Android 移动端 app，原生套壳现有 web 页面。

### 1.1 核心张力

AgentLRay 的设计前提是**读本机 agent 日志**；手机（Android）上没有这些日志。因此 app 必须连**一台别的机器**（跑着完整 AgentLRay 的桌面/服务器）。这与 ADR-0007 的薄服务定位完全一致——**app = 薄服务的 Android 承载**。

### 1.2 可行性约束（grilling R3 发现；2026-11-21 修订）

**原判断（nodejs-mobile，已否决）**：Android 上运行 Node 的成熟方案 nodejs-mobile 不支持 `child_process` / `cluster`，故只能保留纯 JS 的 dsh 隧道。该判断只解决了「SSH 不可用」，但**没有验证 Node 版本**。

**修订后的硬约束（代码核对）**：

| 约束 | 证据 |
| --- | --- |
| dsh vendor 为 ESM，依赖 Node `require(esm)`（≥22.12 默认开启） | `lib/dsh/vendor.js:5-8` |
| vendor 直接 `import '@lukeburns/clatterjs'`（纯 ESM） | `lib/dsh/vendor/dist/crypto/noise.js:5` |
| clatterjs 依赖 `@noble/*` v2.4.0，`engines: node >=20.19.0` | `node_modules/@lukeburns/clatterjs/node_modules/@noble/*/package.json` |
| 传输层使用全局 `WebSocket`（Node 22） | `lib/dsh/vendor/dist/webrtc/adaptive-transport.js:78,553,654` |
| 官方 nodejs-mobile 最新版 **18.20.4**，无法满足上述任一项 | 官方发布记录 |

**结论（修订）**：nodejs-mobile 无法承载 dsh → app 成为空壳。改用 **PRoot** 在 app 私有目录内运行 **Ubuntu + Node 22/24**，直接使用官方 Node 二进制；同时获得真正的子进程 stop/restart 能力。参考开源 Android 客户端 **DSH Go**（AGPL-3.0）的同类实现：PRoot + Ubuntu + Node 24，无需 Root/Termux，Android 8.0+，仅 arm64/x86_64。

## 2. 决策（grill R1–R6 收敛；R2 于 2026-11-21 修订）

### 2.1 形态与拓扑

| 决策点 | 结论 |
| --- | --- |
| **R1 连接对象** | app 经公网或局域网连**远端完整 AgentLRay 实例**（full 模式，自带本地日志的桌面数据源）。 |
| **R1 安全** | **VPN/隧道隔离**（WireGuard / 公司 VPN / dsh 中继加密通道）；2026-11-22 起本机直连额外要求**本机令牌**（§7 D1 已实现），远端链路不再加应用层鉴权。 |
| **R2 承载** | **PRoot + Ubuntu arm64 rootfs + Node 22/24**：在 app 私有目录内以子进程运行 `bin/thin-server.js`，**直接复用现有 thin-server.js + lib/hosts + lib/dsh + lib/routes**，**不重写薄服务逻辑**。 |
| **R2 隧道类型** | **只支持 dsh**（产品裁剪：移动端穿透 NAT 的首选；PRoot 下 SSH 技术上可行，但首版不启用，见 §6）。 |
| **R2 套壳** | **Capacitor**（WebView 托管 + 插件生态），加载本地 `http://127.0.0.1:3801`。 |
| **R3 前端** | 复用同一份 `frontend/dist`，随 app bundle 解压到 `filesDir`，由本地薄服务 serve。 |

### 2.2 App 形态（极简壳）

| 决策点 | 结论 |
| --- | --- |
| **R4 交互面** | app 除启动屏外**不做任何 UI 操作**；**所有操作与查看都在 web 页面内完成**（含主机管理）。 |
| **R4 主机管理** | 复用 web 前端 `HostFormDialog`；Android 下只暴露 **dsh** 传输（deviceId / 中继端口），凭据 **AES-256-GCM 加密落盘**。 |
| **R4 启动** | 原生启动屏 + PRoot/Node 就绪探测（`/api/version`）通过后再加载 WebView；失败显示错误屏与日志。 |
| **R4 后台** | **仅前台**：`onStop` 防抖后停 PRoot 子进程，回前台重建（省电、简单、符合"查看工具"定位）。 |
| **R4 发布** | 签名、加固、崩溃上报；首版按侧载/企业内部分发设计（PRoot + `lib*.so` 与 Play 政策需单独评估）。 |

### 2.3 Android 特有适配点

| 适配点 | 结论 |
| --- | --- |
| **HOME 路径** | 设 `AGENTLRAY_HOME=/home/agentlray`（`lib/config.js:5` 读取的是该变量，**不是 `HOME`**），并 bind 到 `filesDir/.agentlray`；`~/.agentlray` 整体落在 app 私有目录。 |
| **可执行文件** | Android 10+ 禁止从可写目录 `execve`；PRoot/loader 以 `lib*.so` 放入 `jniLibs/<abi>/`，`extractNativeLibs=true`，并验证 16KB page 对齐。 |
| **rootfs / app 分层** | rootfs（Ubuntu + Node）与 app bundle（bin/lib/dist/node_modules/package.json）各带版本标记；持久数据 `.agentlray` 升级不覆盖。 |
| **依赖闭包** | 必须包含 `@lukeburns/clatterjs` 及嵌套 `@noble/*`，以及 `package.json`、`frontend/dist`（`bin/thin-server.js` 硬依赖）。 |
| **进程生命周期** | proot 子进程由 Kotlin `NodeRuntimeManager` 管理：spawn / 健康探测 / SIGTERM / 崩溃退避重启 / 孤儿清理；`proot --kill-on-exit` 兜底。 |
| **能力面裁剪** | `/api/mode` 返回 `capabilities.transports=['dsh']`；前端隐藏 SSH；后端以 `AGENTLRAY_DISABLE_SSH=1` 拒绝。 |
| **dsh 凭据** | 复用 `lib/secret.js` AES-256-GCM，落 app 私有目录。 |

### 2.4 与 ADR-0007 的关系

- **保留**薄服务全部语义：无 `local` 宿主、`/api/mode` 返回 `{mode:'thin'}`、系统配置面 403、dsh 强制 client、前端 thin 裁剪。
- **差异**：首版 Android 只启用 dsh 传输（SSH 为产品裁剪，非技术限制）；承载由「nodejs-mobile 线程」改为「PRoot 子进程」。
- **兼容**：不改变现有完整网关与桌面薄服务行为；Android 薄服务是**同一套代码的第三个承载**（full server / thin server / android thin）。

## 3. 决策理由

- **PRoot 而非 nodejs-mobile**：dsh vendor 的 `require(ESM)`、noble v2 的 `>=20.19`、全局 `WebSocket` 共同要求 Node ≥22.12；官方 nodejs-mobile 停在 18.20.4，无法承载。PRoot + 官方 Node 22/24 一次解决版本问题，也解决 nodejs-mobile 单例线程无法 stop/restart 的生命周期缺陷。
- **PRoot 而非 Kotlin 重写**：dsh 隧道为纯 JS（`lib/dsh/vendor` 约 1008K），Kotlin 重写需移植完整中继协议栈，成本极高且易失真；PRoot 直接复用现有 thin-server 代码，语义完全一致。
- **dsh-only**：dsh 是移动端穿透 NAT 连桌面的关键通道（ADR-0007 Q17）。PRoot 下 `child_process` 可用，SSH 已非技术障碍；首版保持 dsh-only 是产品裁剪（减少密钥管理与 rootfs 体积），后续可按需放开（§6）。
- **Capacitor**：获得生命周期、返回键、插件生态与签名/加固工具链，避免手写原生 WebView；同时用插件桥解决 WebView 的 blob 下载限制。
- **仅前台**：app 定位是"远程查看工具"，无后台刷新/推送需求；避免 Android 后台进程限制与常驻通知。
- **App 不操作 UI**：主机管理、会话查看全部复用现有 web 前端（已有 `HostFormDialog`、多主机、thin 空态），app 层零业务逻辑，最小化维护面。

## 4. 影响与兼容

- **不改变**现有完整网关、桌面薄服务、前端行为——Android 薄服务是新增承载，不影响既有入口。
- **新增**：`android/` 工程（Capacitor + PRoot 运行时管理）、rootfs/app bundle 构建脚本、`jniLibs` 打包、`filesDir` 路径适配；`lib/hosts.js` 的 `AGENTLRAY_DISABLE_SSH` 守卫；`/api/mode` capabilities；前端传输过滤与下载桥接。
- **不再需要**：nodejs-mobile 集成、`transport.js` / `hosts.js` 的惰性 require 改造（PRoot 下 `child_process` 正常）。
- **依赖**：PRoot（GPL-2.0，随包分发需合规确认）、Ubuntu minbase rootfs、官方 Node 22/24 linux-arm64、Capacitor。**不再依赖 nodejs-mobile**。

## 5. 实现进度（代码核对）

**状态：proposed（设计收敛，尚未实现）**

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 方案设计与收敛（grill R1–R6，R2 修订） | ✅ 已完成 | 本文档；[design-android-mobile-app](../.local/design-android-mobile-app.zh-CN.md) |
| P0 运行时/打包/生命周期/能力面/安全基线 | ⬜ 待实现 | — |
| Android 工程搭建（Capacitor + PRoot） | ⬜ 待实现 | — |
| `AGENTLRAY_DISABLE_SSH` 守卫 | ⬜ 待实现 | `lib/hosts.js` |
| `AGENTLRAY_HOME` 重定向到 `filesDir` | ⬜ 待实现 | `lib/config.js:5`（已支持该变量） |
| app bundle 打包（含 `@lukeburns/clatterjs`） | ⬜ 待实现 | `package.json`、`frontend/dist` |
| 私钥 AES 落盘 + 主机表单（dsh 能力裁剪） | ⬜ 待实现 | `lib/secret.js`、`HostFormDialog` |
| 启动屏 + 就绪门控 + 仅前台生命周期 | ⬜ 待实现 | — |
| 签名/加固/崩溃上报 | ⬜ 待实现 | — |
| 本机令牌鉴权 / 接口鉴权 | ✅ 已实现（2026-11-22，见 [design-android-mobile-app](design-android-mobile-app.zh-CN.md) §8.1） | `lib/auth.js`、`NodeRuntimeManager.kt`、`MainActivity.kt` |
| 随机端口 | ⏸ 暂缓 | 见 §7 D3 |

## 6. 开放问题（P0 关闭）

- **Android 10+ exec 限制**：`jniLibs/lib*.so` + `extractNativeLibs=true` 在目标 OEM / API 26/29/33/35 上的实际行为；16KB page 对齐。
- **PRoot 许可证与分发**：GPL-2.0 随包分发的合规路径（独立程序 / 源码提供）；侧载/企业分发 vs Google Play 政策。
- **rootfs 体积与冷启动**：minbase + 官方 Node 的目标体积（150–250 MB）与实际冷启动/内存。
- **Capacitor 加载时序**：`server.url` 与就绪后 `loadUrl` 的取舍。
- **SSH**：PRoot 已具备能力，后续是否放开 `AGENTLRAY_DISABLE_SSH` 并加入 `openssh-client`（产品决策）。

## 7. 暂缓事项（2026-11-21 决定）

> 2026-11-21 决定：token 认证与接口鉴权暂不考虑；端口固定 3801。
> **2026-11-22 更新：本机令牌鉴权已实现**（D1 关闭）；端口仍固定 3801。以下保留原始记录。

| 编号 | 问题 | 当前决定 | 后续建议 |
| --- | --- | --- | --- |
| D1 | Android loopback 非 app 私有，其他应用可访问 `127.0.0.1:3801`；`lib/csrf.js` 对无 Origin 客户端放行 | ✅ 已实现（原生持久化令牌 + env 注入 + `?token=` 兑换 cookie；本机直连校验） | 令牌轮换（可选） |
| D2 | dsh loopback 端点无鉴权（`lib/dsh/loopback-client.js`） | 接受风险 | 内部鉴权头由 `proxy.js` 注入，或改为进程内 RPC |
| D3 | 固定端口 3801 可被抢占 | 固定 3801 | 随机端口 + 稳定 origin，或加载前做服务身份校验 |
| D4 | loopback 明文（无 TLS） | 接受 | 回环风险低；若引入 token，token 不得落在其他应用可读位置 |
| D5 | SSH 传输 | 首版禁用 | 加入 `openssh-client` 并放开开关 |
| D6 | 后台常驻 / 推送 | 不做 | 需要时改 foreground service + 常驻通知 |
| D7 | iOS | 不做 | 另行评估（PRoot 不可用） |
