'use strict';
// 远端版本兼容判定（design-android-mobile-app §10「app 前端 dist 与远端 full 版本漂移」）。
//
// 薄服务/客户端连接的远端必须能提供当前客户端所需的数据面接口。远端版本低于最低要求时
// 仅给出升级提示（不阻断连接，避免把可用但稍旧的远端直接判死）；版本未知（老远端不返回
// version 字段）同样不告警——无法判定就不误报。
//
// 单一真源：/api/hosts 序列化时调用 isRemoteCompatible()，前端只消费布尔结果。
// AGENTLRAY_MIN_REMOTE_VERSION 可覆盖默认下限（部署侧灰度/回滚用）。

const DEFAULT_MIN_REMOTE_VERSION = '0.1.0';

/** 解析 `[v]X.Y.Z`（忽略预发布/构建后缀）；非法 → null。 */
function parseSemver(version) {
  if (typeof version !== 'string') return null;
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 语义化比较：a<b → -1，a=b → 0，a>b → 1；任一不可解析 → null。 */
function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** 当前生效的远端最低版本（env 覆盖需为合法语义化版本，否则回落默认）。 */
function minRemoteVersion() {
  const raw = process.env.AGENTLRAY_MIN_REMOTE_VERSION;
  return parseSemver(raw) ? raw.trim() : DEFAULT_MIN_REMOTE_VERSION;
}

/**
 * 远端版本是否满足最低要求。
 * @returns {boolean|null} true 兼容；false 过低（提示升级）；null 不可判定（未知/非语义化）。
 */
function isRemoteCompatible(remoteVersion) {
  const cmp = compareSemver(remoteVersion, minRemoteVersion());
  if (cmp === null) return null;
  return cmp >= 0;
}

module.exports = {
  DEFAULT_MIN_REMOTE_VERSION,
  parseSemver,
  compareSemver,
  minRemoteVersion,
  isRemoteCompatible,
};
