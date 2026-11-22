'use strict';
// dsh 多登录方式（design-dsh-login-methods）：
// - 账号密码不落盘：saveDshSettings 不再写 email/passwordEnc（保留旧密文）。
// - auth.js：provider 发现 / qr start/poll / 账号密码 login / logout / 登录态判定。
// - 路由：/api/dsh/config 返回 authStatus；/api/dsh/auth/* 端点。
// - 连接改为纯 token 驱动：client.js/host.js 无有效 token 抛「登录已失效」。
//
// 用注入 fake vendor（模拟官方真实形状：providers 3 个、qr 会话、login 401/成功、错误信封），
// 不依赖真实 dsh.r2049.cn。

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-test-'));
process.env.HOME = tmpHome;

const { loadVendor } = require('../lib/dsh/vendor');
const vendorMod = require('../lib/dsh/vendor');
const auth = require('../lib/dsh/auth');
const { saveDshSettings, loadDshSettings } = require('../lib/dsh/settings');
const { HOSTS_FILE } = require('../lib/hosts');
const { SETTINGS_FILE } = require('../lib/settings');
const mountDshRoutes = require('../lib/routes/dsh');

// ---- 注入 fake vendor ----

// 每个 scope 一个内存凭据存储：模拟 ServerCredentialStore（load/save/clear）。
// auth.js 用 `new ServerCredentialStore(credentialDir(scope))`，directory 末段即 scope 名。
const stores = {};
function FakeServerCredentialStore(directory) {
  const scope = directory.split(path.sep).pop();
  if (!stores[scope]) stores[scope] = { saved: undefined };
  this._scope = scope;
  this._store = stores[scope];
}
FakeServerCredentialStore.prototype.load = async function load(serverUrl, deviceId) {
  const s = this._store.saved;
  return s && s.serverUrl === serverUrl && s.deviceId === deviceId ? { ...s } : undefined;
};
FakeServerCredentialStore.prototype.save = async function save(credentials) {
  this._store.saved = { ...credentials };
  return this._store.saved;
};
FakeServerCredentialStore.prototype.clear = async function clear() {
  this._store.saved = undefined;
};
FakeServerCredentialStore.prototype.withRefreshLock = async function withRefreshLock(op) {
  return op();
};
FakeServerCredentialStore.prototype.pairingHostOnly = async function pairingHostOnly() {
  return false;
};
FakeServerCredentialStore.prototype.restrictPairingHostOnly = async function restrictPairingHostOnly() {};

// 官方 providers（实测形状）。
const FAKE_PROVIDERS = [
  { id: 'zhihu', displayName: '知乎', startUrl: '/api/v1/auth/oauth/start', qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=zhihu' },
  { id: 'github', displayName: 'GitHub', startUrl: '/api/v1/auth/oauth/github/start', qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=github' },
  { id: 'google', displayName: 'Google', startUrl: '/api/v1/auth/oauth/google/start', qrStartUrl: '/api/v1/auth/oauth/qr/start?provider=google' },
];

// 记录被调用的事件，供断言。
const calls = { authorizeWithAccount: [], authorizeOwned: [], qrStart: [], qrPoll: [], apiRoles: [], providers: 0, providersBaseUrl: undefined, providersThrow: false, providersNetworkError: false, providersDnsError: false };

// 与真实 vendor 一致：设备 role 由使用的 API 类决定（HostServerApi=host / ClientServerApi=client），
// 注册时上游用 this.role 生成设备描述（deviceDescriptor）→ 记录它以便断言。
function FakeClientServerApi(serverUrl, store, fetchImplementation, role = 'client') {
  this.baseUrl = serverUrl.replace(/\/+$/, '');
  this.store = store;
  this.role = role;
  this.identity = undefined;
  this.bindIdentity = (id) => { this.identity = id; };
  calls.apiRoles.push(this.role);
  // probe（派生身份）用账号授权登记，不传账号密码（PATCH：authorizeOwnedRoleWithAccount）。
  this.authorizeOwnedRoleWithAccount = async (identity, accountToken, account, recoverIdentity) => {
    calls.authorizeOwned.push({ deviceId: identity.deviceId, role: this.role, accountToken, account, recover: typeof recoverIdentity === 'function' });
    if (!accountToken) {
      const e = new Error('Account authorization is required.');
      e.code = 'INVALID_MESSAGE';
      throw e;
    }
    await this.store.save({
      serverUrl: this.baseUrl,
      deviceId: identity.deviceId,
      authorizationMethod: 'account',
      ...(account ? { account } : {}),
      accessToken: 'a'.repeat(20),
      refreshToken: 'r'.repeat(20),
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
    });
  };
  this.oauthProviders = async () => {
    calls.providers += 1;
    calls.providersBaseUrl = this.baseUrl;
    if (calls.providersDnsError) {
      // 手机 rootfs 无可用 nameserver 时的真实链路：fetch failed → getaddrinfo EAI_AGAIN。
      const err = new Error('Server request failed.');
      err.name = 'ServerApiError';
      err.code = 'CONNECTION_FAILED';
      err.reason = 'network_error';
      err.cause = Object.assign(new Error('fetch failed'), {
        name: 'TypeError',
        cause: Object.assign(new Error('getaddrinfo EAI_AGAIN dsh.r2049.cn'), { code: 'EAI_AGAIN' }),
      });
      throw err;
    }
    if (calls.providersNetworkError) {
      // 模拟真实错误链：ServerApiError → TypeError('fetch failed') → 底层 syscall 错误。
      const err = new Error('Server request failed.');
      err.name = 'ServerApiError';
      err.code = 'CONNECTION_FAILED';
      err.reason = 'network_error';
      err.cause = Object.assign(new Error('fetch failed'), {
        name: 'TypeError',
        cause: Object.assign(new Error('connect ENETUNREACH 2402:4e00::1:443'), { code: 'ENETUNREACH' }),
      });
      throw err;
    }
    if (calls.providersThrow) throw new Error('discovery failed');
    return FAKE_PROVIDERS;
  };
  this.startOAuthQrLogin = async (provider) => {
    calls.qrStart.push(provider);
    return { qrId: 'f'.repeat(20) + provider, scanUrl: `${this.baseUrl}/api/v1/auth/q/abc123`, expiresIn: 600, provider };
  };
  // 与上游签名一致：authorizeWithAccount(identity, email, password, recoverIdentity?)，返回
  // { method, account, accountToken }（accountToken 为 AgentLRay 补丁，用于派生身份登记）。
  this.authorizeWithAccount = async (identity, email, password, recoverIdentity) => {
    calls.authorizeWithAccount.push({ deviceId: identity.deviceId, role: this.role, email, password, recover: typeof recoverIdentity === 'function' });
    if (calls.authorizeRejected) {
      // 模拟服务器 revoke 本设备：上游据此调 recoverIdentity 换身份后重试（与真实 register 语义一致）。
      calls.authorizeRejected = false;
      const next = await recoverIdentity();
      return this.authorizeWithAccount(next, email, password, recoverIdentity);
    }
    if (email === 'bad@example.com' || password === 'wrong') {
      const e = new Error('AUTH_INVALID');
      e.code = 'AUTH_INVALID';
      throw e;
    }
    await this.store.save({
      serverUrl: this.baseUrl,
      deviceId: identity.deviceId,
      authorizationMethod: 'account',
      account: email,
      accessToken: 'a'.repeat(20),
      refreshToken: 'r'.repeat(20),
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
    });
    return { method: 'account', account: email, accountToken: 'a'.repeat(20) };
  };
  // 与上游一致：pollOAuthQrLogin(identity, qrId, recoverIdentity?)；token 由上游内部 register() 写入。
  this.pollOAuthQrLogin = async (identity, qrId, recoverIdentity) => {
    calls.qrPoll.push({ qrId, role: this.role, deviceId: identity.deviceId });
    if (calls.qrPollRevoked) {
      calls.qrPollRevoked = false;
      const next = await recoverIdentity();
      return this.pollOAuthQrLogin(next, qrId, recoverIdentity);
    }
    await this.store.save({
      serverUrl: this.baseUrl,
      deviceId: identity.deviceId,
      authorizationMethod: 'account',
      account: '扫码用户',
      accessToken: 'a'.repeat(20),
      refreshToken: 'r'.repeat(20),
      accessTokenExpiresAt: Date.now() + 3600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
    });
    calls.qrPollRecover = { provided: typeof recoverIdentity === 'function' };
    return { status: 'complete', authorization: { method: 'account', account: '扫码用户' }, accountToken: 'a'.repeat(20) };
  };
}

// HostServerApi 默认 role='host'（与上游一致）；ClientServerApi 默认 'client'。
function FakeHostServerApi(serverUrl, store, fetchImplementation, role = 'host') {
  FakeClientServerApi.call(this, serverUrl, store, fetchImplementation, role);
}

function fakeVendor() {
  return {
    serverApi: { ClientServerApi: FakeClientServerApi, HostServerApi: FakeHostServerApi },
    serverCredentials: { ServerCredentialStore: FakeServerCredentialStore },
    crypto: { fromBase64Url: (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64') },
  };
}

// 每用例：mock loadVendor 返回 fake vendor，并清空状态。
beforeEach(() => {
  for (const k of Object.keys(stores)) delete stores[k];
  calls.authorizeWithAccount = [];
  calls.authorizeOwned = [];
  calls.apiRoles = [];
  calls.qrStart = [];
  calls.qrPoll = [];
  calls.providers = 0;
  calls.providersBaseUrl = undefined;
  calls.providersThrow = false;
  calls.providersNetworkError = false;
  calls.providersDnsError = false;
  try { fs.rmSync(SETTINGS_FILE); } catch { /* 忽略 */ }
  try { fs.rmSync(HOSTS_FILE); } catch { /* 忽略 */ }
});

// mock loadVendor 返回 fake vendor，并在执行后恢复。
function withFakeVendor(fn) {
  const m = mock.method(vendorMod, 'loadVendor', fakeVendor);
  return Promise.resolve()
    .then(fn)
    .finally(() => m.mock.restore());
}

// ---- 账号密码不落盘 ----

test('saveDshSettings：旧 email/passwordEnc 在保存时被清除', async () => {
  // 先模拟旧配置已落 email/passwordEnc。
  fs.mkdirSync(path.dirname(HOSTS_FILE), { recursive: true });
  fs.writeFileSync(HOSTS_FILE, JSON.stringify({ dsh: { role: 'both', serverUrl: 'https://dsh.r2049.cn', email: 'old@x.com', passwordEnc: 'enc', deviceName: 'dev', allowedPorts: [3800] } }));
  await saveDshSettings({ role: 'both', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev', allowedPorts: [3800], email: 'new@x.com', password: 'pw' });
  const onDisk = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).dsh;
  // 账号密码相关字段整体清理（不保留旧密文，也不写入新账号密码）。
  assert.equal(onDisk.email, undefined);
  assert.equal(onDisk.passwordEnc, undefined);
});

test('saveDshSettings：新配置不写账号密码', async () => {
  const saved = await saveDshSettings({ role: 'host', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev', allowedPorts: [3800] });
  const onDisk = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).dsh;
  assert.equal(onDisk.email, undefined);
  assert.equal(onDisk.passwordEnc, undefined);
  assert.equal(onDisk.role, 'host');
  assert.equal(saved.authStatus, undefined); // authStatus 由路由 configView 追加
});

// ---- 登录态判定 ----

test('scopeLoginStatus：无 token 时未登录，有 token 时已登录', async () => {
  await withFakeVendor(async () => {
    // 未登录
    let status = await auth.scopeLoginStatus();
    assert.equal(status.loggedIn, false);
    assert.deepEqual(status.roles, []);

    // 通过账号密码登录 client scope
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    status = await auth.scopeLoginStatus();
    assert.equal(status.loggedIn, true);
    assert.deepEqual(status.roles, ['client']);
  });
});

test('loginWithAccount：both 角色注册 host+client 两个 scope', async () => {
  await withFakeVendor(async () => {
    const res = await auth.loginWithAccount('both', 'user@x.com', 'pw');
    assert.deepEqual(res.roles, ['host', 'client']);
    const status = await auth.scopeLoginStatus();
    assert.deepEqual(status.roles, ['host', 'client']);
    // host/client 各调了一次 authorizeWithAccount；both 同时顺带注册 probe（连接测试身份，
    // 独立设备身份，防止连接测试顶替出站隧道）→ 共 3 个互不相同的 deviceId。
    const ids = calls.authorizeWithAccount.map((c) => c.deviceId);
    assert.equal(ids.length, 2);
    assert.equal(calls.authorizeOwned.length, 1);
    assert.equal(new Set([...ids, calls.authorizeOwned[0].deviceId]).size, 3);
    assert.deepEqual(res.probe, { ok: true });
  });
});

test('loginWithAccount：host 角色必须用 HostServerApi 注册为 host 设备（否则中继设备列表看不到）', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('host', 'user@x.com', 'pw');
    // 中继服务器 /api/v1/devices 只返回 role=host 的设备；用 ClientServerApi（role=client）
    // 注册 host 身份会让本机永远不出现在其它 AgentLRay 的设备列表里。
    assert.deepEqual(calls.apiRoles, ['host']);
    assert.deepEqual(calls.authorizeWithAccount.map((c) => c.role), ['host']);
  });
});

test('loginWithAccount：client 与 probe 都注册为 client 设备', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    assert.deepEqual(calls.apiRoles, ['client', 'client']);
    assert.deepEqual(calls.authorizeWithAccount.map((c) => c.role), ['client']);
    assert.deepEqual(calls.authorizeOwned.map((c) => c.role), ['client']);
  });
});

test('pollQrLogin(host)：扫码登录后 host 身份以 host 设备注册', async () => {
  await withFakeVendor(async () => {
    const sess = await auth.startQrLogin('host', 'zhihu');
    await auth.pollQrLogin('host', sess.qrId);
    assert.deepEqual(calls.qrPoll.map((c) => c.role), ['host']);
  });
});

test('loginWithAccount：probe 注册复用账号授权（不传空账号密码、不要求账号密码重输）', async () => {
  await withFakeVendor(async () => {
    const res = await auth.loginWithAccount('client', 'user@x.com', 'pw');
    assert.deepEqual(res.roles, ['client']);
    assert.deepEqual(res.probe, { ok: true });
    // probe 走「账号授权登记」而非账号密码：只调用一次 authorizeOwnedRoleWithAccount，
    // 带本次登录得到的账号令牌 + recoverIdentity，绝不把账号密码扩散给 probe。
    assert.equal(calls.authorizeWithAccount.length, 1);
    assert.equal(calls.authorizeOwned.length, 1);
    assert.equal(calls.authorizeOwned[0].recover, true);
    assert.equal(calls.authorizeOwned[0].accountToken, 'a'.repeat(20));
    assert.equal(calls.authorizeOwned[0].account, 'user@x.com');
    const probeStore = stores.probe.saved;
    assert.ok(probeStore, 'probe 凭据应已落盘');
    assert.notEqual(probeStore.deviceId, stores.client.saved.deviceId, 'probe 必须是独立设备身份');
  });
});

test('discoverProviders / startQrLogin：退出后不重建设备身份文件（读路径不生成身份）', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    const dshDir = path.join(tmpHome, '.agentlray', 'dsh');
    await auth.logout();
    assert.equal(fs.existsSync(dshDir), false);

    // 退出后前端会调用这两个接口渲染登录表单：不得顺手生成 X25519 身份。
    await auth.discoverProviders('client');
    await auth.startQrLogin('client', 'zhihu');

    assert.equal(fs.existsSync(path.join(dshDir, 'dsh-client.json')), false, '发现 provider 不得生成身份');
    assert.equal(fs.existsSync(path.join(dshDir, 'dsh-client.key')), false);
  });
});

test('loginWithAccount：账号密码错误抛错且不落 token', async () => {
  await withFakeVendor(async () => {
    await assert.rejects(() => auth.loginWithAccount('client', 'bad@example.com', 'pw'), /AUTH_INVALID/);
    const status = await auth.scopeLoginStatus();
    assert.equal(status.loggedIn, false);
  });
});

// ---- 扫码 ----

test('discoverProviders：both 禁扫码返回空；host/client 返回官方 3 provider', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'both', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    const both = await auth.discoverProviders();
    assert.deepEqual(both.providers, []);
    assert.equal(both.devicePairing, false);

    await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    const client = await auth.discoverProviders();
    assert.equal(client.providers.length, 3);
    assert.deepEqual(client.providers.map((p) => p.id), ['zhihu', 'github', 'google']);
  });
});

test('startQrLogin / pollQrLogin：both 拒绝，host/client 成功并落 token', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'both', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    await assert.rejects(() => auth.startQrLogin('both', 'zhihu'), /both 角色不支持扫码/);

    await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    const sess = await auth.startQrLogin('client', 'github');
    assert.equal(sess.provider, 'github');
    assert.ok(sess.qrId.length >= 20);
    assert.equal(sess.expiresIn, 600);

    const poll = await auth.pollQrLogin('client', sess.qrId);
    assert.equal(poll.status, 'complete');
    // poll 成功后 token 已落 client scope
    const status = await auth.scopeLoginStatus();
    assert.deepEqual(status.roles, ['client']);
    // 扫码完成后同样注册 probe（复用扫码得到的账号授权），不影响主登录结果。
    assert.deepEqual(poll.probe, { ok: true });
    assert.deepEqual(calls.qrPollRecover, { provided: true });
    assert.ok(stores.probe.saved, 'probe 凭据应已落盘');
  });
});

// ---- 身份被服务器 revoke：登录边界重建身份（否则同一身份永远被拒） ----

test('pollQrLogin：DEVICE_REVOKED → 重建 client 身份并重试，token 落新身份', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    // 模拟扫码 poll 在 register 时被服务器 revoke：上游调 recoverIdentity 换身份后重试成功。
    calls.qrPollRevoked = true;
    const sess = await auth.startQrLogin('client', 'github');
    const before = JSON.parse(fs.readFileSync(path.join(tmpHome, '.agentlray', 'dsh', 'dsh-client.json'), 'utf8')).deviceId;
    const poll = await auth.pollQrLogin('client', sess.qrId);
    assert.equal(poll.status, 'complete');
    const after = JSON.parse(fs.readFileSync(path.join(tmpHome, '.agentlray', 'dsh', 'dsh-client.json'), 'utf8')).deviceId;
    assert.notEqual(after, before, '被 revoke 后必须换新身份');
    assert.equal(stores.client.saved.deviceId, after, 'token 必须落在新身份下');
    assert.deepEqual(poll.probe, { ok: true });
  });
});

test('authorizeWithAccount：DEVICE_REVOKED → 重建 host 身份并重试，token 落新身份', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'host', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    calls.authorizeRejected = true;
    // 显式先建好旧身份（不依赖其它用例留下的目录状态）。
    await require('../lib/dsh/identity').identityStoreFor('host').loadOrCreate('dev');
    const before = JSON.parse(fs.readFileSync(path.join(tmpHome, '.agentlray', 'dsh', 'dsh-device.json'), 'utf8')).deviceId;
    const res = await auth.loginWithAccount('host', 'user@x.com', 'pw');
    assert.deepEqual(res.roles, ['host']);
    const after = JSON.parse(fs.readFileSync(path.join(tmpHome, '.agentlray', 'dsh', 'dsh-device.json'), 'utf8')).deviceId;
    assert.notEqual(after, before, '被 revoke 后必须换新身份');
    assert.equal(stores.host.saved.deviceId, after, 'token 必须落在新身份下');
  });
});

// ---- logout ----

test('logout：清空 ~/.agentlray/dsh 全部文件，回未登录态', async () => {
  await withFakeVendor(async () => {
    await auth.loginWithAccount('both', 'user@x.com', 'pw');
    assert.equal((await auth.scopeLoginStatus()).loggedIn, true);
    const dshDir = path.join(tmpHome, '.agentlray', 'dsh');
    // 登录后该目录下确有凭据 + 设备身份/密钥（host/client/probe 三套）。
    assert.ok(fs.existsSync(path.join(dshDir, 'dsh-device.json')));
    assert.ok(fs.existsSync(path.join(dshDir, 'dsh-client.key')));
    await auth.logout();
    assert.equal(fs.existsSync(dshDir), false, '退出必须删除 ~/.agentlray/dsh 目录');
    const status = await auth.scopeLoginStatus();
    assert.equal(status.loggedIn, false);
    assert.deepEqual(status.roles, []);
    // 重新登录能正常生成新身份。
    await auth.loginWithAccount('client', 'user@x.com', 'pw');
    assert.ok(fs.existsSync(path.join(dshDir, 'dsh-client.json')));
  });
});

// ---- 路由：config 带 authStatus ----

test('GET /api/dsh/config 返回 authStatus', async () => {
  await withFakeVendor(async () => {
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/dsh/config`);
      const body = await res.json();
      assert.equal(body.authStatus.loggedIn, false);
      assert.deepEqual(body.authStatus.roles, []);
      // 账号密码相关字段已从配置视图清理。
      assert.equal(body.email, undefined);
      assert.equal(body.hasPassword, undefined);
      assert.equal(body.authStatus.accountPassword, undefined);
    } finally {
      server.close();
    }
  });
});

test('PUT /api/dsh/config 带 email+password 触发登录（配置已落 + token 生成）', async () => {
  await withFakeVendor(async () => {
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/dsh/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev', allowedPorts: [3800], email: 'user@x.com', password: 'pw' }),
      });
      const body = await res.json();
      assert.equal(body.authStatus.loggedIn, true);
      assert.deepEqual(body.authStatus.roles, ['client']);
      // 账号密码不落盘
      const onDisk = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).dsh;
      assert.equal(onDisk.email, undefined);
      assert.equal(onDisk.passwordEnc, undefined);
      assert.equal(onDisk.role, 'client');
    } finally {
      server.close();
    }
  });
});

test('PUT /api/dsh/config 登录失败（账号密码错）返回 400，配置已落但保持未登录', async () => {
  await withFakeVendor(async () => {
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/dsh/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev', allowedPorts: [3800], email: 'bad@example.com', password: 'wrong' }),
      });
      // P2：认证错误 → 400（而非统一 500），带 AUTH_INVALID code。
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.code, 'AUTH_INVALID');
      // 配置已落（D16 不回滚），但保持未登录。
      const onDisk = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8')).dsh;
      assert.equal(onDisk.role, 'client');
      const cfg = await (await fetch(`${base}/api/dsh/config`)).json();
      assert.equal(cfg.authStatus.loggedIn, false);
    } finally {
      server.close();
    }
  });
});

test('POST /api/dsh/auth/logout 后回未登录态', async () => {
  await withFakeVendor(async () => {
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      // 先登录
      await fetch(`${base}/api/dsh/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev', allowedPorts: [3800], email: 'user@x.com', password: 'pw' }),
      });
      let cfg = await (await fetch(`${base}/api/dsh/config`)).json();
      assert.equal(cfg.authStatus.loggedIn, true);
      // 退出
      const dshDir = path.join(tmpHome, '.agentlray', 'dsh');
      assert.ok(fs.existsSync(dshDir), '登录后 ~/.agentlray/dsh 应存在');
      await fetch(`${base}/api/dsh/auth/logout`, { method: 'POST' });
      assert.equal(fs.existsSync(dshDir), false, '退出必须删除 ~/.agentlray/dsh');
      cfg = await (await fetch(`${base}/api/dsh/config`)).json();
      assert.equal(cfg.authStatus.loggedIn, false);
      // 回归：查登录态的读路径（configView → scopeLoginStatus）不得生成设备身份，
      // 否则退出后 UI 一刷新就把 dsh-device.json/.key 等写回目录（现场：退出后仍残留 4 个文件）。
      assert.equal(fs.existsSync(dshDir), false, 'GET /api/dsh/config 不得重建设备身份文件');
    } finally {
      server.close();
    }
  });
});

// ---- serverUrl 参数化（2026-11-19 评审 Q1–Q4）----

test('discoverProviders：传 serverUrl 时针对该地址发现（不读已保存值）', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://saved.example.com', deviceName: 'dev' });
    const res = await auth.discoverProviders('client', 'http://custom.example.com:9000');
    assert.equal(res.providers.length, 3);
    assert.equal(calls.providersBaseUrl, 'http://custom.example.com:9000');
  });
});

test('startQrLogin/pollQrLogin：传 serverUrl 时 token 落该地址（不落已保存地址）', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://saved.example.com', deviceName: 'dev' });
    const target = 'https://other.example.com';
    const sess = await auth.startQrLogin('client', 'zhihu', target);
    assert.equal(sess.provider, 'zhihu');
    await auth.pollQrLogin('client', sess.qrId, target);
    // token 以目标 serverUrl 为键落盘。
    assert.equal(stores.client.saved.serverUrl, target);
    // 已保存 serverUrl 仍是旧的 → 登录态判定看不到该 token（须 PUT 持久化新地址后才一致）。
    const status = await auth.scopeLoginStatus();
    assert.deepEqual(status.roles, []);
  });
});

test('discoverProviders/startQrLogin：非法 serverUrl（非 http(s)）抛错', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    await assert.rejects(() => auth.discoverProviders('client', 'ftp://x'), /http:\/\/ 或 https:\/\//);
    await assert.rejects(() => auth.startQrLogin('client', 'zhihu', 'nope'), /http:\/\/ 或 https:\/\//);
  });
});

test('discoverProviders：发现失败（oauthProviders 抛错）回退空 providers + error', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    calls.providersThrow = true;
    const res = await auth.discoverProviders('client');
    assert.deepEqual(res.providers, []);
    assert.equal(res.devicePairing, false);
    assert.match(res.error, /discovery failed/);
  });
});

test('GET /api/dsh/auth/providers?serverUrl= 针对该地址发现', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://saved.example.com', deviceName: 'dev' });
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const target = 'https://target.example.com';
      const res = await fetch(`${base}/api/dsh/auth/providers?role=client&serverUrl=${encodeURIComponent(target)}`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.providers.length, 3);
      assert.equal(calls.providersBaseUrl, target);
    } finally {
      server.close();
    }
  });
});

test('GET /api/dsh/auth/providers 非法 serverUrl → 400', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const res = await fetch(`${base}/api/dsh/auth/providers?role=client&serverUrl=${encodeURIComponent('not-a-url')}`);
      assert.equal(res.status, 400);
    } finally {
      server.close();
    }
  });
});

test('POST /api/dsh/auth/qr/start|poll 传 serverUrl → token 落该地址', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'client', serverUrl: 'https://saved.example.com', deviceName: 'dev' });
    const app = require('express')();
    app.use(require('express').json());
    mountDshRoutes(app);
    const server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const target = 'https://target.example.com';
      const startRes = await fetch(`${base}/api/dsh/auth/qr/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'client', provider: 'zhihu', serverUrl: target }),
      });
      const sess = await startRes.json();
      const pollRes = await fetch(`${base}/api/dsh/auth/qr/poll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'client', qrId: sess.qrId, serverUrl: target }),
      });
      const poll = await pollRes.json();
      assert.equal(poll.status, 'complete');
      assert.equal(stores.client.saved.serverUrl, target);
    } finally {
      server.close();
    }
  });
});

// ---- dsh 配置详细日志（含请求/响应参数）----

// 独立日志目录 + 重置懒初始化：每个日志用例读写自己的 app 日志，避免与其它用例串味。
function withLogCapture(fn) {
  const log = require('../lib/logging');
  const { AGENTLRAY_LOG_DIR } = process.env;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-auth-log-'));
  process.env.AGENTLRAY_LOG_DIR = dir;
  process.env.AGENTLRAY_LOG_LEVEL = 'trace';
  log.close();
  const readApp = () => {
    const file = path.join(dir, `app-${log.localDate()}.log`);
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  };
  return Promise.resolve()
    .then(() => fn(readApp))
    .finally(() => {
      log.close();
      if (AGENTLRAY_LOG_DIR === undefined) delete process.env.AGENTLRAY_LOG_DIR;
      else process.env.AGENTLRAY_LOG_DIR = AGENTLRAY_LOG_DIR;
      fs.rmSync(dir, { recursive: true, force: true });
    });
}

test('日志：discoverProviders 记录请求(role/serverUrl)与响应(provider 列表)', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
      await auth.discoverProviders('client', 'https://target.example.com');
      const text = readApp();
      assert.match(text, /dsh discover providers/);
      // 请求参数：role + 目标 serverUrl（draft 覆盖值）。
      assert.match(text, /"role":"client"/);
      assert.match(text, /"serverUrl":"https:\/\/target\.example\.com"/);
      // 响应参数：provider 数量与 id 列表。
      assert.match(text, /"providerCount":3/);
      assert.match(text, /"providers":\["zhihu","github","google"\]/);
    }),
  );
});

test('日志：discoverProviders 失败记录请求与 error（warn）', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
      calls.providersThrow = true;
      await auth.discoverProviders('client');
      const text = readApp();
      assert.match(text, /\[warn\].*dsh discover providers failed/);
      assert.match(text, /"error":"discovery failed"/);
    }),
  );
});

test('日志：discoverProviders 网络失败记录 reason 与底层 cause（code/message）', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
      calls.providersNetworkError = true;
      const res = await auth.discoverProviders('client');
      const text = readApp();
      assert.match(text, /\[warn\].*dsh discover providers failed/);
      // 顶层：原始 message + 错误码 + 失败类别。
      assert.match(text, /"error":"Server request failed\."/);
      assert.match(text, /"code":"CONNECTION_FAILED"/);
      assert.match(text, /"reason":"network_error"/);
      // 底层 cause 链逐层展开：fetch failed → syscall 级 ENETUNREACH（便于区分 DNS/连接/IPv6/证书）。
      assert.match(text, /"cause":\[\{"name":"TypeError","message":"fetch failed"\}/);
      assert.match(text, /"name":"Error","code":"ENETUNREACH","message":"connect ENETUNREACH 2402:4e00::1:443"/);
      // 透出给前端：原始文案 + 全链路原因，让「网络不通」与「服务器拒绝」可区分。
      assert.equal(res.providers.length, 0);
      assert.equal(
        res.error,
        'Server request failed. (network_error; TypeError: fetch failed; ENETUNREACH: connect ENETUNREACH 2402:4e00::1:443)',
      );
    }),
  );
});

test('discoverProviders：DNS 解析失败时返回面向用户的 hint（不再只给 Server request failed.）', async () => {
  await withFakeVendor(() =>
    withLogCapture(async () => {
      await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
      calls.providersDnsError = true;
      const res = await auth.discoverProviders('client');
      // 原始 error 保留（诊断用），hint 供 UI 优先展示。
      assert.match(res.error, /EAI_AGAIN/);
      assert.equal(res.hint, '无法解析中继服务器域名，请检查手机网络或 DNS 设置');
    }),
  );
});

test('discoverProviders：非 DNS 类网络失败（ENETUNREACH）不返回 hint', async () => {
  await withFakeVendor(() =>
    withLogCapture(async () => {
      await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
      calls.providersNetworkError = true;
      const res = await auth.discoverProviders('client');
      assert.equal(res.hint, undefined);
    }),
  );
});

test('both 角色不发起发现（D3：both 禁扫码）', async () => {
  await withFakeVendor(async () => {
    await saveDshSettings({ role: 'both', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
    const res = await auth.discoverProviders();
    assert.deepEqual(res.providers, []);
    assert.equal(calls.providers, 0, 'both 不应发起网络发现');
  });
});

test('日志：PUT /api/dsh/config 记录写白名单与响应参数', async () => {
  await withFakeVendor(() =>
    withLogCapture(async (readApp) => {
      await saveDshSettings({ role: 'client', serverUrl: 'https://dsh.r2049.cn', deviceName: 'dev' });
      const app = require('express')();
      app.use(require('express').json());
      mountDshRoutes(app);
      const server = http.createServer(app);
      await new Promise((r) => server.listen(0, r));
      const base = `http://127.0.0.1:${server.address().port}`;
      try {
        await fetch(`${base}/api/dsh/config`);
        await fetch(`${base}/api/dsh/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'client', serverUrl: 'https://saved2.example.com', deviceName: 'dev2', allowedPorts: [3800] }),
        });
      } finally {
        server.close();
      }
      const text = readApp();
      // 读：不记 app 日志（access 日志已覆盖；读操作无审计需求）。
      assert.doesNotMatch(text, /dsh config read/);
      // 写：白名单只记字段名（update dsh-config）。
      assert.match(text, /"action":"update","target":"dsh-config"/);
      // 写后响应：新 serverUrl/deviceName 落日志（响应参数）。
      assert.match(text, /dsh config saved/);
      assert.match(text, /"serverUrl":"https:\/\/saved2\.example\.com"/);
      assert.match(text, /"deviceName":"dev2"/);
    }),
  );
});
