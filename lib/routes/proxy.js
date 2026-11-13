'use strict';
// 网关 host 路由中间件（multi-host，P0）：按 `X-Host-Id`（或 `?host=`）路由到对应主机。
// - 缺省/`local` → next() 走本地原有路由（零改动，远端 baseUrl 无需覆盖）。
// - 远端 → 校验透传边界（数据面全透传；写设置面 403）→ 用 node:http 转发到隧道 baseUrl。
// - GET/PUT /api/settings 本机化：设置是网关本机资源（settings.json 在本地），远端请求
//   一律走本地路由读/写本机配置，不透传。其余 /api/settings 写面（POST/DELETE、
//   /api/settings/cli-bins、/api/hosts）仍 403。
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
  // 入站 peer 是被连接方本机资源（registry 在本地内存），不随当前查看的远端二次转发。
  /^\/api\/inbound(\/|$)/,
];

// P1 合意写透传（design R2-Q5 / R3-Q6）：用户显式合意、在选中主机的远端真实执行的
// 操作。远端跑完整 AgentLRay，用自己的配置/LLM 后端执行；本地不触发任何写。
// - resume / create：`GET /api/:platform/sessions/:id/resume-command`（copy-command，
//   远端 resolveCliBin 解析远端 cli-bins）与 `POST /api/:platform/sessions/new`（远端
//   real-spawn 新建会话）。
// - prompts LLM：`GET /api/prompts/analyze` 与 `POST /api/prompts/rewrite` 用远端配置的
//   LLM 后端执行（密钥不落本地；`GET/PUT /api/settings` 不透传所以远端密钥安全）。
// 这些端点不属于写设置面（settings / platforms mount|replace / cli-bins），在「默认透传
// + 黑名单」模型下本就透传；此处显式登记为「合意写放行」审计清单，保证边界可读、可测，
// 且与「设置除外」的只读保证区分开（写面网关放行审计，design §4 P1）。
const CONSENTED_WRITES = [
  { method: 'GET', path: /^\/api\/prompts\/analyze$/ },
  { method: 'POST', path: /^\/api\/prompts\/rewrite$/ },
  { method: 'POST', path: /^\/api\/[^/]+\/sessions\/new$/ },
];
// resume-command 是 GET 数据面（design §5.2 已列数据面），随数据面默认透传，无需登记。

/** P1 合意写放行审计：判断 `method + 完整路径` 是否命中已登记的合作写操作。
 *  命中即放行（proxy 默认透传，此处仅作显式审计登记与单测锚点）。 */
function isConsentedWrite(method, pathname) {
  return CONSENTED_WRITES.some((w) => w.method === method && w.path.test(pathname));
}

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
    // P1 合意写放行审计（design §4 P1）：resume/create + prompts analyze/rewrite 是用户
    // 显式合意、在远端真实执行的写操作，显式命中即放行（与「设置除外」只读保证区分）。
    const consented = isConsentedWrite(req.method, pathname);
    // 本机设置（GET/PUT /api/settings）不随当前查看的远端透传：设置是网关本机资源
    //（settings.json 在本地），远端请求一律走本地路由读/写本机配置。其余方法
    //（POST/DELETE）与 /api/settings/cli-bins、/api/hosts 仍落黑名单 403。
    if (req.method === 'GET' || req.method === 'PUT') {
      if (pathname === '/api/settings') return next();
    }
    if (!consented && isBlockedWrite(pathname)) {
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
module.exports.isConsentedWrite = isConsentedWrite;
