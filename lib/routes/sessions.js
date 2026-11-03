const fsp = require('fs/promises');
const path = require('path');
const {
  DATA_DIR,
  OMP_DIR,
  CLAUDE_CODE_DIR,
  resolveDir,
  sanitizeAgentName,
  sanitizeSessionId,
  readAgents,
} = require('../config');
const { PLATFORMS } = require('../platforms');
const { hasResumeContract, buildResumeCommand } = require('../resume');
const { hasCreateContract, spawnNewSession } = require('../new');
const { STATUS_ORDER, STATUS_LABELS } = require('../status');
const { parsePlatformSelection, listSessionsBySelection, listOpenclawSessionsFlat } = require('../session-list');
const { parseOmpSessionMetadata, parseOmpSessionFile, findOmpSpawnDir } = require('../platforms/omp');
const {
  parseClaudeCodeSessionMetadata,
  parseClaudeCodeSessionFile,
  findClaudeSpawnDir,
} = require('../platforms/claude');
const {
  listSessionsForAgent,
  getSessionAcrossAgents,
  resolveSessionFile,
  parseSessionFile,
  buildSpawnMap,
  buildSpawnTree,
} = require('../platforms/openclaw');

// Session browsing: agents, per-agent (openclaw) sessions, spawn tracking,
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
  // openclaw without `agent` lists all agents (one block per agent).
  const PER_PLATFORM_DIR_PARAM = {
    openclaw: 'dirOpenclaw',
    codex: 'dirCodex',
    'claude-code': 'dirClaude',
    hermes: 'dirHermes',
    omp: 'dirOmp',
    dsh: 'dirDsh',
    gemini: 'dirGemini',
  };
  app.get('/api/sessions', async (req, res) => {
    try {
      const selection = parsePlatformSelection(req.query.platform || 'openclaw');
      const dirs = {};
      for (const [id, param] of Object.entries(PER_PLATFORM_DIR_PARAM)) {
        if (typeof req.query[param] === 'string' && req.query[param]) dirs[id] = req.query[param];
      }
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

  app.get('/api/agents', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const agents = await readAgents(dir);
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
      const sessions = await listSessionsForAgent(dir, agentName, req.query.include_archived === 'true');
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
      const filePath = await resolveSessionFile(dir, agentName, sessionId);
      if (!filePath) {
        return res.status(404).json({ error: 'Session not found' });
      }
      const payload = await parseSessionFile(filePath);
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
      const spawnLinks = await buildSpawnMap(dir);
      res.json(spawnLinks);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/spawn-tree', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const tree = await buildSpawnTree(dir);
      res.json(tree);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/spawn-tree/:sessionId', async (req, res) => {
    try {
      const dir = resolveDir(req.query.dir, DATA_DIR);
      const full = await buildSpawnTree(dir);
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

  // --- Generic platform session routes (registry-driven) ---
  // GET /api/:platform/sessions            → session list (newest first)
  // GET /api/:platform/sessions/:sessionId → normalized { session, messages, agent? }
  // openclaw 也落在这些通用路由里：`?agent=` 限定单 agent；缺省合并全部 agents
  // （列表每条会话带 agent 来源；详情跨 agent 查找并在响应用 agent 标注归属）。
  // 旧有 /api/agents/:name/sessions 端点保留（legacy 前端与既有调用）。

  app.get('/api/:platform/sessions', async (req, res, next) => {
    if (req.params.platform === 'openclaw') {
      const agent = sanitizeAgentName(req.query.agent || '');
      if (req.query.agent && !agent) {
        return res.status(400).json({ error: 'Invalid agent name' });
      }
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        const sessions = agent
          ? await listSessionsForAgent(dir, agent, req.query.include_archived === 'true')
          : await listOpenclawSessionsFlat({ dir, includeArchived: req.query.include_archived === 'true' });
        res.json(sessions);
      } catch (error) {
        if (error.code === 'ENOENT') return res.json([]);
        res.status(500).json({ error: error.message });
      }
      return;
    }
    const platform = PLATFORMS[req.params.platform];
    if (!platform || !platform.list) return next();
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

    if (req.params.platform === 'openclaw') {
      const agent = sanitizeAgentName(req.query.agent || '');
      if (req.query.agent && !agent) {
        return res.status(400).json({ error: 'Invalid agent name' });
      }
      try {
        const dir = resolveDir(req.query.dir, DATA_DIR);
        let payload;
        if (agent) {
          const filePath = await resolveSessionFile(dir, agent, sessionId);
          if (!filePath) return res.status(404).json({ error: 'Session not found' });
          payload = { ...(await parseSessionFile(filePath)), agent };
        } else {
          payload = await getSessionAcrossAgents(dir, sessionId);
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

    const platform = PLATFORMS[req.params.platform];
    if (!platform || platform.needsAgent) return next();
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

  // --- OMP subagents ---

  app.get('/api/omp/sessions/:sessionId/children', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      const spawnDir = await findOmpSpawnDir(dir, sessionId);
      if (!spawnDir) return res.json([]);
      const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
      const children = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
        const meta = await parseOmpSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
        children.push({
          name: e.name.replace(/\.jsonl$/, ''),
          file: e.name,
          title: meta?.title || null,
          timestamp: meta?.timestamp || null,
          lastActivity: meta?.lastActivity || null,
          messageCount: meta?.messageCount || 0,
          toolCallCount: meta?.toolCallCount || 0,
        });
      }
      children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      res.json(children);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/omp/sessions/:sessionId/children/:name', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const name = sanitizeAgentName(req.params.name);
    if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
    try {
      const dir = resolveDir(req.query.dir, OMP_DIR);
      const spawnDir = await findOmpSpawnDir(dir, sessionId);
      if (!spawnDir) return res.status(404).json({ error: 'No subagents for this session' });
      const payload = await parseOmpSessionFile(path.join(spawnDir, name + '.jsonl'));
      res.json(payload);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(500).json({ error: error.message });
    }
  });

  // --- Claude Code subagents ---

  app.get('/api/claude-code/sessions/:sessionId/children', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    if (!sessionId) return res.status(400).json({ error: 'Invalid session ID' });
    try {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      const spawnDir = await findClaudeSpawnDir(dir, sessionId);
      if (!spawnDir) return res.json([]);
      const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
      const children = [];
      for (const e of entries) {
        if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
        const stem = e.name.replace(/\.jsonl$/, '');
        const meta = await parseClaudeCodeSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
        let agentMeta = null;
        try {
          agentMeta = JSON.parse(await fsp.readFile(path.join(spawnDir, stem + '.meta.json'), 'utf8'));
        } catch {
          /* absent or corrupt meta.json */
        }
        children.push({
          name: stem,
          file: e.name,
          title: meta?.title || null,
          timestamp: meta?.timestamp || null,
          lastActivity: meta?.lastActivity || null,
          messageCount: meta?.messageCount || 0,
          toolCallCount: meta?.toolCallCount || 0,
          agentType: agentMeta?.agentType || null,
          description: agentMeta?.description || null,
        });
      }
      children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
      res.json(children);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get('/api/claude-code/sessions/:sessionId/children/:name', async (req, res) => {
    const sessionId = sanitizeSessionId(req.params.sessionId);
    const name = sanitizeAgentName(req.params.name);
    if (!sessionId || !name) return res.status(400).json({ error: 'Invalid session or agent name' });
    try {
      const dir = resolveDir(req.query.dir, CLAUDE_CODE_DIR);
      const spawnDir = await findClaudeSpawnDir(dir, sessionId);
      if (!spawnDir) return res.status(404).json({ error: 'No subagents for this session' });
      const payload = await parseClaudeCodeSessionFile(path.join(spawnDir, name + '.jsonl'));
      res.json(payload);
    } catch (error) {
      if (error.code === 'ENOENT') return res.status(404).json({ error: 'Subagent not found' });
      res.status(500).json({ error: error.message });
    }
  });
};
