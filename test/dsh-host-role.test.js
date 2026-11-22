'use strict';
// dsh 被连接方（host）启动接线（2026-11-22，现场：远程以 host 角色登录后，本地 client 的
// 设备列表始终看不到它）：
// - 根因：host scope 曾用 ClientServerApi（role=client）注册设备，而中继 /api/v1/devices
//   只返回 role=host 的设备 → 本机永远不出现在其它 AgentLRay 的设备列表里。
// - 这里守住 host.js 侧的接线：被连接方必须用 HostServerApi（role=host），启动日志带
//   deviceId（便于与中继设备列表核对），且无有效 token 时不静默起服务。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 必须在 require 任何 lib 模块之前改 HOME（lib/config 在 require 期解析 HOME）。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-host-role-test-'));
process.env.HOME = tmpHome;

const { test, mock } = require('node:test');
const assert = require('node:assert/strict');

const vendorMod = require('../lib/dsh/vendor');
const hostService = require('../lib/dsh/host');
const { identityStoreFor } = require('../lib/dsh/identity');
const { saveDshSettings, normalizeServerUrl } = require('../lib/dsh/settings');

const SERVER_URL = normalizeServerUrl('https://relay.example.com');
const DAY = 86400_000;

// 本文件只跑 host scope：单槽位记录落盘凭据与构造调用。
const state = { stored: undefined, apiRoles: [], hostConnectionStarted: 0 };

function FakeStore() {
  this.load = async (serverUrl, deviceId) => {
    const s = state.stored;
    return s && s.serverUrl === serverUrl && s.deviceId === deviceId ? { ...s } : undefined;
  };
  this.save = async (record) => {
    state.stored = { ...record };
    return state.stored;
  };
  this.clear = async () => {
    state.stored = undefined;
  };
}

// 上游 HostServerApi 的第 4 个构造参数是 role（默认 'host'）。
function FakeHostServerApi(serverUrl, store, fetchImplementation, role = 'host') {
  this.baseUrl = serverUrl.replace(/\/+$/, '');
  this.role = role;
  this.bindIdentity = () => {};
  this.close = () => {};
  state.apiRoles.push(role);
}

function FakeConnectionController() {
  this.connectedPeers = () => [];
  this.close = async () => {};
}

function FakeHostServerConnection() {
  this.start = () => {
    state.hostConnectionStarted += 1;
  };
  this.isOnline = () => true;
  this.lastError = () => null;
  this.stop = async () => {};
}

// 与上游同形状的最小 SafeLogger（真实实现会加前缀并按字段脱敏，这里只验证 sink 接线）。
class FakeSafeLogger {
  constructor(sink) {
    this.sink = sink;
  }
  debug(message) {
    this.sink.debug(message);
  }
  info(message) {
    this.sink.info(message);
  }
  warn(message) {
    this.sink.warn(message);
  }
  error(message) {
    this.sink.error(message);
  }
}

// 只替换连接/凭据相关组件；身份存储（identity.js）在 require 期已捕获原始 loadVendor，
// 因此仍走真实 crypto/ids 生成 X25519 身份。
function fakeVendor() {
  return {
    serverApi: { HostServerApi: FakeHostServerApi },
    serverCredentials: { ServerCredentialStore: FakeStore },
    connectionController: { ConnectionController: FakeConnectionController },
    serverConnection: { HostServerConnection: FakeHostServerConnection },
    logging: { SafeLogger: FakeSafeLogger },
  };
}

function tokenRecord(identity) {
  return {
    serverUrl: SERVER_URL,
    deviceId: identity.deviceId,
    authorizationMethod: 'account',
    account: 'user@x.com',
    accessToken: 'a'.repeat(20),
    refreshToken: 'r'.repeat(20),
    accessTokenExpiresAt: Date.now() + 3600_000,
    refreshTokenExpiresAt: Date.now() + 30 * DAY,
  };
}

test('startDshHostService：以 HostServerApi（role=host）起被连接方，状态带 deviceId', async () => {
  // Given：host 角色 + 有效 host 凭据
  await saveDshSettings({ role: 'host', serverUrl: SERVER_URL, deviceName: 'dev', allowedPorts: [3800] });
  const identity = await identityStoreFor('host').loadOrCreate('dev');
  state.stored = tokenRecord(identity);
  state.apiRoles = [];

  // 必须在 mock 生效期间 await：mock.restore() 是同步的，先 restore 会退回真实 vendor。
  const m = mock.method(vendorMod, 'loadVendor', fakeVendor);
  let status;
  try {
    // When
    ({ status } = await hostService.startDshHostService());
  } finally {
    await hostService.stopDshHostService();
    m.mock.restore();
  }

  // Then：设备必须以 host 身份登记（否则中继设备列表看不到本机）
  assert.deepEqual(state.apiRoles, ['host']);
  assert.equal(state.hostConnectionStarted, 1);
  assert.equal(status.deviceId, identity.deviceId);
  assert.equal(status.running, true);
});

test('startDshHostService：无有效 host 凭据 → 登录已失效，不建控制连接', async () => {
  await saveDshSettings({ role: 'host', serverUrl: SERVER_URL, deviceName: 'dev', allowedPorts: [3800] });
  await identityStoreFor('host').loadOrCreate('dev');
  state.stored = undefined;
  state.apiRoles = [];
  state.hostConnectionStarted = 0;

  const m = mock.method(vendorMod, 'loadVendor', fakeVendor);
  const outcome = await hostService.startDshHostService().then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  m.mock.restore();

  assert.equal(outcome.error && outcome.error.code, 'DSH_AUTH_REQUIRED');
  assert.equal(state.hostConnectionStarted, 0);
});

test('startDshHostService：无设备身份（已退出）→ 报未登录且不生成身份文件', async () => {
  await saveDshSettings({ role: 'host', serverUrl: SERVER_URL, deviceName: 'dev', allowedPorts: [3800] });
  const dshDir = path.join(tmpHome, '.agentlray', 'dsh');
  fs.rmSync(dshDir, { recursive: true, force: true });
  state.stored = undefined;
  state.hostConnectionStarted = 0;

  const m = mock.method(vendorMod, 'loadVendor', fakeVendor);
  const outcome = await hostService.startDshHostService().then(
    (value) => ({ value }),
    (error) => ({ error })
  );
  m.mock.restore();

  assert.equal(outcome.error && outcome.error.code, 'DSH_AUTH_REQUIRED');
  // 回归：启动读路径不得把设备身份写回磁盘（否则退出后进程一重启就残留 dsh-device.*）。
  assert.equal(fs.existsSync(dshDir), false, '启动被连接方不得生成设备身份文件');
});

// 2026-11-22 现场：远程 host 显示离线，但 app 日志里没有任何控制通道记录——vendor 日志只写
// console，前台启动后 stdout 丢失，现场无法取证。host 日志器必须同步落 app 日志。
test('createLogger：控制通道日志同时写 console 与 app 日志（含字段）', () => {
  const { createLogger } = hostService;
  const calls = [];
  const appLog = {
    debug: (msg, fields) => calls.push(['debug', msg, fields]),
    info: (msg, fields) => calls.push(['info', msg, fields]),
    warn: (msg, fields) => calls.push(['warn', msg, fields]),
    error: (msg, fields) => calls.push(['error', msg, fields]),
  };
  const vendor = { logging: { SafeLogger: FakeSafeLogger } };
  const consoleSpy = mock.method(console, 'warn', () => {});
  try {
    const logger = createLogger(vendor, appLog);
    // When
    logger.warn('server control connection failed', { code: 'CONNECTION_FAILED' });
  } finally {
    consoleSpy.mock.restore();
  }

  // Then
  assert.deepEqual(calls.map(([level, message]) => [level, message]), [
    ['warn', 'server control connection failed'],
  ]);
  assert.equal(consoleSpy.mock.callCount(), 1);
});

test('createLogger：app 日志写入抛错不影响连接', () => {
  const { createLogger } = hostService;
  const vendor = { logging: { SafeLogger: FakeSafeLogger } };
  const appLog = {
    debug() {},
    info() {},
    warn() {
      throw new Error('disk full');
    },
    error() {},
  };
  const consoleSpy = mock.method(console, 'warn', () => {});
  try {
    const logger = createLogger(vendor, appLog);
    // When / Then
    assert.doesNotThrow(() => logger.warn('server control heartbeat timeout; reconnecting', {}));
  } finally {
    consoleSpy.mock.restore();
  }
});
