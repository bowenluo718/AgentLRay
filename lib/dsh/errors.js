'use strict';
// 链路错误分类（A-1）：把 ssh / dsh / 探测阶段的失败折叠成「稳定错误码 + retryable」。
//
// 对外契约：`GET /api/hosts` 会暴露 `errorCode` / `errorRetryable`，前端据此给出不同动作
// （重试 / 重新登录 / 升级远端 / 删除信任记录）。**码值一旦发布不再改名**，新增只能追加。
//
// retryable=false 的失败由 hosts.js 直接进入 failed，不进入重连退避队列；retryable=true
// 的失败交给 A-3 的指数退避循环（无限重试，手机长时间后台不能因次数耗尽而永久 failed）。

// code → 默认 retryable。计划清单（HOST_OFFLINE / DSH_AUTH_REQUIRED / KEY_CHANGED /
// VERSION_INCOMPATIBLE / TUNNEL_TIMEOUT / TUNNEL_REFUSED / UNREACHABLE）之外补充两个
// 语义必要的码：INVALID_TARGET（目标不可连接）、AUTH_REQUIRED（ssh 认证失败）。
const CODES = {
  HOST_OFFLINE: { retryable: true },
  // dsh 登录态失效（保留既有 code，client.js 已抛该值）。
  DSH_AUTH_REQUIRED: { retryable: false },
  // 对端设备身份公钥变化（fail-closed，必须用户清除信任记录后重连）。
  KEY_CHANGED: { retryable: false },
  // 远端版本不满足客户端最低要求（当前不阻断连接，仅定义码位供后续策略使用）。
  VERSION_INCOMPATIBLE: { retryable: false },
  TUNNEL_TIMEOUT: { retryable: true },
  TUNNEL_REFUSED: { retryable: true },
  UNREACHABLE: { retryable: true },
  // 目标本身不可连接：不在当前账号可见列表 / 不是可被连接的主机 / 自环。
  INVALID_TARGET: { retryable: false },
  // ssh 认证失败（Permission denied / publickey 等）。
  AUTH_REQUIRED: { retryable: false },
};

const DEFAULT_CODE = 'UNREACHABLE';

function isCode(code) {
  return typeof code === 'string' && Object.hasOwn(CODES, code);
}

function retryableFor(code) {
  return isCode(code) ? CODES[code].retryable : CODES[DEFAULT_CODE].retryable;
}

/** 构造规范的链路错误对象（hosts 运行时 entry.error 的形状）。 */
function linkError(code, message, extra = {}) {
  const safeCode = isCode(code) ? code : DEFAULT_CODE;
  return {
    code: safeCode,
    message: String(message || '链路不可用'),
    retryable: retryableFor(safeCode),
    ...extra,
  };
}

// 错误信息 → 稳定码。顺序有意义：先精确语义，再 errno 兜底。
const MESSAGE_RULES = [
  [/身份密钥已变化|PEER_IDENTITY_MISMATCH|identity\s*(?:key\s*)?(?:changed|mismatch)|Host key verification failed/i, 'KEY_CHANGED'],
  [/当前离线|\boffline\b/i, 'HOST_OFFLINE'],
  [/不在当前账号的可见列表|不是可被连接的主机|不能连接本机设备|自环/, 'INVALID_TARGET'],
  [/登录已失效|重新登录|未登记|ACCOUNT_AUTH_REQUIRED|TOKEN_EXPIRED|AUTH_INVALID/, 'DSH_AUTH_REQUIRED'],
  [/Permission denied|publickey|认证失败/i, 'AUTH_REQUIRED'],
  [/timed out|timeout|超时|ETIMEDOUT/i, 'TUNNEL_TIMEOUT'],
  [/ECONNREFUSED|connection refused|refused/i, 'TUNNEL_REFUSED'],
  [/不兼容|incompatible|please upgrade|升级远端/i, 'VERSION_INCOMPATIBLE'],
  [/ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|socket hang up|network is unreachable/i, 'UNREACHABLE'],
];

// errno 码 → 稳定码（错误对象上自带 code 时优先于文案）。
const ERRNO_RULES = {
  ETIMEDOUT: 'TUNNEL_TIMEOUT',
  ECONNREFUSED: 'TUNNEL_REFUSED',
  ECONNRESET: 'UNREACHABLE',
  EHOSTUNREACH: 'UNREACHABLE',
  ENETUNREACH: 'UNREACHABLE',
  ENOTFOUND: 'UNREACHABLE',
  EAI_AGAIN: 'UNREACHABLE',
  EPIPE: 'UNREACHABLE',
};

/**
 * 把任意错误（Error / {code,message} / 字符串）归一为 `{code,message,retryable}`。
 * 已带稳定 code 的错误（如 client.js 抛的 DSH_AUTH_REQUIRED）原样保留其语义。
 */
function normalizeLinkError(error, fallbackCode = DEFAULT_CODE) {
  if (error && typeof error === 'object' && isCode(error.code)) {
    return linkError(error.code, error.message);
  }
  const message =
    typeof error === 'string' ? error : String((error && error.message) || error || '链路不可用');
  const errno = error && typeof error === 'object' ? error.code : null;
  if (typeof errno === 'string' && Object.hasOwn(ERRNO_RULES, errno)) {
    return linkError(ERRNO_RULES[errno], message);
  }
  for (const [re, code] of MESSAGE_RULES) {
    if (re.test(message)) return linkError(code, message);
  }
  return linkError(fallbackCode, message);
}

module.exports = {
  CODES,
  DEFAULT_CODE,
  isCode,
  retryableFor,
  linkError,
  normalizeLinkError,
};
