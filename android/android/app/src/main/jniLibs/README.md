# jniLibs —— PRoot 二进制（构建产物，不入库）

放此处（按 ABI 子目录），Android 安装时解压到 `nativeLibraryDir`，绕过 Android 10+ 可写目录
exec 限制（design-android-mobile-app §4.3）：

```
arm64-v8a/
  libproot.so          # PRoot 主程序（重命名自 proot，lib*.so 命名以通过包扫描）
  libproot-loader.so   # PRoot loader（PROOT_LOADER 指向此文件）
```

来源：P0 阶段从 PRoot 源码重编译（arm64，`-Wl,-z,max-page-size=16384` 满足 Android 15+ 16KB 页），
版本固定并在 README 记录 SHA-256。`.gitignore` 已排除 `**/*.so`。
