'use strict';
// 日志唯一入口（design-logging / ADR-0009）：内部封装「实现适配层」，对外只暴露
// log.boot / log.app / log.access 三组方法。三类文件各自按天、写盘前脱敏、级别过滤、
// 按环境变量配置；require 期零副作用，首次 log.* 调用才懒初始化（配合测试隔离：
// test/setup-env.cjs 不得设 AGENTLRAY_HOME/改 HOME，require 期写盘会污染其它测试）。
//
// 设计要点：
// - 复用既有 dsh SafeLogger 的 LogSink 契约与字段黑名单脱敏规则，**自包含实现**，
//   不 require dsh vendor（vendor 懒加载、可缺失；日志作为横切基础设施不得强依赖它）。
// - 三类文件：boot-YYYY-MM-DD.log（每次启动 + first-run 标记）/ app-YYYY-MM-DD.log
//   （运行事件）/ access-YYYY-MM-DD.log（HTTP 访问），同目录仅前缀区分。
// - 按天切分：每次写入取本地日期，与当前打开的文件句柄日期不同即换文件（无后台定时器）。
// - 保留：启动时清理超过 AGENTLRAY_LOG_KEEP_DAYS（默认 30）天的三类文件。
// - 配置仅环境变量：AGENTLRAY_LOG_LEVEL / AGENTLRAY_LOG_KEEP_DAYS / AGENTLRAY_LOG_DIR
//   （DIR 优先于 AGENTLRAY_HOME||os.homedir()）。
// - 写实现采用**同步文件句柄**（openSync + writeSync）而非 fs.createWriteStream：
//   保证进程退出/崩溃前已写日志即时落盘、且测试写入后可直接读取；按天切换重开句柄。
//   实现隔离在 appendLine 内，后续切换依赖实现（如 pino）只改此适配层，对外接口不变。
const fs = require('fs');
const os = require('os');
const path = require('path');

// 级别由低到高（trace < debug < info < warn < error）。低于阈值的写入被丢弃。
const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'];
const CATEGORIES = ['boot', 'app', 'access'];

// 敏感字段黑名单（与 dsh vendor SafeLogger 的 secretKey 正则对齐，并补 `identityKey`——
// design-logging §3.4 明确把 hosts identityKey 列为敏感值）：写盘前把命中字段的值替换为
// ***。注意正则含 prompt/source/workspace/output 等：宁多脱敏不漏凭据。
const SECRET_KEY_RE =
  /authorization|cookie|token|secret|password|passphrase|credential|apiKey|identityKey|private|shared|ciphertext|payload|prompt|source|workspace|output|registrationCode|deviceCode/i;
// 访问日志 query 的敏感参数名（值一律替换为 ***）。
const SENSITIVE_QUERY_KEY_RE =
  /^(token|access_token|refresh_token|id_token|password|passwd|key|apikey|api_key|secret|code|authorization|credential|identitykey|privatekey)$/i;

const DEFAULT_LEVEL = 'info';
const DEFAULT_KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_RE = /^(boot|app|access)-(\d{4})-(\d{2})-(\d{2})\.log$/;

// 懒初始化后的运行态：null 表示未初始化（require 期保持 null，零副作用）。
// { dir, level, keepDays, consoleMirror, fds: { category: { fd, date } } }
let state = null;

// ---- 脱敏 ----

/**
 * 递归脱敏字段对象（对齐 SafeLogger.redact）：命中敏感键名的值 → '***'，数组逐项，
 * 对象逐键。key 为空（顶层）时不做键名匹配，只递归值。
 */
function redact(value, key = '') {
  if (key && SECRET_KEY_RE.test(key)) return '***';
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redact(child, childKey)]));
}

/**
 * 访问日志 query 脱敏：只替换敏感参数的值，保留其它参数原样（不重编码，避免漂移）。
 * 例：/api/x?token=abc&foo=bar → /api/x?token=***&foo=bar
 */
function redactQuery(rawUrl) {
  const s = String(rawUrl || '');
  const qi = s.indexOf('?');
  if (qi === -1) return s;
  const head = s.slice(0, qi);
  const query = s.slice(qi + 1);
  const masked = query.replace(/([^&#=]+)=([^&#]*)/g, (match, rawKey) => {
    let key = rawKey;
    try {
      key = decodeURIComponent(rawKey);
    } catch {
      /* 非法编码 → 按原文判断 */
    }
    return SENSITIVE_QUERY_KEY_RE.test(key) ? `${rawKey}=***` : match;
  });
  return `${head}?${masked}`;
}

// ---- 配置解析（懒，仅首次 log.* 调用时读取环境变量） ----

function normalizeLevel(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  return LEVELS.includes(v) ? v : DEFAULT_LEVEL;
}

function resolveKeepDays(value) {
  const n = Number.parseInt(String(value ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_KEEP_DAYS;
}

/** 日志目录：AGENTLRAY_LOG_DIR 优先，其次 $(AGENTLRAY_HOME||os.homedir())/.agentlray/logs。 */
function resolveDir() {
  const override = String(process.env.AGENTLRAY_LOG_DIR || '').trim();
  if (override) return override;
  const home = process.env.AGENTLRAY_HOME || os.homedir();
  return path.join(home, '.agentlray', 'logs');
}

/** 本地时区日期 YYYY-MM-DD（文件命名按本地日期，符合运维习惯）。 */
function localDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 启动清理：仅删 logs/ 下三类前缀、日期早于保留期的文件，绝不误删用户其它文件。 */
function cleanup(dir, keepDays) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  const cutoff = Date.now() - keepDays * DAY_MS;
  for (const name of entries) {
    const m = FILE_RE.exec(name);
    if (!m) continue;
    const fileDate = new Date(`${m[2]}-${m[3]}-${m[4]}T00:00:00`).getTime();
    if (Number.isFinite(fileDate) && fileDate < cutoff) {
      try {
        fs.unlinkSync(path.join(dir, name));
      } catch {
        /* 清理失败不影响日志 */
      }
    }
  }
}

// ---- 格式化 ----

/** 统一行格式：[ISO时间] [级别] [类别] 消息 {脱敏后的字段JSON}。 */
function formatLine(level, category, message, fields) {
  let line = `[${new Date().toISOString()}] [${level}] [${category}] ${message}`;
  if (fields && typeof fields === 'object') {
    const safe = redact(fields);
    if (Object.keys(safe).length > 0) line += ` ${JSON.stringify(safe)}`;
  }
  return line;
}

// ---- 写入（同步文件句柄，按天切换） ----

function appendLine(category, line) {
  if (!state) return;
  const st = state;
  const today = localDate();
  let slot = st.fds[category];
  if (!slot || slot.date !== today) {
    if (slot) {
      try {
        fs.closeSync(slot.fd);
      } catch {
        /* ignore */
      }
    }
    const file = path.join(st.dir, `${category}-${today}.log`);
    let fd;
    try {
      fd = fs.openSync(file, 'a', 0o600);
    } catch {
      return; // 目录不可写等 → 放弃该条，绝不影响业务
    }
    try {
      fs.fchmodSync(fd, 0o600);
    } catch {
      /* 某些平台不支持 → 忽略 */
    }
    slot = { fd, date: today };
    st.fds[category] = slot;
  }
  try {
    fs.writeSync(slot.fd, `${line}\n`);
  } catch {
    /* 写失败（磁盘满等）→ 忽略 */
  }
}

/** 懒初始化：建目录（0700）、清理过期文件、目录首次创建时写 first-run 标记。 */
function ensureInit(context) {
  if (state) return state;
  const dir = resolveDir();
  const level = normalizeLevel(process.env.AGENTLRAY_LOG_LEVEL);
  const keepDays = resolveKeepDays(process.env.AGENTLRAY_LOG_KEEP_DAYS);
  // 控制台多目标输出开关（默认开；测试/嵌入可设 AGENTLRAY_LOG_CONSOLE=0 关闭）。
  const consoleMirror = String(process.env.AGENTLRAY_LOG_CONSOLE ?? '1').trim() !== '0';
  const fresh = !fs.existsSync(dir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* 非 POSIX 或权限不足 → 忽略 */
  }
  state = { dir, level, keepDays, consoleMirror, fds: {} };
  if (consoleMirror) guardStdio();
  cleanup(dir, keepDays);
  if (fresh) {
    // 首次引导（安装语义降级为 boot 内一条 first-run 标记）：版本 / 平台目录 / 时间。
    appendLine(
      'boot',
      formatLine('info', 'boot', 'first-run', {
        version: context?.version ?? null,
        platforms: context?.platforms ?? [],
        firstRunAt: new Date().toISOString(),
      })
    );
  }
  return state;
}

function write(category, level, message, fields) {
  const st = ensureInit();
  if (LEVELS.indexOf(level) < LEVELS.indexOf(st.level)) return;
  const text = typeof message === 'string' ? message : String(message);
  const line = formatLine(level, category, text, fields);
  appendLine(category, line);
  // 控制台多目标输出：仅 app（运行事件），避免与既有 console.* 的启动输出重复刷屏；
  // access 为高频请求日志，不镜像控制台。
  if (st.consoleMirror && category === 'app') {
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    try {
      sink(line);
    } catch (error) {
      // 控制台管道已断开（Android 调试桥关闭等）：镜像失败不得反过来打断业务。
      if (!isBrokenPipeError(error)) throw error;
    }
  }
}

// 管道已断开的错误码：EPIPE 是最常见的；流被销毁/已结束时 Node 用 ERR_STREAM_*。
const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

/** 是否为「控制台管道已断开」类错误（不是程序缺陷，不应导致进程退出）。 */
function isBrokenPipeError(error) {
  return Boolean(error && typeof error === 'object' && BROKEN_PIPE_CODES.has(error.code));
}

// stdout/stderr 的 EPIPE 通常以 'error' 事件异步抛出（try/catch 捕获不到），
// 未监听会升级为 uncaughtException → 进程退出 → 重启风暴。装一次性监听吞掉断开类错误。
let stdioGuarded = false;
function guardStdio() {
  if (stdioGuarded) return;
  stdioGuarded = true;
  for (const stream of [process.stdout, process.stderr]) {
    if (!stream || typeof stream.on !== 'function') continue;
    stream.on('error', (error) => {
      if (isBrokenPipeError(error)) return;
      // 其它流错误保持原语义（无监听时会抛成 uncaughtException）。
      throw error;
    });
  }
}

// ---- 对外接口 ----

function makeCategory(category) {
  const api = {};
  for (const level of LEVELS) api[level] = (message, fields) => write(category, level, message, fields);
  return api;
}

/**
 * HTTP 访问日志中间件：记录本机入口请求的 method / path(query 脱敏) / status / 耗时ms /
 * 来源 host。**只记落到本实例的请求**——被 proxy 转发的远端请求不会走到后续中间件，
 * 故须挂在 mountProxyRoutes 之后、路由之前。耗时/status 用 res.on('finish') 采集。
 */
function createAccessMiddleware() {
  return function accessLogger(req, res, next) {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      let ms = 0;
      try {
        ms = Number(process.hrtime.bigint() - start) / 1e6;
      } catch {
        ms = 0;
      }
      const rawUrl = req.originalUrl || req.url || '';
      const headerHost = req.headers ? req.headers['x-host-id'] : null;
      log.access.info('http request', {
        method: req.method,
        path: redactQuery(rawUrl),
        status: res.statusCode,
        ms: Math.round(ms),
        host: headerHost || hostFromQuery(rawUrl) || 'local',
      });
    });
    next();
  };
}

/** 从原始 URL 取 ?host=（SSE 经 query 路由；本地请求缺省 'local'）。 */
function hostFromQuery(rawUrl) {
  const qi = String(rawUrl || '').indexOf('?');
  if (qi === -1) return '';
  try {
    return new URL(rawUrl, 'http://placeholder.invalid').searchParams.get('host') || '';
  } catch {
    return '';
  }
}

/** 关闭所有文件句柄（同步，保证退出前落盘）。幂等；之后再次 log.* 会重新懒初始化。 */
function close() {
  const st = state;
  state = null;
  if (!st) return;
  for (const category of CATEGORIES) {
    const slot = st.fds[category];
    if (slot) {
      try {
        fs.closeSync(slot.fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const log = {
  boot: makeCategory('boot'),
  app: makeCategory('app'),
  access: makeCategory('access'),
  // 初始化（可传 { version, platforms } 供 first-run 标记）；幂等。
  init: (context) => ensureInit(context),
  // 关闭并刷新文件句柄（进程退出/测试收尾）。
  close,
  // 脱敏辅助（app/access 两路共用；亦供测试）。
  redact,
  redactQuery,
  isBrokenPipeError,
  localDate,
  resolveDir,
  /** 便于诊断/测试：当前生效的日志目录（不触发初始化副作用）。 */
  logsDir: () => (state ? state.dir : resolveDir()),
  createAccessMiddleware,
};

module.exports = log;
