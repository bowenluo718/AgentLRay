'use strict';
// 网关 host 路由中间件（multi-host，P0）：按 `X-Host-Id`（或 `?host=`）路由到对应主机。
// - 缺省/`local` → next() 走本地原有路由（零改动，远端 baseUrl 无需覆盖）。
// - 远端 → 校验透传边界（数据面全透传；写设置面 403）→ 用 node:http 转发到隧道 baseUrl。
// 挂载位置：server.js 在 csrfGuard 之后、各业务路由之前。
const http = require('http');
const { LOCAL_ID, getRuntime } = require('../hosts');

// 写设置面黑名单（精确匹配：不透传 → 403）。「设置除外」边界来自 design R2-Q4。
const WRITE_SETTINGS_BLOCKED = new Set([
  '/api/settings',
  '/api/settings/cli-bins',
  '/api/hosts',
]);

// 平台启停/替代写操作（精确前缀匹配路径段）。
const WRITE_RESOURCE_RE = [
  /^\/api\/platforms\/[^/]+\/(mount|replace)$/,
  // 主机管理是本地网关资源（hosts.json 在本地），不随当前查看的远端透传。
  /^\/api\/hosts(\/|$)/,
];

// 由请求取目标 host id：X-Host-Id 头优先，其次 ?host= query（SSE EventSource 不能带头）。
function hostIdFrom(req) {
  const header = req.headers['x-host-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const qHost = typeof req.query?.host === 'string' ? req.query.host.trim() : '';
  return qHost || LOCAL_ID;
}

function isBlockedWrite(pathname) {
  if (WRITE_SETTINGS_BLOCKED.has(pathname)) return true;
  return WRITE_RESOURCE_RE.some((re) => re.test(pathname));
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
    if (isBlockedWrite(pathname)) {
      return res.status(403).json({
        error: '远端设置（settings / platforms mount|replace / cli-bins）不透传，请在远端主机自身实例修改',
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
