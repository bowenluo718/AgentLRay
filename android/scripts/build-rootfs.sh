#!/usr/bin/env bash
# 最小 rootfs 构建（design-android-mobile-app §6.1）。
#
# 需要在 Linux（或 docker）中有 root/debootstrap/chroot/qemu-user（交叉架构时）：
#   bash scripts/build-rootfs.sh arm64
#   bash scripts/build-rootfs.sh x86_64
#
# 产物：android/build/rootfs/<abi>/ 与 assets/runtime/rootfs-<abi>.tgz(+manifest)
#
# 说明：
# - Ubuntu bookworm minbase + Node 官方 linux-<arch> tarball（Node ≥22.15，满足 require(esm)
#   与全局 WebSocket；见 §2.3）；
# - 预创建 PRoot bind target（/opt/agentlray、/home/agentlray/.agentlray）；
# - ldd 校验 node 动态依赖；rootfs 目标体积 150–250MB。
set -euo pipefail

ABI="${1:-arm64}"
case "$ABI" in
  arm64)   DEB_ARCH="arm64"; NODE_ARCH="arm64";;
  x86_64)  DEB_ARCH="amd64"; NODE_ARCH="x64";;
  *) echo "用法：$0 <arm64|x86_64>"; exit 2;;
esac

NODE_VERSION="${NODE_VERSION:-22.15.0}"   # ≥22.15：Node 22 LTS；可覆盖为 24.x
UBUNTU_SUITE="${UBUNTU_SUITE:-bookworm}"
MIRROR="${UBUNTU_MIRROR:-http://ports.ubuntu.com/ubuntu-ports}"  # amd64 用 archive.ubuntu.com
if [ "$DEB_ARCH" = "amd64" ]; then MIRROR="${UBUNTU_MIRROR:-http://archive.ubuntu.com/ubuntu}"; fi

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD_DIR="$REPO_ROOT/android/build/rootfs/$ABI"
ROOTFS="$BUILD_DIR/rootfs"
ASSETS="$REPO_ROOT/android/android/app/src/main/assets/runtime"

echo "==> 构建 rootfs（abi=$ABI, suite=$UBUNTU_SUITE, node=$NODE_VERSION）"
rm -rf "$BUILD_DIR"
mkdir -p "$ROOTFS"

# 1) debootstrap minbase
debootstrap --arch="$DEB_ARCH" --variant=minbase "$UBUNTU_SUITE" "$ROOTFS" "$MIRROR"

# 2) 最小运行依赖
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get update
chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  libstdc++6 ca-certificates tzdata
chroot "$ROOTFS" apt-get clean
rm -rf "$ROOTFS/var/lib/apt/lists/"*

# 3) 官方 Node 二进制
NODE_TAR="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TAR}"
echo "==> 下载 $NODE_URL"
curl -fsSL "$NODE_URL" -o "$BUILD_DIR/$NODE_TAR"
NODE_SHA="$(sha256sum "$BUILD_DIR/$NODE_TAR" | awk '{print $1}')"
echo "    node tarball sha256=$NODE_SHA"
tar -xJf "$BUILD_DIR/$NODE_TAR" -C "$ROOTFS/usr/local" --strip-components=1

# 4) 预创建 bind target（§4.2：-b 目标必须存在）
mkdir -p "$ROOTFS/opt/agentlray" "$ROOTFS/home/agentlray/.agentlray"

# 5) 校验 node 动态依赖
echo "==> ldd /usr/local/bin/node"
chroot "$ROOTFS" ldd /usr/local/bin/node > "$BUILD_DIR/ldd-node.txt" || true
cat "$BUILD_DIR/ldd-node.txt"

# 6) 打包（tar + gzip；manifest sha256 供 RootfsInstaller 校验）
mkdir -p "$ASSETS"
node "$REPO_ROOT/android/scripts/package-runtime.mjs" \
  --src "$ROOTFS" \
  --out "$ASSETS/rootfs-${ABI}.tgz" \
  --manifest "$ASSETS/rootfs-${ABI}.manifest.json" \
  --version "node${NODE_VERSION}-${UBUNTU_SUITE}-${ABI}"

echo "==> 完成：$ASSETS/rootfs-${ABI}.tgz"
du -sh "$ASSETS/rootfs-${ABI}.tgz" || true
