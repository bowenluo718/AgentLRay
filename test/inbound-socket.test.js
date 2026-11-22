'use strict';
// 入站信任通道（ssh 入站免令牌）：被连接方在 `~/.agentlray/inbound.sock`（0600，目录 0700）
// 上再听一个 HTTP 入口。能连上该 socket 的进程即同用户进程 → 放行；TCP 端口仍要求令牌。
// 连接方（lib/hosts.js）用 `ssh -L <port>:<远端 socket>` 指向它，被连接方无需任何配置。

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { startInboundSocket, inboundSocketPath, SOCKET_FILE } = require('../lib/inbound-socket');
const { apiAuthGuard, HEADER_NAME } = require('../lib/auth');
const { buildSshArgs } = require('../lib/transport');

const TOKEN = 'inbound-socket-test-token-0123456789';

/** 最小 app：模拟真实挂载（/api 守卫 + 一个本地资源 + 一个数据面接口）。 */
function buildApp() {
  const express = require('express');
  const app = express();
  app.use('/api', apiAuthGuard({ token: TOKEN, isRemoteHost: async () => false }));
  app.get('/api/sessions', (_req, res) => res.json({ ok: true }));
  app.get('/api/hosts', (_req, res) => res.json({ hosts: [] }));
  return app;
}

/** 经 unix socket 发 GET，返回状态码。 */
function getOverSocket(socketPath, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

/** 经 TCP 发 GET（对照组：本机直连）。 */
function getOverTcp(port, urlPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-sock-'));
}

describe('入站信任通道（UNIX socket）', () => {
  it('socket 0600 / 目录 0700：经 socket 的请求免令牌，同一 app 的 TCP 端口仍要令牌', async () => {
    const home = tmpHome();
    const app = buildApp();
    const tcp = app.listen(0, '127.0.0.1');
    const sock = await startInboundSocket({ app, home });
    try {
      const file = inboundSocketPath(home);
      assert.equal(sock.path, file);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);

      // 入站（同用户进程经 socket）：数据面与本地资源都放行，不需要令牌。
      assert.equal(await getOverSocket(file, '/api/sessions'), 200);
      assert.equal(await getOverSocket(file, '/api/hosts'), 200);

      // 对照：TCP 回环仍然要令牌（本机其他进程不能借 socket 绕过）。
      const port = tcp.address().port;
      assert.equal(await getOverTcp(port, '/api/sessions'), 401);
      assert.equal(await getOverTcp(port, '/api/sessions', { [HEADER_NAME]: TOKEN }), 200);
    } finally {
      await sock.close();
      await new Promise((resolve) => tcp.close(resolve));
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('陈旧 socket 文件被清理后重建；活动实例占用时拒绝启动', async () => {
    const home = tmpHome();
    const file = inboundSocketPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // 陈旧文件：普通文件占位（无人监听）→ 应被删掉重建。
    fs.writeFileSync(file, 'stale');
    const first = await startInboundSocket({ app: buildApp(), home });
    try {
      assert.equal(await getOverSocket(file, '/api/sessions'), 200);
      await assert.rejects(() => startInboundSocket({ app: buildApp(), home }), /已被占用/);
    } finally {
      await first.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('被连接方通告与连接方选择', () => {
  it('只通告本进程实际 bind 成功的路径：未监听/已关闭为 null，已有目录也会收紧到 0700', async () => {
    const { boundInboundSocketPath } = require('../lib/inbound-socket');
    assert.equal(boundInboundSocketPath(), null);
    // 模拟升级场景：`~/.agentlray` 早已由其它模块以 0755 创建。
    const home = tmpHome();
    const dir = path.dirname(inboundSocketPath(home));
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
    fs.chmodSync(dir, 0o755);
    const sock = await startInboundSocket({ app: buildApp(), home });
    try {
      assert.equal(boundInboundSocketPath(), sock.path);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700, '既有目录也要收紧到 0700');
    } finally {
      await sock.close();
      fs.rmSync(home, { recursive: true, force: true });
    }
    assert.equal(boundInboundSocketPath(), null);
  });

  it('/api/version 公开通告 inboundSocket（被连接方 0 配置）', async () => {
    const { startServer } = require('./helpers.js');
    const srv = await startServer({ AGENTLRAY_UI_TOKEN: TOKEN, AGENTLRAY_NO_AUTH: '' });
    try {
      const info = await (await fetch(`${srv.base}/api/version`)).json();
      assert.equal(info.inboundSocket, inboundSocketPath(srv.home));
      // 公开端点只给路径，不给任何凭据；TCP 端口仍要令牌。
      assert.equal((await fetch(`${srv.base}/api/sessions`)).status, 401);
    } finally {
      await srv.stop();
    }
  });
});

describe('连接方 ssh 转发参数', () => {
  it('已知远端 socket → streamlocal 目标；未知 → 退回 TCP 回环', () => {
    const ssh = { host: 'h', remoteAgentLrayPort: 3800 };
    const args = buildSshArgs(ssh, 1234, '/home/u/.agentlray/inbound.sock');
    assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:1234:/home/u/.agentlray/inbound.sock');
    assert.match(buildSshArgs(ssh, 1234, null).join(' '), /-L 127\.0\.0\.1:1234:127\.0\.0\.1:3800/);
  });
});

describe('两阶段 ssh 切换（TCP → streamlocal）', () => {
  it('粘贴私钥的主机切换隧道后仍能用同一个 -i 私钥连上（临时私钥不得提前删除）', () => {
    // 隔离说明：lib/config 的 HOME 在 require 期固定，父进程里改 HOME 无效 → 走子进程 +
    // `AGENTLRAY_HOME`（否则会写真实 ~/.agentlray/hosts.json）。
    const { execFileSync } = require('node:child_process');
    const home = tmpHome();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-phase-'));
    const logFile = path.join(tmp, 'spawns.log');
    const mockSsh = path.join(tmp, 'ssh.cjs');
    // mock ssh：按 `-L local:rhost:rport` 转发（与 test/fixtures/ssh-mock.cjs 同语义），
    // 并把每次 `-i` 的文件是否存在写进日志——第二次 spawn 时该文件必须仍然存在。
    fs.writeFileSync(
      mockSsh,
      `#!/usr/bin/env node
const net = require('net');
const fs = require('fs');
const argv = process.argv.slice(2);
const i = argv.indexOf('-i');
const key = i >= 0 ? argv[i + 1] : null;
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ key, exists: key ? fs.existsSync(key) : null }) + '\\n');
const f = argv[argv.indexOf('-L') + 1];
const parts = f.split(':');
// 两种目标：TCP（127.0.0.1:local:rhost:rport）与 streamlocal（127.0.0.1:local:/abs/x.sock）。
const [local, hostOrPath, rport] = parts.length >= 4
  ? [parts[1], parts[2], Number(parts[3])]
  : [parts[1], parts.slice(2).join(':'), null];
net.createServer((s) => {
  // net.connect 的位置参数是 (port, host)：顺序写反会被当成 unix 路径（ENOENT）。
  const u = rport === null ? net.connect(hostOrPath) : net.connect(rport, hostOrPath);
  u.on('connect', () => { s.pipe(u); u.pipe(s); });
  s.on('error', () => u.destroy());
  u.on('error', () => s.destroy());
}).listen(Number(local), '127.0.0.1');
`
    );
    fs.chmodSync(mockSsh, 0o755);

    const script = `
const path = require('path');
const fs = require('fs');
const express = require(path.join(process.argv[2], 'node_modules', 'express'));
const { HOME } = require(path.join(process.argv[2], 'lib/config'));
const { startInboundSocket, inboundSocketPath } = require(path.join(process.argv[2], 'lib/inbound-socket'));
const hosts = require(path.join(process.argv[2], 'lib/hosts'));
const { encrypt } = require(path.join(process.argv[2], 'lib/secret'));
(async () => {
  // 远端：同一个 app 同时听 TCP（第一阶段探测）与入站 UNIX socket（第二阶段）。
  const app = express();
  app.get('/api/version', (_q, r) =>
    r.json({ bootId: 'mock-boot', version: '9.9.9', inboundSocket: inboundSocketPath(HOME) })
  );
  const tcp = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => tcp.once('listening', resolve));
  const sock = await startInboundSocket({ app, home: HOME });
  const port = tcp.address().port;
  fs.mkdirSync(path.dirname(hosts.HOSTS_FILE), { recursive: true });
  fs.writeFileSync(
    hosts.HOSTS_FILE,
    JSON.stringify({
      hosts: [{
        id: 'two-phase', label: 'two-phase', type: 'ssh',
        ssh: {
          host: '127.0.0.1', port: 2222, remoteAgentLrayPort: port,
          identityKeyEnc: await encrypt('-----BEGIN OPENSSH PRIVATE KEY-----\\nmock\\n-----END-----'),
        },
      }],
    })
  );
  const entry = await hosts.openHost('two-phase');
  const spawns = fs.readFileSync(process.argv[3], 'utf8').trim().split('\\n').map((l) => JSON.parse(l));
  process.stdout.write(JSON.stringify({ status: entry.status, error: entry.error, spawns }));
  hosts.closeHost('two-phase');
  await sock.close();
  tcp.close();
  process.exit(0);
})();
`;
    fs.writeFileSync(path.join(tmp, 'child.cjs'), script);
    const out = execFileSync(
      process.execPath,
      [path.join(tmp, 'child.cjs'), process.cwd(), logFile],
      {
        env: { ...process.env, AGENTLRAY_HOME: home, AGENTLRAY_SSH_BIN: mockSsh, AGENTLRAY_NO_AUTH: '1' },
        timeout: 30_000,
        encoding: 'utf8',
      }
    );
    try {
      const result = JSON.parse(out);
      assert.equal(result.status, 'connected', `应经 socket 阶段连上，实际 ${JSON.stringify(result.error)}`);
      assert.equal(result.spawns.length, 2, '应先 TCP 探测再切 streamlocal');
      assert.ok(result.spawns.every((s) => s.key), '两次 spawn 都应带 -i');
      assert.ok(result.spawns[1].exists, '第二次 spawn 时临时私钥必须仍存在');
      assert.equal(result.spawns[1].key, result.spawns[0].key, '两次 spawn 共用同一个临时私钥');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
