'use strict';
// dsh loopback 通道的共享契约（连接方 ↔ 被连接方，跑在加密业务通道内）。
//
// 传输语义沿用上游 ds-harness-remote 的 loopback 协议（packages/protocol/src/loopback.ts）：
// 连接方把 HTTP 请求拆成「open → read* → close」三个 RPC 操作转发给被连接方，被连接方
// 再把请求打到本机 127.0.0.1:<放行端口>。字段名与响应形状与上游一致，便于将来直接
// 换回上游实现。
//
// 与上游实现的两处刻意差异（均为 AgentLRay 数据面需要）：
// 1. 不做「预览源校验」——上游 LoopbackPreview 要求 Host 头等于随机 *.localhost 授权域，
//    而 AgentLRay 是服务器到服务器的网关转发（Host 头要原样透传给远端，远端的 csrf
//    校验依赖 Host == Origin）。
// 2. 读取不设 20 秒空闲超时——上游 LoopbackHost 的 http.read 空闲 20 秒即断链，而
//    AgentLRay 的会话尾随是 SSE（长时间无事件），断链会导致实时跟随失效。
const LOOPBACK_CHUNK_BYTES = 64 * 1024;
const LOOPBACK_MAX_BODY_BYTES = 1024 * 1024;
const LOOPBACK_MAX_HEADERS = 64;
const LOOPBACK_MAX_HEADER_VALUE = 8192;
const LOOPBACK_MAX_CONNECTIONS = 16;

const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);

// 逐跳首部：不能跨跳转发（RFC 9110 §7.6.1）。
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

// 逐跳首部里 Host 不在其中：Host 需要原样透传给远端（远端 csrf 校验 Host == Origin）。
// content-length 由请求体单独携带，长度由对端重新计算，必须剔除。
const DROPPED_HEADERS = new Set(['content-length']);

/** 剔除逐跳首部，返回小写名 → 值的普通对象（同名多值取首个）。 */
function toForwardHeaders(headers) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (value === undefined) continue;
    const lower = name.toLowerCase();
    if (HOP_HEADERS.has(lower) || DROPPED_HEADERS.has(lower)) continue;
    if (lower.startsWith('sec-websocket-')) continue;
    const item = Array.isArray(value) ? value[0] : value;
    if (typeof item !== 'string') continue;
    out[lower] = item;
  }
  return out;
}

/** 响应首部 → Node 可用的 headers 对象（set-cookie 保留多值）。 */
function toNodeResponseHeaders(pairs) {
  const out = {};
  for (const [name, value] of pairs || []) {
    const key = String(name).toLowerCase();
    if (key === 'set-cookie') {
      const existing = out[key];
      out[key] = [...(Array.isArray(existing) ? existing : existing ? [existing] : []), String(value)];
    } else if (out[key] === undefined) {
      out[key] = String(value);
    }
  }
  return out;
}

/** Node 响应头 → [[name, value]] 对（供 dsh 通道传输）。 */
function toHeaderPairs(headers) {
  const pairs = [];
  for (const [name, value] of Object.entries(headers || {})) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) pairs.push([String(name).toLowerCase(), String(item)]);
  }
  return pairs;
}

/**
 * 校验并规范化一条 loopback 请求。
 * 抛错即拒绝（被连接方只接受白名单操作与放行端口）。
 */
function parseLoopbackRequest(input) {
  if (!input || typeof input !== 'object') throw new Error('loopback 请求格式错误');
  const op = input.op;
  if (op === 'describe') return { op };
  if (op === 'close') {
    if (typeof input.id !== 'string' || !input.id) throw new Error('loopback 请求缺少 id');
    return { op, id: input.id };
  }
  if (op !== 'http.open' && op !== 'http.read') throw new Error(`不支持的 loopback 操作: ${String(op)}`);
  if (typeof input.id !== 'string' || !input.id) throw new Error('loopback 请求缺少 id');
  if (op === 'http.read') return { op, id: input.id };
  const port = Number(input.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('loopback 端口需为 1024–65535 的整数');
  const path = String(input.path || '');
  if (!/^\/(?!\/)[^\x00-\x20\x7f\\]*$/.test(path)) throw new Error('loopback 路径非法');
  const method = String(input.method || 'GET').toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new Error(`不支持的 HTTP 方法: ${method}`);
  const rawHeaders = Array.isArray(input.headers) ? input.headers : [];
  if (rawHeaders.length > LOOPBACK_MAX_HEADERS) throw new Error('loopback 首部过多');
  const headers = [];
  for (const pair of rawHeaders) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error('loopback 首部格式错误');
    const name = String(pair[0]);
    const value = String(pair[1]);
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/.test(name)) throw new Error('loopback 首部名非法');
    if (value.length > LOOPBACK_MAX_HEADER_VALUE) throw new Error('loopback 首部值过长');
    headers.push([name.toLowerCase(), value]);
  }
  let body;
  if (input.body !== undefined && input.body !== null) {
    const raw = String(input.body);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)) throw new Error('loopback 请求体不是合法 base64');
    const buffer = Buffer.from(raw, 'base64');
    if (buffer.length > LOOPBACK_MAX_BODY_BYTES) throw new Error('loopback 请求体超过 1 MiB');
    if (buffer.length > 0) body = buffer;
  }
  return { op, id: input.id, port, path, method, headers, ...(body ? { body } : {}) };
}

module.exports = {
  LOOPBACK_CHUNK_BYTES,
  LOOPBACK_MAX_BODY_BYTES,
  LOOPBACK_MAX_HEADERS,
  LOOPBACK_MAX_HEADER_VALUE,
  LOOPBACK_MAX_CONNECTIONS,
  HTTP_METHODS,
  toForwardHeaders,
  toNodeResponseHeaders,
  toHeaderPairs,
  parseLoopbackRequest,
};
