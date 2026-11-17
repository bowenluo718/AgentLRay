'use strict';
// 网关 host 路由中间件（multi-host，P0）：按 `X-Host-Id`（或 `?host=`）路由到对应主机。
// - 缺省/`local` → next() 走本地原有路由（零改动，远端 baseUrl 无需覆盖）。
// - 远端 → 校验透传边界（数据面全透传；仅本地网关资源 403）→ 用 node:http 转发到隧道 baseUrl。
// - 设置面（settings / cli-bins / platforms mount|replace）随远端透传：设置是远端主机自身
//   资源，读取/修改/报错都落到远端（本机场景 hostId=local 走本地路由不变）。
// - 仅本地网关资源不透传：/api/hosts（主机管理）与 /api/inbound（入站 peer），一律 403
//   （hosts.json 与 inbound registry 都在本地，不随当前查看的远端二次转发）。
// 挂载位置：server.js 在 csrfGuard 之前（远端转发需要原始 body 流，req.pipe 透传）。
// 透传保留原始 headers（含 Host/Origin）→ 远端 csrf 校验 Host==Origin 匹配放行，两端安全。
const http = require('http');
const { LOCAL_ID, getRuntime } = require('../hosts');

// 本地网关资源前缀匹配（主机管理与入站 peer 是本地资源，不随当前查看的远端二次转发）。
// 命中即 403：与 HTTP 方法无关（GET 列表/测试连接同属本机资源）。
const LOCAL_ONLY_RE = [
  // 主机管理是本地网关资源（hosts.json 在本地），不随当前查看的远端透传。
  /^\/api\/hosts(\/|$)/,
  // 入站 peer 是被连接方本机资源（registry 在本地内存），不随当前查看的远端二次转发。
  /^\/api\/inbound(\/|$)/,
  // dsh 传输配置与设备列表是本机资源（settings.json / 设备身份都在本机）。
  /^\/api\/dsh(\/|$)/,
];

// 由请求取目标 host id：X-Host-Id 头优先，其次 ?host= query（SSE EventSource 不能带头）。
function hostIdFrom(req) {
  const header = req.headers['x-host-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const qHost = typeof req.query?.host === 'string' ? req.query.host.trim() : '';
  return qHost || LOCAL_ID;
}

/** 是否为本地网关资源（不透传远端，一律 403）。 */
function isLocalOnly(pathname) {
  return LOCAL_ONLY_RE.some((re) => re.test(pathname));
}

// 转发路径：剥离路由目标的 `host` query 参数（SSE 经 ?host= 路由；远端也跑
// 本网关，若原样透传会让远端再按 host 二次路由 → 503）。`X-Host-Id` 头同样删除。
// 保留其余 query 与 path 原样。
function forwardPath(rawUrl) {
  const u = new URL(rawUrl, 'http://placeholder.invalid');
  u.searchParams.delete('host');
  return u.pathname + u.search;
}

// 远端转发：把 req 代理到 baseUrl，保留 method/query/body/headers（去掉 X-Host-Id
// 与 ?host=），把远端响应（含 SSE 流）stream 回 res。SSE 透传远端 retry: 语义（design R4-Q2）。
function proxyTo(pathname, rawUrl, req, res, baseUrl) {
  const target = new URL(rawUrl, `${baseUrl}/`);
  const headers = { ...req.headers };
  delete headers['x-host-id'];
  const options = {
    hostname: target.hostname,
    port: target.port,
    path: forwardPath(rawUrl),
    method: req.method,
    headers,
  };
  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    if (res.headersSent) {
      res.destroy();
    } else {
      res.status(502).json({ error: `远端请求失败: ${err.message}` });
    }
  });
  req.pipe(proxyReq);
}

module.exports = function mountProxyRoutes(app) {
  // 处理任意 /api/*：放行 local，远端则按透传边界决定转发或 403。
  app.use('/api', (req, res, next) => {
    const hostId = hostIdFrom(req);
    if (hostId === LOCAL_ID || !hostId) return next();

    // 挂载在 /api 下，req.path 已去前缀；用 baseUrl+path 还原完整路径。
    const pathname = `${req.baseUrl}${req.path}`;
    // 仅本地网关资源（/api/hosts、/api/inbound）不透传 → 403；其余（含设置面
    // settings / cli-bins / platforms mount|replace）随远端透传取远端真源。
    if (isLocalOnly(pathname)) {
      return res.status(403).json({
        error: '主机/入站连接管理是本地网关资源，不透传，请在本机操作',
      });
    }

    const rt = getRuntime(hostId);
    if (!rt || rt.status !== 'connected' || !rt.baseUrl) {
      // 尝试现场连一次（首次切换时前端已 openHost；此处兜底）。
      return res.status(503).json({ error: `主机 ${hostId} 未连接，请先测试/切换连接` });
    }
    proxyTo(pathname, req.originalUrl, req, res, rt.baseUrl);
  });
};
