# Android 移动端 App 完整工程设计方案

> 类型：方案设计　｜　日期：2026-11-21　｜　状态：**部分实现**（仓库侧模块改造 + android/ 工程骨架已落地，P0 静态推断完成、P1–P3 已实现、P4 部分实现；真机验证待做，见 §12）
> 需求来源：`todo.md` #17「开发移动端 APP，用于远程连接」
> 前置：ADR-0008（决策收敛，grill R1–R6；2026-11-21 修订 R2 承载）、`design-thin-service`（ADR-0007，已实现）
> 决策真源：[adr-0008-android-mobile-app.zh-CN.md](adr-0008-android-mobile-app.zh-CN.md)

## 变更记录

| 版本 | 日期 | 变更内容 |
| --- | --- | --- |
| v1.0 | 2026-11-20 | 初稿：nodejs-mobile 承载 dsh-only 薄服务 + Capacitor WebView 套壳。 |
| v1.1 | 2026-11-21 | 评审整改：①承载由 nodejs-mobile 改为 **PRoot + Ubuntu + Node 22/24**（原方案受 Node 18 限制无法运行 dsh 栈）；②补齐打包路径、进程生命周期、能力面、发布合规与测试策略；③token 鉴权 / 接口鉴权 / 固定端口风险记入 §11「暂缓事项」，本期不实现。 |
| v1.2 | 2026-11-22 | **本机令牌鉴权已实现**（C-1）：原生生成 256-bit 令牌并持久化（`filesDir/ui-token`）经 `AGENTLRAY_UI_TOKEN` 注入，WebView 以 `?token=` 兑换 `HttpOnly` cookie；只保护本机直连，远端目标走链路认证。§8.1/§8.2/§11 D1、D4 与 §12 进度同步更新。 |
| v1.2 | 2026-11-21 | 构建实测整改：①debug APK 已在本机产出（JDK21+Gradle8.11+AGP8.7.2+SDK35）；②zstd-jni 无 Android ABI，运行时层改 `.tgz` + 内置 `GZIPInputStream`（偏差②）；③真机首启报「rootfs 内缺少 node」，定位为 `ensure()` 并发竞态（onCreate 后台线程 × onStart 双跑共用 tmp），修复见 §7.1（`@Synchronized` + 哨兵校验 + 自愈）；④资产扩展名取 `.tgz` 因 aapt2 会解压并改写 `assets/**.gz` 名（偏差④）。 |
| v1.3 | 2026-11-21 | 真机二次定位：proot 报 `library "libtalloc.so.2" not found`。根因：Android 8+ bionic linker **忽略 app 进程的 `LD_LIBRARY_PATH`**（安全策略），原注入无效；且 proot 的 `DT_RUNPATH` 指向 Termux 前缀（宿主不存在）。修复：依赖库与 proot 同放 `jniLibs/arm64-v8a/`（nativeLibraryDir），用 patchelf 把 proot 及其依赖的 `DT_RUNPATH` 改为 `${ORIGIN}`（bionic API 24+ 支持），`--replace-needed libtalloc.so.2→libtalloc.so`（jniLibs 只收 `*.so`）；删除 `LD_LIBRARY_PATH` 注入与 `assets/runtime/lib` 拷贝。fetch-proot.sh 已内建 patchelf 步骤。 |
| v1.4 | 2026-11-21 | 真机三次定位：proot 已 LINK 并启动，报 `/usr/bin/env: '<宿主 node 绝对路径>': No such file or directory`。根因：传给 guest 进程的程序路径用了宿主绝对路径（`layout.nodeBin.absolutePath`），proot 的 `-r rootfsDir` 只映射 guest `/`，宿主绝对路径在 guest 里被当 guest 路径解析而失配。修复：新增 `Layout.nodeGuestPath="/usr/local/bin/node"`，`buildCommand` 用 guest 根路径（env/脚本本就是 guest 路径）。§7.1 启动顺序补「guest 程序路径必须用 guest 视角」。 |
| v1.5 | 2026-11-23 | 真机反馈整改：**切后台再回前台 WebView 被刷新回主页**。根因两层：①`onStart → runtime.start()` 在服务已健康时同样回调 `onReady`，壳无条件导航（`7f674da` 起为 `webView.reload()`），每次前后台往返整页重载；②重载后 SPA 状态丢失（会话选择不持久化）。修复（修复 1）：`NodeRuntimeManager.generation` 标记薄服务进程生命周期（新 spawn 递增），壳以 `onPageFinished` 记录「已加载页面 + 对应代号」，回前台满足「页面已加载完成 ∧ 代号一致 ∧ 令牌/cookie 有效」时**纯复用、绝不 reload**；仅在冷启动/服务换代/页面失效时导航，且把当前站内路径作为 `next` 传给令牌兑换，避免 302 后丢会话上下文。§7.1/§7.2 同步更新。 |
| v1.6 | 2026-11-23 | 退后台停服务窗口由 5s 延长到 **5 分钟**，并新增 `RuntimeService`（`foregroundServiceType=specialUse` 前台服务）承担保活——仅拉长定时器无效：cached 进程会被系统整体回收，定时器来不及执行。清单补 `FOREGROUND_SERVICE` / `FOREGROUND_SERVICE_SPECIAL_USE` / `POST_NOTIFICATIONS` 权限与 service 声明（含 Android 14+ 子类型 property）；`onStart`/防抖到期收起前台服务，`onTimeout` 收敛停运行时。§7.2 同步。 |
| v1.7 | 2026-11-23 | 保活机制评审整改（代码走查）：①`NodeRuntimeManager` 的 `userStopped` 在每次 `start()` 清零并重置重启预算——修复「一次主动停止后崩溃永久不自愈」；②防抖状态上移到进程级 `App`，修复「Activity 后台被销毁后前台服务与运行时无人收敛」；③`ThinNavigationPlugin` 新增 `onNavigationStarted`/`onMainFrameError`，配合 `runtime.onExit` 多重作废页面证据——修复「失败导航后误判可复用、跳过重新导航」；④`onTaskRemoved`/服务超时/主动退出改用同步 `stopBlocking`，避免 proot 孤儿；⑤`RuntimeService.start()` 返回布尔并记录后台启动受限，`onCreate` 申请 `POST_NOTIFICATIONS`。§7.2 细化上述实现约束。 |

本文档是 ADR-0008 的**可落地工程蓝图**：把已收敛的决策展开为架构图、工程结构、模块改造、构建打包、生命周期状态机、分阶段实施计划与验收标准。**决策本身以 ADR-0008 为准，本文件只回答"怎么做"。**

---

## 1. 目标与范围

### 1.1 目标

交付一个 Android 原生 app：**极简壳**（启动屏 + WebView），通过 **PRoot** 在 app 私有目录内运行一个 Ubuntu + Node 22/24 环境，承载 dsh-only 的现有 thin-server，连接远端完整 AgentLRay，把现有 web 页面套壳呈现。app 不做任何业务 UI，所有操作与查看都在 web 页面内完成。

### 1.2 范围

**在 app 内实现**：
- PRoot 子进程 + Ubuntu arm64 rootfs + Node 22/24，运行 `bin/thin-server.js`（dsh-only）。
- rootfs / app bundle 的首次解压、版本升级与完整性校验。
- 薄服务进程管理：启动、就绪探测、停止、崩溃重启、孤儿进程清理。
- Capacitor WebView 加载本地 `http://127.0.0.1:3801`。
- 启动屏 + 薄服务就绪门控 + 短时后台保活（退后台 `specialUse` 前台服务保活 5 分钟，超窗即停）。
- 主机表单（dsh deviceId / 中继端口）→ 复用 web 前端 `HostFormDialog`，凭据 AES 落盘。
- 能力面裁剪：Android 模式只暴露 dsh 传输。
- 签名 / 加固 / 崩溃上报（原生 + Node 两侧）。

**不在 app 内实现**：
- 平台解析栈、insights、prompts、search 等数据面（全部由远端 full 实例提供，薄服务转发）。
- 后台常驻 / 推送 / 离线缓存（后续可评估）。
- SSH 隧道（**首版不启用**；PRoot 已具备 `child_process`，ssh 二进制可按需加入 rootfs，属于产品裁剪而非技术限制，见 §5.2）。

### 1.3 非目标（首版明确排除）

- iOS 版本。
- 运行多个薄服务实例 / 后台隧道池（web 前端的**多主机切换**仍保留，见本节末说明）。
- 离线查看 / 本地缓存。
- 应用层鉴权 / 接口 token 的**远端侧**方案（本机令牌鉴权已实现，见 §8.1；远端仍依赖链路认证）。

> **多主机说明**：thin-server 本身支持多台 dsh 主机，web 端 `HostFormDialog` / 主机切换器可直接复用。首版排除的是"多个薄服务进程并存"与"后台常驻隧道池"，不是禁用多主机 UI。

---

## 2. 架构总览

### 2.1 组件图

```mermaid
flowchart TB
    subgraph App["Android App 进程（UI 进程）"]
        Splash["Splash + 错误屏"]
        WebView["Capacitor WebView<br/>加载 http://127.0.0.1:3801"]
        Manager["NodeRuntimeManager<br/>spawn / 健康检查 / SIGTERM / 重启"]
        Installer["RootfsInstaller<br/>assets → filesDir，版本化"]
        LogRing["RuntimeLogRing<br/>stdout/stderr 环形缓冲"]
    end

    subgraph Proot["PRoot 子进程（伪 root，非真实 root）"]
        Rootfs["Ubuntu arm64 rootfs<br/>(glibc + ca-certificates)"]
        Node["node 22/24"]
        Thin["thin-server.js<br/>PORT=3801 HOST=127.0.0.1"]
        Hosts["lib/hosts.js / lib/dsh/*<br/>dsh 隧道（纯 JS）"]
    end

    Data["filesDir/.agentlray<br/>hosts.json / secret / dsh 凭据"]
    Relay["dsh 中继服务器<br/>(默认 dsh.r2049.cn)"]
    Full["远端完整 AgentLRay<br/>full 实例 (PORT 3800)"]

    Installer --> Rootfs
    Manager -- "spawn(proot …)" --> Proot
    Manager --> LogRing
    Splash --> WebView
    WebView -- "HTTP 127.0.0.1:3801" --> Thin
    Thin --> Hosts
    Hosts <-- "ws/wss 加密通道" --> Relay
    Relay <--> Full
    Proot -- "bind mount" --> Data
```

### 2.2 数据流

1. **启动**：`RootfsInstaller` 检查 rootfs / app bundle 版本 → 需要时从 assets 解压到 `filesDir` → `NodeRuntimeManager` 以 `proot` 启动 Node 子进程 → `thin-server.js` 监听 `127.0.0.1:3801` 并异步 `autoConnectThinHost()`。
2. **加载**：轮询 `/api/version` 可达后，WebView 加载 `http://127.0.0.1:3801`；主机是否连上由前端 `HostConnectingView` 呈现（`/api/version` 只代表 HTTP 已就绪）。
3. **请求**：WebView 发 `GET/POST /api/*` 到本地薄服务 → 薄服务按 `X-Host-Id` 选中主机 → `lib/routes/proxy.js` 经 dsh loopback 转发到远端 full 实例 3800 → 返回。
4. **实时**：`/api/watch`（SSE）由薄服务经 dsh loopback 流式透传（`proxy.js` 已支持 SSE 透传；远端有 `: ping` 保活）。
5. **凭据**：主机表单（web 页 `HostFormDialog`）写 `/api/hosts` → 薄服务 `lib/secret.js` AES-256-GCM 加密落盘到 `filesDir/.agentlray/`。

### 2.3 运行时选型：PRoot + Ubuntu + Node，而非 nodejs-mobile

**原方案（nodejs-mobile）已不可行**，根因不是 zstd，而是 dsh 运行时栈的硬版本要求：

| 约束 | 证据 |
| --- | --- |
| vendor 产物为 ESM，依赖 Node 的 `require(esm)`（Node ≥22.12 默认开启） | `lib/dsh/vendor.js:5-8` |
| vendor 直接 `import '@lukeburns/clatterjs'`（纯 ESM，`exports` 仅 `import`） | `lib/dsh/vendor/dist/crypto/noise.js:5` |
| clatterjs 依赖 `@noble/*` v2.4.0，`engines: node >=20.19.0` | `node_modules/@lukeburns/clatterjs/node_modules/@noble/*/package.json` |
| 传输层使用全局 `WebSocket`（Node 22 才有全局实现） | `lib/dsh/vendor/dist/webrtc/adaptive-transport.js:78,553,654` |
| 官方 `nodejs-mobile` 最新版为 **18.20.4**；Node 22 仅有第三方 fork（arm64/x86_64、API 30+、V8 ABI 不兼容 18） | 见 §10 参考 |

**结论**：nodejs-mobile 无法承载 dsh → app 只剩空壳。改用 **PRoot** 在 app 私有目录内运行 Ubuntu + Node 22/24，可直接使用官方 Node 二进制，彻底绕开运行时版本问题；同时获得**真正的子进程生命周期**（可 kill / 重启），解决 nodejs-mobile 单例、无法 stop/restart 的问题。

参考实现：开源 Android 客户端 **DSH Go**（AGPL-3.0）采用同类方案——PRoot + Ubuntu + Node 24 + 应用私有目录，无需 Root/Termux，冷启动约 2.5–3 秒，Android 8.0+，仅 arm64/x86_64。本项目只借鉴架构，不复制其代码。

**nodejs-mobile 作为已否决方案**保留在 ADR 中，不再作为实现路径。

### 2.4 与现有承载的关系

同一套 `lib/*` + `frontend/dist`，三种装配：

- **full**：`server.js`（完整网关，读本机日志）。
- **thin（桌面）**：`bin/thin-server.js`（ssh + dsh 隧道）。
- **thin（Android）**：同一 `bin/thin-server.js`，运行在 PRoot Node 子进程中；首版仅启用 dsh 传输。

### 2.5 进程与线程模型

- UI 进程：Activity / Service / WebView，负责壳与进程管理。
- Node 运行在**独立的 proot 子进程**中，与 UI 进程通过 HTTP（loopback）解耦，无共享内存状态。
- UI 进程被杀时子进程可能成为孤儿：由 pid 文件 + 下次启动清理 + `proot --kill-on-exit` 兜底（见 §7.4）。

---

## 3. Android 工程结构

建议新增独立工程目录 `android/`（不并入现有 npm 包）：

```
android/
├── app/src/main/
│   ├── java/com/agentlray/app/
│   │   ├── MainActivity.kt              # Capacitor BridgeActivity + 启动门控
│   │   ├── NodeRuntimeManager.kt        # proot 子进程：spawn/健康检查/停止/重启
│   │   ├── RootfsInstaller.kt           # assets → filesDir，版本标记与校验
│   │   ├── RuntimeLogRing.kt            # stdout/stderr 环形缓冲（错误屏 + 上报）
│   │   ├── RuntimeWatchdog.kt           # 孤儿进程清理 / 退出重启退避
│   │   └── SecurityConfig.kt            # 备份排除、WebView 加固、明文白名单
│   ├── assets/runtime/
│   │   ├── rootfs-arm64.tgz             # 最小 Ubuntu + Node（随 app 发布）
│   │   └── app-bundle.tgz               # bin/lib/frontend/dist/node_modules/package.json
│   ├── jniLibs/arm64-v8a/
│   │   ├── libproot.so                  # proot 二进制（lib*.so 命名以绕过 Android 10+ exec 限制）
│   │   └── libproot-loader.so           # proot loader
│   ├── res/xml/network_security_config.xml
│   └── AndroidManifest.xml
├── build.gradle
└── scripts/
    ├── build-rootfs.sh                  # debootstrap/debootstrap 最小 rootfs + 官方 Node tarball
    ├── bundle-app.mjs                   # 从仓库收集运行时闭包 → app-bundle
    └── package-runtime.mjs              # 压缩、校验和、版本标记
```

**运行时目录（filesDir，持久化与解压分离）：**

```
filesDir/
├── runtime/            # proot / loader / rootfs（可随 app 版本重建）
│   └── rootfs/
├── app/                # AgentLRay 运行时闭包（每版本解压，可覆盖）
│   ├── package.json
│   ├── bin/thin-server.js
│   ├── lib/**
│   ├── frontend/dist/**
│   └── node_modules/**
└── .agentlray/         # 持久数据（hosts.json / secret / dsh 凭据），升级不覆盖
```

**关键决策**：保留仓库的相对目录层级（`bin/thin-server.js` + `lib/**` + `frontend/dist` + `package.json`），这样 `bin/thin-server.js` 的 `require('../package.json')`、`require('../lib/*')` 与硬编码的 `DIST_DIR = __dirname/../frontend/dist` **全部无需修改**。

---

## 4. PRoot + Capacitor 集成

### 4.1 运行时组成

| 组件 | 选型 | 说明 |
| --- | --- | --- |
| PRoot | 固定版本（随 app 打包） | GPL-2.0；`-0` 仅在 PRoot 命名空间内伪造 uid 0，**不是真实 root**。 |
| Loader | 与 PRoot 配套 | 加载 rootfs 内的 glibc ELF。 |
| Rootfs | Ubuntu 22.04/24.04 **minbase arm64** | 只装 Node 运行所需：glibc、libstdc++6、ca-certificates、tzdata。 |
| Node | 官方 **linux-arm64** 二进制，锁 22 LTS（≥22.15）或 24 LTS | 满足 `require(esm)`、全局 `WebSocket`、noble v2 的 `>=20.19`。 |

体积目标：rootfs + Node 约 **150–250 MB**（DSH Go 因含 Python/pnpm/full engine 约 1 GB，本项目不需要）。实际 filesDir 占用 = rootfs + app bundle **解压后**双份（约 APK 体积的 1.5–2 倍），P0 需同时记录「APK 体积」与「首启解压后占用」两个指标（见 §6.4）。

### 4.2 启动命令

```bash
proot \
  --kill-on-exit \
  -0 \
  -r "$FILES/runtime/rootfs" \
  -b "$FILES/app:/opt/agentlray" \
  -b "$FILES/.agentlray:/home/agentlray/.agentlray" \
  -b /dev -b /proc -b /sys \
  -w /opt/agentlray \
  /usr/bin/env \
    AGENTLRAY_HOME=/home/agentlray \
    AGENTLRAY_DISABLE_SSH=1 \
    PORT=3801 \
    HOST=127.0.0.1 \
  /usr/local/bin/node /opt/agentlray/bin/thin-server.js
```

- `/opt/agentlray` 与 `/home/agentlray/.agentlray` 在 rootfs 构建时预先创建，确保 bind target 存在。
- PRoot 与宿主共享网络命名空间，因此 `127.0.0.1:3801` 对同进程的 WebView 可达。
- `AGENTLRAY_HOME` 必须用项目变量名（`lib/config.js:5` 读取 `AGENTLRAY_HOME`），不要只设 `HOME`。
- 设备兼容性兜底：部分内核对 seccomp 敏感，预留 `PROOT_NO_SECCOMP=1`、`PROOT_TMP_DIR` 环境变量（P0 实测）。

### 4.3 Android 10+ 可执行文件限制（P0 必须验证）

Android 10（API 29）起，targetSdk ≥29 的应用**不能 `execve` 应用可写目录中的文件**（SELinux 限制）。PRoot / loader 必须：

1. 以 `lib*.so` 命名放入 `jniLibs/<abi>/`（如 `libproot.so`、`libproot-loader.so`）；
2. `AndroidManifest.xml` 设 `android:extractNativeLibs="true"`（AGP 新版对应 `useLegacyPackaging = true`）；
3. 运行时从 `applicationInfo.nativeLibraryDir` 执行，再通过 symlink 映射为普通文件名；
4. PRoot 的 loader 需通过 `PROOT_LOADER` 指到 nativeLibraryDir 中的 `libproot-loader.so`（具体文件名以 P0 实测为准）。

同时验证 **16KB page size**：目标 Android 15+/16KB 设备要求 native 库按 16KB 对齐构建（`-Wl,-z,max-page-size=16384`）。

> 若目标设备/渠道无法绕过 exec 限制，则只能退化为 targetSdk 28 的侧载包（不可上架），需在 P0 明确该约束。

### 4.4 rootfs 与 app bundle 分层

| 层 | 内容 | 更新频率 | 存放 |
| --- | --- | --- | --- |
| rootfs | Ubuntu + Node + 系统库 | 低（Node 大版本/rootfs 变更） | `filesDir/runtime/rootfs` |
| app bundle | `bin/`、`lib/`、`frontend/dist/`、`node_modules/`、`package.json` | 每个 app 版本 | `filesDir/app` |
| 持久数据 | `hosts.json`、`secret`、dsh 凭据/身份 | 运行时 | `filesDir/.agentlray` |

**升级规则**：
- rootfs 与 app bundle 各带版本标记文件（如 `.version`），APK 更新后按标记重建；
- `.agentlray` 永不随升级覆盖/删除；
- app bundle 解压使用「临时目录 + rename」原子替换，避免半包；
- 启动前校验 manifest SHA-256（防解压损坏/被篡改），失败则重建并提示。

### 4.5 依赖打包

`node_modules` 必须包含完整运行时闭包：

- `express`、`ws`、`zod`（薄服务 HTTP/SSE）。
- **`@lukeburns/clatterjs`**（vendor `crypto/noise.js` 直接 import；原设计遗漏）。
- `@lukeburns/clatterjs` 的嵌套依赖 `@noble/ciphers|curves|hashes` v2、`@noble/post-quantum`。
- `lib/dsh/vendor/dist/**`（只拷 `dist`，不拷 `src/`、`tsconfig.json`）。

打包后冒烟命令（CI 执行）：

```bash
node -e "require('@lukeburns/clatterjs'); require('ws'); require('express'); require('zod')"
```

### 4.6 Capacitor 加载时序

`server.url` 会导致 `BridgeActivity.onCreate` 立即加载 URL，若 Node 尚未监听会停在 `ERR_CONNECTION_REFUSED`。二选一（P0 验证后定稿）：

- **A（推荐）**：原生 Splash 覆盖 + 就绪后 `bridge.getWebView().loadUrl('http://127.0.0.1:3801')`；`server.allowNavigation` 放行 `127.0.0.1`。
- **B**：保留 `server.url`，在 `Application.onCreate` 尽早启动 Node，并用 Splash 覆盖 + `onReceivedError` 提供重试/错误屏。

无论哪种，都必须在加载前确认 `/api/version` 可访问；否则用户会看到系统错误页。

**`allowNavigation` 必须写裸主机名（踩坑记录）**：Capacitor 的 `Bridge.launchIntent` 用 `HostMask` 判定导航是否属于 App 内，
`HostMask.Simple` 把掩码和 `Uri.getHost()` 都按 `.` 切分后逐段比对，**不做 scheme/端口解析**。写成
`http://127.0.0.1:3801` 会被切成 `["http://127","0","0","1:3801"]`，永远匹配不上 host `127.0.0.1`。
后果：`loadUrl('http://127.0.0.1:3801/?token=...')` 返回 302 到 `/#token=` 时，WebView 对该**重定向**
回调 `shouldOverrideUrlLoading` → Capacitor 判为外部 URL → `ACTION_VIEW`，于是「一点图标就跳到系统浏览器
打开 AgentLRay 页面」，App 内始终停在占位页。修复为三层：
1. `capacitor.config.ts` 写 `allowNavigation: ['127.0.0.1']`（端口不参与匹配，薄服务端口由 `ThinNavigation.thinPort` 统一）；
2. `ThinNavigationPlugin.shouldOverrideLoad` 对薄服务同源返回 `false`；
3. `MainActivity.installThinNavigation()` 在 `WebViewClient` 层再兜底（老 APK 内打包的旧配置也能生效），
   其余回调委托 Capacitor 原客户端。包装客户端必须经 `Bridge.setWebViewClient(...)` 安装，
   **不能**直接给 WebView 赋值：Capacitor 的 `BridgeWebViewClient.onRenderProcessGone` 不调 `super`，
   渲染进程崩溃后的 `destroy()` 只由 `setWebViewClient` 触发。插件钩子（第 2 条）只对首次导航
   之后的跳转生效，首次加载的占位页不走它。

**内部页面单页签策略**：App 内只有 `MainActivity` 这一个 WebView，**内部页面**（薄服务同源、
Capacitor 占位页 `https://localhost`）之间的跳转与重定向只能在这个页签内完成，禁止新开页签、
禁止跳系统浏览器；**外部链接**保持 Capacitor 默认行为，交给外部浏览器。

- `WebSettings.setSupportMultipleWindows(false)` + `javaScriptCanOpenWindowsAutomatically=false`：
  内部页里 `target="_blank"` / `window.open` 不创建新窗口（`SecurityConfig.harden`）。
- `ThinNavigationPlugin`（`shouldOverrideLoad`）+ 包装后的 `WebViewClient`（`shouldOverrideUrlLoading`）
  两层裁决：内部页返回 `false` 由当前页加载；其余 URL（外部 http(s)、`intent:`/`mailto:` 等）
  返回 `null` 交 Capacitor 默认策略（外部 http(s) → `ACTION_VIEW` 系统浏览器）。
- 端口不参与 `allowNavigation` 匹配；薄服务端口统一取 `ThinNavigation.thinPort`。

---

## 5. 仓库模块改造方案

改动最小化：PRoot 下 `child_process` 可用，**不再需要**原来的惰性 require / 条件加载改造。

### 5.1 `lib/config.js` — 家目录重定向（AGENTLRAY_HOME，无需改）

`HOME = process.env.AGENTLRAY_HOME || os.homedir()`（`lib/config.js:5`）。启动脚本已注入 `AGENTLRAY_HOME=/home/agentlray`，`~/.agentlray/*` 全部落到 `filesDir/.agentlray`。**无需改 config.js**。

### 5.2 `lib/transport.js` / `lib/hosts.js` — 不改造加载方式，仅加能力开关

- PRoot 内 `child_process` 可用（ssh 二进制可按需加入 rootfs），`lib/transport.js:7` 的顶层 require **保持原样**；
- 首版 dsh-only 属于**产品裁剪**，通过 `AGENTLRAY_DISABLE_SSH=1` 在 hosts 层拒绝 ssh 主机：
  - `createHost` / `updateHost`：`type === 'ssh'` 时返回 400「Android 薄服务仅支持 dsh」；
  - `openHost`：防御性拒绝；
  - 桌面 thin / full 不受影响（未设置该环境变量）。
- 后续若要支持 SSH，只需在 rootfs 中加入 `openssh-client` 并放开该开关（列入 §11 后续项，不阻塞首版）。

### 5.3 `lib/routes/dsh.js` — 无需改（注意依赖链）

`forceClient: true` 已由 `bin/thin-server.js` 传入，`/api/dsh/*` 固定 client。该文件 `require('../transport')`（第 22 行）在 PRoot 下正常，无 child_process 风险。

### 5.4 `lib/routes/mode.js` — 增加能力位

```json
{ "mode": "thin", "version": "x.y.z", "capabilities": { "transports": ["dsh"] } }
```

- 老客户端忽略未知字段，向后兼容；
- 前端据此隐藏/禁用 ssh 选项。

### 5.5 前端 — 三处小改

| 文件 | 改动 |
| --- | --- |
| `frontend/src/api/client.ts` | `ModeInfo` 增加可选 `capabilities?: { transports?: string[] }`。 |
| `frontend/src/components/HostFormDialog.tsx` | 传输下拉按 capabilities 过滤；默认选第一个可用项（Android 下即 dsh，见当前默认 `transport: 'ssh'`）。 |
| 下载辅助（`views/sessions/exports.ts`、`views/prompts/promptsLib.ts`、`ReviewTransferPanel.tsx`） | Android WebView 不支持 blob 下载；按 `capabilities.nativeSave` 走 Capacitor 文件保存/分享桥接（见 §7.6）。 |

### 5.6 `bin/thin-server.js` — 无需改

不修改仓库入口；环境变量全部由原生 `spawn` 注入。桌面语义保持不变。

### 5.7 改动汇总

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `lib/hosts.js` | 小改 | ①`AGENTLRAY_DISABLE_SSH` 守卫（创建/修改/连接）；②`lastHostId` 记忆字段（`resolveThinBootHost` 优先 + `GET/PUT /api/hosts` 透传，见 §7.7 API 契约） |
| `lib/routes/hosts.js` | 小改 | `GET` 响应附 `lastHostId`、`PUT` 透传该字段 |
| `lib/routes/mode.js` | 小改 | capabilities |
| `frontend/src/api/client.ts` | 小改 | ModeInfo 类型 |
| `frontend/src/components/HostFormDialog.tsx` | 小改 | 传输过滤/默认值 |
| 下载辅助 3 处 | 小改 | 原生保存桥接 |
| `bin/thin-server.js` / `lib/transport.js` / `lib/dsh/*` | 不改 | PRoot 下原样运行 |

---

## 6. 构建与打包流程

### 6.1 rootfs 构建（可复现）

```bash
# 在 Linux/docker 中执行（CI 任务，不在开发机手工维护）
debootstrap --arch=arm64 --variant=minbase bookworm rootfs/ http://ports.ubuntu.com/ubuntu-ports
# 安装最小运行依赖
chroot rootfs/ apt-get install -y --no-install-recommends libstdc++6 ca-certificates tzdata
# 解压官方 Node linux-arm64 到 /usr/local
tar -xJf node-v22.x-linux-arm64.tar.xz -C rootfs/usr/local --strip-components=1
# 预创建 bind target
mkdir -p rootfs/opt/agentlray rootfs/home/agentlray/.agentlray
# 校验动态依赖
chroot rootfs/ ldd /usr/local/bin/node
# 打包（gzip；不用 .gz 后缀——aapt2 会解压 assets/**.gz 并改写文件名）
tar -czf rootfs-arm64.tgz -C rootfs .
```

- 记录 debootstrap 镜像快照/包清单、Node 版本与 SHA-256，产出 `rootfs.manifest.json`；
- 目标体积 150–250 MB；P0 记录冷启动与内存。
- **ABI 双构建**：上述命令为 arm64（真机主路径）。x86_64 模拟器需要**独立的 x86_64 rootfs + x86_64 Node 二进制**（arm64 rootfs 无法在 x86_64 模拟器执行）。`build-rootfs.sh` 按 `$ABI`（`arm64`/`x86_64`）切换 `debootstrap --arch` 与 Node tarball；`assets/runtime/` 按 ABI 目录存放。若 x86_64 仅用于 UI/壳冒烟、不承载运行时，则 P0 明确该口径并跳过 x86_64 rootfs 构建，避免承诺无法兑现。

### 6.2 app bundle

```bash
node android/scripts/bundle-app.mjs
# 收集：package.json、bin/thin-server.js、lib/**（排除 lib/dsh/vendor/src）、
#       frontend/dist/**、node_modules 运行时闭包
# 产出：app-bundle.tgz + app.manifest.json（SHA-256 清单）
```

**必须包含**：`package.json`（`bin/thin-server.js:24` 需要）、`frontend/dist`（`DIST_DIR` 依赖）、`@lukeburns/clatterjs` 及其嵌套依赖。

### 6.3 Android 构建

```bash
# 一键（仓库根；rootfs 与 PRoot 二进制已就绪）
npm run build:apk            # debug
npm run build:apk:release    # release（未注入 keystore 时回退 debug 签名）

# 等价手工步骤
cd android
npm install && npx cap sync
./gradlew assembleRelease     # APK/AAB
```

### 6.4 发布

| 项 | 方案 |
| --- | --- |
| 分发渠道 | 首版按**侧载/企业内部分发**设计；PRoot + `lib*.so` exec 方案与 Google Play 政策存在冲突，上架前需单独评估（§10）。 |
| ABI | `arm64-v8a` 为主，`x86_64` 仅模拟器（需独立 x86_64 rootfs + Node，见 §6.1）；不支持 32 位 ARM（与 Node 22/24 官方 arm64 构建一致）。 |
| minSdk / targetSdk | minSdk 26（Android 8.0+）；targetSdk 按当前商店要求，但受 §4.3 exec 限制约束。 |
| 签名 | 正式 keystore 不入库；CI 密钥注入，文档记录轮换流程。 |
| 加固 | 企业分发或渠道要求时接入厂商加固 SDK。 |
| 体积 | ABI split + rootfs 压缩；预算：APK ≤ 350 MB，且记录首启解压后 filesDir 占用（rootfs + app 双份，P0 实测后一并修订）；企业 MDM/AAB 分发链的体积约束另行评估。 |
| 崩溃上报 | 原生 Sentry/Crashlytics + Node 侧 stderr/异常转发（§7.5）。 |

---

## 7. 生命周期与状态机

### 7.1 启动顺序

```
Application.onCreate / Service.onCreate
  → RootfsInstaller.ensure()           # 版本标记/校验/解压（仅首次或升级）
  → NodeRuntimeManager.start()          # spawn proot → node thin-server
  → 轮询 GET /api/version（200ms，≤20s）
  → 就绪 → 页面已对应当前服务进程则复用；否则 WebView.loadUrl(
             "http://127.0.0.1:3801/?token=…&next=<当前站内路径>")   # 302 兑换 cookie
  → 失败（超时/进程退出）→ 错误屏：展示日志尾部 + 重试
```

> `/api/version` 只代表 HTTP 服务已监听，**不代表 dsh 已连上**；主机连接状态由前端 `HostConnectingView` 负责。

### 7.2 前台/后台（退后台前台服务保活 5 分钟）

| 事件 | 行为 |
| --- | --- |
| `onStop`（界面不可见） | 立即转**前台服务**保活（`foregroundServiceType=specialUse`），防抖 **5 分钟**；到期才 `SIGTERM` proot（`--kill-on-exit` 连带清理 Node），等待 3s 后 `SIGKILL`，并收起前台服务。 |
| `onStart`（回前台） | 取消防抖并立即收起前台服务；重新 `start()`；服务仍健康（同一进程代号）且页面已加载完成 → **纯复用页面，不 reload**；服务换代/页面失效 → 重新导航并带上站内 `next`。 |
| 隧道断开 | 薄服务 hostReady 置 false，web 端显示断线占位；重连由 `autoConnectThinHost` 或用户操作触发。 |

- **回前台绝不 reload**：`onStart → NodeRuntimeManager.start()` 在服务已健康时（`alreadyHealthy`）同样回调 `onReady`，若壳每次都导航，就会在每次前后台往返时重建 SPA——丢失当前会话/滚动位置、触发全量重拉与 SSE 重连（真机现象：回到主页）。判据由 `MainActivity.pageIsCurrent` 统一给出，三条必须同时成立：
  1. **页面已加载完成**：`ThinNavigationPlugin` 包装的 `BridgeWebViewClient.onPageFinished` 记录 URL，且落在薄服务同源——只认「加载完成」，不用 `webView.url`（后者在加载中/加载失败时也是薄服务地址）；
  2. **服务进程没换过**：`NodeRuntimeManager.generation` 只在**新 spawn** 后递增，壳记录导航时的代号，代号不一致说明退后台防抖已杀进程并重启，旧页面指向已退出进程（刷新/SSE 全失败），必须重新导航；
  3. **令牌一致且 cookie 仍在**：WebView cookie jar 可能被回收，此时链接全 401，必须重新导航兑换。
  重新导航时把当前站内路径（query，不含 fragment）作为 `next` 传给 `/?token=`，服务端 `safeNextPath` 校验后 302 回原页面，避免丢掉 `?view=&session=&sid=`。

- **不要在 `onStart` 时与 `onStop` 的回收竞态**：`start()` 前必须 `await` 旧进程完全回收（SIGTERM 后至多 3s 的 `SIGKILL` 完成）再 spawn 新进程；否则快速前后台切换会同时存在新旧进程，撞 `3801` 端口 `EADDRINUSE`。`NodeRuntimeManager.start()` 内部串行化：任何时刻至多一个 proot 子进程存活。
- **`ensure()` 必须单飞**：`Application.onCreate` 的后台线程与 `MainActivity.onStart → start()` 会**并发**调用 `RootfsInstaller.ensure()`。若不加锁，两条路径共用 `runtime/rootfs.tmp`，会互相删除 tmp/目标目录，产生「流程正常返回但 rootfs 残缺（缺 `usr/local/bin/node`）」的竞态——真机实测即报「rootfs 内缺少 node」。修复：`ensure()` 加 `@Synchronized`；解压后按哨兵（rootfs 的 `usr/local/bin/node`、app 的 `bin/thin-server.js`）校验，残缺即抛错；`spawnAndAwait` 与 `ensureLayout` 的缓存也过哨兵，命中残缺目录则删除重建（自愈）。

- **不要用 `onPause`**：对话框、通知栏、权限弹窗都可能触发，会误停服务。
- 旋转/多窗口：`android:configChanges` 避免 Activity 重建；进程管理放在 Application/Service 单例，不绑定 Activity 生命周期。
- **防抖窗口 = 5 分钟，且必须配前台服务**：单纯的 `Handler.postDelayed` 撑不住长窗口——界面不可见后进程进入 **cached** 状态，系统可在数分钟内回收整个进程（proot/Node 一并消失），定时器根本没机会执行。因此 `onStop` 先 `startForegroundService(RuntimeService)`（`foregroundServiceType="specialUse"`，常驻低优先级通知），进程在窗口内按前台服务计权；`onStart` 与防抖到期都先 `stopService`。通知权限（Android 13+ `POST_NOTIFICATIONS`）未授予时通知不展示，但前台服务本身仍生效。
- `RuntimeService` 的两条边界：①**不要**在 `onStopForeground` 里停运行时（回前台时壳主动收起前台服务，那正是要复用页面的时刻）；②`onTimeout`（Android 15+ `specialUse` 6 小时上限，或 ROM 更短）必须立即停运行时并 `stopSelf`，否则按 ANR 处理。服务返回 `START_NOT_STICKY`——自行重建时无人调 `startForeground`，会立刻被杀。
- 防抖到期判定要复查 `activityStarted`：进程被冻结时定时器会推迟到解冻（可能已在 `onStart` 之后）才派发，不复查会在前台把服务停掉。
- 5 分钟窗口是体验与耗电的折中：窗口内回前台纯复用页面（服务未换代），超窗则停服务、回前台重启并重新导航。后台期间 proot/Node 仍占 CPU/内存，SSE 连接保持（这正是「回前台无感」的前提）。
- **防抖状态放在 `App`（进程级）而非 Activity**：Activity 可能在后台被系统销毁（「不保留活动」、低内存回收单 Activity），若定时器寄宿在 Activity 的 Handler 上则随销毁丢失，前台服务与运行时无人收敛。改为 `App.debounceHandler` 持有 Runnable（只读 `activityStarted`，不持有 Activity 引用，无泄漏）；Activity 销毁只影响它自己，收敛责任交给进程级定时器。
- **页面证据必须多重作废**：`thinPageSel`/`loadedGeneration` 不只在 `loadThinUi` 里清空——`ThinNavigationPlugin` 在 `onPageStarted`（任何新文档）与主框架 `onReceivedError`（加载失败不触发 `onPageFinished`）时回调作废，`runtime.onExit` 也作废。否则一次失败的全页导航会留下过期证据，`pageIsCurrent` 误判为可复用而跳过重新导航，把用户留在 Chrome 错误页。
- **停止必须区分异步/同步**：`onTaskRemoved`、前台服务超时、主动退出这几个「进程即将被回收」的场景用 `stopBlocking(graceMs)`——同步 `SIGTERM` 并等待（默认 1s），超时才 `SIGKILL`；若只把 `SIGTERM` 丢进 daemon executor，线程可能来不及跑，proot/Node 变孤儿继续占 3801。
- **`userStopped` 必须在每次 `start()` 清零**：否则一次主动停止后，本进程内后续崩溃会被 `maybeRestart` 永久短路，既不重启也不报错（WebView 停在死页面）。
- **Android 12+ 后台启动前台服务受限**：`onStop` 时刻可能已被判定后台，`startForegroundService` 抛 `ForegroundServiceStartNotAllowedException`。`RuntimeService.start()` 返回布尔，失败记入运行时日志，保活退化为仅靠防抖定时器（用户可在日志/错误屏看到，而非静默）。Android 13+ 另需在 `onCreate` 申请 `POST_NOTIFICATIONS`，否则通知被隐藏（服务本身仍计权）。

### 7.3 崩溃与重启

- `NodeRuntimeManager` 监听进程退出码与 stderr；
- 非用户主动停止 → 指数退避重启（1s / 2s / 4s，最多 3 次）；
- 超过重试次数 → 错误屏（含最后 200 行日志 + "重启运行时"按钮）；
- Node 侧安装 `uncaughtException` / `unhandledRejection`：打印堆栈后 `process.exit(1)`，由原生 supervisor 重启；**不吞异常**。

### 7.4 孤儿进程清理

- 启动时读取 `filesDir/runtime/node.pid`；若 pid 存活且 `/proc/<pid>/cmdline` 含我们的 proot 路径 → 先 `SIGKILL` 再启动；
- `proot --kill-on-exit` 保证 proot 退出时清理其 tracee；
- 应用被系统杀死后，下次启动必须完成上述清理，避免 3801 端口被残留进程占用。

### 7.5 日志与崩溃上报

- proot stdout/stderr → `RuntimeLogRing`（内存环形缓冲 + logcat）；
- 原生 Sentry 捕获 Java 崩溃；
- Node 致命异常 / proot 异常退出 → 原生将日志尾部作为 breadcrumb/event 上报 Sentry（Node 侧无独立 SDK，避免额外依赖）；
- 错误屏展示同一份日志尾部，便于用户截图反馈。

### 7.6 下载 / 导出 / 文件选择

- `<input type="file">`：Capacitor WebView 自带文件选择，私钥文件与导入 JSON 可用；
- **blob 下载在 Android WebView 不工作**（`URL.createObjectURL` + `a.download`）：导出会话、导出 prompts、复核 JSON 下载需要原生保存桥接；
- 方案：自定义 Capacitor 插件 `saveFile({ base64, fileName, mime })` → 写入 `Downloads`/应用私有目录并触发分享；
- `/api/mode` 增加 `capabilities.nativeSave = true`，前端下载辅助按能力切换；
- P2/P3 验收必须覆盖「导出 → 文件落盘/分享成功」。

### 7.7 恢复上次主机

现有 `resolveThinBootHost()` 只认 `AGENTLRAY_THIN_HOST` 或 `hosts[0]`（`lib/hosts.js:428-436`），**没有"记忆主机"**。Android 侧需：

- 在 `hosts.json` 顶层记录 `lastHostId`；
- `resolveThinBootHost` 优先 `lastHostId`，且过滤掉非 dsh 主机；
- 前端切换主机时写入该字段。

**API 契约（新增，纳入 §5.7 改动汇总）**：
- `GET /api/hosts` 响应对象顶层返回 `lastHostId`（与既有 `hosts` 数组并存）；
- `PUT /api/hosts`（前端保存主机表单）透传可选的 `lastHostId` 顶层字段，由 `lib/hosts.js` 写入 `hosts.json`；
- 兼容性：字段为可选，老客户端不写不影响；桌面 thin / full 未设置 `AGENTLRAY_DISABLE_SSH` 时 `lastHostId` 同样生效（记忆主机是通用行为，非 Android 专属），但 Android 端仅接受 dsh 类型。

> 原生侧备选（不引入 API 改动）：把上次主机 id 作为 `AGENTLRAY_THIN_HOST` 注入。但该 env 仅在启动时读取，无法表达「前端运行时切换」，因此采用 `lastHostId` 字段方案。

---

## 8. 安全与凭据

### 8.1 本期实现

| 项 | 做法 |
| --- | --- |
| 凭据加密 | `lib/secret.js` AES-256-GCM；密钥 `filesDir/.agentlray/secret`（0600，app 私有目录）。 |
| 网络绑定 | 薄服务固定 `HOST=127.0.0.1`、`PORT=3801`（端口固定为产品决策，风险见 §11）。 |
| 本机接口鉴权 | `lib/auth.js`：本机直连（目标 local / 本机资源 `/api/{hosts,inbound,dsh,mode}`）必须携带令牌。原生 `NodeRuntimeManager` 首次启动生成 256-bit 令牌并持久化到 `filesDir/ui-token`（应用私有，跨重启/升级不变），经 env `AGENTLRAY_UI_TOKEN` 注入；`MainActivity` 以 `http://127.0.0.1:3801/?token=…` 导航，thin-server 校验后设一年长效 `HttpOnly; SameSite=Strict` cookie 并 302 回 `/#token=<令牌>`（前端据此写 `localStorage` 并在每个请求附头，`replaceState` 抹掉 fragment）。已兑换的令牌记在 `filesDir/ui-token.exchanged`；令牌不变**且 WebView cookie 仍在**时不重复导航（cookie 被清则重新导航兑换，否则会永久 401）。远端目标不验本机令牌（链路认证：dsh 设备密钥），proxy 转发前剥除本机 cookie/令牌头。 |
| 端口占用检测 | 启动后若 `/api/version` 不通且进程报告 `EADDRINUSE` → **不加载 WebView**，显示错误屏，防止加载未知页面。 |
| Android 备份 | `android:allowBackup="false"` + `dataExtractionRules` 排除 `.agentlray`（secret/hosts 不进云备份）。 |
| 明文流量 | `network_security_config.xml` 仅对 `127.0.0.1` 放行 cleartext；其余默认拒绝。 |
| WebView 加固 | 关闭 file/content access；release 关闭调试；禁止混合内容；敏感页面评估 `FLAG_SECURE`。 |
| PRoot 信任边界 | rootfs/app bundle 来自 app 自身签名包；启动前校验 SHA-256；PRoot 仅是同进程权限下的兼容层，**不构成安全边界**。 |
| dsh 通道 | Noise IK 握手 + 加密传输，经中继，不要求 full 实例暴露公网端口。 |
| VPN/隧道 | 用户自选（WireGuard / 公司 VPN / 中继）。 |

### 8.2 暂缓（本期明确不实现）

- 随机端口 / 防端口抢占（见 §11 D3）；
- dsh loopback 端点独立鉴权（当前由入站 UNIX socket 信任通道 + 进程内标记 `X-AgentLRay-Tunnel` 覆盖，见 §11 D2）；
- 详见 §11「暂缓事项」。

> 已知边界：Android 的 loopback 不是 app 私有，其他应用可访问 `127.0.0.1:3801`——现已由**本机令牌鉴权**（§8.1）覆盖：无令牌即 401。`lib/csrf.js` 对无 Origin 的非浏览器客户端仍放行，但这类客户端同样需要令牌。

---

## 9. 分阶段实施计划

| 阶段 | 内容 | 验收（必须留证据） |
| --- | --- | --- |
| **P0-A 运行时可行性** | PRoot + rootfs + Node 在真机启动 thin-server；完成 dsh 握手；记录 proot/Node 版本、rootfs 构建脚本、SHA-256、体积、冷启动、内存 | arm64 真机（API 26/29/33/35）`/api/version` 200；dsh 隧道连通；会话列表可见；SSE 连续 5 分钟；`exec` 限制与 16KB 结论 |
| **P0-B 打包闭环** | assets→filesDir、rootfs/app bundle 分层、`package.json`/`@lukeburns/clatterjs`/`frontend/dist` 路径、bind mount、升级保留 `.agentlray` | 全新安装/覆盖升级/清除数据三种路径均可启动；依赖冒烟命令通过 |
| **P0-C 生命周期** | spawn/就绪/stop/restart/崩溃退避/孤儿清理/旋转 | 前后台往返 ≥3 次、崩溃自动重启、旋转不重载、无残留进程占 3801 |
| **P0-D 能力面** | `/api/mode` capabilities、ssh 隐藏与后端拒绝、下载桥接决策 | Android 下新建主机只出现 dsh；ssh 请求返回 400；导出落盘/分享成功 |
| **P0-E 安全基线** | allowBackup、network security config、WebView 加固、端口占用错误屏 | 备份不含 `.agentlray`；非 127.0.0.1 明文被拒；占用 3801 时不加载 WebView |
| **P1 最小可运行壳** | Capacitor 工程 + PRoot 进程管理 + 启动门控 + WebView | 启动 → 本地薄服务可达 → 空态「添加主机」页面正常 |
| **P2 dsh 连接闭环** | dsh 登录/设备选择 → 主机表单 → 隧道连远端 full → 会话/分析视图 | 手机经 dsh 中继看到远端会话列表与详情；导出/下载可用 |
| **P3 健壮性** | 断线重连、前后台、SSE 流式、错误屏、版本兼容检查 | 断网/切后台往返后数据恢复；SSE 实时尾随正常；远端版本不兼容时给出明确提示 |
| **P4 发布** | 签名、加固、崩溃上报、体积优化、分发说明 | 可分发 APK/AAB；崩溃日志可回传；安装包体积达标 |

**P0 是 go/no-go 门禁**：若 P0-A 在目标分发渠道上无法满足 exec/16KB/targetSdk 约束，则回到 ADR-0008 重新评估（targetSdk 28 侧载、替代运行时或放弃原生 app），不得带着未验证的假设进入 P1。

### 9.1 测试与回归

| 层 | 覆盖 | 方式 |
| --- | --- | --- |
| 后端 | `AGENTLRAY_DISABLE_SSH` 守卫（create/update/open）、`/api/mode` capabilities、dsh 路由 `forceClient` 不变、`lastHostId` 记忆（resolveThinBootHost 优先 + GET/PUT 透传） | `node --require ./test/setup-env.cjs --test test/*.test.js`；新增 `test/thin-android-guards.test.js`（含 lastHostId 用例） |
| 前端 | 传输过滤/默认值、下载能力分支 | 前端当前无测试运行器 → 构建校验 + 手工用例（P2/P3 留证据） |
| 设备矩阵 | API 26 / 29 / 33 / 35；arm64 真机为主，x86_64 仅模拟器 | 手工冒烟 |
| 安装/升级 | 全新安装、覆盖升级、清除数据、rootfs 版本变更 | 手工，逐项留日志 |
| 生命周期 | 前后台往返、崩溃重启、孤儿清理、端口占用 | 手工 + logcat |
| 回归 | 现有 full / 桌面 thin / CLI 行为不变 | `npm test`（全量） |

---

## 10. 风险与开放问题

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| Android 10+ 禁止从可写目录 exec；Play 政策不欢迎 `lib*.so` 绕过 | **高** | P0 验证 `jniLibs` + `extractNativeLibs=true`；明确侧载/企业分发；上架前单独评估。 |
| PRoot 二进制/loader 与 16KB page、ABI 不匹配 | 高 | 固定 proot 版本并重编译（`-Wl,-z,max-page-size=16384`）；P0 真机验证。 |
| PRoot 许可证（GPL-2.0）与分发合规 | 中 | 作为独立程序随包分发，保留许可证与源码获取方式；法务确认后再发布。 |
| rootfs 体积/冷启动/内存 | 中 | minbase + 官方 Node；rootfs 只解压一次；预算 150–250 MB；P0 实测。 |
| 孤儿进程 / 端口占用 | 中 | pid 文件 + 启动清理 + `--kill-on-exit`；EADDRINUSE 错误屏。 |
| Android 自动备份泄露凭据 | 中 | `allowBackup=false` + 备份排除规则。 |
| 本机 API 无鉴权（其他 app 可访问） | 中 | ✅ 已缓解：本机令牌鉴权（`lib/auth.js` + 原生持久化令牌），无令牌 401。 |
| 固定端口 3801 可被抢占 | 中 | 本期仅做占用检测；随机端口见 §11 D3（令牌部分已实现）。 |
| app 前端 dist 与远端 full 版本漂移 | 中 | 连接时检查远端 `/api/version` 最低版本；不兼容给出升级提示。 |
| 下载/导出在 WebView 不可用 | 中 | 原生保存桥接 + `capabilities.nativeSave`；P2 验收覆盖。 |
| Node 崩溃日志漏报 | 中 | stderr 环形缓冲 + 异常退出 → Sentry breadcrumb/event。 |
| dsh 中继/账号不可用 | 中 | 错误屏提示检查登录/网络；复用现有 dsh 登录弹框。 |

**开放问题（P0 关闭）**：
- PRoot 在目标 OEM 设备上的 `exec`/seccomp 行为；
- rootfs 最小依赖清单（`ldd` 结果）；
- Capacitor `server.url` vs 手动 `loadUrl` 的最终加载时序；
- 侧载/企业分发渠道与签名/加固方案。

---

## 11. 暂缓事项（记录在案，本期不实现）

> 2026-11-21 评审决定：token 认证与接口鉴权暂不考虑；端口固定使用 3801。
> **2026-11-22 更新**：本机令牌鉴权已实现（§8.1，D1/D4 关闭）；端口仍固定 3801（D3 未变）。

| 编号 | 问题 | 当前决定 | 后续建议 | 触发条件 |
| --- | --- | --- | --- | --- |
| D1 | Android loopback 非 app 私有，其他应用可访问 `127.0.0.1:3801`；`lib/csrf.js` 对无 Origin 客户端放行 | ✅ **已实现**（2026-11-22）：原生生成令牌并持久化，经 env 注入，WebView `?token=` 兑换 cookie；本机直连 `/api/*` 校验令牌，远端目标走链路认证 | 余项：令牌轮换策略（可选） | 对外分发 / 安全评审 |
| D2 | dsh loopback 端点（`lib/dsh/loopback-client.js`）是无鉴权本地 HTTP 服务 | ✅ 已实现（2026-11-22）：被连接方提供 `~/.agentlray/inbound.sock`（0600）信任通道，连接方 dsh/ssh 隧道直接指向它；dsh loopback 宿主另注入进程内密钥 `X-AgentLRay-Tunnel` | 连接方 loopback 端点本身仅监听 127.0.0.1 随机端口（数据面已由被连接方鉴权覆盖） | 同 D1 |
| D3 | 固定端口 3801 可被其他应用抢占，导致监听失败或加载未知页面 | 固定 3801（产品决策） | 采用随机端口 + 稳定 origin 方案（如自定义 scheme / 端口映射）；或在加载前做服务身份校验 | 同 D1 |
| D4 | 无 TLS（loopback 明文） | 接受 | ✅ 令牌满足「不出现在可被其他应用读取的位置」：`filesDir/ui-token` 为应用私有，日志中脱敏；仍建议后续评估 loopback TLS | 同 D1 |
| D5 | SSH 传输 | 首版禁用 | PRoot 已具备 `child_process`；后续可在 rootfs 加入 `openssh-client` 并放开 `AGENTLRAY_DISABLE_SSH` | 用户需求 |
| D6 | 后台常驻 / 推送 | 不做 | 需要时改用 foreground service + 常驻通知 | 用户需求 |
| D7 | iOS | 不做 | 另行评估（PRoot 不可用，需独立方案） | 用户需求 |

---

## 12. 实现进度（代码核对：2026-11-21）

**状态：部分实现**——仓库侧模块改造、Android 工程骨架、P1 最小壳、P2 导出桥接、P3 版本兼容已落地并做后端/前端验证；P4 发布部分实现（签名注入/R8/崩溃落盘）。P0 真机门禁未做（当前环境无 Android SDK/真机，未构建 APK），已以静态推断文档覆盖（`android/docs/p0-runtime-inference.zh-CN.md`）。

| 能力/阶段 | 状态 | 代码证据 |
| --- | --- | --- |
| 决策收敛（ADR-0008，R2 修订为 PRoot） | ✅ 已完成（待 P0 验证） | [adr-0008](adr-0008-android-mobile-app.zh-CN.md) |
| 完整工程蓝图（本文件） | ✅ 已完成 | 本文档 |
| 一键 APK 打包 | ✅ 已实现（本机 debug/release 构建通过） | `android/scripts/build-apk.sh`（前端 → app-bundle → assets 同步 + rootfs SHA-256 校验 → cap sync → Gradle → APK 条目自检）+ 根 `package.json` 的 `build:apk`/`build:apk:release`；`android/README.md` 同步说明 |
| §5 仓库模块改造（hosts 守卫/lastHostId/mode capabilities/前端传输过滤/下载桥接） | ✅ 已实现 | `lib/hosts.js`（`sshDisabled`/`assertTransportAllowed`/`getLastHostId`/`setLastHostId`、`resolveThinBootHost` 优先 lastHostId + DISABLE_SSH 过滤）、`lib/routes/hosts.js`（GET `{lastHostId,hosts}`、PUT 透传、connect 写盘）、`lib/routes/mode.js`（capabilities）、`frontend/src/api/{types,client}.ts`、`frontend/src/store.ts`（`modeCapabilities`）、`frontend/src/components/HostFormDialog.tsx`（传输按 capabilities 过滤/默认）、`frontend/src/lib/download.ts`（nativeSave 桥接）+ 3 处调用（`exports.ts`/`promptsLib.ts`/`ReviewTransferPanel.tsx`）；测试 `test/thin-android-guards.test.js`（12 例），全量 **757/757** 通过（本轮新增版本兼容 6 例），`npm run build:ui` 通过 |
| Android 工程骨架（`android/`） | 🟡 已落地，**本机 debug APK 构建通过**（真机未验） | `android/{package.json,capacitor.config.ts,www/,README.md}`、`android/android/app/src/main/java/com/agentlray/app/{App,MainActivity,NodeRuntimeManager,RootfsInstaller,RuntimeLogRing,RuntimeWatchdog,SecurityConfig,SaveFilePlugin}.kt`、`AndroidManifest.xml`、`res/xml/{network_security_config,data_extraction_rules,file_paths}.xml`、`android/android/{build.gradle,settings.gradle,variables.gradle,app/build.gradle}`、`android/scripts/{build-rootfs.sh,bundle-app.mjs,package-runtime.mjs,fetch-proot.sh}`、`jniLibs/arm64-v8a/{libproot,libproot-loader}.so`、`assets/runtime/{rootfs-arm64.tgz,app-bundle.tgz}`；JDK 21 + Gradle 8.11 + AGP 8.7.2 本机 `:app:assembleDebug` 成功（`app-debug.apk` 96MB）|
| P0 运行时/打包/生命周期/能力面/安全基线 | 🟡 APK 可构建 + 静态量测（真机待验） | 工程闭环见 `android/`；推断/量测与两处高险（exec、16KB 设备行为；zstd-jni ABI 已改 gzip 消除）见 `android/docs/p0-runtime-inference.zh-CN.md`；真机必验清单同上 |
| P1 最小可运行壳 | 🟡 已实现（未真机构建/启动） | Capacitor 壳 + `MainActivity` 就绪门控 + `www/` 占位页 + `App` 单例启动 |
| P2 dsh 连接闭环 | 🟡 已实现（未真机连远端验证） | dsh 登录/设备选择/隧道复用现有栈；**本轮补齐服务端导出桥接**：`frontend/src/views/sessions/exports.ts` 在 `nativeSave` 时 `fetch(exportUrl)→saveTextFile`，`serverExportFilename` 解析 `Content-Disposition` |
| P3 健壮性 | 🟡 已实现（断线/版本兼容，SSE 真机待验） | 崩溃退避/前后台/孤儿清理/端口错误屏已落地；**本轮新增版本兼容**：`lib/version-compat.js`（单一真源判定）+ `/api/hosts` 序列化 `remoteVersion`/`compatible` + `HostCompatBanner.tsx` 升级提示；`test/version-compat.test.js`（6 例） |
| P4 发布（签名/加固/Sentry/体积） | 🟡 部分实现 | **本轮**：release 签名经 env 注入（`app/build.gradle`）+ R8 压缩/混淆（`proguard-rules.pro`）+ 原生崩溃落盘基线（`CrashLog.kt`）；厂商加固 SDK / 正式 Sentry / AAB 分发链 / 体积实测待发布前完成 |
| 本机令牌鉴权（C-1） | ✅ 已实现 | `lib/auth.js`（本机直连才验令牌、无令牌自动生成 `~/.agentlray/ui-token`、隧道可信标记）、`server.js`/`bin/thin-server.js` 挂载顺序、`NodeRuntimeManager.kt`（令牌持久化 + 日志脱敏）、`MainActivity.kt`（`?token=` 导航 + 已兑换令牌记录）、`lib/dsh/loopback-host.js`（可信标记注入）；测试 `test/local-auth.test.js`（含远端目标放行、本机资源强制令牌、伪造标记 401） |
| 随机端口 / 防端口抢占 | ⏸ 暂缓（§11 D3） | — |

> 实现偏差（记录在案）：①目录布局按标准 Capacitor 落在 `android/android/`（`cap sync` 要求），design §3 扁平树为其内容；②原 `.tar.zst` + `zstd-jni` 方案经 Maven 核验**无 Android ABI 分类器**（`linux_aarch64` 为 glibc，bionic 无法加载），已改为 `.tgz` + Android 内置 `GZIPInputStream`（`commons-compress` 仅做 tar 解析）；③前端下载桥接依赖 `window.Capacitor.Plugins.SaveFile` 探测，未引入 `@capacitor/core` 构建耦合；④资产扩展名取 `.tgz` 而非 `.tar.gz`：aapt2 会解压 `assets/**.gz` 并把资产名改写为去后缀形式，导致运行时找不到文件。⑤PRoot 原生依赖不随 `LD_LIBRARY_PATH` 注入：Android 8+ bionic 忽略 app 进程的 `LD_LIBRARY_PATH`，且 jniLibs 只收无版本号 `*.so`（`libtalloc.so.2` 会被 AGP 丢弃）；故依赖库与 proot 同放 `jniLibs`，构建期用 patchelf 把 proot 及其依赖的 `DT_RUNPATH` 改成 `${ORIGIN}`（bionic API 24+ 把 `$ORIGIN` 重写为可执行文件目录）并同步 `NEEDED` 命名。

---

## 参考

- DSH Go（Android 客户端，AGPL-3.0）：PRoot + Ubuntu + Node 24 运行环境，Android 8.0+、arm64/x86_64、侧载分发、冷启动约 2.5–3 秒。
- Node.js Mobile（官方，最后版本 18.20.4）：本项目已否决，原因见 §2.3。
- PRoot：GPL-2.0；Android 10+ exec 限制与 `lib*.so` 打包方式见 §4.3。
