'use strict';
// dsh 借码层加载器：lib/dsh/vendor/dist 是上游 ds-harness-remote 连接骨架的编译产物
// （来源 commit 与裁剪清单见 lib/dsh/vendor/README.md）。
//
// 为什么产物是 ESM：上游 Noise 实现依赖 @lukeburns/clatterjs（纯 ESM，`exports` 只暴露
// "import" 条件），CJS 侧 require 该包会抛 ERR_PACKAGE_PATH_NOT_EXPORTED。因此整条
// vendor 产物保持 ESM，由 Node 的 require(esm) 能力加载（Node ≥22.12 默认开启；本项目
// engines 要求 node ≥22.13）。
//
// 懒加载：仅在真正使用 dsh（建隧道 / 起被连接方服务）时才 require —— vendor 缺失或损坏
// 不影响 AgentLRay 的其它能力，只让 dsh 传输报「组件不可用」。
const path = require('path');

const VENDOR_DIR = path.join(__dirname, 'vendor');
const VENDOR_ENTRY = path.join(VENDOR_DIR, 'dist', 'index.js');

let cached = null;

/**
 * 加载借码层（命名空间导出：crypto/protocol/webrtc/clientCore/serverApi/... ）。
 * 失败抛带 code 的错误，调用方转成可读文案。
 */
function loadVendor() {
  if (cached) return cached;
  try {
    cached = require(VENDOR_ENTRY);
  } catch (error) {
    const e = new Error(`dsh 传输组件不可用（${VENDOR_ENTRY}）：${error.message}`);
    e.code = 'DSH_VENDOR_UNAVAILABLE';
    throw e;
  }
  return cached;
}

module.exports = {
  VENDOR_DIR,
  VENDOR_ENTRY,
  loadVendor,
};
