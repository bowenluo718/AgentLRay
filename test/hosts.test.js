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
const { encrypt: encryptSecret, decrypt: decryptSecret } = require('../lib/secret');
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
  testHostSpec,
  resolveIdentityKey,
  getRuntime,
  shutdownHosts,
  setRuntimeForTest,
  setSelfIdentity,
  reportPeer,
  shortHostname,
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
    { host: 'devbox', user: '', port: null, remoteAgentLrayPort: 3800, identityFile: '', identityKeyEnc: '', useAgent: false }
  );
});

test('normalizeHost：非法 id 拒绝（含 local 保留、含非法字符、空）', () => {
  assert.throws(() => normalizeHost({ id: 'bad id', label: 'x', ssh: { host: 'h' } }), /id 仅允许/);
  assert.throws(() => normalizeHost({ id: LOCAL_ID, label: 'x', ssh: { host: 'h' } }), /保留给本机/);
  assert.throws(() => normalizeHost({ id: '', label: 'x', ssh: { host: 'h' } }), /id 仅允许/);
  assert.throws(() => normalizeHost({ id: 'a-b_c', label: 'x', ssh: { host: 'h' } }), /id 仅允许/);
});

test('normalizeHost：identityKeyEnc 保留原文（不 trim）；明文 identityKey 不入对象', () => {
  const h = normalizeHost({
    id: 'devbox',
    label: '开发机A',
    ssh: {
      host: 'devbox',
      identityFile: '/home/u/.ssh/id_ed25519',
      identityKeyEnc: 'v1:aa:bb:cc',
    },
  });
  assert.equal(h.ssh.identityFile, '/home/u/.ssh/id_ed25519');
  assert.equal(h.ssh.identityKeyEnc, 'v1:aa:bb:cc');
  // 明文键不被接受（防误落盘）。
  const h2 = normalizeHost({
    id: 'devbox2',
    label: 'x',
    ssh: { host: 'h', identityKey: '-----BEGIN OPENSSH PRIVATE KEY-----' },
  });
  assert.equal(h2.ssh.identityKeyEnc, '');
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

test('updateHost：当前已连接的主机被编辑 → 先关隧道（运行时清空，待前端重连）', async () => {
  await createHost({ id: 'live', label: '旧', ssh: { host: 'h' } });
  // 模拟当前已连接（connected 运行时 = 已建隧道）。
  setRuntimeForTest('live', 'http://127.0.0.1:41001', { bootId: 'boot-x' });
  assert.equal(getRuntime('live').status, 'connected');

  const updated = await updateHost('live', { label: '新', ssh: { host: 'h2' } });
  assert.equal(updated.label, '新');
  // 配置可能变化 → 隧道已断：运行时清空（前端据此用新配置重连）。
  assert.equal(getRuntime('live'), undefined);
});

test('deleteHost：当前已连接的主机被删除 → 先关隧道（运行时清空）', async () => {
  await createHost({ id: 'live', label: 'x', ssh: { host: 'h' } });
  setRuntimeForTest('live', 'http://127.0.0.1:41001', { bootId: 'boot-x' });
  assert.equal(getRuntime('live').status, 'connected');

  await deleteHost('live');
  // 删除 + 隧道一并关闭：运行时清空、hosts.json 不含该 id。
  assert.equal(getRuntime('live'), undefined);
  const raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  assert.ok(!raw.hosts.some((h) => h.id === 'live'));
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

test('closeHost：断开指定主机（关隧道 + 清运行时）；local 无副作用；幂等不抛', () => {
  // 注入一个 connected 远端运行时（模拟已建隧道）。
  setRuntimeForTest('host-a', 'http://127.0.0.1:41001');
  assert.equal(getRuntime('host-a').status, 'connected');
  closeHost('host-a');
  assert.equal(getRuntime('host-a'), undefined);

  // local 恒 connected、不在 runtime：closeHost 无副作用，不抛。
  closeHost(LOCAL_ID);
  // 对不存在的 id 幂等，不抛。
  closeHost('no-such-host');
});

test('resolveIdentityKey：identityKeyEnc 非空 → 解密写临时私钥文件（0600）并让 identityFile 指向它；否则原样返回', async () => {
  const keyEnc = await encryptSecret('-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
  // 有密文：解密为内容写临时文件、identityFile 指向临时路径、identityKey 置解密内容（供 buildSshArgs 走内容）。
  const { ssh: eff, tempKeyPath } = await resolveIdentityKey({
    host: 'devbox',
    identityFile: '/home/u/.ssh/id_ed25519',
    identityKeyEnc: keyEnc,
  });
  assert.ok(tempKeyPath);
  assert.notEqual(eff.identityFile, '/home/u/.ssh/id_ed25519');
  assert.equal(eff.identityKey, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
  // 临时文件内容 = 私钥内容，权限 0600（仅属主可读写）。
  assert.equal(fs.readFileSync(eff.identityFile, 'utf8'), '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----');
  const mode = fs.statSync(eff.identityFile).mode & 0o777;
  assert.equal(mode, 0o600);
  // 测试清理临时目录，避免残留。
  fs.rmSync(path.dirname(eff.identityFile), { recursive: true, force: true });

  // 无密文：不产生临时文件，原样返回（沿用 identityFile 文件地址）。
  const { ssh: eff2, tempKeyPath: t2 } = await resolveIdentityKey({
    host: 'devbox',
    identityFile: '/home/u/.ssh/id_ed25519',
    identityKeyEnc: '',
  });
  assert.equal(eff2.identityFile, '/home/u/.ssh/id_ed25519');
  assert.equal(t2, null);
});

test('createHost/updateHost：明文 identityKey 加密落盘 identityKeyEnc、不落明文；编辑留空保留原密钥', async () => {
  const KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----';
  // 新建：明文 → 加密落盘。
  await createHost({ id: 'k1', label: 'x', ssh: { host: 'h', identityKey: KEY } });
  let raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  const stored = raw.hosts.find((x) => x.id === 'k1');
  assert.ok(!('identityKey' in stored.ssh), '磁盘不得落明文 identityKey');
  assert.ok(stored.ssh.identityKeyEnc && stored.ssh.identityKeyEnc.startsWith('v1:'));
  assert.equal(await decryptSecret(stored.ssh.identityKeyEnc), KEY);

  // 编辑未带 identityKey（仅改 label）→ 保留既有密文。
  const updated = await updateHost('k1', { label: 'y', ssh: { host: 'h' } });
  assert.equal(await decryptSecret(updated.ssh.identityKeyEnc), KEY);

  // 编辑传 identityKey: '' → 显式清除密文。
  const cleared = await updateHost('k1', { label: 'z', ssh: { host: 'h', identityKey: '' } });
  assert.equal(cleared.ssh.identityKeyEnc, '');

  // 编辑传新明文 → 替换密文。
  const replaced = await updateHost('k1', {
    label: 'w',
    ssh: { host: 'h', identityKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nnew\n-----END OPENSSH PRIVATE KEY-----' },
  });
  assert.equal(await decryptSecret(replaced.ssh.identityKeyEnc), '-----BEGIN OPENSSH PRIVATE KEY-----\nnew\n-----END OPENSSH PRIVATE KEY-----');
});

test('testHostSpec：成功路径 → 建隧道探测到 version、不残留运行时、不落盘、不向被连接方上报', async () => {
  // 用本地 mock HTTP server 模拟被连接方 AgentLRay：/api/version 与 /api/inbound/hello。
  // 隧道用 test/fixtures/ssh-mock.cjs 转发到该本地 server（经 AGENTLRAY_SSH_BIN 注入，
  // 避免依赖系统 sshd；对齐 cli-bins 的 AGENTLRAY_*_BIN 覆盖模式）。
  const http = require('node:http');
  let helloCount = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/inbound/hello') {
      helloCount += 1; // skipReporting=true 不应有上报
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bootId: 'boot-probe', version: '0.1.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  process.env.AGENTLRAY_SSH_BIN = path.join(__dirname, 'fixtures', 'ssh-mock.cjs');
  try {
    // ssh-mock 把本地转发端口代理到 rhost:rport；ssh.host=127.0.0.1 仅作命令串填充。
    const result = await testHostSpec({
      id: 'probe-ok',
      label: '探针',
      ssh: { host: '127.0.0.1', port, remoteAgentLrayPort: port },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'connected');
    assert.equal(result.bootId, 'boot-probe');
    // 合成 id 隔离：测试结束后运行时不含 __probe__ 残留。
    assert.equal(getRuntime('__probe__probe-ok'), undefined);
    // 不落盘：hosts.json 不存在或不含该主机（testHostSpec 不写盘）。
    let ids = [];
    try {
      const raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
      ids = raw?.hosts ?? [];
    } catch {
      /* 文件不存在 → 未落盘，符合预期 */
    }
    assert.ok(!ids.some((h) => h.id === 'probe-ok'));
    // skipReporting=true → 不向被连接方上报身份/心跳。
    assert.equal(helloCount, 0);
  } finally {
    delete process.env.AGENTLRAY_SSH_BIN;
    server.close();
  }
});

test('testHostSpec：带明文 identityKey → 临时私钥文件在隧道关闭后自动清理', async () => {
  // 与成功路径同构，但带 identityKey：验证 resolveIdentityKey 写的临时文件在
  // testHostSpec 收尾（closeHost）时被删除，无 /tmp/agentlray-key-* 残留。
  const http = require('node:http');
  const server = http.createServer((req, res) => {
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ bootId: 'boot-key', version: '0.1.0' }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  // 收集清理前/后的 /tmp/agentlray-key-* 目录。
  const listKeyDirs = () => {
    try {
      return fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('agentlray-key-'));
    } catch {
      return [];
    }
  };
  const before = listKeyDirs();

  process.env.AGENTLRAY_SSH_BIN = path.join(__dirname, 'fixtures', 'ssh-mock.cjs');
  try {
    const result = await testHostSpec({
      id: 'probe-key',
      label: '密钥探针',
      ssh: {
        host: '127.0.0.1',
        port,
        remoteAgentLrayPort: port,
        identityKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
      },
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'connected');
    // 运行时无残留。
    assert.equal(getRuntime('__probe__probe-key'), undefined);
    // 无新增临时目录残留（清理逻辑生效）。
    assert.deepEqual(listKeyDirs(), before);
  } finally {
    delete process.env.AGENTLRAY_SSH_BIN;
    server.close();
  }
});

test('testHostSpec：非法/缺 ssh.host 配置 → 拒绝；不落盘', async () => {
  // 缺 ssh.host → normalizeHost 抛错（校验必填）。
  await assert.rejects(
    () => testHostSpec({ id: 'bad', label: 'x', ssh: { host: '' } }),
    /ssh\.host 必填/
  );
  await assert.rejects(
    () => testHostSpec({ id: 'bad', label: '', ssh: { host: 'h' } }),
    /label 必填/
  );
  // 测试不持久化：即使校验通过，hosts.json 也不含该主机（用 id 唯一去重探测路径，
  // 但校验失败即返回，这里确认文件仍为空/不含）。
  await assert.rejects(() => testHostSpec({ id: 'probe-x', label: 'x', ssh: { host: '' } }));
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(HOSTS_FILE, 'utf8'));
  } catch {
    /* 文件不存在 */
  }
  const ids = (raw?.hosts ?? []).map((h) => h.id);
  assert.ok(!ids.includes('probe-x'));
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

test('reportPeer：向被连接方 POST /api/inbound/hello 上报本机身份（inbound peers）', async () => {
  const http = require('node:http');
  let received = null;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { url: req.url, method: req.method, body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const hn = shortHostname();
    setSelfIdentity({ version: '0.1.0', bootId: 'boot-1' });
    // 自报身份：peerId/label 缺省为本机 hostname 短名（区分「哪台机器在连」）。
    const ok = await reportPeer(baseUrl, { peerId: hn, label: hn, version: '0.1.0', bootId: 'boot-1' });
    assert.equal(ok, true);
    assert.equal(received.method, 'POST');
    assert.equal(received.url, '/api/inbound/hello');
    assert.deepEqual(received.body, { peerId: hn, label: hn, version: '0.1.0', bootId: 'boot-1' });
  } finally {
    server.close();
  }
});

test('shortHostname：去域后缀返回短名，非空', () => {
  const hn = shortHostname();
  assert.equal(typeof hn, 'string');
  assert.ok(hn.length > 0);
  // 短名不含点（域后缀已被剥离）。
  assert.ok(!hn.includes('.'));
});

test('reportPeer：对端不可达静默失败（不抛错，不阻塞连接）', async () => {
  const ok = await reportPeer('http://127.0.0.1:1', { peerId: shortHostname(), label: shortHostname() });
  assert.equal(ok, false);
});
