'use strict';
// dsh 连接方 loopback 端点：在本机开一个随机端口的 HTTP 服务，把收到的请求经加密
// 通道转发到远端 AgentLRay 的 loopback 端口（= 远端 AgentLRay 自身的 HTTP 数据面）。
//
// 它是 ssh `-L` 本地端口转发在 dsh 传输下的等价物：AgentLRay 现有网关（lib/routes/proxy.js）
// 拿到 baseUrl 后照旧把请求转发过来，因此代理层无需感知 dsh。
//
// 实现与上游 LoopbackPreview 的差异见 lib/dsh/loopback.js 顶部说明（不做预览源校验、
// 读操作不设短空闲超时）。
const http = require('http');
const crypto = require('crypto');
const { toForwardHeaders, toNodeResponseHeaders } = require('./loopback');

// 读操作超时：与被连接方侧的读取超时对齐（10 分钟），覆盖 SSE 长时间无事件的场景。
const READ_TIMEOUT_MS = 10 * 60_000;
// 请求体上限（与上游 loopback 协议一致）。
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 创建一个本地 loopback 端点。
 * @param client 已连接的 RemoteClientCore（提供 rpc）
 * @param options.port 远端 AgentLRay 端口（被连接方放行列表内），或被连接方公布的
 *                     本机 UNIX socket 绝对路径（入站信任通道，见 lib/inbound-socket.js）
 * @param options.localPort A-5 稳定端口：期望复用的本机监听端口（上次连接用过的端口）。
 *                     端口被占用/非法时回退随机端口，绝不因复用失败而连不上。
 * @returns { url, port, close }
 */
function createLoopbackEndpoint(client, options) {
  const port = typeof options.port === 'string' ? options.port : Number(options.port);
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    void forward(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh 远端不可用');
      } else {
        res.destroy();
      }
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 60_000;
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  async function forward(req, res) {
    const id = crypto.randomUUID();
    const body = await readBody(req);
    const headers = toForwardHeaders(req.headers);
    const head = await client.rpc(
      'loopback.call',
      {
        op: 'http.open',
        id,
        port,
        path: req.url || '/',
        method: (req.method || 'GET').toUpperCase(),
        headers: Object.entries(headers),
        ...(body.length > 0 ? { body: body.toString('base64') } : {}),
      }
    );
    res.writeHead(head.status || 502, toNodeResponseHeaders(head.headers));

    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      void client.rpc('loopback.call', { op: 'close', id }).catch(() => undefined);
    };
    res.on('close', release);

    for (;;) {
      const chunk = await client.rpc('loopback.call', { op: 'http.read', id }, undefined, { timeoutMs: READ_TIMEOUT_MS });
      if (chunk?.data) {
        const buffer = Buffer.from(chunk.data, 'base64');
        if (buffer.length > 0 && !res.write(buffer)) {
          await new Promise((resolve) => res.once('drain', resolve));
        }
      }
      if (chunk?.done) break;
    }
    res.end();
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let length = 0;
      req.on('data', (chunk) => {
        length += chunk.length;
        if (length > MAX_BODY_BYTES) {
          reject(new Error('请求体超过 1 MiB'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const preferred = Number(options.localPort);
  const wantPreferred = Number.isInteger(preferred) && preferred >= 1 && preferred <= 65535;
  return new Promise((resolve, reject) => {
    // 先尝试复用期望端口；EADDRINUSE / EACCES 等 → 回退 listen(0) 随机端口（一次）。
    const listen = (port, isFallback) => {
      const onError = (err) => {
        server.off('listening', onListening);
        if (!isFallback && wantPreferred) {
          listen(0, true);
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        const address = server.address();
        if (address === null || typeof address === 'string') {
          server.close();
          reject(new Error('dsh loopback 端口不可用'));
          return;
        }
        resolve({
          url: `http://127.0.0.1:${address.port}`,
          port: address.port,
          async close() {
            for (const socket of sockets) socket.destroy();
            sockets.clear();
            await new Promise((done) => {
              server.closeAllConnections?.();
              server.close(() => done());
            });
          },
        });
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    };
    listen(wantPreferred ? preferred : 0, !wantPreferred);
  });
}

module.exports = { createLoopbackEndpoint, READ_TIMEOUT_MS };
