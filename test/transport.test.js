'use strict';
// transport 层单测：ssh -L 命令串构造、local baseUrl 解析、空闲端口探测、版本探测。
// 不涉及真实 ssh 子进程/网络（命令构造为纯函数）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildSshArgs,
  localBaseUrl,
  findFreePort,
  probeVersion,
  spawnSsh,
  sshStderrText,
} = require('../lib/transport');

test('local baseUrl = 127.0.0.1:<port>', () => {
  assert.equal(localBaseUrl(3809), 'http://127.0.0.1:3809');
});

test('buildSshArgs 基础：-N -L + 保活参数 + host', () => {
  const args = buildSshArgs(
    { host: 'devbox', user: '', port: null, remoteAgentLrayPort: 3800, identityFile: '', useAgent: false },
    41234
  );
  assert.deepEqual(args, [
    '-N',
    '-L',
    '127.0.0.1:41234:127.0.0.1:3800',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    'devbox',
  ]);
});

test('buildSshArgs 条件拼装：user/port/identityFile/ForwardAgent', () => {
  const args = buildSshArgs(
    {
      host: 'devbox',
      user: 'luobo',
      port: 2222,
      remoteAgentLrayPort: 4000,
      identityFile: '/home/luobo/.ssh/id_ed25519',
      useAgent: true,
    },
    50000
  );
  assert.deepEqual(args, [
    '-N',
    '-L',
    '127.0.0.1:50000:127.0.0.1:4000',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-p',
    '2222',
    '-i',
    '/home/luobo/.ssh/id_ed25519',
    '-o',
    'ForwardAgent=yes',
    'luobo@devbox',
  ]);
});

test('findFreePort 返回 1–65535 空闲端口', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port >= 1 && port <= 65535);
});

test('probeVersion 成功解析 bootId', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ bootId: 'abc-123', version: '0.1.0' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const v = await probeVersion(localBaseUrl(port), { timeoutMs: 1000 });
    assert.equal(v.bootId, 'abc-123');
    assert.equal(v.version, '0.1.0');
  } finally {
    server.close();
  }
});

test('probeVersion 非 200 → 抛错', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end('boom');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    await assert.rejects(() => probeVersion(localBaseUrl(port), { timeoutMs: 1000 }), /HTTP 500/);
  } finally {
    server.close();
  }
});

test('probeVersion 连接拒绝 → 抛错', async () => {
  // 用一个已关闭端口（先拿一个端口再关掉）触发 ECONNREFUSED。
  const port = await findFreePort();
  await assert.rejects(
    () => probeVersion(localBaseUrl(port), { timeoutMs: 800, attempts: 1 }),
    /version probe failed|ECONNREFUSED/
  );
});

test('spawnSsh 累积 ssh 子进程 stderr 到 child.sshStderr', async () => {
  // 用假 ssh 脚本注入 PATH，避免真实网络依赖。脚本向 stderr 打印报错后退出非零。
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fakessh-'));
  fs.writeFileSync(
    path.join(bin, 'ssh'),
    '#!/bin/sh\n' +
      'echo "ssh: connect to host 10.0.0.1 port 22: Connection timed out" >&2\n' +
      'echo "debug1: Connecting to 10.0.0.1 [10.0.0.1] port 22." >&2\n' +
      'exit 255\n',
    { mode: 0o755 }
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  try {
    const child = spawnSsh(['-N', 'fakehost']);
    await new Promise((resolve) => child.on('exit', resolve));
    // 真实报错行与 debug 行都被累积。
    assert.match(child.sshStderr, /Connection timed out/);
    assert.match(child.sshStderr, /debug1/);
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('sshStderrText 提炼首条非 debug 真实报错行', () => {
  assert.equal(
    sshStderrText({
      sshStderr:
        'debug1: Connecting to 10.0.0.1 port 22.\nssh: connect to host 10.0.0.1 port 22: Connection timed out\n',
    }),
    'ssh: connect to host 10.0.0.1 port 22: Connection timed out'
  );
});

test('sshStderrText：无 stderr / 全 debug / 空对象 → 空串', () => {
  assert.equal(sshStderrText({ sshStderr: '' }), '');
  assert.equal(sshStderrText({ sshStderr: 'debug1: some noise\n' }), '');
  assert.equal(sshStderrText(undefined), '');
  assert.equal(sshStderrText({}), '');
});
