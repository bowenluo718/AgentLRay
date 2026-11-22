'use strict';
// dsh 连接方（client 角色）：连到中继服务器，选定目标设备后建立加密通道，
// 再把远端 AgentLRay 的 HTTP 数据面通过本机 loopback 端口暴露出来。
//
// 契约与 ssh 隧道完全一致：调用方拿到 { baseUrl } 后即可按现有网关逻辑转发请求；
// 差别只在「隧道」由加密通道 + loopback 组成，而不是 ssh -L 子进程。
//
// 流程（对齐上游 ds-harness-remote 的 client 连接链路）：
//   账号登录/注册设备 → 查设备列表 → 取目标设备授权信息 → 钉住对端身份 → 查在线状态
//   → 建 AdaptiveTransport（Relay）→ Noise IK 握手 → 开本机 loopback 端点。
//
// 身份作用域：中继服务器对同一设备只保留一条控制连接（新连接顶替旧连接），因此
// 出站隧道（client）与连接测试（probe）必须用不同设备身份，否则测试会顶替正在
// 使用的隧道。被连接方服务用第三个身份（host），见 lib/dsh/identity.js。
const path = require('path');
const { HOME } = require('../config');
// 用命名空间访问而非解构：便于测试注入 fake vendor（与 lib/dsh/auth.js 一致）。
const vendorMod = require('./vendor');
const { identityStoreFor } = require('./identity');
const { loadDshSettings } = require('./settings');
const { createLoopbackEndpoint } = require('./loopback-client');
const { probeVersion } = require('../transport');
const log = require('../logging');

// RemoteClientCore 的 RPC 默认超时（上游 client-connection 用 60s）。
const RPC_TIMEOUT_MS = 60_000;

/** 中继服务器控制通道地址（ws(s)://<server>/ws/v1/connect）。 */
function controlUrl(baseUrl) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/ws/v1/connect`;
  return url.toString();
}

/** 某作用域的中继服务器凭据落盘目录（每个设备身份一份凭据）。 */
function credentialDir(scope) {
  return path.join(HOME, '.agentlray', 'dsh', scope);
}

/** 中继服务器明确判定 token 失效的错误码：只有这些才等价于「需要重新登录」。 */
const TOKEN_REJECTED_CODES = new Set(['AUTH_INVALID', 'TOKEN_EXPIRED', 'ACCOUNT_AUTH_REQUIRED', 'AUTH_REQUIRED']);

/**
 * 把 authenticate 失败转成对外错误：token 被拒 → 「登录已失效」（保留原始错误为 cause）；
 * 其余（凭据刷新锁不可用 / 磁盘错误 / 网络 / 身份异常）保留真实 code 与文案——此前一律
 * 折叠成「登录已失效」，Android 现场（PRoot 下硬链接锁不可用）被误导为需要重新登录。
 */
function toClientAuthError(error) {
  const code = error && error.code;
  const rejected = TOKEN_REJECTED_CODES.has(code) || (error && error.status === 401);
  if (!rejected) return error;
  const e = new Error('dsh 登录已失效，请重新登录');
  e.code = 'DSH_AUTH_REQUIRED';
  e.upstreamCode = code || null;
  e.cause = error;
  return e;
}

/** 认证失败的诊断字段（落 app 日志）：scope + 错误码 + 上游码 + 原因链。 */
function authFailureFields(scope, error) {
  const cause = error && error.cause;
  return {
    scope,
    code: (error && error.code) || null,
    upstreamCode: (error && error.upstreamCode) || null,
    error: (error && error.message) || String(error),
    cause: cause ? cause.message : null,
  };
}

/**
 * 确保有可用的设备凭据（design-dsh-login-methods D26/D27）：
 * 纯 token 驱动——优先读本 scope store 的 token，refresh 有效则直接 authenticate；
 * 无有效 token 时抛「登录已失效」提示（不再回退账号密码，账号密码不落盘）。
 * 失败一律写 app 日志（scope + code + cause），供现场定位。
 */
async function ensureCredentials({ api, credentialStore, identity, scope }) {
  // 无设备身份 = 从未登录（读路径不生成身份，见 openClientSession）→ 直接报未登录。
  if (!identity) {
    log.app.warn('dsh client auth failed', { scope, code: 'DSH_AUTH_REQUIRED', reason: 'no-identity' });
    const e = new Error('dsh 登录已失效，请重新登录');
    e.code = 'DSH_AUTH_REQUIRED';
    throw e;
  }
  let stored;
  try {
    stored = await credentialStore.load(api.baseUrl, identity.deviceId);
  } catch (error) {
    // 凭据文件损坏 / 权限不是 0600 等：不是「未登录」，不得改写成登录失效。
    log.app.warn('dsh client auth failed', { ...authFailureFields(scope, error), reason: 'credential-invalid' });
    throw error;
  }
  const reusable = stored && stored.refreshTokenExpiresAt > Date.now() + 30_000;
  if (!reusable) {
    log.app.warn('dsh client auth failed', { scope, code: 'DSH_AUTH_REQUIRED', reason: 'no-credential' });
    const e = new Error('dsh 登录已失效，请重新登录');
    e.code = 'DSH_AUTH_REQUIRED';
    throw e;
  }
  try {
    return await api.authenticate(identity);
  } catch (error) {
    const mapped = toClientAuthError(error);
    log.app.warn('dsh client auth failed', authFailureFields(scope, mapped));
    throw mapped;
  }
}

/** 尽力释放会话持有的资源（ServerApi / 凭据存储若提供 close 则调用）；不抛错。 */
async function closeSessionApi(api, session) {
  for (const target of [session, api]) {
    if (target && typeof target.close === 'function') {
      try {
        await target.close();
      } catch {
        /* 释放失败不影响主流程 */
      }
    }
  }
}

/**
 * 建立一台「连接方身份」的会话（身份 + 凭据 + ServerApi）。无需账号密码。
 * createIdentity=false：只读会话，不生成设备身份（列设备等读路径）。退出后任何读操作都
 * 不得把 dsh 身份文件写回 ~/.agentlray/dsh（身份只在登录/建隧道时生成）。
 */
async function openClientSession(scope, options = {}) {
  const vendor = vendorMod.loadVendor();
  const config = await loadDshSettings();
  const identities = identityStoreFor(scope);
  let identity;
  if (options.createIdentity === false) {
    identity = await identities.loadExisting();
    // 只读路径同样要载入信任库：否则后续 savePeers 会用空 Map 覆盖已有钉扎。
    if (identity) await identities.loadPeers();
  } else {
    identity = await identities.loadOrCreate(config.deviceName);
  }
  const credentialStore = new vendor.serverCredentials.ServerCredentialStore(credentialDir(scope));
  const api = new vendor.serverApi.ClientServerApi(config.serverUrl, credentialStore);
  let session;
  try {
    session = await ensureCredentials({ api, credentialStore, identity, scope });
  } catch (error) {
    // 连接测试（probe）凭据自愈：旧版本登录没有顺带登记 probe，现场表现为
    // 「测试连接 → 登录已失效」。用已登录 client 的 token 补登记一次后重试；
    // 补登记失败或仍失败则保留原始错误（只重试一次，不会无限循环）。
    if (scope !== 'probe' || options.provisionProbe !== true || error.code !== 'DSH_AUTH_REQUIRED') throw error;
    const repaired = await require('./auth').provisionProbeFromOwner(config.serverUrl);
    if (!repaired.ok) {
      // 「登录已失效」会误导用户去查 client 登录态——真实原因是连接测试的独立身份没登记。
      const e = new Error('连接测试所需的独立设备身份未登记，请重新登录一次 dsh');
      e.code = 'DSH_PROBE_NOT_PROVISIONED';
      e.cause = error;
      throw e;
    }
    // 释放本轮已创建的 api/凭据存储再重试：否则每次自愈都会残留一个未关闭实例
    //（其刷新逻辑仍可能写盘），反复点「测试连接」会累积。
    await closeSessionApi(api, session);
    return openClientSession(scope, { ...options, provisionProbe: false });
  }
  return { vendor, config, identities, identity, api, session };
}

// 询问被连接方是否提供入站 UNIX socket（streamlocal 等价物）。老版本/不支持 → null，
// 退回 TCP 端口（此时被连接方若开着本机令牌，需要在它那边关闭）。
// 校验复用被连接方的唯一真源 `parseLoopbackPort`：路径字符集（空格/@/中文/超长）若过宽，
// 被连接方每次 http.open 都会拒绝，连接方却以为拿到了可用目标。
async function probeInboundSocketPath(client) {
  try {
    const described = await client.rpc('harness.transport.describe', {});
    const path = described?.inboundSocket;
    if (typeof path !== 'string' || !path.startsWith('/')) return null;
    const { parseLoopbackPort } = require('./loopback');
    return parseLoopbackPort(path) === path ? path : null;
  } catch {
    return null;
  }
}

/**
 * 建立一条到远端 AgentLRay 的 dsh 隧道。
 * @param spec { deviceId, remoteAgentLrayPort, scope }
 * @returns { baseUrl, close() }
 */
async function openDshTunnel(spec) {
  const deviceId = String(spec?.deviceId || '').trim();
  if (!deviceId) throw new Error('dsh 目标设备 id 必填');
  const remoteAgentLrayPort = Number(spec?.remoteAgentLrayPort || 3800);
  if (!Number.isInteger(remoteAgentLrayPort) || remoteAgentLrayPort < 1 || remoteAgentLrayPort > 65535) {
    throw new Error('dsh 远端 AgentLRay 端口需为 1–65535 的整数');
  }
  const scope = spec?.scope === 'probe' ? 'probe' : 'client';

  // 建隧道也不生成身份：未登录直接提示重新登录，而不是留下一个无凭据的设备身份。
  const { vendor, identities, identity, api, session } = await openClientSession(scope, {
    createIdentity: false,
    provisionProbe: scope === 'probe',
  });
  if (identity.deviceId === deviceId) {
    // 稳定错误码（A-1）：自环属于目标配置错误，不可重试。
    const e = new Error('不能连接本机设备（dsh 自环连接已拒绝）');
    e.code = 'INVALID_TARGET';
    throw e;
  }

  // 目标设备必须在当前账号可见列表内（授权判定由中继服务器执行）。
  const devices = await api.listDevices();
  if (!devices.some((device) => device.deviceId === deviceId)) {
    const e = new Error('目标设备不在当前账号的可见列表中');
    e.code = 'INVALID_TARGET';
    throw e;
  }
  const descriptor = await api.deviceFor(deviceId);
  if (descriptor.role !== 'host') {
    const e = new Error('目标设备不是可被连接的主机');
    e.code = 'INVALID_TARGET';
    throw e;
  }

  // 钉住对端身份公钥：变了说明设备重装/换机，拒绝连接（防身份被替换）。
  const existing = identities.trustedPeer(descriptor.deviceId);
  if (existing && existing.publicKey !== descriptor.identityKey) {
    // KEY_CHANGED：fail-closed，不进入重连循环（用户须先删除信任记录）。
    const e = new Error('目标主机的身份密钥已变化，拒绝连接（请在本机删除该设备的信任记录后重试）');
    e.code = 'KEY_CHANGED';
    throw e;
  }
  const peer = existing || (await identities.trustPeer({
    deviceId: descriptor.deviceId,
    name: descriptor.name,
    platform: descriptor.platform,
    publicKey: descriptor.identityKey,
    membershipId: descriptor.membershipId,
  }));

  const presence = await api.presenceFor(deviceId);
  if (!presence.online) {
    // HOST_OFFLINE：目标设备不在线，属于可重试的临时状态。
    const e = new Error('目标主机当前离线');
    e.code = 'HOST_OFFLINE';
    throw e;
  }

  const transport = new vendor.webrtc.AdaptiveTransport(controlUrl(api.baseUrl), {
    role: 'client',
    deviceId: identity.deviceId,
    accessToken: session.accessToken,
    refreshAccessToken: async () => (await api.authenticate(identity)).accessToken,
    targetDeviceId: deviceId,
    // 只走 Relay：AgentLRay 未内置 WebRTC/TURN 后端（依赖 werift 栈），Relay 通道
    // 由中继服务器承载，天然穿 NAT。
    forceRelay: true,
    preferredTransports: ['relay'],
  });
  const client = new vendor.clientCore.RemoteClientCore(
    new vendor.clientSecureTransport.ClientSecureTransport(transport, identity, peer),
    RPC_TIMEOUT_MS
  );
  try {
    await client.connect();
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  // 入站信任通道：被连接方在新版本里公布本机 UNIX socket 路径（capabilities
  // agentlray.loopback.socket.v1），把 loopback 目标指向它 → 被连接方无需关闭本机令牌。
  const socketPath = await probeInboundSocketPath(client);
  const openEndpoint = (port) => createLoopbackEndpoint(client, { port });
  let endpoint;
  try {
    endpoint = await openEndpoint(socketPath || remoteAgentLrayPort);
    if (socketPath) {
      // 通告 ≠ 可用（socket 被删/权限变化/对端已重启）。先探一次 `/api/version`：
      // 失败就按 TCP 端口重开，否则整个主机连接会退化成可重试的 UNREACHABLE 无限重连。
      try {
        await probeVersion(endpoint.url, { timeoutMs: 5000, attempts: 1 });
      } catch (error) {
        log.app.warn('dsh inbound socket unusable; falling back to loopback port', {
          socketPath,
          port: remoteAgentLrayPort,
          error: (error && error.message) || String(error),
        });
        await endpoint.close().catch(() => undefined);
        endpoint = await openEndpoint(remoteAgentLrayPort);
      }
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }

  return {
    baseUrl: endpoint.url,
    async close() {
      await endpoint.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

// presence 结果短缓存（5s）：前端打开/刷新设备列表会连续触发，N 台设备每次都打一轮
// presence 请求既慢又容易撞中继限流。只缓存成功结果，失败不入缓存（下次重查）。
const PRESENCE_TTL_MS = 5_000;
const presenceCache = new Map(); // `${baseUrl}\n${deviceId}` → { online, lastSeenAt, at }

/**
 * 单台设备的在线状态。中继的 /api/v1/devices 列表条目**不含 online/lastSeenAt**
 * （只有 lastConnectedAt，且常为 null），在线与否只能查 /api/v1/devices/:id/presence。
 * 查询失败不拖垮整张列表：返回 online=null（未知）——列表条目也没有 online 字段，
 * 回落到 Boolean(undefined)=false 会把在线设备误报为离线；调用方仍可选择该设备，
 * 连接时会再次校验 presence。
 */
async function devicePresence(api, device) {
  const key = `${api.baseUrl}\n${device.deviceId}`;
  const cached = presenceCache.get(key);
  if (cached && Date.now() - cached.at < PRESENCE_TTL_MS) {
    return { online: cached.online, lastSeenAt: cached.lastSeenAt };
  }
  try {
    const presence = await api.presenceFor(device.deviceId);
    const result = { online: Boolean(presence.online), lastSeenAt: presence.lastSeenAt ?? null };
    presenceCache.set(key, { ...result, at: Date.now() });
    return result;
  } catch (error) {
    log.app.warn('dsh device presence failed', {
      deviceId: device.deviceId,
      code: (error && error.code) || null,
      error: (error && error.message) || String(error),
    });
    return { online: null, lastSeenAt: device.lastSeenAt ?? null };
  }
}

/** 列出中继服务器上当前账号可见的设备（供前端选择连接目标），在线状态按 presence 实时回填。 */
async function listDshDevices() {
  // 读路径不生成身份：未登录时由 ensureCredentials 报「登录已失效」。
  const { identity, api } = await openClientSession('client', { createIdentity: false });
  const devices = await api.listDevices();
  // 本机设备从候选列表排除（防自环）。
  const visible = devices.filter((device) => device.deviceId !== identity.deviceId);
  // 逐台并行查 presence：列表的 online 字段在中继实现里可能缺失，直接用会让所有设备恒显示离线。
  // 缓存的条目直接命中，未命中的并行查询（命中 5s 内不重复请求）。
  const withPresence = await Promise.all(
    visible.map(async (device) => ({
      device,
      presence: await devicePresence(api, device),
    }))
  );
  // 记录中继实际返回的可见设备与在线情况：排查「对方已启动却显示离线」时先看这里，
  // 可与对方 host 启动日志（deviceId + control connection online）交叉核对。
  log.app.info('dsh devices listed', {
    serverUrl: api.baseUrl,
    count: withPresence.length,
    deviceIds: withPresence.map((item) => item.device.deviceId),
    onlineDeviceIds: withPresence.filter((item) => item.presence.online).map((item) => item.device.deviceId),
  });
  return withPresence.map(({ device, presence }) => ({
    deviceId: device.deviceId,
    name: device.name,
    platform: device.platform,
    membershipId: device.membershipId,
    online: presence.online,
    lastSeenAt: presence.lastSeenAt,
  }));
}

/** 测试专用：清空 presence 短缓存（避免用例间共享同一 baseUrl/deviceId 的缓存结果）。 */
function clearPresenceCacheForTest() {
  presenceCache.clear();
}

module.exports = {
  controlUrl,
  credentialDir,
  openDshTunnel,
  listDshDevices,
  clearPresenceCacheForTest,
};
