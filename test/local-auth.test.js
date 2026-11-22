// 本机接口鉴权（C-1）：只保护**本机直连**——目标 local / 本机资源（hosts、inbound、dsh、
// mode）必须携带令牌（HttpOnly cookie 或 X-AgentLRay-Token 头），否则 401；远端目标与隧道内
// 可信请求不验本机令牌。GET /?token= 换 cookie；未配置令牌时自动生成并落盘；
// AGENTLRAY_NO_AUTH=1 可显式关闭。

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers.js');
const os = require('node:os');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {
  authEnabled,
  resolveUiToken,
  tokenMatches,
  cookieValue,
  requiresLocalToken,
  isTunnelRequest,
  COOKIE_NAME,
  HEADER_NAME,
} = require('../lib/auth');
const { TUNNEL_HEADER, tunnelSecret } = require('../lib/tunnel-headers');

const TOKEN = 'test-token-0123456789abcdef';

describe('lib/auth 纯函数', () => {
  it('authEnabled：缺省启用；AGENTLRAY_NO_AUTH=1 显式关闭', () => {
    assert.equal(authEnabled({}), true);
    assert.equal(authEnabled({ AGENTLRAY_UI_TOKEN: '  ' }), true);
    assert.equal(authEnabled({ AGENTLRAY_UI_TOKEN: TOKEN, AGENTLRAY_NO_AUTH: '1' }), false);
  });

  it('resolveUiToken：env 优先；未配置时自动生成并落盘复用（0600）；关闭时不生成', async () => {
    const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'ui-token-'));
    try {
      assert.equal(resolveUiToken({ env: { AGENTLRAY_UI_TOKEN: TOKEN }, home }), TOKEN);
      const generated = resolveUiToken({ env: {}, home });
      assert.match(generated, /^[A-Za-z0-9_-]{40,}$/);
      const file = path.join(home, '.agentlray', 'ui-token');
      assert.equal((await fsp.readFile(file, 'utf8')).trim(), generated);
      assert.equal((await fsp.stat(file)).mode & 0o777, 0o600);
      // 第二次调用读文件，令牌稳定（cookie 不因重启失效）。
      assert.equal(resolveUiToken({ env: {}, home }), generated);
      assert.equal(resolveUiToken({ env: { AGENTLRAY_NO_AUTH: '1' }, home }), '');
    } finally {
      await fsp.rm(home, { recursive: true, force: true });
    }
  });

  it('requiresLocalToken：local/本机资源要令牌；已配置的远端目标不要', async () => {
    const req = (headers = {}, query = {}, p = '/sessions') => ({ path: p, headers, query });
    const isRemoteHost = async (id) => id === 'remote-a';
    assert.equal(await requiresLocalToken(req(), { isRemoteHost }), true);
    assert.equal(await requiresLocalToken(req({ 'x-host-id': 'local' }), { isRemoteHost }), true);
    // 本机资源：任何主机头都要令牌（防 X-Host-Id 绕过读 hosts.json）。
    for (const p of ['/hosts', '/hosts/x', '/inbound', '/inbound/hello', '/dsh/devices', '/mode']) {
      assert.equal(await requiresLocalToken(req({ 'x-host-id': 'remote-a' }, {}, p), { isRemoteHost }), true, p);
    }
    // 已配置远端目标（头或 query）→ 链路认证，不验本机令牌。
    assert.equal(await requiresLocalToken(req({ 'x-host-id': 'remote-a' }), { isRemoteHost }), false);
    assert.equal(await requiresLocalToken(req({}, { host: 'remote-a' }), { isRemoteHost }), false);
    // 未配置的主机 id → fail-closed（按本机处理）。
    assert.equal(await requiresLocalToken(req({ 'x-host-id': 'ghost' }), { isRemoteHost }), true);
    // 判定抛错同样 fail-closed。
    const broken = async () => {
      throw new Error('hosts.json 不可读');
    };
    assert.equal(await requiresLocalToken(req({ 'x-host-id': 'remote-a' }), { isRemoteHost: broken }), true);
  });

  it('tokenMatches：常量时间比较，空/非字符串一律不匹配', () => {
    assert.equal(tokenMatches(TOKEN, TOKEN), true);
    assert.equal(tokenMatches(TOKEN, `${TOKEN}x`), false);
    assert.equal(tokenMatches(TOKEN, TOKEN.slice(0, -1)), false);
    assert.equal(tokenMatches(TOKEN, ''), false);
    assert.equal(tokenMatches(TOKEN, undefined), false);
    assert.equal(tokenMatches('', ''), false);
  });

  it('cookieValue：解析指定 cookie、忽略其它项、坏编码不抛错', () => {
    assert.equal(cookieValue(`a=1; ${COOKIE_NAME}=abc; b=2`, COOKIE_NAME), 'abc');
    assert.equal(cookieValue('a=1', COOKIE_NAME), null);
    assert.equal(cookieValue(undefined, COOKIE_NAME), null);
    assert.equal(cookieValue(`${COOKIE_NAME}=%E0%A4%A`, COOKIE_NAME), '%E0%A4%A');
  });
});

describe('鉴权启用（AGENTLRAY_UI_TOKEN 配置）', () => {
  let srv;
  before(async () => {
    srv = await startServer({ AGENTLRAY_UI_TOKEN: TOKEN, AGENTLRAY_NO_AUTH: '' });
  });
  after(async () => {
    await srv.stop();
  });

  it('/api/sessions 无令牌 → 401（验收：未鉴权请求 401）', async () => {
    const res = await fetch(`${srv.base}/api/sessions`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.code, 'AUTH_REQUIRED');
  });

  it('错误令牌头 / 错误 cookie → 401', async () => {
    const viaHeader = await fetch(`${srv.base}/api/sessions`, { headers: { [HEADER_NAME]: 'wrong' } });
    assert.equal(viaHeader.status, 401);
    const viaCookie = await fetch(`${srv.base}/api/sessions`, {
      headers: { cookie: `${COOKIE_NAME}=wrong` },
    });
    assert.equal(viaCookie.status, 401);
  });

  it('X-AgentLRay-Token 头正确 → 放行', async () => {
    const res = await fetch(`${srv.base}/api/sessions`, { headers: { [HEADER_NAME]: TOKEN } });
    assert.equal(res.status, 200);
  });

  it('GET /?token= 换长效 HttpOnly cookie，并 302 到 /#token=（前端长效缓存）', async () => {
    const res = await fetch(`${srv.base}/?token=${TOKEN}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    // fragment 不发往服务端、不进服务端日志；前端读到后立即 replaceState 抹掉。
    assert.equal(res.headers.get('location'), `/#token=${TOKEN}`);
    const setCookie = res.headers.get('set-cookie') || '';
    assert.match(setCookie, new RegExp(`${COOKIE_NAME}=${TOKEN}`));
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Path=\//);
    // 长效：Max-Age ≈ 一年 + Expires（同名同 Path 的 Set-Cookie 自动覆盖旧值）。
    assert.match(setCookie, /Max-Age=31536000/);
    assert.match(setCookie, /Expires=[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4}/);
  });

  it('token 兑换支持站内 next（cookie 丢失后自动重兑换回原页面），拒绝开放重定向', async () => {
    const ok = await fetch(`${srv.base}/?token=${TOKEN}&next=${encodeURIComponent('/sessions?x=1')}`, {
      redirect: 'manual',
    });
    assert.equal(ok.headers.get('location'), `/sessions?x=1#token=${TOKEN}`);
    for (const bad of ['//evil.example', 'http://evil.example', '/a\\b', '/x#frag']) {
      const res = await fetch(`${srv.base}/?token=${TOKEN}&next=${encodeURIComponent(bad)}`, { redirect: 'manual' });
      assert.equal(res.headers.get('location'), `/#token=${TOKEN}`, bad);
    }
  });

  it('凭据任一有效即放行：旧缓存令牌头 + 新 cookie 不被互相顶掉', async () => {
    const stale = await fetch(`${srv.base}/api/sessions`, {
      headers: { [HEADER_NAME]: 'stale-cached-token', cookie: `${COOKIE_NAME}=${TOKEN}` },
    });
    assert.equal(stale.status, 200, '有效 cookie 不应被过期缓存令牌头顶掉');
    const swapped = await fetch(`${srv.base}/api/sessions`, {
      headers: { [HEADER_NAME]: TOKEN, cookie: `${COOKIE_NAME}=old-cookie` },
    });
    assert.equal(swapped.status, 200, '有效令牌头不应被旧 cookie 顶掉');
    const neither = await fetch(`${srv.base}/api/sessions`, {
      headers: { [HEADER_NAME]: 'stale', cookie: `${COOKIE_NAME}=old` },
    });
    assert.equal(neither.status, 401);
  });

  it('cookie 正确 → /api 放行（SSE 同源自动携带的同一机制）', async () => {
    const res = await fetch(`${srv.base}/api/sessions`, { headers: { cookie: `${COOKIE_NAME}=${TOKEN}` } });
    assert.equal(res.status, 200);
  });

  it('token 错误 → 401 且不设置 cookie；无 token 参数 → 正常返回页面（不被拦截）', async () => {
    const bad = await fetch(`${srv.base}/?token=wrong`, { redirect: 'manual' });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get('set-cookie'), null);
    const plain = await fetch(`${srv.base}/`, { redirect: 'manual' });
    assert.ok([200, 503].includes(plain.status), `GET / 不应被鉴权拦截，实际 ${plain.status}`);
  });

  it('/api/version 保持公开（启动就绪探测，不含会话数据）', async () => {
    const res = await fetch(`${srv.base}/api/version`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.bootId);
  });

  it('远端目标不验本机令牌（链路认证）；未配置的主机 id 仍 401（fail-closed）', async () => {
    // 已配置远端主机 → 直接放行到网关（未连接 → 503，而不是 401）。
    await fetch(`${srv.base}/api/hosts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [HEADER_NAME]: TOKEN },
      body: JSON.stringify({
        id: 'remote-a',
        label: 'remote-a',
        type: 'ssh',
        ssh: { host: '127.0.0.1', port: 22 },
      }),
    });
    const viaHeader = await fetch(`${srv.base}/api/sessions`, { headers: { 'X-Host-Id': 'remote-a' } });
    assert.notEqual(viaHeader.status, 401, '已配置远端目标不得被本机令牌拦截');
    const viaQuery = await fetch(`${srv.base}/api/sessions?host=remote-a`);
    assert.notEqual(viaQuery.status, 401);
    // 未配置的 id 不能绕过令牌。
    const ghost = await fetch(`${srv.base}/api/sessions`, { headers: { 'X-Host-Id': 'ghost' } });
    assert.equal(ghost.status, 401);
  });

  it('本机资源即使带远端主机头也要令牌（防 X-Host-Id 绕过）', async () => {
    const res = await fetch(`${srv.base}/api/hosts`, { headers: { 'X-Host-Id': 'remote-a' } });
    assert.equal(res.status, 401);
  });

  it('隧道内可信标记：本进程密钥放行（isTunnelRequest）；伪造值不放行', async () => {
    assert.equal(isTunnelRequest({ headers: { [TUNNEL_HEADER]: tunnelSecret() } }), true);
    assert.equal(isTunnelRequest({ headers: { [TUNNEL_HEADER]: 'local-process' } }), false);
    assert.equal(isTunnelRequest({ headers: {} }), false);
    // 跨进程无法伪造（密钥只在被连接方进程内）：HTTP 层拿不到 → 401。
    const forged = await fetch(`${srv.base}/api/inbound`, { headers: { [TUNNEL_HEADER]: 'local-process' } });
    assert.equal(forged.status, 401);
  });
});

describe('鉴权自动启用', () => {
  it('未配置令牌：自动生成并要求本机令牌（浏览器首次带 ?token=）', async () => {
    const srv = await startServer({ AGENTLRAY_NO_AUTH: '' });
    try {
      const denied = await fetch(`${srv.base}/api/sessions`);
      assert.equal(denied.status, 401);
      const token = (await fsp.readFile(path.join(srv.home, '.agentlray', 'ui-token'), 'utf8')).trim();
      assert.ok(token.length > 0);
      const ok = await fetch(`${srv.base}/api/sessions`, { headers: { [HEADER_NAME]: token } });
      assert.equal(ok.status, 200);
      const exchange = await fetch(`${srv.base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
      assert.equal(exchange.status, 302);
    } finally {
      await srv.stop();
    }
  });

  it('AGENTLRAY_NO_AUTH=1：完全关闭（测试/脚本基线）', async () => {
    const srv = await startServer();
    try {
      const res = await fetch(`${srv.base}/api/sessions`);
      assert.equal(res.status, 200);
    } finally {
      await srv.stop();
    }
  });

  it('配置令牌但 AGENTLRAY_NO_AUTH=1：显式关闭', async () => {
    const srv = await startServer({ AGENTLRAY_UI_TOKEN: TOKEN, AGENTLRAY_NO_AUTH: '1' });
    try {
      const res = await fetch(`${srv.base}/api/sessions`);
      assert.equal(res.status, 200);
    } finally {
      await srv.stop();
    }
  });
});
