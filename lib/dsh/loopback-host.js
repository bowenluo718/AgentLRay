'use strict';
// dsh 被连接方 loopback 宿主：接收连接方（经加密业务通道）发来的 HTTP 转发请求，
// 打到本机 127.0.0.1:<放行端口>，把响应分块回传。
//
// 放行端口由 dsh 配置的 allowedPorts 决定（默认 3800 = AgentLRay 默认端口），
// 端口不在放行列表 → 拒绝（与上游 LoopbackHost 的 LOOPBACK_PORT_DENIED 语义一致）。
//
// 空闲回收：超过 LOOPBACK_IDLE_TIMEOUT_MS（默认 10 分钟）没有任何操作的句柄会被回收，
// 防止对端异常断开后句柄泄漏；SSE 长连接在读操作之间也会因读超时被回收（见常量说明）。
const http = require('http');
const {
  LOOPBACK_CHUNK_BYTES,
  LOOPBACK_MAX_CONNECTIONS,
  parseLoopbackRequest,
  toHeaderPairs,
} = require('./loopback');

// 读操作的最长等待：SSE 尾随可能长时间没有新事件，超过该时间即视为对端失联。
const READ_TIMEOUT_MS = 10 * 60_000;
// 句柄空闲回收阈值（无任何操作）。
const LOOPBACK_IDLE_TIMEOUT_MS = 10 * 60_000;
// 回收扫描间隔。
const SWEEP_INTERVAL_MS = 30_000;

class DshLoopbackHost {
  /**
   * @param getPorts 放行端口读取函数（动态：每次调用都重新读取，配置变更后即时生效）
   * @param options.onClose 全部句柄关闭时的回调
   */
  constructor(getPorts, options = {}) {
    this.getPorts = getPorts;
    this.onClose = options.onClose;
    this.handles = new Map();
    this.closed = false;
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }

  /** 处理一条 loopback 请求（与上游 LoopbackHost.call 同构）。 */
  async call(input) {
    if (this.closed) throw new Error('dsh loopback 已关闭');
    const request = parseLoopbackRequest(input);
    if (request.op === 'describe') return { ports: [...this.getPorts()] };
    if (request.op === 'close') {
      this.close(request.id);
      return { closed: true };
    }
    if (request.op === 'http.open') return this.open(request);
    const handle = this.handles.get(request.id);
    if (!handle) throw new Error('loopback 请求已关闭');
    handle.touched = Date.now();
    return this.read(handle);
  }

  /** 打开一条到本机端口的 HTTP 请求，返回响应首部。 */
  async open(request) {
    const ports = [...this.getPorts()];
    if (!ports.includes(request.port)) {
      const error = new Error(`端口 ${request.port} 未在 dsh 放行列表中`);
      error.code = 'LOOPBACK_PORT_DENIED';
      throw error;
    }
    if (this.handles.has(request.id)) throw new Error('loopback 句柄已被占用');
    if (this.handles.size >= LOOPBACK_MAX_CONNECTIONS) throw new Error('loopback 并发连接数已达上限');
    const headers = Object.fromEntries(request.headers);
    return new Promise((resolve, reject) => {
      const handle = {
        id: request.id,
        port: request.port,
        request: null,
        response: null,
        touched: Date.now(),
      };
      this.handles.set(request.id, handle);
      const req = http.request(
        { hostname: '127.0.0.1', port: request.port, method: request.method, path: request.path, headers, agent: false },
        (response) => {
          handle.response = response;
          response.on('error', () => undefined);
          resolve({ status: response.statusCode ?? 502, headers: toHeaderPairs(response.headers) });
        }
      );
      handle.request = req;
      req.on('error', (error) => {
        this.close(request.id);
        reject(error);
      });
      req.end(request.body);
    });
  }

  /** 读取下一块响应数据（流式，支持 SSE 长时间无事件）。 */
  async read(handle) {
    const response = handle.response;
    if (!response) throw new Error('loopback 响应尚未就绪');
    for (;;) {
      if (response.readableEnded || response.destroyed) {
        this.close(handle.id);
        return { data: '', done: true };
      }
      const chunk = response.readableLength >= LOOPBACK_CHUNK_BYTES
        ? response.read(LOOPBACK_CHUNK_BYTES)
        : response.read();
      if (chunk !== null) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        return { data: buffer.toString('base64'), done: false };
      }
      // 缓冲区暂无数据：等下一次 readable / 结束 / 关闭。
      await this.waitReadable(response);
    }
  }

  /** 等待响应流可读（或结束）。超时/断开 → 抛错并回收句柄。 */
  waitReadable(response) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        response.off('readable', onReadable);
        response.off('end', onEnd);
        response.off('close', onClose);
        response.off('error', onError);
      };
      const onReadable = () => {
        cleanup();
        resolve();
      };
      const onEnd = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('loopback 响应已关闭'));
      };
      const onError = () => {
        cleanup();
        reject(new Error('loopback 响应出错'));
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('loopback 读取超时'));
      }, READ_TIMEOUT_MS);
      response.once('readable', onReadable);
      response.once('end', onEnd);
      response.once('close', onClose);
      response.once('error', onError);
    });
  }

  /** 关闭一个句柄（销毁本地请求/响应）。 */
  close(id) {
    const handle = this.handles.get(id);
    if (!handle) return;
    this.handles.delete(id);
    try {
      handle.response?.destroy();
    } catch {
      /* ignore */
    }
    try {
      handle.request?.destroy();
    } catch {
      /* ignore */
    }
  }

  /** 回收空闲超时的句柄。 */
  sweep(now = Date.now()) {
    for (const [id, handle] of this.handles) {
      if (now - handle.touched > LOOPBACK_IDLE_TIMEOUT_MS) this.close(id);
    }
  }

  /** 关闭全部句柄（被连接方服务停止时）。 */
  closeAll() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const id of [...this.handles.keys()]) this.close(id);
    this.onClose?.();
  }
}

module.exports = {
  DshLoopbackHost,
  READ_TIMEOUT_MS,
  LOOPBACK_IDLE_TIMEOUT_MS,
};
