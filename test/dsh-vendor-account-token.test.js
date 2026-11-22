'use strict';
// 账号密码登录必须把本次登录得到的账号令牌透出给调用方：
// lib/dsh/auth.js 用它为 probe（连接测试的派生身份）走 authorizeOwnedRoleWithAccount 登记。
// 此前 authorizeWithAccount 返回值里没有 accountToken（只有 login 内部变量有），
// 真实 vendor 下 probe 永远登记不上；测试 fake 却伪造了该字段，缺陷被全绿掩盖。
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { ClientServerApi } = require('../lib/dsh/vendor/dist/plugin/server-api.js');

const SERVER_URL = 'https://relay.example.com';
const ACCOUNT_TOKEN = 'acc-token-0123456789';
const IDENTITY = {
  deviceId: '018f0a3c-1234-7abc-8def-0123456789ab',
  name: 'dev',
  publicKey: `${'A'.repeat(42)}A`,
};

/** 只实现 publicRequest 需要的响应形状（ok/status/text）。 */
function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

function fakeFetch(calls) {
  return async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/auth/login')) {
      return jsonResponse({
        token: ACCOUNT_TOKEN,
        expiresAt: Date.now() + 3600_000,
        account: 'user@x.com',
        isAdmin: false,
      });
    }
    if (url.endsWith('/api/v1/devices/register')) {
      return jsonResponse({
        accessToken: 'a'.repeat(20),
        accessTokenExpiresAt: Date.now() + 3600_000,
        refreshToken: 'r'.repeat(20),
        refreshTokenExpiresAt: Date.now() + 30 * 86400_000,
      });
    }
    throw new Error(`unexpected request: ${url}`);
  };
}

function memoryStore() {
  const saved = [];
  return {
    saved,
    load: async () => undefined,
    save: async (record) => {
      saved.push(record);
      return record;
    },
    clear: async () => undefined,
    withRefreshLock: async (operation) => operation(),
  };
}

test('authorizeWithAccount：返回值包含本次登录的账号令牌（供 probe 登记复用）', async () => {
  const calls = [];
  const store = memoryStore();
  const api = new ClientServerApi(SERVER_URL, store, fakeFetch(calls), 'client');

  const authorization = await api.authorizeWithAccount(IDENTITY, 'user@x.com', 'pw');

  assert.equal(authorization.method, 'account');
  assert.equal(authorization.account, 'user@x.com');
  assert.equal(authorization.accountToken, ACCOUNT_TOKEN, '必须透出账号令牌，否则 probe 无法登记');
  // 账号令牌只随注册请求发往中继，不写入设备凭据文件。
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].accountToken, undefined, '账号令牌不得落盘');
  // 注册请求用账号令牌授权（Authorization: Bearer）。
  const register = calls.find((call) => call.url.endsWith('/api/v1/devices/register'));
  assert.equal(register.init.headers.Authorization, `Bearer ${ACCOUNT_TOKEN}`);
});

test('authorizeWithAccount：账号密码为空时直接拒绝，不发请求', async () => {
  const calls = [];
  const api = new ClientServerApi(SERVER_URL, memoryStore(), fakeFetch(calls), 'client');

  await assert.rejects(() => api.authorizeWithAccount(IDENTITY, '  ', 'pw'), /Email and password are required/);
  assert.equal(calls.length, 0);
});

test('authorizeOwnedRoleWithAccount：没有账号信息时不得把空串写进凭据（schema min(1) 会拒绝加载）', async () => {
  const calls = [];
  const store = memoryStore();
  const api = new ClientServerApi(SERVER_URL, store, fakeFetch(calls), 'client');

  const authorization = await api.authorizeOwnedRoleWithAccount(IDENTITY, ACCOUNT_TOKEN);

  assert.equal(authorization.method, 'account');
  assert.equal(authorization.account, undefined);
  assert.equal(store.saved.length, 1);
  assert.equal(store.saved[0].account, undefined, 'account 缺省时不得写入空串');
  assert.equal(store.saved[0].authorizationMethod, 'account');
});

test('authorizeOwnedRoleWithAccount：传入的账号原样落盘', async () => {
  const calls = [];
  const store = memoryStore();
  const api = new ClientServerApi(SERVER_URL, store, fakeFetch(calls), 'client');

  await api.authorizeOwnedRoleWithAccount(IDENTITY, ACCOUNT_TOKEN, 'user@x.com', undefined);

  assert.equal(store.saved[0].account, 'user@x.com');
});
