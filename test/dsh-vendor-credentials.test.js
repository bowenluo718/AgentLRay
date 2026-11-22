'use strict';
// dsh 借码层凭据存储（lib/dsh/vendor）在 Android/PRoot 现场暴露的三个缺陷：
// 1) 文件系统不支持硬链接（/sdcard FUSE、部分 PRoot 挂载）时，withRefreshLock 直接抛
//    SERVER_CREDENTIALS_LOCK_UNSUPPORTED —— 认证/拉设备列表必然失败，应降级为进程内互斥。
// 2) authenticate() 即使本地 access token 仍新鲜，也要先进跨进程刷新锁 —— 无谓地引入
//    锁依赖（现场因此整条链路被锁能力卡死），应先读 store 走无锁快路径。
// 3) clear() 只删凭据文件，不清理残留的 refresh-lock 标记/已死进程的 holder 记录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { ServerCredentialStore } = require('../lib/dsh/vendor/dist/plugin/server-credentials.js');
const { ClientServerApi } = require('../lib/dsh/vendor/dist/plugin/server-api.js');

const SERVER_URL = 'https://relay.example.com';
const DAY = 86400_000;
const UUID = '018f0a3c-1234-7abc-8def-0123456789ab';

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function credentials(deviceId, overrides = {}) {
  return {
    schemaVersion: 1,
    serverUrl: SERVER_URL,
    deviceId,
    authorizationMethod: 'account',
    accessToken: 'a'.repeat(20),
    accessTokenExpiresAt: Date.now() + 3600_000,
    refreshToken: 'r'.repeat(20),
    refreshTokenExpiresAt: Date.now() + 30 * DAY,
    ...overrides,
  };
}

function writePrivate(file, contents) {
  fs.writeFileSync(file, contents, { mode: 0o600 });
}

/** 模拟硬链接不可用（EXDEV / EOPNOTSUPP / EPERM…，见 publishExclusive 的映射表）。 */
function unsupportedLink() {
  const error = new Error('EPERM: operation not permitted, link');
  error.code = 'EPERM';
  return error;
}

// ---- 1) 锁降级 ----

test('withRefreshLock：可通过 linkFile 注入硬链接实现（不支持硬链接的现场据此降级）', async () => {
  const dir = tmpDir('dsh-vendor-lock-');
  try {
    let linkCalls = 0;
    const store = new ServerCredentialStore(dir, {
      linkFile: async (from, to) => {
        linkCalls += 1;
        await fs.promises.link(from, to);
      },
    });
    await store.withRefreshLock(async () => 'ok');
    assert.ok(linkCalls > 0, '注入的 linkFile 应参与发布刷新锁');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withRefreshLock：文件系统不支持硬链接时降级为进程内互斥，而不是直接失败', async () => {
  const dir = tmpDir('dsh-vendor-lock-');
  try {
    const store = new ServerCredentialStore(dir, { linkFile: async () => { throw unsupportedLink(); } });
    const value = await store.withRefreshLock(async () => 42);
    assert.equal(value, 42);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withRefreshLock：降级后同一 store 的并发操作仍然串行（进程内互斥生效）', async () => {
  const dir = tmpDir('dsh-vendor-lock-');
  try {
    const store = new ServerCredentialStore(dir, { linkFile: async () => { throw unsupportedLink(); } });
    let active = 0;
    let maxActive = 0;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        store.withRefreshLock(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
        })
      )
    );
    assert.equal(maxActive, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('withRefreshLock：操作自身抛错不会被当成锁不可用而重跑', async () => {
  const dir = tmpDir('dsh-vendor-lock-');
  try {
    const store = new ServerCredentialStore(dir, { linkFile: async () => { throw unsupportedLink(); } });
    let runs = 0;
    await assert.rejects(
      () =>
        store.withRefreshLock(async () => {
          runs += 1;
          throw new Error('business failure');
        }),
      /business failure/
    );
    assert.equal(runs, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 2) authenticate 无锁快路径 ----

test('authenticate：本地 access token 仍新鲜时直接返回，不进入刷新锁', async () => {
  const stored = credentials('device-1');
  let lockCalls = 0;
  const store = {
    load: async (serverUrl, deviceId) =>
      serverUrl === SERVER_URL && deviceId === 'device-1' ? { ...stored } : undefined,
    save: async (record) => record,
    clear: async () => undefined,
    withRefreshLock: async () => {
      lockCalls += 1;
      throw new Error('本地 token 新鲜时不应进锁');
    },
  };
  const api = new ClientServerApi(SERVER_URL, store);
  const result = await api.authenticate({ deviceId: 'device-1', name: 'dev', publicKey: 'pk' });
  assert.equal(result.accessToken, stored.accessToken);
  assert.equal(lockCalls, 0);
});

test('authenticate：access token 已过期时仍进锁刷新（不破坏既有语义）', async () => {
  const stored = credentials('device-1', { accessTokenExpiresAt: Date.now() + 1_000 });
  let lockCalls = 0;
  const store = {
    load: async () => ({ ...stored }),
    save: async (record) => record,
    clear: async () => undefined,
    withRefreshLock: async (operation) => {
      lockCalls += 1;
      return operation();
    },
  };
  const api = new ClientServerApi(SERVER_URL, store, async () => {
    throw new Error('network disabled');
  });
  await assert.rejects(() => api.authenticate({ deviceId: 'device-1', name: 'dev', publicKey: 'pk' }));
  assert.equal(lockCalls, 1);
});

// ---- 3) clear 清理残留锁 ----

test('clear：清掉 refresh-lock 标记与已退出进程的 holder 记录', async () => {
  const dir = tmpDir('dsh-vendor-clear-');
  try {
    const store = new ServerCredentialStore(dir);
    const lock = `${store.path}.refresh-lock`;
    const deadPid = spawnSync(process.execPath, ['-e', '']).pid;
    const deadHolder = `${lock}.holder-${deadPid}-${UUID}`;
    writePrivate(store.path, JSON.stringify(credentials('device-1')));
    writePrivate(lock, 'DSH_REFRESH_LOCK_V2\n');
    writePrivate(deadHolder, `${deadPid} choosing\n`);

    await store.clear();

    assert.equal(fs.existsSync(store.path), false);
    assert.equal(fs.existsSync(deadHolder), false, '已死进程的 holder 应被清理');
    assert.equal(fs.existsSync(lock), false, '无存活参与者时锁标记应被清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('clear：仍有存活进程排队时保留锁标记与 holder（不破坏互斥）', async () => {
  const dir = tmpDir('dsh-vendor-clear-live-');
  try {
    const store = new ServerCredentialStore(dir);
    const lock = `${store.path}.refresh-lock`;
    const liveHolder = `${lock}.holder-${process.pid}-${UUID}`;
    writePrivate(lock, 'DSH_REFRESH_LOCK_V2\n');
    writePrivate(liveHolder, `${process.pid} 1\n`);

    await store.clear();

    assert.equal(fs.existsSync(liveHolder), true, '存活进程的排队记录不得被清理');
    assert.equal(fs.existsSync(lock), true, '仍有存活参与者时锁标记不得被清理');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
