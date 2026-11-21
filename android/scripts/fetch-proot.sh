#!/usr/bin/env bash
# 获取 PRoot 运行二进制（design-android-mobile-app §4.3）。
#
# 本机无 root/NDK 交叉编译链时，从 Termux 官方仓库取 aarch64 预编译 proot + 依赖：
#   bin/proot            → jniLibs/arm64-v8a/libproot.so        （nativeLibraryDir 可执行）
#   libexec/proot/loader → jniLibs/arm64-v8a/libproot-loader.so （静态 aarch64 loader）
#   lib/libtalloc.so.2.5.0 → assets/runtime/lib/libtalloc.so.2  （文件名含 .2，jniLibs 不收）
#   lib/libandroid-shmem.so → assets/runtime/lib/libandroid-shmem.so
#
# 运行时由 RootfsInstaller 把 assets/runtime/lib/* 拷到 filesDir/runtime/lib，
# NodeRuntimeManager 设 LD_LIBRARY_PATH 指向它（proot 的 DT_RUNPATH 指向 Termux 前缀，宿主不存在）。
#
# 用法：bash scripts/fetch-proot.sh [arm64]
# 说明：Termux proot 为 targetSdk 28（Termux 自身）构建；本 app targetSdk 35 下
#       exec/非 PIE loader 的兼容性须真机验证（P0-A），失败则改用 NDK 源码重编译。
set -euo pipefail

ABI="${1:-arm64}"
case "$ABI" in
  arm64) TERMUX_ARCH="aarch64"; JNI_ABI="arm64-v8a";;
  *) echo "用法：$0 <arm64>"; exit 2;;
esac

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
JNI_DIR="$REPO_ROOT/android/android/app/src/main/jniLibs/$JNI_ABI"
LIB_DIR="$REPO_ROOT/android/android/app/src/main/assets/runtime/lib"
REPO_BASE="${TERMUX_REPO:-https://packages.termux.dev/apt/termux-main}"
PKG_INDEX="$REPO_BASE/dists/stable/main/binary-$TERMUX_ARCH/Packages"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

echo "==> 拉取 Termux 包索引"
curl -fsSL "$PKG_INDEX" -o Packages

pkg_filename() {
  awk -v pkg="$1" 'BEGIN{RS="";FS="\n"} $0 ~ "^Package: "pkg"\n" {print}' Packages \
    | awk -F': ' '/^Filename:/{print $2; exit}'
}

fetch_pkg() {
  local name="$1"
  local path
  path="$(pkg_filename "$name")"
  if [ -z "$path" ]; then echo "!! 索引中找不到 $name" >&2; exit 1; fi
  echo "==> 下载 $name ($path)"
  curl -fsSL "$REPO_BASE/$path" -o "$name.deb"
  local out="$WORK/x/$name"
  mkdir -p "$out"
  ( cd "$out" && ar x "$WORK/$name.deb" && tar -xf data.tar.* 2>/dev/null || tar -xf data.tar.* )
}

extract_pkg() {
  local name="$1"
  local path
  path="$(pkg_filename "$name")"
  if [ -z "$path" ]; then echo "!! 索引中找不到 $name" >&2; exit 1; fi
  echo "==> 下载 $name"
  curl -fsSL "$REPO_BASE/$path" -o "$WORK/$name.deb"
  mkdir -p "$WORK/x/$name"
  ( cd "$WORK/x/$name" && ar x "$WORK/$name.deb" && for dt in data.tar.*; do tar -xf "$dt"; done )
}

extract_pkg proot
extract_pkg libtalloc
extract_pkg libandroid-shmem

PREFIX="data/data/com.termux/files/usr"
mkdir -p "$JNI_DIR" "$LIB_DIR"
cp "$WORK/x/proot/$PREFIX/bin/proot" "$JNI_DIR/libproot.so"
cp "$WORK/x/proot/$PREFIX/libexec/proot/loader" "$JNI_DIR/libproot-loader.so"
chmod 755 "$JNI_DIR/libproot.so" "$JNI_DIR/libproot-loader.so"
cp "$WORK/x/libtalloc/$PREFIX/lib/libtalloc.so.2.5.0" "$LIB_DIR/libtalloc.so.2"
cp "$WORK/x/libandroid-shmem/$PREFIX/lib/libandroid-shmem.so" "$LIB_DIR/libandroid-shmem.so"
chmod 644 "$LIB_DIR/libtalloc.so.2" "$LIB_DIR/libandroid-shmem.so"

echo "==> 完成"
ls -lh "$JNI_DIR" "$LIB_DIR"
