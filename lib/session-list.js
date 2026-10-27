'use strict';

// 多平台会话列表查询的共享逻辑：`bin/sessions.js list` 与 HTTP 聚合端点
// （GET /api/sessions）都从这里取数，保证 CLI 与 API 的过滤/分页/平台选择
// 语义一致（也都是纯数据层，不写 stdout/响应）。
//
// selection: { all, ids } —— 平台选择，见 parsePlatformSelection。
// opts: { agent, dirs?, status, match, since, until, offset, limit }
//   dirs: { [platformId]: 目录覆盖 }；平台无覆盖时用该平台默认目录。
//   对 openclaw：opts.agent 指定时只列该 agent；未指定则遍历全部 agents。

const { PLATFORMS } = require('./platforms');
const { resolveDir, readAgents } = require('./config');
const { listSessionsForAgent } = require('./platforms/openclaw');
const { STATUS, sortSessionsByStatusGroups } = require('./status');

// 解析平台选择：单个平台 id、逗号分隔多值、或 'all'（全部平台）。
// 返回 { all, ids }；未知平台照旧报错。
function parsePlatformSelection(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error("Missing value for '--platform'.");
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error("Missing value for '--platform'.");
  const all = parts.includes('all');
  if (all && parts.length > 1) {
    throw new Error(`'all' cannot be combined with other platform ids ('${value}').`);
  }
  const ids = all ? Object.keys(PLATFORMS) : parts;
  for (const id of ids) {
    if (!PLATFORMS[id]) {
      throw new Error(`Unknown platform '${id}'. Expected one of: ${Object.keys(PLATFORMS).join(', ')}.`);
    }
  }
  return { all, ids: [...new Set(ids)] };
}

function tsMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function parseNonNegInt(value, name) {
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isInteger(n) || n < 0) throw new Error(`'${name}' expects a nonnegative integer.`);
  return n;
}

// 状态/match/时间过滤 + 分页。返回 { total, offset, limit, shown }：
// total 为过滤后总数（分页前），shown 为分页窗口。offset/limit 接受数字或字符串。
function filterAndPage(sessions, opts) {
  let filtered = sessions;

  if (opts.status) {
    const wanted = new Set(
      String(opts.status).split(',').map((s) => s.trim()).filter(Boolean)
    );
    for (const s of wanted) {
      if (!Object.values(STATUS).includes(s)) {
        throw new Error(`Unknown status '${s}'. Expected: ${Object.values(STATUS).join(', ')}.`);
      }
    }
    filtered = filtered.filter((s) => wanted.has(s.status));
  }

  if (opts.match) {
    const needle = String(opts.match).toLowerCase();
    filtered = filtered.filter((s) =>
      [s.id, s.title, s.firstUserMessage, s.lastMessage && s.lastMessage.text].some(
        (v) => v && String(v).toLowerCase().includes(needle)
      )
    );
  }

  const sinceMs = opts.since != null ? tsMs(opts.since) : null;
  const untilMs = opts.until != null ? tsMs(opts.until) : null;
  if (opts.since != null && sinceMs === null) throw new Error(`Invalid --since timestamp '${opts.since}'.`);
  if (opts.until != null && untilMs === null) throw new Error(`Invalid --until timestamp '${opts.until}'.`);
  if (sinceMs !== null || untilMs !== null) {
    filtered = filtered.filter((s) => {
      const activity = tsMs(s.lastActivity) ?? tsMs(s.timestamp);
      if (activity === null) return false;
      if (sinceMs !== null && activity < sinceMs) return false;
      if (untilMs !== null && activity > untilMs) return false;
      return true;
    });
  }

  const offset = opts.offset != null ? parseNonNegInt(opts.offset, '--offset') : 0;
  const limit = opts.limit != null ? parseNonNegInt(opts.limit, '--limit') : 0;
  const shown = limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);
  return { total: filtered.length, offset, limit: limit || null, shown };
}

// 拉取一个平台（含 openclaw 按 agent）的会话列表，返回 [{ platform, agent, sessions }]。
// dir 覆盖优先取 opts.dirs[id]，其次 opts.dir（单平台用）随后为平台默认目录——由
// resolveDir 决定是否采纳（非法/相对路径回退默认）。openclaw 列表包含已归档与否
// 由 opts.includeArchived 控制（缺省仅活跃）。
async function listPlatformSessions(id, opts) {
  const platform = PLATFORMS[id];
  const dir = resolveDir((opts.dirs && opts.dirs[id]) || opts.dir, platform.defaultDir());
  const includeArchived = Boolean(opts.includeArchived);

  if (id === 'openclaw') {
    if (opts.agent) {
      const sessions = await listSessionsForAgent(dir, opts.agent, includeArchived);
      return sessions.length ? [{ platform: id, agent: opts.agent, sessions }] : [];
    }
    // 未指定 agent → 遍历全部 agents，每个 agent 一段，保持来源可见。
    let agents = [];
    try {
      agents = await readAgents(dir);
    } catch {
      agents = [];
    }
    const groups = [];
    for (const name of agents) {
      try {
        const sessions = await listSessionsForAgent(dir, name, includeArchived);
        if (sessions.length) groups.push({ platform: id, agent: name, sessions });
      } catch {
        /* 该 agent 目录缺失，跳过 */
      }
    }
    return groups;
  }

  if (!platform.list) throw new Error(`Platform '${id}' does not support listing.`);
  return [{ platform: id, agent: null, sessions: await platform.list(dir) }];
}

// openclaw 全部 agents 合并的扁平会话列表（每条带 agent 来源，全局状态分组排序）。
// 供 CLI list 单平台 openclaw 缺省 --agent 与 HTTP GET /api/openclaw/sessions 使用；
// 枚举逻辑与 listPlatformSessions 同源（readAgents → 逐 agent → 跳过缺失目录），
// 由本层统一，避免调用方（bin/sessions.js、routes/sessions.js）另起一路。
async function listOpenclawSessionsFlat(opts = {}) {
  const groups = await listPlatformSessions('openclaw', opts);
  return sortSessionsByStatusGroups(
    groups.flatMap((g) => g.sessions),
    { nowMs: Date.now(), sortBy: 'timestamp' }
  );
}

// 按平台选择列出会话：每个平台各自过滤/分页，返回统一结构
// { all, platformIds, total, offset, limit, platforms:[{platform, agent, total, offset, limit, sessions}] }。
async function listSessionsBySelection(selection, opts = {}) {
  const groups = [];
  for (const id of selection.ids) {
    const byPlatform = await listPlatformSessions(id, opts);
    for (const item of byPlatform) {
      const paged = filterAndPage(item.sessions, opts);
      groups.push({ ...item, ...paged });
    }
  }
  const offset = opts.offset != null ? parseNonNegInt(opts.offset, '--offset') : 0;
  const limit = opts.limit != null ? parseNonNegInt(opts.limit, '--limit') : null;
  return {
    all: selection.all,
    platformIds: selection.ids,
    total: groups.reduce((n, g) => n + g.total, 0),
    offset,
    limit,
    platforms: groups.map((g) => ({
      platform: g.platform,
      agent: g.agent,
      total: g.total,
      offset: g.offset,
      limit: g.limit,
      sessions: g.shown,
    })),
  };
}

module.exports = {
  parsePlatformSelection,
  filterAndPage,
  listPlatformSessions,
  listOpenclawSessionsFlat,
  listSessionsBySelection,
};
