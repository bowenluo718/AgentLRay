# assets/runtime —— 运行时资产（构建产物，不入库）

本目录在构建 APK 前由脚本产出：

- `rootfs-<abi>.tar.zst`：Ubuntu minbase + Node 22/24 最小 rootfs（`scripts/build-rootfs.sh`）
- `rootfs-<abi>.manifest.json`：`{ version, abi, sha256 }`（`scripts/package-runtime.mjs`）
- `app-bundle.tar.zst`：AgentLRay 运行时闭包（`scripts/bundle-app.mjs` 产出 staging，`package-runtime.mjs` 压缩）
- `app.manifest.json`：`{ version, sha256 }`

二进制体积大（rootfs 150–250MB），不提交仓库；`.gitignore` 已排除 `*.tar.zst`。
运行时由 `RootfsInstaller` 解压到 `filesDir/runtime/rootfs` 与 `filesDir/app`。
