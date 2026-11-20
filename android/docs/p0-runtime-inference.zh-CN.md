# P0 运行时可行性推断（Android 移动端 App）

> 类型：P0 门禁的**静态推断分析**。当前开发环境无 Android SDK/真机，无法做 APK 构建与真机冒烟；
> 本文件基于既有源码证据、Android 平台机制与 PRoot/Node 官方产物，逐项推断 P0-A~P0-E 的可行性、
> 风险与真机必验项。**推断 ≠ 验证**：每项结论都标注[证据]/[机制]/[推断]，真机实测前不得把推断
> 当已通过。
> 关联：[`docs/design/design-android-mobile-app.zh-CN.md`](../../docs/design/design-android-mobile-app.zh-CN.md)
> （v1.1，§4 运行时 / §6 打包 / §7 生命周期 / §8 安全 / §9 P0 门禁）、[`adr-0008`](../../docs/design/adr-0008-android-mobile-app.zh-CN.md)。

---

## 0. 结论摘要

| P0 项 | 推断 | 确定性 | 真机必验 |
| --- | --- | --- | --- |
| P0-A 运行时可行性（exec/16KB/proot/rootfs） | **可行但有三处高险**：exec 限制、16KB 对齐、zstd-jni ABI | 中 | 必验，决定 go/no-go |
| P0-B 打包闭环（assets→filesDir/分层/升级） | **工程已闭环**，代码路径完整 | 高 | 全新/覆盖/清数据三路径 |
| P0-C 生命周期（spawn/前后台/崩溃/孤儿/旋转） | **工程已闭环**，逻辑完整 | 高 | 前后台/崩溃/旋转/端口 |
| P0-D 能力面（transports/nativeSave/导出桥接） | **工程已闭环** + 本轮补齐服务端导出桥接 | 高 | Android 下 ssh 隐藏 + 400 |
| P0-E 安全基线（备份/明文/加固/端口错误屏） | **工程已闭环** | 高 | 备份排除/明文拒绝/端口占用 |
| go/no-go 结论 | **代码侧可进入 P1–P4**；但 exec/16KB/zstd-jni 三处高险未实测前，发布链路仍阻塞 | — | 见 §8 |

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

**[推断]** Node 官方 linux-arm64 二进制是否 16KB 对齐**未知**（官方 tarball 面向通用 Linux，
未承诺 Android 16KB 页）。若 Node 或 proot 未对齐，16KB 设备上会启动失败。**必验**：在 16KB
设备（如 Pixel 设备 API 35+）实测；或改用 16KB 对齐的 Node 构建。这是**高险**之一。

### 1.3 PRoot / rootfs / Node

**[机制]** PRoot 用 ptrace 做系统调用拦截，把 guest rootfs 的路径/权限映射到 host；不要求真实 root。
rootfs 用 debootstrap minbase + Node 官方 tarball。

**[证据]** `build-rootfs.sh`（arm64/x86_64 双 ABI）、`RootfsInstaller`（zstd+tar 解压、符号/硬链接、
权限位、原子替换）均已落地；`bundle-app.mjs` 本机实测产出 `app-bundle.tar.zst`（2.4MB）且
`require('@lukeburns/clatterjs'/'ws'/'express'/'zod')` 冒烟通过。

**[推断]** 可行性高。**风险**：
- **zstd-jni ABI 兼容性**：`com.github.luben:zstd-jni` 是否有 `arm64-v8a` 的 Android ABI 变体未验证
  （设计 §12 偏差②已记录）。若不兼容 → 改随包静态 zstd/tar 或未压缩 tar（`RootfsInstaller` 已留扩展点）。
- rootfs 体积/冷启动/内存未实测（预算 150–250MB）。
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

---

## 8. go/no-go 与真机必验清单

**代码侧判定：可进入 P1–P4**（工程骨架 + 能力面 + 生命周期 + 打包 + 本轮 P2/P3/P4 均已落地并通过
后端/前端验证）。

**但发布链路仍有三处高险，未实测前不得视为通过**：
1. Android 10+ `exec` 限制（`jniLibs` + `useLegacyPackaging`）——API 29/33/35 真机；
2. 16KB page size——Android 15+ 16KB 设备（Node/proot 是否 16KB 对齐）；
3. `zstd-jni` Android ABI——`RootfsInstaller` 解压路径。

**真机必验（对照设计 §9 P0 验收原文）**：
- [ ] arm64 真机（API 26/29/33/35）`/api/version` 200；dsh 握手连通；会话列表可见；SSE 连续 5 分钟；
- [ ] `exec` 限制与 16KB 结论；
- [ ] rootfs/app bundle 全新安装 / 覆盖升级 / 清除数据三路径；
- [ ] 前后台往返 ≥3、崩溃自动重启、旋转不重载、无残留进程占 3801；
- [ ] 备份不含 `.agentlray`；非 127.0.0.1 明文被拒；占用 3801 时不加载 WebView；
- [ ] 记录 APK 体积与首启解压后 filesDir 占用（预算 APK ≤350MB）。

完成以上真机验证后，回到设计文档 §12 把「P0 待真机验证」更新为已验证，再进入发布。
