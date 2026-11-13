'use strict';

// 多平台会话列表查询的共享逻辑：`bin/sessions.js list` 与 HTTP 聚合端点
// （GET /api/sessions）都从这里取数，保证 CLI 与 API 的过滤/分页/平台选择
// 语义一致（也都是纯数据层，不写 stdout/响应）。
//
// selection: { all, ids } —— 平台选择，见 parsePlatformSelection。
// opts: { agent, dirs?, status, match, since, until, offset, limit }
//   dirs: { [platformId]: 目录覆盖 }；平台无覆盖时用该平台默认目录。
//   对 openclaw：opts.agent 指定时只列该 agent；未指定则遍历全部 agents。

const { PLATFORMS, ALL_PLATFORMS } = require('./platforms');
const { dirFor } = require('./dirs-config');
const { loadUiSettings } = require('./ui-settings');
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
      // 平台存在于 catalog 但未挂载（停用/替代待生效，重启后生效）→ 给出可恢复的提示；
      // 真正不存在的 id 维持原有报错。
      if (ALL_PLATFORMS.has(id)) {
        throw new Error(
          `Platform '${id}' 当前未挂载（已在平台管理中停用或替代待生效）：重启后生效，可用 agentlray platform mount ${id} 恢复。`
        );
      }
      throw new Error(`Unknown platform '${id}'. Expected one of: ${Object.keys(PLATFORMS).join(', ')}.`);
    }
  }
  return { all, ids: [...new Set(ids)] };
}

// 未传 platform 时的缺省选择：优先页面持久化 selectedPlatforms（聚合），空 → 全部平台。
// 与 CLI resolveDefaultPlatform 的 list 语义一致（读同一 settings.json ui section）。
async function defaultSelection() {
  const ui = await loadUiSettings();
  const picked = (ui && Array.isArray(ui.selectedPlatforms) ? ui.selectedPlatforms : [])
    .filter((id) => PLATFORMS[id]);
  if (picked.length === 0) return { all: true, ids: Object.keys(PLATFORMS) };
  return { all: picked.length === Object.keys(PLATFORMS).length, ids: picked };
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

// 拉取一个平台（含 needsAgent 平台按 agent）的会话列表，返回 [{ platform, agent, sessions }]。
// dir 覆盖优先取 opts.dirs[id]，其次 opts.dir（单平台用）随后为平台默认目录——由
// resolveDir 决定是否采纳（非法/相对路径回退默认）。needsAgent 平台列表包含已归档与否
// 由 opts.includeArchived 控制（缺省仅活跃）。
async function listPlatformSessions(id, opts) {
  const platform = PLATFORMS[id];
  const dir = dirFor(platform, (opts.dirs && opts.dirs[id]) || opts.dir);
  const includeArchived = Boolean(opts.includeArchived);

  if (platform.needsAgent) {
    if (opts.agent) {
      const sessions = await platform.listForAgent(dir, opts.agent, includeArchived);
      return sessions.length ? [{ platform: id, agent: opts.agent, sessions }] : [];
    }
    // 未指定 agent → 遍历全部 agents，每个 agent 一段，保持来源可见。
    let agents = [];
    try {
      agents = await platform.listAgents(dir);
    } catch {
      agents = [];
    }
    const groups = [];
    for (const name of agents) {
      try {
        const sessions = await platform.listForAgent(dir, name, includeArchived);
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
// 兼容导出，委托到 openclaw 适配器的 listAllAgents hook（保持既有调用方零改动）。
async function listOpenclawSessionsFlat(opts = {}) {
  const platform = PLATFORMS.openclaw;
  const dir = dirFor(platform, opts.dir);
  const sessions = await platform.listAllAgents(dir, {
    agent: opts.agent,
    includeArchived: opts.includeArchived,
  });
  return sortSessionsByStatusGroups(sessions, { nowMs: Date.now(), sortBy: 'timestamp' });
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
  defaultSelection,
  filterAndPage,
  listPlatformSessions,
  listOpenclawSessionsFlat,
  listSessionsBySelection,
};
