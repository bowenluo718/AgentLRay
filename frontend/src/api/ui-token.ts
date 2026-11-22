// 本机访问令牌的前端长效缓存（C-1）。
//
// 为什么需要：HttpOnly cookie 是主要凭证，但浏览器/WebView 的 cookie jar 可能被清理
// （清站点数据、WebView 存储回收、隐私模式），此时页面会永久 401 且无法自愈。这里在
// localStorage 留一份同源副本，请求用 `X-AgentLRay-Token` 兜底；服务端接受「cookie 或
// 请求头」任一有效值，因此两条通道互不干扰。
//
// 令牌的唯一来源是启动 URL：`/?token=<t>` 由服务端校验后 302 到 `/#token=<t>`（fragment
// 不发往服务端、不进服务端日志），本模块读取后**立即**用 replaceState 抹掉 fragment，
// 避免留在地址栏/历史里。
//
// 替换语义：任何一次带新令牌的导航都直接覆盖缓存（`writeCache`），令牌轮换后打开一次
// 新地址即生效；服务端已换成同名长效 cookie，同样自动覆盖。

const TOKEN_KEY = 'agentlray.uiToken';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    // 隐私模式 / 存储被禁用：退回「仅本次会话」（内存），不影响功能。
    return null;
  }
}

let memo: string | null | undefined;

/** 当前缓存的令牌（undefined = 尚未读盘；空串/null = 无缓存）。 */
export function cachedUiToken(): string | null {
  if (memo === undefined) {
    try {
      memo = storage()?.getItem(TOKEN_KEY) || null;
    } catch {
      memo = null;
    }
  }
  return memo || null;
}

/** 写入/覆盖缓存（新值立即生效；同值不重复写盘）。 */
export function setCachedUiToken(token: string | null | undefined): void {
  const next = (token || '').trim() || null;
  if (next === cachedUiToken()) return;
  memo = next;
  try {
    if (next) storage()?.setItem(TOKEN_KEY, next);
    else storage()?.removeItem(TOKEN_KEY);
  } catch {
    /* 存储不可写：仅内存缓存 */
  }
}

/** 清除缓存（服务端明确返回 401 时才调用：说明 cookie 与缓存都已失效）。 */
export function clearCachedUiToken(): void {
  setCachedUiToken(null);
}

/**
 * 从启动 URL 的 `?token=` / `#token=` 取令牌写入缓存，并把 fragment 从地址栏抹掉。
 *
 * fragment 不经过服务端，任何跨源页面/旧书签都能把顶层导航指到 `/#token=<任意值>`；因此
 * **先校验再覆盖**：用候选令牌请求本机资源端点（`/api/mode` 在 LOCAL_ONLY_RE 内，必验令牌），
 * 401 视为无效、保留既有缓存；服务端不可达时保留既有缓存。返回是否取到新值。
 * 必须在本机 API 请求之前调用（main.tsx 引导阶段）。
 */
export async function adoptTokenFromLocation(): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  const { location, history } = window;
  const hashToken = /(?:^#|&)token=([^&]+)/.exec(location.hash || '')?.[1];
  const queryToken = new URLSearchParams(location.search || '').get('token');
  const raw = hashToken ?? queryToken;
  if (!raw) return false;
  let token = raw;
  try {
    token = decodeURIComponent(raw);
  } catch {
    /* 保持原样 */
  }
  if (!token) return false;
  let valid = true;
  try {
    const res = await fetch('/api/mode', {
      headers: { 'X-AgentLRay-Token': token, accept: 'application/json' },
    });
    valid = res.status !== 401;
  } catch {
    // 服务端不可达（冷启动/离线）：无法判定，按可用处理，避免丢掉刚拿到的令牌。
    valid = true;
  }
  if (!valid) return false;
  setCachedUiToken(token);
  // 抹掉 URL 里的令牌（服务端 302 已把 query 换成 fragment；这里两者都清）。
  if (history?.replaceState) {
    const url = `${location.pathname}${stripTokenFromQuery(location.search)}`;
    history.replaceState(history.state, '', url || '/');
  }
  return Boolean(token);
}

function stripTokenFromQuery(search: string): string {
  if (!search || !/[?&]token=/.test(search)) return search;
  const params = new URLSearchParams(search);
  params.delete('token');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
