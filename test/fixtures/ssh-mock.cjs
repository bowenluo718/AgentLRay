#!/usr/bin/env node
'use strict';
// Mock ssh 转发脚本（供测试经 AGENTLRAY_SSH_BIN 注入，替代系统 ssh）：
// 解析与 buildSshArgs 一致的命令串（-L local:rhost:rport … user@host），
// 在本地 local 端口上 TCP 转发到 rhost:rport。stderr 静默（探测失败路径
// 透出的 sshStderrText 为空，可接受）。进程常驻直到被杀（SIGTERM 退出 0）。
// 仅用于 hosts 单测的「隧道成功」路径，不需要真实 sshd。
const net = require('net');

function parseForwardArg(arg) {
  // 形态 127.0.0.1:local:rhost:rport（buildSshArgs 恒产出该形态）。
  const parts = arg.split(':');
  if (parts.length < 4) return null;
  const local = Number(parts[1]);
  const rhost = parts[2];
  const rport = Number(parts[3]);
  if (!Number.isInteger(local) || !Number.isInteger(rport)) return null;
  return { local, rhost, rport };
}

const argv = process.argv.slice(2);
let forward = null;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '-L' && argv[i + 1]) {
    forward = parseForwardArg(argv[i + 1]);
    break;
  }
}
if (!forward) {
  process.stderr.write('ssh-mock: missing -L forward arg\n');
  process.exit(2);
}

const { local, rhost, rport } = forward;
const server = net.createServer((sock) => {
  const upstream = net.connect(rport, rhost, () => {
    sock.pipe(upstream);
    upstream.pipe(sock);
  });
  sock.on('error', () => upstream.destroy());
  upstream.on('error', () => sock.destroy());
});

server.listen(local, '127.0.0.1', () => {
  // 转发就绪。保持事件循环存活（server 本身即为活引用，勿 unref）。
  process.stderr.write('');
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
