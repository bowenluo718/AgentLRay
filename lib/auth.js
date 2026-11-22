'use strict';
// 本机接口鉴权（C-1）：薄服务 / 完整实例在 127.0.0.1 上暴露全部会话数据（含工具输出
// details），同机任意进程都能读写。CSRF 只能挡住浏览器跨站，挡不住本机进程；这里补一层
// 「启动令牌」。
//
// 边界（谁需要令牌）——**只看请求目标是本机还是远端**：
//   1. 目标本机（缺省 / `local` / 本机资源 `/api/hosts`、`/api/inbound`、`/api/dsh`、
//      `/api/mode`）→ 必须携带令牌：cookie（浏览器/WebView）或 `X-AgentLRay-Token`（CLI/测试）。
//   2. 目标远端（`X-Host-Id` / `?host=` 指向已配置的远端主机）→ **不验本机令牌**：链路认证
//      由隧道本身承担（ssh 私钥 / dsh 设备身份 + 加密通道），且剥除本机凭证后再转发，避免
//      把本机 cookie/头泄露给远端。
//   3. 被连接方（入站 peer 上报 `POST /api/inbound/hello`、dsh/ssh 隧道打到本机 `/api/*`）
//      → 视作可信连接，不要求令牌。两种入站各有传输层锚点：
//        · dsh：本进程 loopback 宿主注入进程内密钥 `X-AgentLRay-Tunnel`（lib/tunnel-headers.js）；
//        · ssh：连接方把隧道指向本机的 UNIX socket `~/.agentlray/inbound.sock`（0600，见
//          lib/inbound-socket.js）；能连上该 socket 的进程即同用户进程，请求带
//          `req.agentlrayInboundSocket` 标记放行。**被连接方无需任何配置**。
//
// 令牌来源：
//   - Android：原生壳生成 256-bit 令牌经 env `AGENTLRAY_UI_TOKEN` 注入（不走 TCP），并由壳
//     持久化；每次拉起复用同一令牌，WebView 的 cookie 不会因进程重启失效。
//   - 桌面 / 其他：未配置时**自动生成**并落 `~/.agentlray/ui-token`（0600），启动日志打印
//     `GET /?token=<令牌>` 地址。`AGENTLRAY_NO_AUTH=1` 显式关闭（仅排障用，日志不打印令牌）。
//
// `/api/version` 是启动就绪探测端点，保持公开（只含 bootId/version，无会话数据）。

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TUNNEL_HEADER, tunnelSecret } = require('./tunnel-headers');

const COOKIE_NAME = 'agentlray_token';
// cookie 有效期：一年（长效缓存，浏览器/WebView 重启后仍免登录）。
// 同名同 Path 的 Set-Cookie 会**自动覆盖**旧值，因此令牌变化时无需先清 cookie。
const COOKIE_MAX_AGE_S = 365 * 24 * 60 * 60;
const HEADER_NAME = 'x-agentlray-token';
// 启动就绪探测端点：Android 侧 awaitHealthy() 轮询它，不能要求 cookie（此时还没导航）。
const PUBLIC_API_PATHS = new Set(['/version']);

// 本机资源前缀：hosts.json / 入站 registry / dsh 配置 / 进程模式都在本地，无论请求带什么
// 主机头都不得绕过令牌（proxy 同样把它们判为本地资源，不随远端转发）。
const LOCAL_ONLY_RE = [
  /^\/hosts(\/|$)/,
  /^\/inbound(\/|$)/,
  /^\/dsh(\/|$)/,
  /^\/mode(\/|$)/,
];

function configuredToken(env = process.env) {
  return String(env.AGENTLRAY_UI_TOKEN || '').trim();
}

/** 是否启用本机鉴权：未被 AGENTLRAY_NO_AUTH 显式关闭（令牌由 resolveUiToken 保证存在）。 */
function authEnabled(env = process.env) {
  return String(env.AGENTLRAY_NO_AUTH || '').trim() !== '1';
}

/**
 * 解析本次运行期的本机令牌：env 优先（Android 壳注入），否则读/生成 `~/.agentlray/ui-token`。
 * 返回空串表示鉴权关闭（`AGENTLRAY_NO_AUTH=1`）。进程内只解析一次。
 */
function resolveUiToken(options = {}) {
  const env = options.env || process.env;
  const home = options.home || require('./config').HOME;
  if (!authEnabled(env)) return '';
  const fromEnv = configuredToken(env);
  if (fromEnv) return fromEnv;
  const file = path.join(home, '.agentlray', 'ui-token');
  let token = readTokenFile(file);
  if (!token) {
    token = crypto.randomBytes(32).toString('base64url');
    writeTokenFile(file, token);
  }
  return token;
}

function readTokenFile(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw || '';
  } catch {
    return '';
  }
}

// 原子写（临时文件 + rename）+ 0600：并发首启时后写者覆盖前者，读方拿到的始终是完整文件。
function writeTokenFile(file, token) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, token, { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* 不可写（只读家目录等）→ 仅本次运行有效，下次重新生成 */
  }
}

/** 常量时间比较（先 sha256 定长，避免长度差异泄露）。 */
function tokenMatches(expected, provided) {
  if (!expected || typeof provided !== 'string' || provided.length === 0) return false;
  const a = crypto.createHash('sha256').update(expected).digest();
  const b = crypto.createHash('sha256').update(provided).digest();
  return crypto.timingSafeEqual(a, b);
}

/** 从 Cookie 头解析指定名字的值（无则 null）。 */
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() !== name) continue;
    const raw = part.slice(idx + 1).trim();
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

/** 请求携带的令牌：自定义头优先（桌面/CLI），其次 cookie（浏览器/WebView）。 */
function requestToken(req) {
  const header = req.get ? req.get(HEADER_NAME) : req.headers?.[HEADER_NAME];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return cookieValue(req.headers?.cookie, COOKIE_NAME);
}

/** 请求携带的全部候选令牌（去重）：头 + cookie。
 *  前端可能缓存旧令牌（localStorage）而 cookie 已换成新值，只取一个会让有效凭据被无效值
 *  顶掉 → 逐个比对，任一匹配即放行。 */
function requestTokens(req) {
  const out = [];
  const header = req.get ? req.get(HEADER_NAME) : req.headers?.[HEADER_NAME];
  if (typeof header === 'string' && header.trim()) out.push(header.trim());
  const cookie = cookieValue(req.headers?.cookie, COOKIE_NAME);
  if (cookie) out.push(cookie);
  return out;
}

/** 请求目标主机：`X-Host-Id` 头优先，其次 `?host=`（SSE）；缺省 = 本机。 */
function targetHostId(req) {
  const header = req.get ? req.get('x-host-id') : req.headers?.['x-host-id'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = req.query && req.query.host;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return 'local';
}

function isLocalOnlyPath(p) {
  return LOCAL_ONLY_RE.some((re) => re.test(p || ''));
}

/**
 * 隧道内可信请求：被连接方的 loopback 宿主在进程内注入本进程密钥
 * （见 lib/tunnel-headers.js）。外部进程不知道该密钥 → 无法伪造。
 */
function isTunnelRequest(req) {
  const raw = req.get ? req.get(TUNNEL_HEADER) : req.headers?.[TUNNEL_HEADER];
  return tokenMatches(tunnelSecret(), typeof raw === 'string' ? raw.trim() : '');
}

/**
 * 该请求是否「本机直连」（需要本机令牌）：目标是 local，或命中本机资源路径。
 * 远端目标但主机不存在时按本机处理（fail-closed：宁可 401，也不让伪造主机头绕过）。
 * `options.isRemoteHost` 允许异步（hosts.json 读取）——返回 Promise<boolean>。
 */
async function requiresLocalToken(req, options = {}) {
  // 挂载在 /api 下：req.path 为去掉前缀后的路径（/version、/hosts/...）。
  if (isLocalOnlyPath(req.path)) return true;
  const target = targetHostId(req);
  if (target === 'local') return true;
  const isHost = options.isRemoteHost;
  if (typeof isHost !== 'function') return true;
  try {
    return !(await isHost(target));
  } catch {
    return true; // 判定失败 → 按本机处理（需要令牌）
  }
}

/**
 * `/api` 鉴权中间件。挂载在 proxy 之前：本机资源与 local 目标先验令牌，远端目标直接放行
 * （链路认证 + 剥除本机凭证由 proxy 负责）。只读 headers/cookie，不消费 body，保持 proxy
 * 的原始流语义。
 */
function apiAuthGuard(options = {}) {
  const env = options.env || process.env;
  const token = options.token !== undefined ? options.token : resolveUiToken({ env });
  return async function authGuard(req, res, next) {
    if (!authEnabled(env) || !token) return next();
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (isTunnelRequest(req)) return next();
    // ssh 入站：请求来自本机 UNIX socket（0600），内核按文件权限做了身份判定。
    if (req.agentlrayInboundSocket === true) return next();
    if (!(await requiresLocalToken(req, options))) return next();
    if (requestTokens(req).some((candidate) => tokenMatches(token, candidate))) return next();
    return res.status(401).json({ error: '未授权：缺少本机访问令牌', code: 'AUTH_REQUIRED' });
  };
}

/** 仅接受站内绝对路径（防开放重定向）：`/x?y=1#z` 可以，`//evil`、`http://…` 拒绝。 */
function safeNextPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return '/';
  // 拒绝 `//host`（协议相对）、反斜杠（部分浏览器按 `/` 处理）、空白与 `#`
  //（重定向里还要再拼一个 `#token=` 片段）。
  if (raw.startsWith('//') || raw.includes('\\') || raw.includes('#')) return '/';
  if (!/^\/(?!\/)[^\s]*$/.test(raw)) return '/';
  return raw;
}

/**
 * `GET /?token=<token>` 换 cookie。无 token 参数时 next()（交回静态资源/SPA）。
 * 必须挂在 express.static 之前，否则 `/` 会先被静态首页命中而绕过兑换。
 */
function tokenExchangeHandler(options = {}) {
  const env = options.env || process.env;
  const token = options.token !== undefined ? options.token : resolveUiToken({ env });
  return function exchange(req, res, next) {
    const provided = typeof req.query?.token === 'string' ? req.query.token : '';
    if (!provided) return next();
    if (!authEnabled(env) || !token) return res.redirect(302, '/');
    if (!tokenMatches(token, provided)) {
      return res.status(401).json({ error: '本机访问令牌无效', code: 'AUTH_REQUIRED' });
    }
    // 长效 cookie：Max-Age + Expires（老客户端兜底）。同名同 Path → 新值自动替换旧值，
    // 令牌轮换/重新生成后打开一次 `/?token=` 即更新缓存。
    const expires = new Date(Date.now() + COOKIE_MAX_AGE_S * 1000).toUTCString();
    res.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; ` +
        `Expires=${expires}; HttpOnly; SameSite=Strict`
    );
    res.setHeader('Cache-Control', 'no-store');
    // 同时把令牌交给前端缓存：fragment 不发往服务端、不进服务端日志；前端读到后立即
    // replaceState 抹掉（frontend/src/api/ui-token.ts）。没有 JS 的环境直接忽略。
    // `next` 供「cookie 丢了但缓存令牌还在」的自动重兑换回到原页面（只接受站内路径）。
    return res.redirect(302, `${safeNextPath(req.query?.next)}#token=${encodeURIComponent(token)}`);
  };
}

module.exports = {
  COOKIE_NAME,
  COOKIE_MAX_AGE_S,
  HEADER_NAME,
  PUBLIC_API_PATHS,
  LOCAL_ONLY_RE,
  configuredToken,
  authEnabled,
  resolveUiToken,
  tokenMatches,
  safeNextPath,
  cookieValue,
  requestToken,
  requestTokens,
  targetHostId,
  isLocalOnlyPath,
  isTunnelRequest,
  requiresLocalToken,
  apiAuthGuard,
  tokenExchangeHandler,
};
