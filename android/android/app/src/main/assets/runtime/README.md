# assets/runtime —— 运行时资产（构建产物，不入库）

本目录在构建 APK 前由脚本产出：

- `rootfs-<abi>.tgz`：Ubuntu minbase + Node 22/24 最小 rootfs（`scripts/build-rootfs.sh`）
- `rootfs-<abi>.manifest.json`：`{ version, sha256, size }`（`scripts/package-runtime.mjs`）
- `app-bundle.tgz`：AgentLRay 运行时闭包（`scripts/bundle-app.mjs` 产出 staging，`package-runtime.mjs` 压缩）
- `app.manifest.json`：`{ version, sha256 }`

体积参考：rootfs 未压缩 tar 约 247MB、`.tgz` 约 76MB（arm64 + Node 22.15）；不提交仓库，`.gitignore` 已排除 `*.tgz`。

> 资产后缀必须是 `.tgz`：AGP/aapt2 会解压 `assets/**.gz` 并去掉后缀（资产名变成 `rootfs-arm64.tar`），
> 导致 `RootfsInstaller` 找不到资产。

运行时由 `RootfsInstaller` 解压到 `filesDir/runtime/rootfs` 与 `filesDir/app`。
