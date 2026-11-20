# AgentLRay Android 壳

Android 客户端：**极简壳**（Capacitor WebView）+ **PRoot + Ubuntu + Node 22/24** 承载 dsh-only 薄服务
（`bin/thin-server.js`），连接远端完整 AgentLRay 并套壳呈现其 web 页面。

> 决策与蓝图：[`docs/.local/design-android-mobile-app.zh-CN.md`](../docs/.local/design-android-mobile-app.zh-CN.md)（v1.1，PRoot 承载）、[`docs/design/adr-0008-android-mobile-app.zh-CN.md`](../docs/design/adr-0008-android-mobile-app.zh-CN.md)。
> **状态：P0 未验证**。本工程的源码/脚本已就绪，但 APK 构建、真机启动、exec/16KB 限制等需在带
> Android SDK 与真机的环境完成 P0 门禁（见下）。

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
│   │       ├── assets/runtime/           # rootfs-<abi>.tar.zst + app-bundle.tar.zst（脚本产出，不入库）
│   │       └── jniLibs/arm64-v8a/        # libproot.so / libproot-loader.so（P0 产出，不入库）
└── scripts/
    ├── build-rootfs.sh                   # debootstrap + Node tarball → rootfs-<abi>.tar.zst
    ├── bundle-app.mjs                    # 收集 bin/lib/frontend/dist/node_modules → app-bundle.tar.zst
    └── package-runtime.mjs               # tar+zstd 压缩 + SHA-256 清单（供 RootfsInstaller 校验）
```

## 构建步骤

```bash
# 0) 仓库根：构建前端 dist（app bundle 依赖它）
cd <repo> && npm run build:ui

# 1) 前端运行时闭包 → app-bundle.tar.zst（本机已可运行）
node android/scripts/bundle-app.mjs
#   产物：android/build/app-bundle/{staging,app-bundle.tar.zst,app.manifest.json}

# 2) rootfs（需 Linux + root/debootstrap；交叉架构需 qemu-user）
bash android/scripts/build-rootfs.sh arm64
#   产物：android/android/app/src/main/assets/runtime/rootfs-arm64.tar.zst(+manifest)

# 3) PRoot 二进制（P0：从源码重编译，放入 jniLibs/arm64-v8a/libproot.so + libproot-loader.so）
#    需 -Wl,-z,max-page-size=16384（Android 15+ 16KB 页）

# 4) 把 bundle 放到 assets/runtime 并同步 Capacitor 原生工程
cp android/build/app-bundle/app-bundle.tar.zst android/build/app-bundle/app.manifest.json \
   android/android/app/src/main/assets/runtime/
cd android && npm install && npx cap sync android

# 5) 构建 APK（需 Android SDK / JDK 17）
cd android/android && ./gradlew assembleRelease    # 或 assembleDebug
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

## P0 门禁（go/no-go，未完成前不得进入 P1）

- [ ] PRoot + rootfs + Node 在 **arm64 真机**（API 26/29/33/35）启动 `thin-server`，`/api/version` 200；
- [ ] dsh 握手连通、会话列表可见、SSE 连续 5 分钟；
- [ ] Android 10+ `exec` 限制（jniLibs + `useLegacyPackaging`）与 Android 15 16KB 页结论；
- [ ] rootfs/app bundle 全新安装 / 覆盖升级 / 清除数据三路径均可启动；
- [ ] 前后台往返 ≥3、崩溃自动重启、旋转不重载、无残留进程占 3801；
- [ ] 备份不含 `.agentlray`；非 127.0.0.1 明文被拒；占用 3801 时不加载 WebView；
- [ ] APK 体积与首启解压后 filesDir 占用记录（预算 APK ≤350MB）。

## 已知偏差 / 待验证项

1. **目录布局**：design §3 的扁平树按标准 Capacitor 布局落在 `android/android/`（`cap sync` 要求）。
2. **解压实现**：`RootfsInstaller` 用 `org.apache.commons:commons-compress` + `com.github.luben:zstd-jni`
   解压 `.tar.zst`（支持符号/硬链接与权限位）。**zstd-jni 的 Android ABI 兼容性需 P0 验证**；
   若不兼容，改用随包静态 `zstd`/`tar` 或改存未压缩 tar。
3. **下载桥接**：前端 `saveTextFile()` 在 `nativeSave=true` 且探测到 `window.Capacitor.Plugins.SaveFile`
   时走原生；否则 blob 下载。服务端 GET 导出（`a.href=exportUrl`）仍为浏览器式下载，Android 上
   需 P2 补齐（fetch→saveFile）。
4. **签名/加固/崩溃上报（Sentry）**：P4，未在本轮实现。
