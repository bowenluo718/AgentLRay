const fsp = require('fs/promises');
const {
  DATA_DIR,
  resolveDir,
  sanitizeAgentName,
  sanitizeSessionId,
} = require('../config');
const { PLATFORMS, defaultPlatformId, isMounted } = require('../platforms');
const { hasResumeContract, buildResumeCommand } = require('../resume');
const { hasCreateContract, spawnNewSession } = require('../new');
const { STATUS_ORDER, STATUS_LABELS } = require('../status');
const { parsePlatformSelection, listSessionsBySelection } = require('../session-list');

// 按平台能力收集 dir query 参数：内置平台用 dirParam，无 dirParam 的（自定义）回退
// 通用 `dir`。返回 { [platformId]: dirOverride }；空目录覆盖返回 {}。
function collectDirs(req) {
  const dirs = {};
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const param = (p && p.dirParam) || 'dir';
    if (typeof req.query[param] === 'string' && req.query[param]) dirs[id] = req.query[param];
  }
  return dirs;
}

// Session browsing: agents, per-agent (needsAgent) sessions, spawn tracking,
// the generic registry-driven platform routes, and subagent children.
module.exports = function mountSessionRoutes(app) {
  // 统一会话状态定义的单源透出（React 与 legacy 前端据此渲染徽标/组头，避免各端硬编码漂移）
  app.get('/api/status-labels', (req, res) => {
    res.json({ order: STATUS_ORDER, labels: STATUS_LABELS });
  });

  // --- Multi-platform session list (aggregate) ---
  // GET /api/sessions?platform=all|openclaw,codex&[agent=]&[dirOpenclaw=]…&[status=]&[match=]&[since=]&[until=]&[limit=]&[offset=]
  // Returns { all, platformIds, total, offset, limit, platforms:[{platform, agent, total, offset, limit, sessions}] }.
  // Single-platform shape via GET /api/:platform/sessions (below) is unchanged.
  // needsAgent 平台（openclaw）without `agent` lists all agents (one block per agent).
  app.get('/api/sessions', async (req, res) => {
    try {
      const selection = parsePlatformSelection(req.query.platform || defaultPlatformId());
      const dirs = collectDirs(req);
      const agent = sanitizeAgentName(req.query.agent || '') || '';
      const result = await listSessionsBySelection(selection, {
        agent: agent || undefined,
        dirs: Object.keys(dirs).length ? dirs : undefined,
        status: req.query.status || undefined,
        match: req.query.match || undefined,
        since: req.query.since || undefined,
        until: req.query.until || undefined,
        includeArchived: req.query.include_archived === 'true',
        offset: req.query.offset,
        limit: req.query.limit,
      });
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // --- Generic platform session routes (registry-driven) ---
  // GET /api/:platform/sessions            → session list (newest first)
  // GET /api/:platform/sessions/:sessionId → normalized { session, messages, agent? }
  // needsAgent 平台（openclaw）也落在这些通用路由里：`?agent=` 限定单 agent；缺省合并
  // 全部 agents（列表每条会话带 agent 来源；详情跨 agent 查找并在响应用 agent 标注归属）。

  app.get('/api/:platform/sessions', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform) return next();
    if (platform.needsAgent) {
      const agent = sanitizeAgentName(req.query.agent || '');
      if (req.query.agent && !agent) {
        return res.status(400).json({ error: 'Invalid agent name' });
      }
      try {
        const dir = resolveDir(req.query.dir, platform.defaultDir());
        const sessions = agent
          ? await platform.listForAgent(dir, agent, req.query.include_archived === 'true')
          : await platform.listAllAgents(dir, { includeArchived: req.query.include_archived === 'true' });
        res.json(sessions);
      } catch (error) {
        if (error.code === 'ENOENT') return res.json([]);
        res.status(500).json({ error: error.message });
      }
      return;
    }
    if (!platform.list) return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      res.json(await platform.list(dir));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId', async (req, res, next) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) {
      return res.status(400).json({ error: 'Invalid session ID' });
    }

    const platform = PLATFORMS[req.params.platform];
    if (!platform) return next();
    if (platform.needsAgent) {
      const agent = sanitizeAgentName(req.query.agent || '');
      if (req.query.agent && !agent) {
        return res.status(400).json({ error: 'Invalid agent name' });
      }
      try {
        const dir = resolveDir(req.query.dir, platform.defaultDir());
        let payload;
        if (agent) {
          const filePath = await resolveSessionFileFor(platform, dir, sessionId, agent);
          if (!filePath) return res.status(404).json({ error: 'Session not found' });
          payload = { ...(await platform.parse(filePath)), agent };
        } else {
          payload = await platform.getSessionAcrossAgents(dir, sessionId);
          if (!payload) return res.status(404).json({ error: 'Session not found' });
        }
        res.json(payload);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Session not found' });
        }
        res.status(500).json({ error: error.message });
      }
      return;
    }

    if (!platform.getSession) return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await platform.getSession(dir, sessionId);
      if (!payload) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(payload);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // --- Generic agents routes (capability: listAgents / listForAgent) ---
  // GET /api/:platform/agents                       → agent 列表
  // GET /api/:platform/agents/:name/sessions        → 某 agent 的会话
  // GET /api/:platform/agents/:name/sessions/:id    → 某 agent 的单会话
  app.get('/api/:platform/agents', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || typeof platform.listAgents !== 'function') return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const agents = await platform.listAgents(dir);
      res.json(agents);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/agents/:name/sessions', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    const agentName = sanitizeAgentName(req.params.name);
    if (!agentName) {
      return res.status(400).json({ error: 'Invalid agent name' });
    }
    if (!platform || typeof platform.listForAgent !== 'function') return next();

    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const sessions = await platform.listForAgent(dir, agentName, req.query.include_archived === 'true');
      res.json(sessions);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Agent not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/agents/:name/sessions/:sessionId', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    const agentName = sanitizeAgentName(req.params.name);
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!agentName || !sessionId) {
      return res.status(400).json({ error: 'Invalid parameters' });
    }
    if (!platform || typeof platform.getSession !== 'function') return next();

    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await platform.getSession(dir, sessionId, { agent: agentName });
      if (!payload) {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.json(payload);
    } catch (error) {
      if (error.code === 'ENOENT') {
        return res.status(404).json({ error: 'Session not found' });
      }
      res.status(500).json({ error: error.message });
    }
  });

  // --- Generic children routes (capability: children) ---
  // GET /api/:platform/sessions/:sessionId/children        → 子会话列表
  // GET /api/:platform/sessions/:sessionId/children/:name  → 某子会话详情
  app.get('/api/:platform/sessions/:sessionId/children', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    if (!platform || typeof platform.listChildren !== 'function') return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const children = await platform.listChildren(dir, sessionId);
      res.json(children);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/sessions/:sessionId/children/:name', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const name = sanitizeAgentName(req.params.name);
    if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
    if (!platform || typeof platform.getChild !== 'function') return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const payload = await platform.getChild(dir, sessionId, name);
      if (payload === null) return res.status(404).json({ error: 'No subagents for this session' });
      res.json(payload);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(500).json({ error: error.message });
    }
  });

  // --- Generic spawn routes (capability: spawn) ---
  // GET /api/:platform/spawn-map             → 全部 spawn 关系
  // GET /api/:platform/spawn-tree            → 完整 spawn 树
  // GET /api/:platform/spawn-tree/:sessionId → 单节点的树视角（node/parent/total）
  app.get('/api/:platform/spawn-map', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || typeof platform.spawnMap !== 'function') return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const spawnLinks = await platform.spawnMap(dir);
      res.json(spawnLinks);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/spawn-tree', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || typeof platform.spawnTree !== 'function') return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const tree = await platform.spawnTree(dir);
      res.json(tree);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/:platform/spawn-tree/:sessionId', async (req, res, next) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform || typeof platform.spawnTree !== 'function') return next();
    try {
      const dir = resolveDir(req.query.dir, platform.defaultDir());
      const full = await platform.spawnTree(dir);
      const sid = req.params.sessionId;
      // Find tree rooted at this session, or find this session as a child
      function findNode(nodes, targetId) {
        for (const n of nodes) {
          if (n.id === targetId) return n;
          const found = findNode(n.children || [], targetId);
          if (found) return found;
        }
        return null;
      }
      // Find parent of this session
      function findParent(nodes, targetId, parent) {
        for (const n of nodes) {
          if (n.id === targetId) return parent;
          const found = findParent(n.children || [], targetId, n);
          if (found) return found;
        }
        return null;
      }
      const node = findNode(full.trees, sid);
      const parent = findParent(full.trees, sid, null);
      res.json({
        node: node || null,
        parent: parent || null,
        totalSessions: full.totalSessions,
        totalSpawnCalls: full.totalSpawnCalls,
        matchedLinks: full.matchedLinks,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- Legacy shims: top-level openclaw endpoints (openclaw only) ---
  // 兼容既有 legacy 前端与旧调用：/api/agents*、/api/spawn-*。仅当 openclaw
  // 已挂载时挂载，内部委托 openclaw 适配器 hooks——openclaw 卸载后这些端点即 404。
  function openclawHook(name) {
    return PLATFORMS.openclaw && typeof PLATFORMS.openclaw[name] === 'function'
      ? PLATFORMS.openclaw[name]
      : null;
  }

  const ocListAgents = openclawHook('listAgents');
  const ocListForAgent = openclawHook('listForAgent');
  const ocGetSession = openclawHook('getSession');
  const ocResolveFile = openclawHook('find');
  const ocParse = openclawHook('parse');
  const ocSpawnMap = openclawHook('spawnMap');
  const ocSpawnTree = openclawHook('spawnTree');
  const ocGetAcross = openclawHook('getSessionAcrossAgents');

  if (isMounted('openclaw')) {
    app.get('/api/agents', async (req, res) => {
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const agents = await ocListAgents(dir);
        res.json(agents);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/agents/:name/sessions', async (req, res) => {
      const agentName = sanitizeAgentName(req.params.name);
      if (!agentName) {
        return res.status(400).json({ error: 'Invalid agent name' });
      }
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const sessions = await ocListForAgent(dir, agentName, req.query.include_archived === 'true');
        res.json(sessions);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Agent not found' });
        }
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/agents/:name/sessions/:sessionId', async (req, res) => {
      const agentName = sanitizeAgentName(req.params.name);
      const sessionId = sanitizeSessionId(req.params.sessionId);
      if (!agentName || !sessionId) {
        return res.status(400).json({ error: 'Invalid parameters' });
      }
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const filePath = await ocResolveFile(dir, sessionId, { agent: agentName });
        if (!filePath) {
          return res.status(404).json({ error: 'Session not found' });
        }
        const payload = await ocParse(filePath);
        res.json(payload);
      } catch (error) {
        if (error.code === 'ENOENT') {
          return res.status(404).json({ error: 'Session not found' });
        }
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/spawn-map', async (req, res) => {
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const spawnLinks = await ocSpawnMap(dir);
        res.json(spawnLinks);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/spawn-tree', async (req, res) => {
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const tree = await ocSpawnTree(dir);
        res.json(tree);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    app.get('/api/spawn-tree/:sessionId', async (req, res) => {
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const full = await ocSpawnTree(dir);
        const sid = req.params.sessionId;
        function findNode(nodes, targetId) {
          for (const n of nodes) {
            if (n.id === targetId) return n;
            const found = findNode(n.children || [], targetId);
            if (found) return found;
          }
          return null;
        }
        function findParent(nodes, targetId, parent) {
          for (const n of nodes) {
            if (n.id === targetId) return parent;
            const found = findParent(n.children || [], targetId, n);
            if (found) return found;
          }
          return null;
        }
        const node = findNode(full.trees, sid);
        const parent = findParent(full.trees, sid, null);
        res.json({
          node: node || null,
          parent: parent || null,
          totalSessions: full.totalSessions,
          totalSpawnCalls: full.totalSpawnCalls,
          matchedLinks: full.matchedLinks,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });
  }

  // --- Resume 复制恢复命令（web 会话详情「复制恢复命令」按钮） ---
  // GET /api/:platform/sessions/:sessionId/resume-command?cwd=...
  // 命令串与 CLI（bin/sessions.js resume）同源（lib/resume.js buildResumeCommand），
  // 保证页面复制的命令即终端实际 spawn。平台无 resume 契约 → 200 { supported:false }
  //（前端以 GET /api/platforms 的 resume 标志预判，此处仅兜底幂等）。
  app.get('/api/:platform/sessions/:sessionId/resume-command', async (req, res) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform) {
      return res.status(404).json({ error: `Unknown platform '${req.params.platform}'` });
    }
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    if (!hasResumeContract(platform)) {
      return res.json({
        supported: false,
        error: `Platform '${req.params.platform}' has no native resume command.`,
      });
    }
    try {
      const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : null;
      const { bin, args, command } = await buildResumeCommand(platform, sessionId, { cwd });
      res.json({ supported: true, bin, args, command });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // --- 新建会话任务（web 任务看板「新建任务」按钮） ---
  // POST /api/:platform/sessions/new  body: { message?, cwd? }
  // 命令串与 spawn 逻辑与 CLI（bin/sessions.js new）同源（lib/new.js
  // buildNewCommand + spawnNewSession），保证页面触发与终端实际执行一致。
  // fire-and-forget：输出丢弃、不跟踪进程、阻塞最窄（仅 50ms 首发 error 窗口），
  // 命中即返 200 { triggered:true }（进程生命周期管理明确不做，结果需在平台
  // CLI 侧自行观察）；平台无 create 契约 → 4xx，cwd 不存在 → 400。
  app.post('/api/:platform/sessions/new', async (req, res) => {
    const platform = PLATFORMS[req.params.platform];
    if (!platform) {
      return res.status(404).json({ error: `Unknown platform '${req.params.platform}'` });
    }
    if (!hasCreateContract(platform)) {
      return res.status(422).json({
        triggered: false,
        error: `Platform '${req.params.platform}' has no native create command. Only codex / claude-code / omp / gemini / hermes, or custom platforms declaring create, are supported.`,
      });
    }
    const cwd = typeof req.body?.cwd === 'string' && req.body.cwd ? req.body.cwd : null;
    if (cwd) {
      try {
        const st = await fsp.stat(cwd);
        if (!st.isDirectory()) return res.status(400).json({ error: `cwd is not a directory: '${cwd}'` });
      } catch {
        return res.status(400).json({ error: `cwd does not exist: '${cwd}'` });
      }
    }
    const message = typeof req.body?.message === 'string' ? req.body.message : '';
    try {
      const result = await spawnNewSession(platform, { cwd, message });
      res.json({
        triggered: true,
        platform: req.params.platform,
        bin: result.bin,
        args: result.args,
        command: result.command,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};

// 辅助：needsAgent 平台在指定 agent 下解析会话文件（委托适配器 find hook）。
async function resolveSessionFileFor(platform, dir, sessionId, agent) {
  if (typeof platform.find === 'function') {
    return platform.find(dir, sessionId, { agent });
  }
  return null;
}
