'use strict';
// dsh 连接方认证诊断（2026-11-22，基于 Android 薄服务现场日志 docs/.local/test/files/agentlray/logs）：
// - 认证失败不得一律折叠成「登录已失效」：只有 token 真失效才这样提示，其它失败保留真实 code。
// - 认证失败必须落 app 日志（含 code / cause），此前 `/api/dsh/devices` 失败零日志，无法现场定位。
// - probe（连接测试）scope 同样需要可用的设备凭据，否则 /api/dsh/test 永远报登录失效。
// 用注入 fake vendor（真实 ServerCredentialStore 的语义 + 可注入的 authenticate 行为），不访问真实中继。
const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-auth-test-'));
process.env.HOME = tmpHome;

const vendorMod = require('../lib/dsh/vendor');
const client = require('../lib/dsh/client');
const auth = require('../lib/dsh/auth');
const { identityStoreFor } = require('../lib/dsh/identity');
const { saveDshSettings } = require('../lib/dsh/settings');
const { SETTINGS_FILE } = require('../lib/settings');
const { HOSTS_FILE } = require('../lib/hosts');
const mountDshRoutes = require('../lib/routes/dsh');

const SERVER_URL = 'https://relay.example.com';
const DAY = 86400_000;

function tokenRecord(identity, overrides = {}) {
  return {
    serverUrl: SERVER_URL,
    deviceId: identity.deviceId,
    authorizationMethod: 'account',
    accessToken: 'a'.repeat(20),
    refreshToken: 'r'.repeat(20),
    accessTokenExpiresAt: Date.now() + 3600_000,
    refreshTokenExpiresAt: Date.now() + 30 * DAY,
    ...overrides,
  };
}

function serverApiError(code, message) {
  const e = new Error(message);
  e.name = 'ServerApiError';
  e.code = code;
  return e;
}

// 每个 scope 一个内存凭据存储（directory 末段即 scope 名），语义与真实 ServerCredentialStore 对齐。
const stores = {};
function FakeStore(directory) {
  const scope = directory.split(path.sep).pop();
  if (!stores[scope]) stores[scope] = { saved: undefined };
  this._scope = scope;
  this._store = stores[scope];
}
FakeStore.prototype.load = async function load(serverUrl, deviceId) {
  const s = this._store.saved;
  return s && s.serverUrl === serverUrl && s.deviceId === deviceId ? { ...s } : undefined;
};
FakeStore.prototype.save = async function save(c) {
  this._store.saved = { ...c };
  return this._store.saved;
};
FakeStore.prototype.clear = async function clear() {
  this._store.saved = undefined;
};
// 测试专用：按 scope 取当前落盘记录（生产 store 无此方法）。
FakeStore.get = (scope) => (stores[scope] ??= { saved: undefined });
// 测试专用：模拟磁盘凭据文件随目录一起消失（真实 store 的 clear 不会自动发生）。
FakeStore.reset = () => {
  for (const scope of Object.keys(stores)) stores[scope].saved = undefined;
};
FakeStore.prototype.withRefreshLock = async function withRefreshLock(op) {
  return op();
};

// authenticate 行为可注入：默认成功（模拟本地 access token 仍在有效期）。
const calls = { authenticate: [], listDevices: [], presenceFor: [], authorizeWithAccount: [], authorizeOwnedRole: [], scopes: [] };
let authenticateImpl;
let listDevicesImpl;
let presenceImpl;

function FakeClientServerApi(serverUrl, store, fetchImplementation, role = 'client') {
  this.baseUrl = serverUrl.replace(/\/+$/, '');
  this.role = role;
  this.store = store;
  this.identity = undefined;
  this.bindIdentity = (id) => {
    this.identity = id;
  };
  this.authenticate = async (identity) => {
    calls.authenticate.push({ scope: this.store._scope, deviceId: identity.deviceId });
    return authenticateImpl(this, identity);
  };
  this.listDevices = async () => {
    calls.listDevices.push(this.store._scope);
    return listDevicesImpl();
  };
  this.presenceFor = async (deviceId) => {
    calls.presenceFor.push(deviceId);
    return presenceImpl(deviceId);
  };
  // 返回账号授权（PATCH：authorizeWithAccount 返回 { method, account, accountToken }），
  // 供登录后顺带登记 probe 复用（probe 不能再走账号密码）。
  this.authorizeWithAccount = async (identity, email) => {
    calls.authorizeWithAccount.push(this.store._scope);
    // PATCH：上游 authorizeWithAccount 返回账号令牌并随凭据落盘（用于补登记 probe）。
    const accountToken = 'a'.repeat(20);
    await this.store.save(tokenRecord(identity, { accountToken, account: email ?? '' }));
    return { method: 'account', account: email ?? '', accountToken };
  };
  // 派生身份登记（上游 authorizeOwnedRole）：用 owner 的 access token 换 probe 凭据。
  this.authorizeOwnedRole = async (identity, authorizingAccessToken, account) => {
    calls.authorizeOwnedRole.push(this.store._scope);
    if (!authorizingAccessToken) throw serverApiError('AUTHORIZATION_REQUIRED', 'authorizing access token required');
    await this.store.save(tokenRecord(identity, { authorizationMethod: 'owned_device', ...(account ? { account } : {}) }));
    return { method: 'owned_device', ...(account ? { account } : {}) };
  };
  // probe（派生身份）用账号授权登记（PATCH：authorizeOwnedRoleWithAccount）。
  this.authorizeOwnedRoleWithAccount = async (identity, accountToken, account) => {
    calls.authorizeWithAccount.push(this.store._scope);
    if (!accountToken) throw serverApiError('INVALID_MESSAGE', 'Account authorization is required.');
    await this.store.save(tokenRecord(identity, account ? { account } : {}));
  };
  this.oauthProviders = async () => [];
  this.startOAuthQrLogin = async () => ({ qrId: 'q'.repeat(20), scanUrl: `${this.baseUrl}/qr`, expiresIn: 600 });
  this.pollOAuthQrLogin = async (identity) => {
    await this.store.save(tokenRecord(identity));
    return { status: 'complete', authorization: { method: 'account' }, accountToken: 'a'.repeat(20) };
  };
}

// HostServerApi 默认 role='host'（与上游一致）：auth.js 的 host scope 必须用它注册。
function FakeHostServerApi(serverUrl, store, fetchImplementation, role = 'host') {
  FakeClientServerApi.call(this, serverUrl, store, fetchImplementation, role);
}

function fakeVendor() {
  return {
    serverApi: { ClientServerApi: FakeClientServerApi, HostServerApi: FakeHostServerApi },
    serverCredentials: { ServerCredentialStore: FakeStore },
    crypto: { fromBase64Url: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64') },
  };
}

// 独立日志目录 + 重置懒初始化：读本次用例写入的 app 日志。
function withLogCapture(fn) {
  const log = require('../lib/logging');
  const prevDir = process.env.AGENTLRAY_LOG_DIR;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-client-auth-log-'));
  process.env.AGENTLRAY_LOG_DIR = dir;
  log.close();
  const readApp = () => {
    const file = path.join(dir, `app-${log.localDate()}.log`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  return Promise.resolve()
    .then(() => fn(readApp))
    .finally(() => {
      log.close();
      if (prevDir === undefined) delete process.env.AGENTLRAY_LOG_DIR;
      else process.env.AGENTLRAY_LOG_DIR = prevDir;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

function withFakeVendor(fn) {
  const m = mock.method(vendorMod, 'loadVendor', fakeVendor);
  return Promise.resolve()
    .then(fn)
    .finally(() => m.mock.restore());
}

beforeEach(async () => {
  for (const k of Object.keys(stores)) delete stores[k];
  client.clearPresenceCacheForTest();
  calls.authenticate = [];
  calls.listDevices = [];
  calls.presenceFor = [];
  calls.authorizeWithAccount = [];
  calls.authorizeOwnedRole = [];
  calls.scopes = [];
  authenticateImpl = async (api, identity) => {
    const stored = await api.store.load(api.baseUrl, identity.deviceId);
    return stored;
  };
  listDevicesImpl = async () => [];
  presenceImpl = async () => ({ online: false });
  try {
    fs.rmSync(SETTINGS_FILE);
  } catch {
    /* 忽略 */
  }
  try {
    fs.rmSync(HOSTS_FILE);
  } catch {
    /* 忽略 */
  }
  await saveDshSettings({ role: 'client', serverUrl: SERVER_URL, deviceName: 'dev', allowedPorts: [3800] });
});

// ---- listDshDevices 的错误分类 ----

test('listDshDevices：client token 有效但 authenticate 因凭据刷新锁不可用失败 → 不误报「登录已失效」', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      // Given：client scope 已有有效 token（配置视图会显示已登录）
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      authenticateImpl = async () => {
        throw serverApiError(
          'SERVER_CREDENTIALS_LOCK_UNSUPPORTED',
          'Credential lock cannot create a hard link in DSH_HOME. Use a writable local ext4 or XFS file system.'
        );
      };

      // When / Then：真实原因透出，而不是「登录已失效」
      await assert.rejects(
        () => client.listDshDevices(),
        (error) => {
          assert.equal(error.code, 'SERVER_CREDENTIALS_LOCK_UNSUPPORTED');
          assert.doesNotMatch(error.message, /登录已失效/);
          assert.match(error.message, /hard link/);
          return true;
        }
      );
      // 日志：warn + 真实 code（可现场定位）
      const text = readApp();
      assert.match(text, /\[warn\].*dsh client auth failed/);
      assert.match(text, /"scope":"client"/);
      assert.match(text, /"code":"SERVER_CREDENTIALS_LOCK_UNSUPPORTED"/);
    })
  );
});

test('listDshDevices：refresh token 已被中继服务器拒绝（401）→ 保留「登录已失效」语义并带 DSH_AUTH_REQUIRED', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      authenticateImpl = async () => {
        throw serverApiError('AUTH_INVALID', 'invalid refresh token');
      };

      await assert.rejects(
        () => client.listDshDevices(),
        (error) => {
          assert.equal(error.code, 'DSH_AUTH_REQUIRED');
          assert.match(error.message, /登录已失效/);
          // 原始原因保留在 cause 上，供日志与诊断
          assert.equal(error.cause?.code, 'AUTH_INVALID');
          return true;
        }
      );
      const text = readApp();
      assert.match(text, /"code":"DSH_AUTH_REQUIRED"/);
      assert.match(text, /"upstreamCode":"AUTH_INVALID"/);
    })
  );
});

test('listDshDevices：client scope 无凭据 → 不发起 authenticate，直接提示重新登录并落日志', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      await assert.rejects(
        () => client.listDshDevices(),
        (error) => {
          assert.equal(error.code, 'DSH_AUTH_REQUIRED');
          assert.match(error.message, /登录已失效/);
          return true;
        }
      );
      assert.equal(calls.authenticate.length, 0);
      const text = readApp();
      assert.match(text, /\[warn\].*dsh client auth failed/);
      assert.match(text, /"reason":"no-credential"/);
    })
  );
});

test('listDshDevices：成功路径不写认证失败日志', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      const devices = await client.listDshDevices();
      assert.deepEqual(devices, []);
      assert.doesNotMatch(readApp(), /dsh client auth failed/);
    })
  );
});

// ---- 设备在线状态：列表接口不返回 online，必须逐个查 presence ----

// 现场（2026-11-22）：中继 /api/v1/devices 的条目只有 lastConnectedAt，没有 online/lastSeenAt；
// 在线与否只能从 /api/v1/devices/:id/presence 取（实测本机 host 控制通道已上线，列表却恒为 false）。
function relayDevice(deviceId, overrides = {}) {
  return { deviceId, name: `dev-${deviceId.slice(-4)}`, platform: 'linux', membershipId: 'm-1', ...overrides };
}

test('listDshDevices：列表缺 online 字段时逐个查 presence 回填在线状态', async () => {
  await withFakeVendor(() =>
    withLogCapture(async () => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      listDevicesImpl = async () => [relayDevice('01a200c6-2268-7ab8-a19e-380074f3dccf')];
      presenceImpl = async () => ({ online: true, lastSeenAt: 1795309326057 });

      const devices = await client.listDshDevices();

      assert.equal(devices.length, 1);
      assert.equal(devices[0].online, true);
      assert.equal(devices[0].lastSeenAt, 1795309326057);
      assert.deepEqual(calls.presenceFor, ['01a200c6-2268-7ab8-a19e-380074f3dccf']);
    })
  );
});

test('listDshDevices：presence 以中继实时值为准，覆盖列表里的旧 online', async () => {
  await withFakeVendor(() =>
    withLogCapture(async () => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      listDevicesImpl = async () => [relayDevice('01a200c6-2268-7ab8-a19e-380074f3dccf', { online: true })];
      presenceImpl = async () => ({ online: false, lastSeenAt: 1000 });

      const devices = await client.listDshDevices();

      assert.equal(devices[0].online, false);
      assert.equal(devices[0].lastSeenAt, 1000);
    })
  );
});

test('listDshDevices：presence 结果 5s 内复用缓存，避免刷新列表时重复 N+1 请求', async () => {
  await withFakeVendor(() =>
    withLogCapture(async () => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      listDevicesImpl = async () => [relayDevice('01a200c6-2268-7ab8-a19e-380074f3dccf')];
      presenceImpl = async () => ({ online: true, lastSeenAt: 3000 });

      await client.listDshDevices();
      const devices = await client.listDshDevices();

      assert.equal(devices[0].online, true);
      assert.equal(devices[0].lastSeenAt, 3000);
      assert.deepEqual(calls.presenceFor, ['01a200c6-2268-7ab8-a19e-380074f3dccf'], '第二次应命中缓存');
    })
  );
});

test('listDshDevices：单台 presence 查询失败不影响整张列表（该台标为未知，不误报离线）', async () => {
  await withFakeVendor(() =>
    withLogCapture(async () => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      listDevicesImpl = async () => [
        relayDevice('01a200c6-2268-7ab8-a19e-380074f3dccf'),
        relayDevice('01a1ff17-2bb2-71b7-a9e9-50bfb2b494d9'),
      ];
      presenceImpl = async (deviceId) => {
        if (deviceId.startsWith('01a200c6')) throw serverApiError('CONNECTION_FAILED', 'request timeout');
        return { online: true, lastSeenAt: 2000 };
      };

      const devices = await client.listDshDevices();

      assert.equal(devices.length, 2);
      // 列表条目没有 online 字段，presence 失败时不得回落到 Boolean(undefined)=false
      //（会把在线设备误报为离线，用户无法在 UI 中选中），而是返回「未知」。
      assert.equal(devices[0].online, null);
      assert.equal(devices[0].lastSeenAt, null);
      assert.equal(devices[1].online, true);
      assert.equal(devices[1].lastSeenAt, 2000);
    })
  );
});

// ---- 路由：/api/dsh/devices 失败可诊断 ----

test('GET /api/dsh/devices 失败 → 400 带真实 code 与原因，且落 app 日志', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      const identity = await identityStoreFor('client').loadOrCreate('dev');
      FakeStore.get('client').saved = tokenRecord(identity);
      authenticateImpl = async () => {
        throw serverApiError('SERVER_CREDENTIALS_LOCK_UNSUPPORTED', 'lock unsupported');
      };
      const app = require('express')();
      app.use(require('express').json());
      mountDshRoutes(app, { forceClient: true });
      const server = http.createServer(app);
      await new Promise((r) => server.listen(0, r));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        const res = await fetch(`${base}/api/dsh/devices`);
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.equal(body.code, 'SERVER_CREDENTIALS_LOCK_UNSUPPORTED');
        assert.match(body.error, /lock unsupported/);
      } finally {
        server.close();
      }
      assert.match(readApp(), /\[warn\].*dsh devices failed/);
      assert.match(readApp(), /"code":"SERVER_CREDENTIALS_LOCK_UNSUPPORTED"/);
    })
  );
});

// ---- probe scope（连接测试）凭据 ----

test('loginWithAccount(client)：同时为 probe（连接测试）scope 注册凭据', async () => {
  await withFakeVendor(async () => {
    const res = await auth.loginWithAccount('client', 'user@x.com', 'pw');
    // roles 仍只表示「登录 scope」；probe 结果单独返回（不改变既有契约）。
    assert.deepEqual(res.roles, ['client']);
    assert.deepEqual(res.probe, { ok: true });
    assert.deepEqual(calls.authorizeWithAccount, ['client', 'probe']);
    // 登录态判定只看 host/client（probe 不参与「是否已登录」）。
    assert.deepEqual((await auth.scopeLoginStatus()).roles, ['client']);
  });
});

test('loginWithAccount(host)：不需要 probe 凭据', async () => {
  await withFakeVendor(async () => {
    const res = await auth.loginWithAccount('host', 'user@x.com', 'pw');
    assert.deepEqual(res.roles, ['host']);
    assert.equal(res.probe, undefined);
    assert.deepEqual(calls.authorizeWithAccount, ['host']);
  });
});

test('loginWithAccount：probe 注册失败不影响 client 登录结果', async () => {
  await withFakeVendor(async () => {
    const realSave = FakeStore.prototype.save;
    FakeStore.prototype.save = async function save(c) {
      if (this._scope === 'probe') throw serverApiError('CONNECTION_FAILED', 'probe register failed');
      return realSave.call(this, c);
    };
    try {
      const res = await auth.loginWithAccount('client', 'user@x.com', 'pw');
      assert.deepEqual(res.roles, ['client']);
      assert.deepEqual(res.probe, { ok: false, code: 'CONNECTION_FAILED', message: 'probe register failed' });
    } finally {
      FakeStore.prototype.save = realSave;
    }
    assert.deepEqual((await auth.scopeLoginStatus()).roles, ['client']);
  });
});

test('pollQrLogin(client)：扫码完成后同时为 probe scope 注册凭据', async () => {
  await withFakeVendor(async () => {
    const sess = await auth.startQrLogin('client', 'zhihu');
    const poll = await auth.pollQrLogin('client', sess.qrId);
    assert.equal(poll.status, 'complete');
    assert.deepEqual(poll.probe, { ok: true });
    assert.ok(FakeStore.get('client').saved, 'client 凭据已落盘');
    assert.ok(FakeStore.get('probe').saved, 'probe 凭据已落盘');
    // probe 用独立的设备身份（不与 client 共用，避免顶替出站控制连接）。
    assert.notEqual(FakeStore.get('probe').saved.deviceId, FakeStore.get('client').saved.deviceId);
  });
});

test('provisionProbeFromOwner：用 host scope 的 access token 登记 probe（授权方角色必须相反）', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('both', 'user@x.com', 'pw');
    // 模拟现场：probe 凭据目录缺失。
    FakeStore.get('probe').saved = undefined;
    calls.authorizeOwnedRole = [];
    calls.authenticate = [];

    const result = await auth.provisionProbeFromOwner();

    assert.equal(result.ok, true, `补登记应成功，实际 ${JSON.stringify(result.error)}`);
    assert.deepEqual(calls.authorizeOwnedRole, ['probe']);
    assert.ok(FakeStore.get('probe').saved, 'probe 凭据已落盘');
    assert.ok(
      calls.authenticate.some((call) => call.scope === 'host'),
      '授权 token 必须来自 host scope（probe 是 client 角色，owned-role 要求相反角色）'
    );
  });
});

test('provisionProbeFromOwner：只有 client 登录时不盲目用 client token，返回明确失败', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    FakeStore.get('probe').saved = undefined;
    calls.authorizeOwnedRole = [];

    const result = await auth.provisionProbeFromOwner();

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'AUTHORIZATION_REQUIRED');
    assert.deepEqual(calls.authorizeOwnedRole, [], 'client token 会被中继以「角色必须相反」拒绝，不得尝试');
  });
});

test('loginWithAccount：client token 仍有效但 probe 缺失时，重新登录会补登记 probe', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    // 旧版本升级现场：client 凭据有效，probe 目录缺失。
    FakeStore.get('probe').saved = undefined;
    calls.authorizeWithAccount = [];

    await auth.loginWithAccount('client', 'user@x.com', 'pw');

    assert.ok(calls.authorizeWithAccount.length >= 1, '主 scope 被跳过时仍需取一次账号授权来登记 probe');
    assert.ok(FakeStore.get('probe').saved, '重新登录后 probe 凭据应已落盘');
  });
});

test('openDshTunnel(probe)：凭据已就绪时能通过认证（不再永远报登录失效）', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    // 走到 authenticate 之后的列表检查（fake listDevices 为空 → 「不在可见列表」），说明认证已通过。
    await assert.rejects(
      () => client.openDshTunnel({ deviceId: '01a1fe91-c085-75aa-a90b-a471c92ba182', scope: 'probe' }),
      /不在当前账号的可见列表/
    );
    assert.deepEqual(calls.authenticate.map((c) => c.scope), ['probe'], '凭据已就绪时不得再取 owner token');
  });
});

test('openDshTunnel(probe)：probe 无凭据时用 host 身份的 access token 自动补登记后再连接', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('both', 'user@x.com', 'pw');
    // 模拟现场：历史版本登录时没有顺带登记 probe（凭据目录缺失，身份文件还在）。
    FakeStore.get('probe').saved = undefined;
    calls.authorizeOwnedRole = [];

    // 走到 authenticate 之后的列表检查（fake listDevices 为空 → 「不在可见列表」），说明认证已通过。
    await assert.rejects(
      () => client.openDshTunnel({ deviceId: '01a1fe91-c085-75aa-a90b-a471c92ba182', scope: 'probe' }),
      /不在当前账号的可见列表/
    );
    assert.deepEqual(calls.authorizeOwnedRole, ['probe'], '应复用 host 身份的 access token 补登记 probe');
    // 一次 host 认证（取 owner token）+ 一次 probe 认证（重试连接）。
    assert.deepEqual(calls.authenticate.map((c) => c.scope), ['host', 'probe']);
    assert.ok(FakeStore.get('probe').saved, 'probe 凭据已补登记');
  });
});

test('openDshTunnel(probe)：本机没有 host 登录时给出可操作的提示（不再误报登录已失效）', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    FakeStore.get('probe').saved = undefined;
    calls.authorizeOwnedRole = [];

    await assert.rejects(
      () => client.openDshTunnel({ deviceId: '01a1fe91-c085-75aa-a90b-a471c92ba182', scope: 'probe' }),
      (error) => error.code === 'DSH_PROBE_NOT_PROVISIONED' && /重新登录一次 dsh/.test(error.message)
    );
    assert.deepEqual(calls.authorizeOwnedRole, [], 'client token 不是相反角色，不得盲目登记（会被中继拒绝）');
  });
});

test('logout 后 listDshDevices：报未登录且不重建身份文件', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    const dshDir = path.join(tmpHome, '.agentlray', 'dsh');
    await auth.logout();
    assert.equal(fs.existsSync(dshDir), false);
    // 回归：列设备是读路径，退出后打开「添加主机」弹框会触发它——不得重新生成设备身份。
    await assert.rejects(() => client.listDshDevices(), /登录已失效/);
    assert.equal(fs.existsSync(dshDir), false, 'listDshDevices 不得生成设备身份文件');
  });
});

test('logout：一并清理 probe 凭据', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    assert.ok(FakeStore.get('probe').saved);
    await auth.logout();
    // 退出 = 删除 ~/.agentlray/dsh（磁盘上的凭据没了）；内存存储模拟同一语义。
    assert.equal(fs.existsSync(path.join(tmpHome, '.agentlray', 'dsh')), false);
    FakeStore.reset();
    assert.equal(FakeStore.get('probe').saved, undefined);
    assert.equal(FakeStore.get('client').saved, undefined);
  });
});
