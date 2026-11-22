'use strict';
// 入站信任通道（ssh 入站免令牌）：被连接方在 `~/.agentlray/inbound.sock`（0600，目录 0700）
// 上再听一个 HTTP 入口，只有「能连上这个 socket 的进程」才算可信。
//
// 为什么必须放在传输层：ssh `-L` 隧道（`ssh -L port:host:port`）到被连接方后，请求源就是
// 127.0.0.1，与「同机任意进程」在 HTTP 层完全无法区分——任何在 HTTP 层「自证」的引导协议
// （上报密钥、challenge 等）都同样能被本机任意进程走一遍，等于关掉令牌。UNIX socket 的
// 连接权限由内核按文件 mode 判定：其他用户/其他 app（Android 不同 UID）连不上，天然是边界。
//
// 连接方（lib/hosts.js / lib/dsh/client.js）用 streamlocal 转发把隧道指向该 socket 路径：
//   - ssh：先建 TCP 隧道读公开的 `/api/version`，取其 `inboundSocket` 后改用
//     `ssh -L <本地端口>:<远端 socket 路径>`；
//   - dsh：`harness.transport.describe` 返回 `inboundSocket`，loopback 目标直接设为该路径。
// 路径由被连接方自己通告，因此**被连接方不需要任何额外配置**。
//
// 落在这里的请求被标记 `req.agentlrayInboundSocket = true`，`lib/auth.js` 据此放行。
// dsh 入站不走这里（由 `lib/dsh/loopback-host.js` 在进程内注入 `X-AgentLRay-Tunnel`）。

const fs = require('fs');
const http = require('http');
const path = require('path');

const SOCKET_FILE = 'inbound.sock';

/** 本进程**实际**监听成功的 socket 路径；未监听/已关闭时为 null。通告只认真实值。 */
let boundPath = null;

/** 被连接方的 socket 路径（与 HOME 同源，绝对路径）。注意这是「候选路径」，不保证已监听。 */
function inboundSocketPath(home) {
  return path.join(home, '.agentlray', SOCKET_FILE);
}

/**
 * 本进程实际生效的入站 socket 路径，供 `/api/version` 与 dsh `harness.transport.describe`
 * 通告。不能按 HOME 算常量：同机可并存 thin(3801)/full(3800)，两者 HOME 相同 → 第二条
 * 进程 bind 失败，若仍通告该路径，对端会把流量打到**另一个实例**（thin 的 403 边界失效）。
 */
function boundInboundSocketPath() {
  return boundPath;
}

/** 在 unix socket 上监听：清理陈旧 socket、目录 0700、socket 0600。返回 { path, close }。 */
async function startInboundSocket({ app, home, log } = {}) {
  const file = inboundSocketPath(home);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir 的 mode 只对新建目录生效：`~/.agentlray` 通常已由其它模块以 0755 创建，
  // 这里无条件收紧，保证「目录 0700」的声明与实际一致。
  try {
    fs.chmodSync(dir, 0o700);
  } catch (error) {
    log?.warn?.('inbound socket dir chmod failed', { error: error.message });
  }
  // 上个进程异常退出留下的 socket 文件：先试着连一下，连不上（ECONNREFUSED/ENOENT）说明是陈旧
  // 文件，删掉重建；能连上说明另有一个实例在跑，直接抛错避免两个进程共用一个入口。
  if (fs.existsSync(file)) {
    const alive = await canConnect(file);
    if (alive) throw new Error(`入站 socket 已被占用：${file}`);
    fs.unlinkSync(file);
  }
  const server = http.createServer((req, res) => {
    // 能连上 0600 socket 的进程即同用户进程；标记后由 auth 守卫放行（只对入站连接生效）。
    req.agentlrayInboundSocket = true;
    app(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(file, () => {
      server.off('error', reject);
      try {
        fs.chmodSync(file, 0o600);
      } catch (error) {
        log?.warn?.('inbound socket chmod failed', { error: error.message });
      }
      resolve();
    });
  });
  boundPath = file;
  let closed = false;
  return {
    path: file,
    close: () =>
      new Promise((resolve) => {
        if (closed) return resolve();
        closed = true;
        if (boundPath === file) boundPath = null;
        server.close(() => resolve());
      }),
  };
}

function canConnect(file) {
  return new Promise((resolve) => {
    const net = require('net');
    const socket = net.connect(file);
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    const dead = () => {
      socket.destroy();
      resolve(false);
    };
    socket.once('error', dead);
    socket.once('timeout', dead);
  });
}

module.exports = { SOCKET_FILE, inboundSocketPath, boundInboundSocketPath, startInboundSocket };
