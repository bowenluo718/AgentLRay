'use strict';
// 主机管理（multi-host，P0）：hosts.json CRUD + 校验 + 内建 local 语义。
// hosts.json 在 require 时基于 lib/config 的 HOME 求值 → 先设临时 HOME 再 require。

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hosts-test-'));
process.env.HOME = tmpHome;
const {
  LOCAL_ID,
  HOSTS_FILE,
  normalizeHost,
  listHosts,
  getHost,
  createHost,
  updateHost,
  deleteHost,
  openHost,
  closeHost,
  closeAllExcept,
  getRuntime,
  shutdownHosts,
  setRuntimeForTest,
} = require('../lib/hosts');

// 每个测试前重置 hosts.json 与运行时，保证用例间无共享落盘状态。
beforeEach(async () => {
  shutdownHosts();
  try {
    fs.rmSync(HOSTS_FILE);
  } catch {
    /* 不存在则忽略 */
  }
});

test('normalizeHost：合法输入规范化（缺省字段填默认）', () => {
  const h = normalizeHost({ id: 'devbox', label: '开发机A', ssh: { host: 'devbox' } });
  assert.equal(h.id, 'devbox');
  assert.equal(h.label, '开发机A');
  assert.equal(h.type, 'ssh');
  assert.deepEqual(
    h.ssh,
    { host: 'devbox', user: '', port: null, remoteAgentLrayPort: 3800, identityFile: '', useAgent: false }
  );
});

test('normalizeHost：非法 id 拒绝（含 local 保留、含非法字符、空）', () => {
  assert.throws(() => normalizeHost({ id: 'bad id', label: 'x', ssh: { host: 'h' } }), /id 仅允许/);
  assert.throws(() => normalizeHost({ id: LOCAL_ID, label: 'x', ssh: { host: 'h' } }), /保留给本机/);
  assert.throws(() => normalizeHost({ id: '', label: 'x', ssh: { host: 'h' } }), /id 仅允许/);
  assert.throws(() => normalizeHost({ id: 'a-b_c', label: 'x', ssh: { host: 'h' } }), /id 仅允许/);
});

test('normalizeHost：label 必填、ssh.host 必填、端口范围校验、dsh 预留', () => {
  assert.throws(() => normalizeHost({ id: 'dev', label: '', ssh: { host: 'h' } }), /label 必填/);
  assert.throws(() => normalizeHost({ id: 'dev', label: 'x', ssh: { host: '' } }), /ssh.host 必填/);
  assert.throws(() => normalizeHost({ id: 'dev', label: 'x', ssh: { host: 'h', port: 0 } }), /1–65535/);
  assert.throws(() => normalizeHost({ id: 'dev', label: 'x', ssh: { host: 'h', port: 70000 } }), /1–65535/);
  assert.throws(() => normalizeHost({ id: 'dev', label: 'x', type: 'dsh', ssh: { host: 'h' } }), /dsh 传输尚未支持/);
});

test('createHost / listHosts / getHost：写入 hosts.json 并可读回', async () => {
  const created = await createHost({ id: 'devbox', label: '开发机A', ssh: { host: 'devbox' } });
  assert.equal(created.id, 'devbox');
  const hosts = await listHosts();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].id, 'devbox');
  const got = await getHost('devbox');
  assert.equal(got.label, '开发机A');
  // 落盘验证
  const raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.equal(raw.hosts.length, 1);
});

test('createHost：重复 id → duplicate 错误', async () => {
  await createHost({ id: 'dup', label: 'x', ssh: { host: 'h' } });
  await assert.rejects(
    () => createHost({ id: 'dup', label: 'y', ssh: { host: 'h2' } }),
    (e) => e.code === 'duplicate'
  );
});

test('updateHost：编辑字段并保留 id；不存在 → not-found', async () => {
  await createHost({ id: 'ed', label: '旧', ssh: { host: 'h' } });
  const updated = await updateHost('ed', { label: '新', ssh: { host: 'h2', user: 'u' } });
  assert.equal(updated.label, '新');
  assert.equal(updated.id, 'ed');
  assert.equal(updated.ssh.host, 'h2');
  await assert.rejects(
    () => updateHost('nope', { label: 'x', ssh: { host: 'h' } }),
    (e) => e.code === 'not-found'
  );
});

test('deleteHost：移除并保留其他；不存在 → not-found', async () => {
  await createHost({ id: 'keep', label: 'x', ssh: { host: 'h' } });
  await createHost({ id: 'drop', label: 'y', ssh: { host: 'h' } });
  await deleteHost('drop');
  const hosts = await listHosts();
  assert.deepEqual(hosts.map((h) => h.id), ['keep']);
  await assert.rejects(() => deleteHost('drop'), (e) => e.code === 'not-found');
});

test('openHost(local) → connected 直连 baseUrl，不建隧道', async () => {
  const rt = await openHost(LOCAL_ID);
  assert.equal(rt.status, 'connected');
  assert.match(rt.baseUrl, /127\.0\.0\.1:\d+/);
  // local 不落运行时（closeHost 无副作用）
  closeHost(LOCAL_ID);
});

test('openHost(不存在) → not-found 错误', async () => {
  await assert.rejects(() => openHost('no-such-host'), (e) => e.code === 'not-found');
});

test('closeAllExcept：保留 keepId 隧道，关闭其余（design R4-Q1 无常驻池）', async () => {
  // 注入两个远端 connected runtime（模拟已建隧道）。
  setRuntimeForTest('host-a', 'http://127.0.0.1:41001');
  setRuntimeForTest('host-b', 'http://127.0.0.1:41002');
  assert.equal(getRuntime('host-a').status, 'connected');
  assert.equal(getRuntime('host-b').status, 'connected');

  // 切到 host-b：只留 b，a 被关。
  closeAllExcept('host-b');
  assert.equal(getRuntime('host-b').status, 'connected');
  assert.equal(getRuntime('host-a'), undefined);

  // 切回 local（keepId 不在 runtime）：全部关闭。
  setRuntimeForTest('host-b', 'http://127.0.0.1:41002');
  closeAllExcept(LOCAL_ID);
  assert.equal(getRuntime('host-b'), undefined);
});
