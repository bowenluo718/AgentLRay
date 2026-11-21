'use strict';
// dsh 被连接方（host 角色）：常驻连接中继服务器，接受其它 AgentLRay 的加密连接，
// 把它们的 loopback 请求转发到本机 AgentLRay 的 HTTP 数据面（放行端口列表内），
// 并把「谁在连我」登记进现有 inbound peer 注册表（via = 'dsh'）。
//
// 生命周期：随 server 进程常驻（role ∈ {host, both} 时启动），独立于「当前选中主机」，
// 不占 hosts.js 的运行时连接槽；进程退出即关闭。
const path = require('path');
const { HOME } = require('../config');
const { loadVendor } = require('./vendor');
const { identityStoreFor } = require('./identity');
const { loadDshSettings } = require('./settings');
const { DshLoopbackHost } = require('./loopback-host');
const { registerPeer } = require('../inbound');
const log = require('../logging');

const DSH_CREDENTIAL_DIR = path.join(HOME, '.agentlray', 'dsh', 'host');
// 本机作为被连接方对外声明的能力（连接方据此判断可用面）。
const HOST_CAPABILITIES = ['agentlray.loopback.v1'];
// inbound peer 心跳续期间隔（注册表 TTL 30s，需小于它）。
const PEER_SYNC_INTERVAL_MS = 10_000;

/** 放行端口缓存：随 dsh 设置变更刷新（设置保存后调用 setAllowedPorts）。 */
let allowedPortsCache = [3800];
/** 当前被连接方服务实例（未启动为 null）。 */
let service = null;

/** 构造最小 host 路由：只实现 loopback 转发 + 能力描述（不需要上游 workspace 面）。 */
function createHostRouter(loopback) {
  const { createRpcResponse, createRpcError } = loadVendor().protocol;
  return {
    async handle(message) {
      const id = typeof message?.id === 'string' ? message.id : '';
      if (message?.type !== 'rpc.request') {
        return createRpcError(id, 'INVALID_MESSAGE', '只接受 rpc.request 消息');
      }
      const method = message.payload?.method;
      try {
        if (method === 'loopback.call') {
          const result = await loopback.call(message.payload.params);
          return createRpcResponse(id, result);
        }
        if (method === 'harness.transport.describe') {
          return createRpcResponse(id, { capabilities: [...HOST_CAPABILITIES] });
        }
        return createRpcError(id, 'METHOD_NOT_FOUND', `不支持的方法: ${String(method)}`);
      } catch (error) {
        return createRpcError(id, error.code || 'LOOPBACK_UNAVAILABLE', error.message || 'loopback 调用失败');
      }
    },
    async closePeerStreams() {
      loopback.closeAll();
    },
  };
}

/** 把当前已连接的 dsh 对端登记进 inbound peer 注册表（via = 'dsh'）。 */
function syncInboundPeers(state) {
  const peers = state.connections.connectedPeers();
  for (const peer of peers) {
    const trusted = state.identities.trustedPeer(peer.deviceId);
    try {
      registerPeer({
        peerId: peer.deviceId,
        label: trusted?.name || peer.deviceId,
        version: null,
        bootId: null,
        via: 'dsh',
      });
    } catch {
      // peerId 不符合注册表白名单（极少见）→ 跳过，不影响其它 peer。
    }
  }
  return peers.length;
}

/** 构造日志器（用上游 SafeLogger：内置敏感字段脱敏）。 */
function createLogger(vendor) {
  const sink = {
    debug: (message) => console.log(message),
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
  };
  return new vendor.logging.SafeLogger(sink, 'info');
}

/**
 * 启动被连接方服务（幂等）。
 * @returns { started, status } —— started=false 表示当前配置/环境不支持被连。
 */
async function startDshHostService() {
  if (service) return { started: true, status: service.status() };
  const config = await loadDshSettings();
  if (config.role !== 'host' && config.role !== 'both') {
    const reason = '当前角色不开放被连接';
    log.app.info('dsh host skipped', { role: config.role, reason });
    return { started: false, status: { role: config.role, running: false, reason } };
  }
  const vendor = loadVendor();
  const identities = identityStoreFor('host');
  const identity = await identities.loadOrCreate(config.deviceName);
  const credentialStore = new vendor.serverCredentials.ServerCredentialStore(DSH_CREDENTIAL_DIR);
  const api = new vendor.serverApi.HostServerApi(config.serverUrl, credentialStore, fetch, 'host');
  api.bindIdentity(identity);

  // 纯 token 驱动（design-dsh-login-methods D26/D27）：读本 scope store 的 token，
  // 无有效 token 时抛「登录已失效」（不再回退账号密码，账号密码不落盘）。
  const stored = await credentialStore.load(api.baseUrl, identity.deviceId);
  if (!stored || stored.refreshTokenExpiresAt <= Date.now() + 30_000) {
    log.app.warn('dsh host auth failed', { error: 'dsh 登录已失效，请重新登录' });
    const e = new Error('dsh 登录已失效，请重新登录');
    e.code = 'DSH_AUTH_REQUIRED';
    throw e;
  }

  allowedPortsCache = [...config.allowedPorts];
  const resolvedConfig = {
    enabled: true,
    role: 'host',
    serverUrl: config.serverUrl,
    httpServerAllowlist: [],
    deviceName: config.deviceName,
    // 只走 Relay：AgentLRay 未内置 WebRTC/TURN 后端，Relay 通道由中继服务器承载。
    forceRelay: true,
    rotatePinnedPeerKey: false,
    logLevel: 'info',
    reconnect: { enabled: true, initialDelayMs: 1000, maxDelayMs: 30_000, jitter: 1000 },
    terminal: { enabled: false },
    sidebar: { entry: 'standard' },
    loopback: { ports: [...config.allowedPorts] },
    codex: { enabled: false, binary: '' },
    cursor: { enabled: false, binary: '' },
  };
  const logger = createLogger(vendor);
  // 每条连接一个独立的 loopback 宿主：连接断开时只回收自己那条通道的在途请求，
  // 不影响其它连接（共享实例会让一条连接的 closePeerStreams 把所有人的在途请求一起断掉）。
  const connections = new vendor.connectionController.ConnectionController(
    identities,
    () => createHostRouter(new DshLoopbackHost(() => allowedPortsCache)),
    logger
  );
  const serverConnection = new vendor.serverConnection.HostServerConnection(
    resolvedConfig,
    identity,
    identities,
    api,
    connections,
    logger,
    undefined,
    undefined,
    () => HOST_CAPABILITIES
  );
  serverConnection.start();

  const state = { identities, api, connections, serverConnection, deviceId: identity.deviceId };
  const timer = setInterval(() => {
    try {
      syncInboundPeers(state);
    } catch {
      /* 同步失败不影响连接 */
    }
  }, PEER_SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();

  service = {
    state,
    timer,
    status() {
      return {
        role: config.role,
        running: true,
        online: serverConnection.isOnline(),
        serverUrl: config.serverUrl,
        deviceId: identity.deviceId,
        deviceName: config.deviceName,
        allowedPorts: [...allowedPortsCache],
        peers: connections.connectedPeers().map((peer) => peer.deviceId),
        lastError: serverConnection.lastError() ?? null,
      };
    },
    async stop() {
      clearInterval(timer);
      await serverConnection.stop().catch(() => undefined);
      // 连接全部断开 → 每条连接的 loopback 宿主随之回收（closePeerStreams）。
      await connections.close().catch(() => undefined);
      api.close();
    },
  };
  log.app.info('dsh host started', {
    serverUrl: config.serverUrl,
    deviceName: config.deviceName,
    allowedPorts: [...allowedPortsCache],
  });
  return { started: true, status: service.status() };
}

/** 刷新放行端口（设置变更后调用）。各连接的 loopback 宿主按需读取该缓存，立即生效。 */
function setAllowedPorts(ports) {
  allowedPortsCache = [...ports];
}

/**
 * dsh 配置变更后即时生效（热切换，无需重启进程）：
 * - 角色含 host → 起被连接方服务；角色为 client → 停被连接方服务。
 * - 放行端口变更 → 立即刷新 loopback 放行列表。
 */
async function applyDshRuntime(config) {
  setAllowedPorts(config?.allowedPorts || []);
  const shouldRun = config?.role === 'host' || config?.role === 'both';
  if (shouldRun && !service) return startDshHostService();
  if (!shouldRun && service) await stopDshHostService();
  return { started: Boolean(service), status: dshHostStatus() };
}

/** 当前被连接方服务状态（未启动 → running:false）。 */
function dshHostStatus() {
  if (!service) return { role: 'both', running: false, online: false, peers: [], allowedPorts: [...allowedPortsCache] };
  return service.status();
}

/** 停止被连接方服务（进程退出 / 设置变更时调用）。 */
async function stopDshHostService() {
  if (!service) return;
  const current = service;
  service = null;
  log.app.info('dsh host stopped', {});
  await current.stop().catch(() => undefined);
}

module.exports = {
  DSH_CREDENTIAL_DIR,
  HOST_CAPABILITIES,
  PEER_SYNC_INTERVAL_MS,
  startDshHostService,
  stopDshHostService,
  dshHostStatus,
  setAllowedPorts,
  applyDshRuntime,
  syncInboundPeers,
  createHostRouter,
};
