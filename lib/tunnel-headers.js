'use strict';
// 隧道内可信请求标记（C-1「信任连接认证」的落地方式）。
//
// 问题：被连接方（dsh 设备 / ssh 主机）经隧道打到本机 `127.0.0.1:<port>/api/*` 的请求
// 与「同机任意进程」的请求在 HTTP 层完全一样；若一刀切要求本机令牌，被连接方就永远 401。
//
// 解法：**被连接方自己的进程内注入一个随机密钥**——dsh loopback 宿主
// （lib/dsh/loopback-host.js）在把请求打到本机 API 前加上
// `X-AgentLRay-Tunnel: <进程内密钥>`。密钥只在内存里生成、不落盘、不进日志、不随请求
// 出站（proxy 转发前剥除），因此同机其他进程无法伪造；而 dsh 通道的对端身份已由设备
// 密钥 + 加密通道认证（连接认证即鉴权）。
//
// ssh 入站（`ssh -L` → 接收方 127.0.0.1）：请求直接落在接收方的 TCP 端口上，接收方进程
// 无法在请求里注入密钥，也无法从 HTTP 层区分它与本机其他进程（任何「自证」引导协议同样
// 能被本机任意进程走一遍）。因此信任锚下移到**传输层**：连接方把隧道指向接收方的 UNIX
// socket `~/.agentlray/inbound.sock`（0600），内核按文件权限判定来源（见
// lib/inbound-socket.js）。本模块只管 dsh 那一半。
const crypto = require('crypto');

const TUNNEL_HEADER = 'x-agentlray-tunnel';

let secret = null;

/** 本进程的隧道信任密钥（首次调用生成，32 字节 base64url；绝不落盘/打印）。 */
function tunnelSecret() {
  if (!secret) secret = crypto.randomBytes(32).toString('base64url');
  return secret;
}

module.exports = { TUNNEL_HEADER, tunnelSecret };
