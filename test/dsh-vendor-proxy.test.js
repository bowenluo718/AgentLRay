'use strict';
// dsh 借码层（vendor）缺诊断信息（2026-11-22，现场：Windows 远程主机必须经企业代理出网，
// 控制通道 `CONNECTION_FAILED`，但日志无法区分「WS 打不开」与「凭据刷新超时」，
// 也无法区分「请求走没走代理」）：
// - 控制通道失败日志补齐 `message` 与底层 `cause`；
// - 控制请求超时日志带出底层网络错误（connect timeout / proxy 错误等）；
// - 控制帧编解码失败（中继返回非 JSON 帧等）必须落日志，不能静默丢弃。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vendor-proxy-test-'));
process.env.HOME = tmpHome;

const { test } = require('node:test');
const assert = require('node:assert/strict');

// loadVendor 是懒加载：与 host.js 一样经 vendor.js 入口取命名空间。
const vendorMod = require('../lib/dsh/vendor').loadVendor();

const SERVER_URL = 'https://relay.example.com';
const DEVICE_ID = '01a1ff17-2bb2-71b7-a9e9-50bfb2b494d9';
const DAY = 86400_000;

function recordingLogger() {
  const entries = [];
  const record = (level) => (message, fields) => entries.push({ level, message, fields });
  return { entries, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') };
}

function identity() {
  return { deviceId: DEVICE_ID, name: 'dev', publicKey: 'p'.repeat(44), privateKey: 'k'.repeat(44) };
}

// 凭据新鲜：authenticate() 走无锁快路径直接返回，不碰网络与锁。
function fakeApi(overrides = {}) {
  return {
    baseUrl: SERVER_URL,
    authenticate: async () => ({
      serverUrl: SERVER_URL,
      deviceId: DEVICE_ID,
      accessToken: 'a'.repeat(20),
      refreshToken: 'r'.repeat(20),
      accessTokenExpiresAt: Date.now() + DAY,
      refreshTokenExpiresAt: Date.now() + 30 * DAY,
      authorizationMethod: 'account',
      account: 'u',
    }),
    refreshCredentials: async () => {
      throw new Error('unused');
    },
    ...overrides,
  };
}

function fakeIdentities() {
  return { trustedPeer: () => undefined, save: async () => undefined, load: async () => undefined };
}

function config() {
  return {
    enabled: true,
    role: 'host',
    serverUrl: SERVER_URL,
    httpServerAllowlist: [],
    deviceName: 'dev',
    forceRelay: true,
    rotatePinnedPeerKey: false,
    logLevel: 'info',
    reconnect: { enabled: false },
    terminal: { enabled: false },
    sidebar: { entry: 'standard' },
    loopback: { ports: [3800] },
    codex: { enabled: false, binary: '' },
    cursor: { enabled: false, binary: '' },
  };
}

function connection(api, logger, overrides = {}) {
  return new vendorMod.serverConnection.HostServerConnection(
    config(),
    identity(),
    fakeIdentities(),
    api,
    { close: async () => {} },
    logger,
    overrides.createWebSocket,
    undefined,
    () => ['agentlray.loopback.v1']
  );
}

/** 轮询等待条件成立（日志在连接收尾之后才写，不能只看 start() 返回）。 */
async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function failuresOf(logger) {
  return logger.entries.filter((entry) => entry.message === 'server control connection failed');
}

/** 最近一次控制通道失败日志（首次失败后可能还有重连失败，取最后一条）。 */
function failureOf(logger) {
  return failuresOf(logger).at(-1);
}

/** 等到出现第一条 code 为 expectedCode 的控制通道失败日志。 */
async function waitForFailure(logger, expectedCode) {
  await waitFor(() => failuresOf(logger).some((entry) => entry.fields.code === expectedCode));
  return failuresOf(logger).find((entry) => entry.fields.code === expectedCode);
}

function controlErrorFrame(payload) {
  return JSON.stringify({ v: 1, id: '01a1ff42-0000-7000-8000-0000000000aa', type: 'error', timestamp: Date.now(), payload });
}

test('控制通道失败日志：WS 打不开时带 message 与底层 cause.code', async () => {
  // Given：WebSocket 立即失败，底层是代理/连接错误
  const logger = recordingLogger();
  const cause = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
  const createWebSocket = () => {
    const handlers = {};
    const socket = {
      readyState: 0,
      set onopen(fn) {
        handlers.open = fn;
      },
      set onmessage(fn) {
        handlers.message = fn;
      },
      set onerror(fn) {
        handlers.error = fn;
      },
      set onclose(fn) {
        handlers.close = fn;
      },
      close() {},
      send() {},
    };
    setImmediate(() => {
      socket.readyState = 3;
      handlers.error?.({ error: cause });
      handlers.close?.({ code: 1006, reason: '' });
    });
    return socket;
  };
  const conn = connection(fakeApi(), logger, { createWebSocket });

  // When
  conn.start();
  await waitFor(() => failureOf(logger) !== undefined);

  // Then
  const failure = failureOf(logger);
  assert.ok(failure, '必须记录控制通道失败');
  assert.equal(failure.fields.code, 'CONNECTION_FAILED');
  assert.equal(typeof failure.fields.message, 'string');
  assert.equal(failure.fields.cause, 'ECONNREFUSED');
  await conn.stop();
});

test('控制通道失败日志：hello 后中继以 close 4002 拒绝时记录 code 与原因', async () => {
  // Given：WS 打开后中继以 close 4002（未 hello.ack）拒绝，凭据刷新成功但重连仍被拒——
  // 现场 hello 后收到「4002 invalid access token」，中继以 close 表达拒绝而不是发 error 帧。
  const logger = recordingLogger();
  const createWebSocket = () => {
    const handlers = {};
    const socket = {
      readyState: 0,
      set onopen(fn) {
        handlers.open = fn;
      },
      set onmessage(fn) {
        handlers.message = fn;
      },
      set onerror(fn) {
        handlers.error = fn;
      },
      set onclose(fn) {
        handlers.close = fn;
      },
      close() {},
      send() {},
    };
    setImmediate(() => {
      socket.readyState = 1;
      handlers.open?.();
      // 必须等 hello 帧真正发出后再关闭：Node 内置 WebSocket 会静默丢弃 CONNECTING 阶段的 close，
      // 立即关闭会让断言拿到「无关闭」的 CONNECTION_FAILED，测不到真实中继行为。
      setImmediate(() => handlers.close?.({ code: 4002, reason: 'invalid access token' }));
    });
    return socket;
  };
  const api = fakeApi({ refreshCredentials: async () => fakeApi().authenticate() });
  const conn = connection(api, logger, { createWebSocket });

  // When
  conn.start();
  const failure = await waitForFailure(logger, 'AUTH_INVALID');

  // Then：vendor 把 4002 归一成 AUTH_INVALID，但日志必须保留中继给出的关闭码与原因，
  // 否则现场只能看到「AUTH_INVALID」，无法区分 token 失效 / 设备被顶替 / 协议版本不符。
  assert.ok(failure, '必须记录控制通道失败');
  assert.equal(failure.fields.code, 'AUTH_INVALID');
  assert.equal(failure.fields.closeCode, 4002);
  assert.equal(failure.fields.closeReason, 'invalid access token');
  await conn.stop();
});

test('控制请求超时：日志带出底层网络错误（如代理连接超时）', async () => {
  // Given：底层 fetch 在 abort 前抛出连接超时
  const logger = recordingLogger();
  // 模拟 Node fetch 经代理时的形态：TypeError('fetch failed')，cause 为带 code 的连接错误。
  const underlying = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }),
  });
  const fetchImplementation = async () => {
    throw underlying;
  };
  const store = {
    load: async () => undefined,
    save: async () => undefined,
    withRefreshLock: async (operation) => operation(),
  };
  const api = new vendorMod.serverApi.HostServerApi(SERVER_URL, store, fetchImplementation, 'host');
  api.bindIdentity(identity());
  const conn = connection(api, logger);

  // When
  conn.start();
  await waitFor(() => failureOf(logger) !== undefined);

  // Then
  const failure = failureOf(logger);
  assert.ok(failure, '必须记录控制通道失败');
  assert.equal(failure.fields.reason, 'network_error');
  const chain = logger.entries.find((entry) => entry.message === 'server control authenticate failed');
  assert.ok(chain, 'debug 级应输出完整错误链');
  assert.match(chain.fields.chain, /Connect Timeout Error \[UND_ERR_CONNECT_TIMEOUT\]/);
  assert.equal(failure.fields.cause, 'UND_ERR_CONNECT_TIMEOUT');
  await conn.stop();
});

test('控制帧编解码失败：记录 server control frame failed（含底层 cause）', async () => {
  // Given：WS 打开后收到非 JSON 帧
  const logger = recordingLogger();
  const createWebSocket = () => {
    const handlers = {};
    const socket = {
      readyState: 0,
      set onopen(fn) {
        handlers.open = fn;
      },
      set onmessage(fn) {
        handlers.message = fn;
      },
      set onerror(fn) {
        handlers.error = fn;
      },
      set onclose(fn) {
        handlers.close = fn;
      },
      close() {},
      send() {},
    };
    setImmediate(() => {
      socket.readyState = 1;
      handlers.open?.();
      handlers.message?.({ data: '<html>502 Bad Gateway</html>' });
    });
    return socket;
  };
  const conn = connection(fakeApi(), logger, { createWebSocket });

  // When
  conn.start();
  await waitFor(() => logger.entries.some((entry) => entry.message === 'server control frame failed'));

  // Then
  const frameLog = logger.entries.find((entry) => entry.message === 'server control frame failed');
  assert.ok(frameLog, '编解码失败必须落日志');
  assert.ok(frameLog.fields.cause, '必须带出底层错误');
  await conn.stop();
});
