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
const { loadVendor } = require('./vendor');
const { identityStoreFor } = require('./identity');
const { loadDshSettings } = require('./settings');
const { createLoopbackEndpoint } = require('./loopback-client');

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

/**
 * 确保有可用的设备凭据（design-dsh-login-methods D26/D27）：
 * 纯 token 驱动——优先读本 scope store 的 token，refresh 有效则直接 authenticate；
 * 无有效 token 时抛「登录已失效」提示（不再回退账号密码，账号密码不落盘）。
 */
async function ensureCredentials({ api, credentialStore, identity }) {
  const stored = await credentialStore.load(api.baseUrl, identity.deviceId);
  const reusable = stored && stored.refreshTokenExpiresAt > Date.now() + 30_000;
  if (!reusable) {
    const e = new Error('dsh 登录已失效，请重新登录');
    e.code = 'DSH_AUTH_REQUIRED';
    throw e;
  }
  try {
    return await api.authenticate(identity);
  } catch {
    // authenticate 内部会用 refresh token 自动续期；失败即 refresh 也失效。
    const e = new Error('dsh 登录已失效，请重新登录');
    e.code = 'DSH_AUTH_REQUIRED';
    throw e;
  }
}

/** 建立一台「连接方身份」的会话（身份 + 凭据 + ServerApi）。无需账号密码。 */
async function openClientSession(scope) {
  const vendor = loadVendor();
  const config = await loadDshSettings();
  const identities = identityStoreFor(scope);
  const identity = await identities.loadOrCreate(config.deviceName);
  const credentialStore = new vendor.serverCredentials.ServerCredentialStore(credentialDir(scope));
  const api = new vendor.serverApi.ClientServerApi(config.serverUrl, credentialStore);
  const session = await ensureCredentials({ api, credentialStore, identity });
  return { vendor, config, identities, identity, api, session };
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

  const { vendor, identities, identity, api, session } = await openClientSession(scope);
  if (identity.deviceId === deviceId) throw new Error('不能连接本机设备（dsh 自环连接已拒绝）');

  // 目标设备必须在当前账号可见列表内（授权判定由中继服务器执行）。
  const devices = await api.listDevices();
  if (!devices.some((device) => device.deviceId === deviceId)) {
    throw new Error('目标设备不在当前账号的可见列表中');
  }
  const descriptor = await api.deviceFor(deviceId);
  if (descriptor.role !== 'host') throw new Error('目标设备不是可被连接的主机');

  // 钉住对端身份公钥：变了说明设备重装/换机，拒绝连接（防身份被替换）。
  const existing = identities.trustedPeer(descriptor.deviceId);
  if (existing && existing.publicKey !== descriptor.identityKey) {
    throw new Error('目标主机的身份密钥已变化，拒绝连接（请在本机删除该设备的信任记录后重试）');
  }
  const peer = existing || (await identities.trustPeer({
    deviceId: descriptor.deviceId,
    name: descriptor.name,
    platform: descriptor.platform,
    publicKey: descriptor.identityKey,
    membershipId: descriptor.membershipId,
  }));

  const presence = await api.presenceFor(deviceId);
  if (!presence.online) throw new Error('目标主机当前离线');

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

  let endpoint;
  try {
    endpoint = await createLoopbackEndpoint(client, { port: remoteAgentLrayPort });
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

/** 列出中继服务器上当前账号可见的设备（供前端选择连接目标）。 */
async function listDshDevices() {
  const { identities, identity, api } = await openClientSession('client');
  const devices = await api.listDevices();
  // 本机设备从候选列表排除（防自环）。
  return devices
    .filter((device) => device.deviceId !== identity.deviceId)
    .map((device) => ({
      deviceId: device.deviceId,
      name: device.name,
      platform: device.platform,
      membershipId: device.membershipId,
      online: Boolean(device.online),
      lastSeenAt: device.lastSeenAt ?? null,
    }));
}

module.exports = {
  controlUrl,
  credentialDir,
  openDshTunnel,
  listDshDevices,
};
