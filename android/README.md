# AgentLRay Android 壳

Android 客户端：**极简壳**（Capacitor WebView）+ **PRoot + Ubuntu + Node 22/24** 承载 dsh-only 薄服务
（`bin/thin-server.js`），连接远端完整 AgentLRay 并套壳呈现其 web 页面。

> 决策与蓝图：[`docs/design/design-android-mobile-app.zh-CN.md`](../docs/design/design-android-mobile-app.zh-CN.md)（v1.1，PRoot 承载）、[`docs/design/adr-0008-android-mobile-app.zh-CN.md`](../docs/design/adr-0008-android-mobile-app.zh-CN.md)。
> **状态：P1–P3 已实现、P4 部分实现；P0 真机门禁未验证**（已做静态推断，见
> [`docs/p0-runtime-inference.zh-CN.md`](docs/p0-runtime-inference.zh-CN.md)）。APK 构建、真机启动、
> exec/16KB 限制需在带 Android SDK 与真机的环境完成。

## 目录

```
android/
├── package.json / capacitor.config.ts   # Capacitor 工程根
├── www/index.html                        # 启动占位页（就绪后 loadUrl 到 3801）
├── android/                              # Capacitor 原生平台目录（等价 `cap add android` 产物）
│   ├── build.gradle / settings.gradle / variables.gradle / gradle.properties
│   ├── app/
│   │   ├── build.gradle
│   │   └── src/main/
│   │       ├── AndroidManifest.xml
│   │       ├── java/com/agentlray/app/   # Kotlin：App/MainActivity/NodeRuntimeManager/RootfsInstaller/
│   │       │                            #         RuntimeLogRing/RuntimeWatchdog/SecurityConfig/SaveFilePlugin
│   │       ├── res/xml/{network_security_config,data_extraction_rules,file_paths}.xml
│   │       ├── assets/runtime/           # rootfs-<abi>.tgz + app-bundle.tgz（脚本产出，不入库）
│   │       └── jniLibs/arm64-v8a/        # libproot.so / libproot-loader.so（P0 产出，不入库）
└── scripts/
    ├── build-rootfs.sh                   # debootstrap + Node tarball → rootfs-<abi>.tgz
    ├── bundle-app.mjs                    # 收集 bin/lib/frontend/dist/node_modules → app-bundle.tgz
    └── package-runtime.mjs               # tar+zstd 压缩 + SHA-256 清单（供 RootfsInstaller 校验）
```

## 构建步骤

> **环境**：JDK 21（Capacitor 7 的 `capacitor-android` 要求 Java 21）+ Android SDK（compileSdk 35 / build-tools 35）。
> 本仓库的 `app/build.gradle` 自行设置 Kotlin/Java 17，但 Gradle 进程需 JDK 21。

```bash
# 0) 仓库根：构建前端 dist（app bundle 依赖它）
cd <repo> && npm run build:ui

# 1) 前端运行时闭包 → app-bundle.tgz（本机已可运行）
node android/scripts/bundle-app.mjs
#   产物：android/build/app-bundle/{staging,app-bundle.tgz,app.manifest.json}

# 2) rootfs：二选一
#    a) 有 root/debootstrap/qemu-user：bash android/scripts/build-rootfs.sh arm64
#    b) 无 root（推荐 CI/开发机）：下载 Ubuntu base arm64 + Node 官方 arm64，手工组装
#       curl -O https://cdimage.ubuntu.com/ubuntu-base/releases/22.04/release/ubuntu-base-22.04.5-base-arm64.tar.gz
#       tar -xzf ubuntu-base-22.04.5-base-arm64.tar.gz -C rootfs/
#       tar -xJf node-v22.15.0-linux-arm64.tar.xz -C rootfs/usr/local --strip-components=1
#       # 补 ca-certificates（Mozilla bundle）与 tzdata，再：
#       node android/scripts/package-runtime.mjs --src rootfs --out .../rootfs-arm64.tgz \
#         --manifest .../rootfs-arm64.manifest.json --version node22.15.0-arm64

# 3) PRoot 二进制：Termux 官方 aarch64 预编译（无 NDK 交叉编译链时）
bash android/scripts/fetch-proot.sh arm64      # 需要 patchelf（pip install patchelf）
#   → jniLibs/arm64-v8a/{libproot.so,libproot-loader.so,libtalloc.so,libandroid-shmem.so}
#   依赖库与 proot 同目录，proot 的 DT_RUNPATH 被 patchelf 改为 ${ORIGIN}：
#   Android 8+ 的 bionic linker 会忽略 app 进程的 LD_LIBRARY_PATH，只能靠 ELF 内嵌 RUNPATH。

# 4) 把 bundle/rootfs 放到 assets/runtime 并同步 Capacitor 原生工程
cp android/build/app-bundle/app-bundle.tgz android/build/app-bundle/app.manifest.json \
   android/android/app/src/main/assets/runtime/
cd android && npm install && npx cap sync android

# 5) 构建 APK（需 Android SDK / build-tools 35 / **JDK 21**）
cd android/android && ./gradlew assembleDebug     # 或 assembleRelease

# 6) P4 正式签名（可选）：release 会经环境变量注入 keystore（不入库）
#    AGENTLRAY_KEYSTORE=... AGENTLRAY_KEYSTORE_PASSWORD=... \
#    AGENTLRAY_KEY_ALIAS=... AGENTLRAY_KEY_PASSWORD=... ./gradlew assembleRelease
#    未配置时 release 退回 debug 签名（仅本地冒烟）；release 已启用 R8 压缩/混淆
#    （proguard-rules.pro）。
```

> `android/android/` 是 Capacitor 生成的原生平台目录。本仓库已提供关键**来源覆盖**（Kotlin、
> Manifest、res、build.gradle）。若重新 `npx cap add android`，需重新应用这些覆盖（尤其
> `app/build.gradle` 的 `useLegacyPackaging=true` 与依赖、Manifest 的 `allowBackup=false`/
> `networkSecurityConfig`/FileProvider、`MainActivity` 的插件注册与就绪门控、`App` 的单例启动）。
> 主题 `@style/AppTheme`、`@mipmap/ic_launcher` 由 Capacitor 模板提供。

## 运行时行为

- **启动**：`App.onCreate` 后台 `RootfsInstaller.ensure()`（校验 SHA-256 → 解压到 filesDir）→
  `NodeRuntimeManager.start()`（spawn `proot`）→ 轮询 `/api/version`（200ms，≤20s）→ 就绪后
  `MainActivity` 将 WebView 导航到 `http://127.0.0.1:3801`。
- **前后台**：`onStop` 防抖 5s 后 `SIGTERM`（`proot --kill-on-exit`）→ 3s 后 `SIGKILL`；`onStart`
  取消防抖并重启（串行化，避免 3801 `EADDRINUSE`）。
- **崩溃**：非主动退出 → 指数退避重启（1s/2s/4s，最多 3 次）→ 超限错误屏（日志尾部 + 重试）。
- **孤儿清理**：启动读 `runtime/node.pid`，`/proc/<pid>/cmdline` 命中则 `SIGKILL`。
- **能力面**：`/api/mode` 下发 `capabilities.transports=['dsh']`（`AGENTLRAY_DISABLE_SSH=1`）与
  `nativeSave=true`（`AGENTLRAY_NATIVE_SAVE=1`）；前端据此隐藏 ssh 选项、导出走原生 SaveFile。

## 启动命令（PRoot，§4.2）

```
proot --kill-on-exit -0 -r <filesDir>/runtime/rootfs \
  -b <filesDir>/app:/opt/agentlray \
  -b <filesDir>/.agentlray:/home/agentlray/.agentlray \
  -b /dev -b /proc -b /sys -w /opt/agentlray \
  /usr/bin/env AGENTLRAY_HOME=/home/agentlray AGENTLRAY_DISABLE_SSH=1 \
    AGENTLRAY_NATIVE_SAVE=1 PORT=3801 HOST=127.0.0.1 \
  /usr/local/bin/node /opt/agentlray/bin/thin-server.js
```

## P0 门禁（go/no-go）

> 无真机环境下已做**静态推断**：[`docs/p0-runtime-inference.zh-CN.md`](docs/p0-runtime-inference.zh-CN.md)
> （exec/16KB/zstd-jni ABI 三处高险 + 逐项证据）。以下勾选项为真机实测项，未完成前发布链路阻塞。

- [ ] PRoot + rootfs + Node 在 **arm64 真机**（API 26/29/33/35）启动 `thin-server`，`/api/version` 200；
- [ ] dsh 握手连通、会话列表可见、SSE 连续 5 分钟；
- [ ] Android 10+ `exec` 限制（jniLibs + `useLegacyPackaging`）与 Android 15 16KB 页结论；
- [ ] rootfs/app bundle 全新安装 / 覆盖升级 / 清除数据三路径均可启动；
- [ ] 前后台往返 ≥3、崩溃自动重启、旋转不重载、无残留进程占 3801；
- [ ] 备份不含 `.agentlray`；非 127.0.0.1 明文被拒；占用 3801 时不加载 WebView；
- [ ] APK 体积与首启解压后 filesDir 占用记录（预算 APK ≤350MB）。

## 调试入口：导出用户配置

debug 构建在界面右下角悬浮「同步配置」按钮（`MainActivity.installSyncFab`）：点击后把应用私有目录
`filesDir/.agentlray`（`hosts.json`/`settings.json`/`secret`/dsh 凭据）**递归同步**到

```
/sdcard/Android/data/com.agentlray.app/files/agentlray
```

- 选**应用专属外部目录**（`Context.getExternalFilesDir(null)`）：免任何存储权限，且手机文件管理器
  可直接浏览 `Android/data/<pkg>/files/`（无需 adb `run-as`）。
- 实现：`DataDirSyncer`（镜像覆盖拷贝，不删目标侧多余文件；符号链接/特殊文件跳过），结果计数
  与失败项经 Toast 展示，同时写入运行日志环。
- 拷贝在后台线程执行（`agentlray-sync`），完成后回主线程提示。
- `secret` 为 AES-256-GCM 密文，导出后仍是密文（设计如此）。

## 已知偏差 / 待验证项

1. **目录布局**：design §3 的扁平树按标准 Capacitor 布局落在 `android/android/`（`cap sync` 要求）。
2. **解压实现**：`RootfsInstaller` 用 `org.apache.commons:commons-compress` + Android 内置 `GZIPInputStream`
   解压 `.tgz`（支持符号/硬链接与权限位）。原设计为 `.tar.zst` + `zstd-jni`，但 zstd-jni
   **无 Android ABI 分类器**（`linux_aarch64` 为 glibc 链接，bionic 无法 `dlopen`），按 design 的
   「解压兼容性兜底」改为 gzip：零原生依赖、APK 增大约 20MB（rootfs 52MB→约 70MB）。
3. **服务端导出桥接**：Android WebView 不支持 `<a href>` 服务端附件下载，`runExport` 的 md/html
   分支在 `nativeSave` 时改走 `fetch(exportUrl) → saveTextFile`（`frontend/src/views/sessions/exports.ts`）；
   桌面/常规浏览器仍走浏览器下载。
4. **P0 真机验证未完成**：见 `android/docs/p0-runtime-inference.zh-CN.md`（静态推断）与下方
   「P0 门禁」清单；exec/16KB/zstd-jni ABI 三处高险须真机实测后方可发布。
5. **崩溃上报**：`CrashLog` 已把未捕获异常 + 运行时日志尾部落盘（Sentry 接入点）；厂商加固/
   正式 Sentry SDK 接入属发布前工程，未接入。
