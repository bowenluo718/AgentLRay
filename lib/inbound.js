'use strict';
// 入站 peer 注册表（inbound peers，design-inbound-peers）：
// 本机 AgentLRay「当前被哪些其他主机连接」的反向展示。
// 多主机连接方向是本机出站（ssh -L 主动连远端），被连接方无法从 TCP/HTTP 层
// 识别"谁在连我"（隧道抹平来源，TCP 源地址都是 127.0.0.1）。因此唯一可靠途径是
// **连接方主动上报 + 心跳**：连接方 connect 成功后 POST 身份给被连接方，被连接方
// 按心跳过期判定存活。本模块即被连接方的 peer 注册表。
// - 内存 Map，不落盘（会话级状态，进程退出即清）。
// - 同一 peerId 反复上报为 upsert 刷新 lastSeen，不新增。
// - 风格对齐 lib/hosts.js（内存 Map + module interface + 测试专用注入）。

// 心跳过期窗口：lastSeen 距今超过该值时判为失活并从快照移除。
const HEARTBEAT_TTL_MS = 30_000;

// peerId → Peer（不落盘）。
const peers = new Map();

// 规范化校验：peerId/label 白名单正则（同主机 id 宽松 slug 风格）。
const PEER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * 注册/续期一个 peer。upsert：首次置 connectedAt，否则刷新 lastSeen。
 * 非法 peerId 抛错（由路由层转 400）。@param info { peerId, label, version?, bootId? }
 */
function registerPeer(info) {
  const peerId = String(info?.peerId ?? '').trim();
  const label = String(info?.label ?? '').trim();
  if (!PEER_ID_RE.test(peerId)) throw new Error('peerId 仅允许字母数字与连字符，且以字母/数字开头');
  if (!label) throw new Error('label 必填');

  const now = new Date().toISOString();
  const existing = peers.get(peerId);
  if (existing) {
    existing.label = label;
    existing.version = info.version ?? existing.version ?? null;
    existing.bootId = info.bootId ?? existing.bootId ?? null;
    existing.lastSeen = now;
    return existing;
  }
  const peer = {
    peerId,
    label,
    version: info.version ?? null,
    bootId: info.bootId ?? null,
    connectedAt: now,
    lastSeen: now,
  };
  peers.set(peerId, peer);
  return peer;
}

/** 清理超过心跳窗口仍无续期的 peer。now 可注入（测试用），缺省当前时间。 */
function expireStale(now = Date.now()) {
  for (const [peerId, peer] of peers) {
    if (now - Date.parse(peer.lastSeen) > HEARTBEAT_TTL_MS) peers.delete(peerId);
  }
}

/** 存活 peer 快照：先过期清理，再按 connectedAt 升序返回。 */
function snapshot() {
  expireStale();
  const list = Array.from(peers.values())
    .sort((a, b) => Date.parse(a.connectedAt) - Date.parse(b.connectedAt))
    .map(({ peerId, label, version, bootId, connectedAt, lastSeen }) => ({
      peerId,
      label,
      version,
      bootId,
      connectedAt,
      lastSeen,
    }));
  return { count: list.length, peers: list };
}

/** 清空注册表（进程退出兜底 / 测试重置）。 */
function clear() {
  peers.clear();
}

module.exports = {
  HEARTBEAT_TTL_MS,
  PEER_ID_RE,
  registerPeer,
  expireStale,
  snapshot,
  clear,
};
