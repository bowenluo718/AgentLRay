#!/usr/bin/env bash
# 一键构建 AgentLRay Android APK（design-android-mobile-app §6）。
#
# 编排：前端 dist → app-bundle.tgz → assets/runtime → cap sync → Gradle assemble → 产物自检
#
# 用法：
#   bash android/scripts/build-apk.sh             # debug APK（默认）
#   bash android/scripts/build-apk.sh --release   # release APK（未配置签名时回退 debug 签名）
#   bash android/scripts/build-apk.sh --skip-web  # 复用已构建的前端 dist（迭代原生层时加速）
#
# 一次性前置（脚本不代劳，缺失时直接报错并给出命令）：
#   1. rootfs：android/android/app/src/main/assets/runtime/rootfs-arm64.{tgz,manifest.json}
#        bash android/scripts/build-rootfs.sh arm64
#   2. PRoot 二进制：android/android/app/src/main/jniLibs/arm64-v8a/libproot{,-loader}.so
#        bash android/scripts/fetch-proot.sh arm64
#   3. Android SDK（compileSdk 35 / build-tools 35.0.0）+ JDK 21+。
#
# 环境变量：
#   ANDROID_HOME / ANDROID_SDK_ROOT   Android SDK 路径（缺省读 android/android/local.properties）
#   JAVA_HOME                         JDK 21+（缺省按常见路径探测）
#   AGENTLRAY_GRADLE_BIN              指定 Gradle 可执行文件（缺省 gradlew 或本机 gradle-8.11*）
#   AGENTLRAY_GRADLE_ARGS             追加给 Gradle 的参数（如 "-Pfoo=bar"）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANDROID_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"   # android/
REPO_ROOT="$(cd "$ANDROID_ROOT/.." && pwd)"    # 仓库根
NATIVE_DIR="$ANDROID_ROOT/android"             # Capacitor 原生平台目录
ASSET_DIR="$NATIVE_DIR/app/src/main/assets/runtime"
JNI_DIR="$NATIVE_DIR/app/src/main/jniLibs/arm64-v8a"
ABI=arm64
BUILD_TYPE=debug
SKIP_WEB=0

die() { printf '✖ %s\n' "$*" >&2; exit 1; }
step() { printf '\n▶ %s\n' "$*"; }

usage() {
  sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    --release) BUILD_TYPE=release ;;
    --debug) BUILD_TYPE=debug ;;
    --skip-web) SKIP_WEB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数：$arg（见 --help）" ;;
  esac
done

# ---------------------------------------------------------------- JDK 21+
java_major() {
  "$1" -version 2>&1 | sed -n 's/.* version "\([0-9][0-9]*\).*/\1/p'
}

pick_jdk() {
  local candidates=() cand major
  [ -n "${JAVA_HOME:-}" ] && candidates+=("$JAVA_HOME")
  candidates+=("$HOME/android-build/jdk21" "$HOME/jdk21" /opt/jdk21 /opt/jdk-21 /usr/lib/jvm/jdk-21)
  for cand in "$HOME"/android-build/jdk-* /usr/lib/jvm/*21* /opt/*21*; do
    [ -d "$cand" ] && candidates+=("$cand")
  done
  for cand in "${candidates[@]}"; do
    if [ -x "$cand/bin/java" ] && [ -x "$cand/bin/javac" ]; then
      major="$(java_major "$cand/bin/java" || true)"
      if [ -n "$major" ] && [ "$major" -ge 21 ]; then printf '%s\n' "$cand"; return 0; fi
    fi
  done
  # 退回 PATH 上的 java（需 JDK 且 ≥21）。
  local cur; cur="$(command -v java || true)"
  if [ -n "$cur" ]; then
    major="$(java_major "$cur" || true)"
    if [ -n "$major" ] && [ "$major" -ge 21 ]; then
      dirname "$(dirname "$(readlink -f "$cur")")"
      return 0
    fi
  fi
  return 1
}

# ---------------------------------------------------------------- Android SDK
has_sdk_components() {
  [ -d "$1/platforms/android-35" ] && [ -x "$1/build-tools/35.0.0/aapt2" ]
}

pick_sdk() {
  local candidates=() cand p
  [ -n "${ANDROID_SDK_ROOT:-}" ] && candidates+=("$ANDROID_SDK_ROOT")
  [ -n "${ANDROID_HOME:-}" ] && candidates+=("$ANDROID_HOME")
  if [ -f "$NATIVE_DIR/local.properties" ]; then
    p="$(sed -n 's/^sdk\.dir=//p' "$NATIVE_DIR/local.properties")"
    [ -n "$p" ] && candidates+=("$p")
  fi
  for cand in "${candidates[@]}"; do
    if has_sdk_components "$cand"; then printf '%s\n' "$cand"; return 0; fi
  done
  return 1
}

# ---------------------------------------------------------------- 前置检查
JDK="$(pick_jdk)" || die "未找到 JDK 21+（Capacitor 7 的 android 模块以 Java 21 编译）。
  → 安装 JDK 21 并设置 JAVA_HOME，或把 JDK 21 放到 \$HOME/android-build/jdk21。"

SDK="$(pick_sdk)" || die "未找到含 platforms/android-35 与 build-tools/35.0.0 的 Android SDK。
  → 设置 ANDROID_HOME / ANDROID_SDK_ROOT，或写入 android/android/local.properties 的 sdk.dir。"

current_sdk="$(sed -n 's/^sdk\.dir=//p' "$NATIVE_DIR/local.properties" 2>/dev/null)"
if [ "$current_sdk" != "$SDK" ]; then
  printf 'sdk.dir=%s\n' "$SDK" > "$NATIVE_DIR/local.properties"
  echo "  已写入 $NATIVE_DIR/local.properties（sdk.dir=$SDK）"
fi

[ -f "$ASSET_DIR/rootfs-$ABI.tgz" ] || die "缺少 rootfs 资产：$ASSET_DIR/rootfs-$ABI.tgz
  → 先执行：bash android/scripts/build-rootfs.sh $ABI"
[ -f "$ASSET_DIR/rootfs-$ABI.manifest.json" ] || die "缺少 rootfs 清单：$ASSET_DIR/rootfs-$ABI.manifest.json
  → 先执行：bash android/scripts/build-rootfs.sh $ABI"
[ -f "$JNI_DIR/libproot.so" ] || die "缺少 PRoot 二进制：$JNI_DIR/libproot.so
  → 先执行：bash android/scripts/fetch-proot.sh $ABI"
[ -f "$JNI_DIR/libproot-loader.so" ] || die "缺少 PRoot loader：$JNI_DIR/libproot-loader.so
  → 先执行：bash android/scripts/fetch-proot.sh $ABI"

if [ "$SKIP_WEB" -eq 1 ] && [ ! -f "$REPO_ROOT/frontend/dist/index.html" ]; then
  die "frontend/dist 不存在，无法 --skip-web。去掉该参数重新构建。"
fi

echo "  JDK:      $JDK"
echo "  SDK:      $SDK"
echo "  ABI:      $ABI"
echo "  构建类型:   $BUILD_TYPE"

# ---------------------------------------------------------------- 1/5 前端
if [ "$SKIP_WEB" -eq 0 ]; then
  step "[1/5] 构建前端 dist"
  ( cd "$REPO_ROOT" && npm run build:ui )
else
  step "[1/5] 跳过前端构建（--skip-web）"
fi

# ---------------------------------------------------------------- 2/5 app bundle
step "[2/5] 打包运行时闭包（app-bundle.tgz）"
node "$SCRIPT_DIR/bundle-app.mjs"

# ---------------------------------------------------------------- 3/5 运行时资产
step "[3/5] 同步运行时资产到 assets/runtime"
cp -f "$ANDROID_ROOT/build/app-bundle/app-bundle.tgz" "$ASSET_DIR/app-bundle.tgz"
cp -f "$ANDROID_ROOT/build/app-bundle/app.manifest.json" "$ASSET_DIR/app.manifest.json"
# rootfs 是外部产物：嵌入前按清单校验，避免把损坏/陈旧包打进 APK。
rootfs_sha="$(node -e 'process.stdout.write(String(require(process.argv[1]).sha256 || ""))' \
  "$ASSET_DIR/rootfs-$ABI.manifest.json")"
actual_sha="$(sha256sum "$ASSET_DIR/rootfs-$ABI.tgz" | cut -d' ' -f1)"
[ "$rootfs_sha" = "$actual_sha" ] || die "rootfs SHA-256 与清单不一致（清单=$rootfs_sha，实际=$actual_sha）
  → 重新生成 rootfs：bash android/scripts/build-rootfs.sh $ABI"
echo "  rootfs SHA-256 校验通过：$actual_sha"

# ---------------------------------------------------------------- 4/5 cap sync
step "[4/5] Capacitor sync android"
if [ ! -x "$ANDROID_ROOT/node_modules/.bin/cap" ]; then
  echo "  android/node_modules 缺失，执行 npm ci"
  ( cd "$ANDROID_ROOT" && npm ci )
fi
( cd "$ANDROID_ROOT" && npx cap sync android )

# ---------------------------------------------------------------- 5/5 Gradle
# Gradle 选择：wrapper 分发包已缓存 → gradlew；否则用本机 gradle-8.11.x（内网无下载）。
pick_gradle() {
  [ -n "${AGENTLRAY_GRADLE_BIN:-}" ] && { printf '%s\n' "$AGENTLRAY_GRADLE_BIN"; return 0; }
  local wrapper_ver
  wrapper_ver="$(sed -n 's/.*gradle-\([0-9][0-9.]*\)-bin\.zip.*/\1/p' \
    "$NATIVE_DIR/gradle/wrapper/gradle-wrapper.properties")"
  if [ -n "$wrapper_ver" ] && [ -d "$HOME/.gradle/wrapper/dists" ] &&
     [ -n "$(find "$HOME/.gradle/wrapper/dists" -maxdepth 3 -type d -name "gradle-$wrapper_ver" 2>/dev/null)" ]; then
    printf '%s\n' "$NATIVE_DIR/gradlew"; return 0
  fi
  local cand
  for cand in "$HOME"/android-build/gradle-8.11*/bin/gradle /opt/gradle-8.11*/bin/gradle \
              /usr/local/gradle-8.11*/bin/gradle; do
    [ -x "$cand" ] && { printf '%s\n' "$cand"; return 0; }
  done
  if command -v gradle >/dev/null 2>&1; then command -v gradle; return 0; fi
  printf '%s\n' "$NATIVE_DIR/gradlew"
}

GRADLE="$(pick_gradle)"
GRADLE_TASK=":app:assembleDebug"
[ "$BUILD_TYPE" = release ] && GRADLE_TASK=":app:assembleRelease"

step "[5/5] Gradle $GRADLE_TASK"
echo "  Gradle:   $GRADLE"
export JAVA_HOME="$JDK"
export PATH="$JAVA_HOME/bin:$PATH"
# shellcheck disable=SC2086  # AGENTLRAY_GRADLE_ARGS 需要按空格拆分
( cd "$NATIVE_DIR" && "$GRADLE" "$GRADLE_TASK" --console=plain ${AGENTLRAY_GRADLE_ARGS:-} )

# ---------------------------------------------------------------- 产物与自检
APK_DIR="$NATIVE_DIR/app/build/outputs/apk/$BUILD_TYPE"
apk_line="$(find "$APK_DIR" -maxdepth 2 -name '*.apk' -printf '%T@ %p\n' 2>/dev/null |
  sort -nr | sed -n '1p')"
APK="${apk_line#* }"
[ -n "$APK" ] && [ -f "$APK" ] || die "Gradle 成功但未找到 APK：$APK_DIR"

step "产物自检"
# 先取完整条目列表再匹配：`unzip | grep -q` 在 pipefail 下会因 SIGPIPE(141) 误报失败。
apk_entries="$(unzip -Z1 "$APK")"
for entry in \
  "assets/runtime/app-bundle.tgz" \
  "assets/runtime/app.manifest.json" \
  "assets/runtime/rootfs-$ABI.tgz" \
  "assets/runtime/rootfs-$ABI.manifest.json" \
  "lib/arm64-v8a/libproot.so" \
  "lib/arm64-v8a/libproot-loader.so"; do
  grep -qxF "$entry" <<<"$apk_entries" || die "APK 缺少条目：$entry"
done

printf '\n✔ APK 构建完成：%s\n' "$APK"
printf '  大小：%s\n' "$(du -h "$APK" | cut -f1)"
printf '  安装：adb install -r %q\n' "$APK"
