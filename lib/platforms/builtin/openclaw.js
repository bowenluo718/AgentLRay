'use strict';
// 内置平台 openclaw 适配器（P1 从 lib/platforms/index.js 逐字搬迁 + 声明字段）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const fsp = require('fs/promises');
const path = require('path');
const { DATA_DIR, isArchivedFile, readAgents } = require('../../config');
const {
  resolveSessionFile,
  normalizeMessage,
  parseSessionFile,
  listSessionsForAgent,
  getSessionAcrossAgents,
  buildSpawnMap,
  buildSpawnTree,
} = require('../openclaw');
const { sortSessionsByStatusGroups } = require('../../status');

module.exports = {
  id: 'openclaw',
  label: 'OpenClaw',
  needsAgent: true,
  // 目录设置：数据目录 tab（settings.json ui section 的 openclawDir）。
  dirSettingKey: 'openclawDir',
  dirSettingLabel: 'OpenClaw 会话目录',
  dirSettingHint: 'OpenClaw agent 的会话日志位置；留空用默认目录',
  dirParam: 'dirOpenclaw',
  color: '#3fb950',
  // 无 resume / create / bin（openclaw 不可续跑、不可新建）。
  bin: null,
  defaultDir: () => DATA_DIR,
  // per-agent listing: listSessionsForAgent(dir, agent, includeArchived) 已按状态分组排序。
  list: null,
  listForAgent: (dir, agent, includeArchived) => listSessionsForAgent(dir, agent, includeArchived),
  // 全部 agents 扁平合并（每条带 agent 来源），全局状态分组排序；opts.agent 限定单 agent。
  listAllAgents: async (dir, opts = {}) => {
    const agents = opts.agent ? [opts.agent] : await readAgents(dir).catch(() => []);
    const all = [];
    for (const name of agents) {
      try {
        const sessions = await listSessionsForAgent(dir, name, Boolean(opts.includeArchived));
        all.push(...sessions);
      } catch {
        /* 该 agent 目录缺失，跳过 */
      }
    }
    return sortSessionsByStatusGroups(all, { nowMs: Date.now(), sortBy: 'timestamp' });
  },
  listAgents: (dir) => readAgents(dir),
  find: (dir, sessionId, opts = {}) => (opts.agent ? resolveSessionFile(dir, opts.agent, sessionId) : null),
  parse: parseSessionFile,
  getSession: async (dir, sessionId, opts = {}) => {
    if (!opts.agent) return null;
    const filePath = await resolveSessionFile(dir, opts.agent, sessionId);
    return filePath ? parseSessionFile(filePath) : null;
  },
  // 跨全部 agents 按 id 查找，返回 { session, messages, agent }；未命中 null。
  getSessionAcrossAgents: (dir, sessionId) => getSessionAcrossAgents(dir, sessionId),
  // 单 agent 内的会话文件解析（通用路由 ?agent= 限定单 agent 时用 find + parse）。
  // 缺此 hook 时通用路由会把这类请求回落 SPA（曾出现 /api/openclaw/agents/:name/sessions
  // 无法标识无子代理的会话），与 parse 配对声明即可。
  getSessionFile: async (dir, sessionId, agentName) => {
    if (!agentName) return null;
    try {
      return await resolveSessionFile(dir, agentName, sessionId);
    } catch {
      return null;
    }
  },
  // spawn 关系图/树（openclaw 会话文件的 toolCall/exec 扫描）。
  spawnMap: (dir) => buildSpawnMap(dir),
  spawnTree: (dir) => buildSpawnTree(dir),
  collectFiles: async (dir, opts = {}) => {
    const files = [];
    const agents = opts.agent ? [opts.agent] : await readAgents(dir).catch(() => []);
    for (const agent of agents) {
      const agentDir = path.join(dir, agent, 'sessions');
      let entries;
      try {
        entries = await fsp.readdir(agentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl') && !isArchivedFile(e.name)) {
          files.push({
            path: path.join(agentDir, e.name),
            file: e.name,
            sessionId: e.name.replace(/\.jsonl$/, ''),
            agent,
          });
        }
      }
    }
    return files;
  },
  watchParse: (rec) => {
    if (rec.type === 'session') return { session: { id: rec.id, cwd: rec.cwd, timestamp: rec.timestamp } };
    if (rec.type === 'message') return { messages: [normalizeMessage(rec)] };
    return null;
  },
};
