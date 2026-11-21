# P0 运行时可行性推断（Android 移动端 App）

> 类型：P0 门禁的**静态推断 + 本机构建记录**。构建环境已自举（JDK 21 + Gradle 8.11 + Android SDK 35），
> **debug APK 已产出**（见 §7）；仍**无 arm64 真机**，运行时行为（exec/16KB 设备行为/PRoot 启动）
> 未实测。本文件基于源码证据、Android 平台机制与 PRoot/Node 官方产物逐项推断 P0-A~P0-E，
> 标注[证据]/[机制]/[推断]/[实测]；真机实测前不得把推断当已通过。
> 关联：[`docs/design/design-android-mobile-app.zh-CN.md`](../../docs/design/design-android-mobile-app.zh-CN.md)
> （v1.1，§4 运行时 / §6 打包 / §7 生命周期 / §8 安全 / §9 P0 门禁）、[`adr-0008`](../../docs/design/adr-0008-android-mobile-app.zh-CN.md)。

---

## 0. 结论摘要

| P0 项 | 推断 | 确定性 | 真机必验 |
| --- | --- | --- | --- |
| P0-A 运行时可行性（exec/16KB/proot/rootfs） | **可行，两处高险**：exec 限制（待真机）、16KB 设备行为（对齐已量测通过）；zstd-jni ABI 风险**已消除**（改 gzip） | 中 | 必验，决定 go/no-go |
| P0-B 打包闭环（assets→filesDir/分层/升级） | **工程已闭环**，代码路径完整 | 高 | 全新/覆盖/清数据三路径 |
| P0-C 生命周期（spawn/前后台/崩溃/孤儿/旋转） | **工程已闭环**，逻辑完整 | 高 | 前后台/崩溃/旋转/端口 |
| P0-D 能力面（transports/nativeSave/导出桥接） | **工程已闭环** + 本轮补齐服务端导出桥接 | 高 | Android 下 ssh 隐藏 + 400 |
| P0-E 安全基线（备份/明文/加固/端口错误屏） | **工程已闭环** | 高 | 备份排除/明文拒绝/端口占用 |
| go/no-go 结论 | **代码侧可进入 P1–P4 且 APK 可构建**；exec 与 16KB 真机行为未实测前，发布链路仍阻塞 | — | 见 §8 |

---

## 1. P0-A 运行时可行性

### 1.1 Android 10+ 可执行文件限制（API 29+）

**[机制]** Android 10（API 29）起，targetSdk ≥29 的应用不能 `execve` 应用可写目录中的文件
（SELinux `file_type`/`execute` 策略收紧）。绕过方式：native 库以 `lib*.so` 放入 `jniLibs/<abi>/`，
安装时由系统解压到 `nativeLibraryDir`（只读、可执行），再 symlink 映射为可执行名。

**[证据]** `NodeRuntimeManager`（`android/android/app/src/main/java/com/agentlray/app/NodeRuntimeManager.kt`）
从 `applicationInfo.nativeLibraryDir` 取 `libproot.so` / `libproot-loader.so`，经 `PROOT_LOADER`
指向 loader；`app/build.gradle` 设 `useLegacyPackaging = true`（对应 `extractNativeLibs`）——与
设计 §4.3 完全对齐。

**[推断]** 该方案是社区对 PRoot/Termux 类应用的**标准做法**，可行性高。**风险点**：
- `useLegacyPackaging` 在 AGP 8.7 下会额外解压全部 jniLibs，体积与安装时长上升；
- 部分厂商 ROM 对 `lib*.so` 的 exec 仍有额外限制，需真机（API 26/29/33/35）逐一验证；
- 若目标渠道（Play）拒绝该模式，只能退 targetSdk 28 侧载（设计 §4.3 已记录）。

### 1.2 16KB page size（Android 15+）

**[机制]** Android 15 起部分设备使用 16KB 内存页；native 库必须按 16KB 对齐，否则 `dlopen`/
`execve` 失败。

**[证据]** 设计 §4.3 要求 proot 重编译加 `-Wl,-z,max-page-size=16384`；`jniLibs/README.md` 记录了
该编译参数；`app/build.gradle` 以注释保留该约束。

**[实测]** 本机 `readelf -lW` 量测（2026-11-21）：
- `libproot.so` LOAD `Align 0x4000`（16KB）、`libproot-loader.so` LOAD `Align 0x4000`；
- rootfs 内 `usr/local/bin/node`、`libc.so.6`、`ld-linux-aarch64.so.1` 的 LOAD 均为 `Align 0x10000`（64KB）。

即打包进 APK 的原生库与 guest 关键 ELF 均满足 16KB 页对齐要求。**剩余风险**：16KB 内核下
PRoot ptrace 与 loader 映射行为仍需真机实测（对齐不等于可运行）。

**[证据]** 量测命令：`readelf -lW app/src/main/jniLibs/arm64-v8a/libproot.so`、
`readelf -lW <rootfs>/usr/local/bin/node`。

### 1.3 PRoot / rootfs / Node

**[机制]** PRoot 用 ptrace 做系统调用拦截，把 guest rootfs 的路径/权限映射到 host；不要求真实 root。
rootfs 用 debootstrap minbase + Node 官方 tarball。

**[证据]** `build-rootfs.sh`（arm64/x86_64 双 ABI）、`RootfsInstaller`（tgz+tar 解压、符号/硬链接、
权限位、原子替换）均已落地；`bundle-app.mjs` 本机实测产出 `app-bundle.tgz`（5.1MB）且
`require('@lukeburns/clatterjs'/'ws'/'express'/'zod')` 冒烟通过。

**[实测]** rootfs（Ubuntu base 22.04 arm64 + Node 22.15.0 + CA/tzdata）194 万字节级内容：
未压缩 tar 247MB、gzip 76MB，6047 文件 / 1281 目录 / 735 硬链接 / 211 符号链接；
`RootfsInstaller` 逐一保留四种条目类型与 POSIX 权限位。

**[已消除风险] zstd-jni ABI**：Maven Central 上 `com.github.luben:zstd-jni` **无 Android 分类器**
（仅 `linux_aarch64` 等 glibc 变体，bionic 无法 `dlopen`；版本号亦为 `1.5.6-4` 连字符格式）。
已按设计 §12 偏差②的兜底改为 **gzip**（Android 内置 `GZIPInputStream`，零原生依赖），
`zstdVersion`/依赖已移除；代价是 rootfs 资产 52MB→76MB、APK 约 96MB（预算 ≤350MB 内）。

**[推断]** 可行性高。**剩余风险**：
- rootfs 冷启动/解压耗时未实测（真机首启解压 247MB）。
- 部分内核对 seccomp 敏感：已预留 `PROOT_NO_SECCOMP=1`、`PROOT_TMP_DIR`（`NodeRuntimeManager`），真机验证。

### 1.4 dsh 握手 / SSE

**[机制]** dsh 经 Noise IK 加密通道连中继；SSE 走本地 loopback 3801。PRoot 与宿主共享网络命名空间，
`127.0.0.1:3801` 对 WebView 可达（设计 §4.2）。

**[证据]** `lib/dsh/*` 在 PRoot 下原样运行（`bin/thin-server.js`/`lib/transport.js` 未改）；薄服务
`/api/version` 由 `NodeRuntimeManager.awaitHealthy` 轮询判定就绪。

**[推断]** dsh 栈（Node ≥22.12 硬性要求）由官方 Node 22/24 满足。**必验**：真机 dsh 握手连通、
SSE 连续 5 分钟（P0-A 验收原文）。

---

## 2. P0-B 打包闭环

**[证据]**
- `RootfsInstaller.ensure()`：按版本标记（`versionName-versionCode-abi`）解压 rootfs 与 app bundle；
  分层到 `filesDir/runtime/rootfs` + `filesDir/app`；`.agentlray` 持久数据升级永不覆盖。
- SHA-256 校验（manifest）+「临时目录 + rename」原子替换；符号/硬链接 + POSIX 权限保留。
- 三路径：全新安装（无标记→解压）、覆盖升级（版本标记变化→重建，保留 `.agentlray`）、清除数据
  （filesDir 清空→重建）。

**[推断]** 工程闭环，确定性高。**必验**：真机三路径各启动一次（P0-B 验收原文）；校验绑定路径
`/opt/agentlray`、`/home/agentlray/.agentlray` 在 rootfs 预创建（`RootfsInstaller` 已 `mkdirs`）。

---

## 3. P0-C 生命周期

**[证据]** `NodeRuntimeManager`（串行 executor + 单 proot 进程）、`MainActivity`（onStart/onStop 5s
防抖/onDestroy）、`RuntimeWatchdog`（孤儿清理）、`RuntimeLogRing`（环形缓冲）。崩溃指数退避
1s/2s/4s 最多 3 次 → 错误屏（日志尾部 + 重试）。`proot --kill-on-exit` 连带清 tracee。

**[推断]** 逻辑完整。**必验**：前后台往返 ≥3、崩溃自动重启、旋转不重载（Manifest `configChanges` 全项）、
无残留进程占 3801。

---

## 4. P0-D 能力面

**[证据]**
- `lib/hosts.js` `sshDisabled`/`assertTransportAllowed`：`AGENTLRAY_DISABLE_SSH=1` 时 create/update/open
  拒绝 ssh（`e.code='transport-disabled'` → 400）；薄服务 `resolveThinBootHost` 过滤非 dsh。
- `lib/routes/mode.js`：`capabilities.transports=['dsh']` + `nativeSave=true`。
- 前端：`HostFormDialog` 按 capabilities 过滤传输、默认 dsh；`download.ts` nativeSave 桥接。
- **本轮新增**：`runExport` md/html 服务端导出在 Android 走 `fetch(exportUrl) → saveTextFile`
  （`exports.ts`），补齐设计 §7.6/§12 记录的缺口；`serverExportFilename` 解析 `Content-Disposition`。

**[推断]** 能力面闭环。**必验**：Android 下新建主机只出现 dsh；ssh 请求 400；导出落盘/分享成功。

---

## 5. P0-E 安全基线

**[证据]**
- Manifest `allowBackup="false"` + `dataExtractionRules` 排除 `.agentlray`（secret/hosts 不进云备份）。
- `network_security_config.xml` 仅 `127.0.0.1`/`localhost` cleartext。
- `SecurityConfig.harden`：关 file/content access、禁混合内容、release 关调试；`MainActivity` 就绪前
  不 loadUrl（占位页），端口占用时 `awaitHealthy` 超时 → 错误屏（不加载未知页面）。
- `lib/secret.js` AES-256-GCM；PRoot 仅同进程权限，不构成安全边界（§8.1）。

**[推断]** 闭环。**必验**：备份不含 `.agentlray`；非 loopback 明文被拒；占用 3801 时不加载 WebView。

---

## 6. 本轮新增工程产物（P1–P4 落地）

| 阶段 | 产物 | 位置 |
| --- | --- | --- |
| P2 | 服务端导出 fetch→saveFile 桥接 + Content-Disposition 文件名解析 | `frontend/src/views/sessions/exports.ts` |
| P3 | 远端版本兼容判定（单一真源）+ `remoteVersion`/`compatible` 序列化 + 升级提示横幅 | `lib/version-compat.js`、`lib/routes/hosts.js`、`frontend/src/components/HostCompatBanner.tsx`、`frontend/src/api/types.ts`、`test/version-compat.test.js`（6 例） |
| P4 | release 签名注入 + R8 压缩/混淆规则 | `android/android/app/build.gradle`、`proguard-rules.pro` |
| P4 | 原生崩溃落盘基线（Sentry 接入点） | `android/android/app/src/main/java/com/agentlray/app/CrashLog.kt`、`App.kt` |

---

## 7. 验证记录

- 前端：`npm run build:ui`（tsc -b + vite）通过；服务端导出桥接与 compat banner 编译无误。
- 后端：`npm test` **757/757** 通过（含新增 `test/version-compat.test.js` 6 例）。
- `test/thin-android-guards.test.js`、`test/thin-service.test.js` 未改动即通过（无回归）。
- **APK 构建（本机自举，2026-11-21）**：JDK 21（华为镜像 OpenJDK 21+35）+ Gradle 8.11 +
  AGP 8.7.2 + compileSdk 35 / build-tools 35 → `:app:assembleDebug` BUILD SUCCESSFUL，
  `app-debug.apk` **96MB**（debug 签名）。
  - APK 内资产：`assets/runtime/{rootfs-arm64.tgz 78,954,685 B, app-bundle.tgz 5,254,853 B}`，
    与 `*.manifest.json` 的 sha256 逐字节一致；
  - APK 内原生库：`lib/arm64-v8a/{libproot.so 259,832 B, libproot-loader.so 18,136 B}` +
    `assets/runtime/lib/{libtalloc.so.2, libandroid-shmem.so}`；
  - **坑**：AGP/aapt2 会对 `assets/**.gz` 解压并去掉 `.gz` 后缀（资产名变 `rootfs-arm64.tar`），
    导致 `RootfsInstaller` 找不到资产 → 资产统一改名为 `.tgz`。
- 工具链获取脚本：`android/scripts/fetch-proot.sh`（Termux aarch64 预编译 proot/loader/libtalloc/
  libandroid-shmem，幂等）。

---

## 8. go/no-go 与真机必验清单

**代码侧判定：可进入 P1–P4**（工程骨架 + 能力面 + 生命周期 + 打包 + 本轮 P2/P3/P4 均已落地并通过
后端/前端验证）。

**发布链路仍有两处高险，未实测前不得视为通过**（第三项 zstd-jni ABI 已由 gzip 方案消除）：
1. Android 10+ `exec` 限制（`jniLibs` + `useLegacyPackaging`）——API 29/33/35 真机；
   本机无 adb 设备，`nativeLibraryDir` 下 `lib*.so` 的 `execve` 行为未验；
2. 16KB page size——对齐已量测通过（§1.2），但 16KB 设备上 PRoot ptrace/loader 行为未验。

**真机必验（对照设计 §9 P0 验收原文）**：
- [ ] arm64 真机（API 26/29/33/35）`/api/version` 200；dsh 握手连通；会话列表可见；SSE 连续 5 分钟；
- [ ] `exec` 限制结论；16KB 设备上 PRoot 启动（对齐已通过，行为待验）；
- [ ] rootfs/app bundle 全新安装 / 覆盖升级 / 清除数据三路径；
- [ ] 前后台往返 ≥3、崩溃自动重启、旋转不重载、无残留进程占 3801；
- [ ] 备份不含 `.agentlray`；非 127.0.0.1 明文被拒；占用 3801 时不加载 WebView；
- [ ] 记录 APK 体积与首启解压后 filesDir 占用（预算 APK ≤350MB）。

完成以上真机验证后，回到设计文档 §12 把「P0 待真机验证」更新为已验证，再进入发布。
