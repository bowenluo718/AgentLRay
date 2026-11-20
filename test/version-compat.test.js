'use strict';
// 远端版本兼容判定（lib/version-compat.js + GET /api/hosts 序列化）。
// design-android-mobile-app §10：远端版本低于客户端最低要求 → 提示升级（不阻断连接）；
// 版本未知 → null（不误报）。

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'version-compat-test-'));
process.env.HOME = tmpHome;
process.env.AGENTLRAY_NO_PLUGINS = '1';
delete process.env.AGENTLRAY_MIN_REMOTE_VERSION;

const {
  DEFAULT_MIN_REMOTE_VERSION,
  parseSemver,
  compareSemver,
  minRemoteVersion,
  isRemoteCompatible,
} = require('../lib/version-compat');
const { createHost, setRuntimeForTest, closeHost } = require('../lib/hosts');
const mountHostsRoutes = require('../lib/routes/hosts');
const express = require('express');

after(() => {
  closeHost('compat-old');
  delete process.env.AGENTLRAY_MIN_REMOTE_VERSION;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('parseSemver：接受 v 前缀与预发布后缀，拒绝非语义化', () => {
  assert.deepEqual(parseSemver('0.1.1'), [0, 1, 1]);
  assert.deepEqual(parseSemver('v2.10.3'), [2, 10, 3]);
  assert.deepEqual(parseSemver('1.2.3-beta.1'), [1, 2, 3]);
  assert.equal(parseSemver('1.2'), null);
  assert.equal(parseSemver('abc'), null);
  assert.equal(parseSemver(null), null);
});

test('compareSemver：数值逐段比较（10 > 9 不是字典序）', () => {
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.equal(compareSemver('0.1.0', '0.1.1'), -1);
  assert.equal(compareSemver('0.2.0', '0.1.9'), 1);
  assert.equal(compareSemver('0.1.10', '0.1.9'), 1);
  assert.equal(compareSemver('nope', '0.1.0'), null);
});

test('isRemoteCompatible：默认下限 + 未知版本不误报', () => {
  assert.equal(DEFAULT_MIN_REMOTE_VERSION, '0.1.0');
  assert.equal(minRemoteVersion(), '0.1.0');
  assert.equal(isRemoteCompatible('0.1.0'), true);
  assert.equal(isRemoteCompatible('0.1.1'), true);
  assert.equal(isRemoteCompatible('0.0.9'), false);
  assert.equal(isRemoteCompatible(null), null);
  assert.equal(isRemoteCompatible(''), null);
});

test('isRemoteCompatible：AGENTLRAY_MIN_REMOTE_VERSION 覆盖下限', () => {
  process.env.AGENTLRAY_MIN_REMOTE_VERSION = '1.2.0';
  assert.equal(minRemoteVersion(), '1.2.0');
  assert.equal(isRemoteCompatible('1.1.9'), false);
  assert.equal(isRemoteCompatible('1.2.0'), true);
  // 非法值回落默认。
  process.env.AGENTLRAY_MIN_REMOTE_VERSION = 'not-a-version';
  assert.equal(minRemoteVersion(), DEFAULT_MIN_REMOTE_VERSION);
  delete process.env.AGENTLRAY_MIN_REMOTE_VERSION;
});

test('GET /api/hosts 序列化 remoteVersion / compatible（旧版本 → false）', async () => {
  await createHost({ id: 'compat-old', label: '旧远端', ssh: { host: 'old.invalid' } });
  setRuntimeForTest('compat-old', 'http://127.0.0.1:1', { bootId: 'boot-old', version: '0.0.9' });
  const app = express();
  app.use(express.json());
  mountHostsRoutes(app, { includeLocal: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/hosts`);
    assert.equal(res.status, 200);
    const body = await res.json();
    const host = body.hosts.find((h) => h.id === 'compat-old');
    assert.ok(host, '应返回已保存主机');
    assert.equal(host.remoteVersion, '0.0.9');
    assert.equal(host.compatible, false);
    assert.deepEqual(host.version, { bootId: 'boot-old', version: '0.0.9' });
  } finally {
    server.close();
  }
});

test('GET /api/hosts：远端未上报版本 → compatible 为 null（不误报）', async () => {
  setRuntimeForTest('compat-old', 'http://127.0.0.1:1', { bootId: 'boot-only' });
  const app = express();
  app.use(express.json());
  mountHostsRoutes(app, { includeLocal: false });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/hosts`);
    const body = await res.json();
    const host = body.hosts.find((h) => h.id === 'compat-old');
    assert.equal(host.remoteVersion, null);
    assert.equal(host.compatible, null);
  } finally {
    server.close();
  }
});
