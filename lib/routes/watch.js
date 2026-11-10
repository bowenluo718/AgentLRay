const { dirFor } = require('../dirs-config');
const { sanitizeAgentName, sanitizeSessionId } = require('../config');
const { PLATFORMS, defaultPlatformId } = require('../platforms');
const { watchFile } = require('../platforms/shared/watch');

// ========= Real-time SSE tail endpoint =========
// GET /api/watch?platform=openclaw&agent=NAME&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=codex&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=claude-code&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=hermes&sessionId=ID[&dir=PATH]
// GET /api/watch?platform=omp&sessionId=ID[&dir=PATH]
// Streams Server-Sent Events:
//   event: connected     data: {"messageCount": N}
//   event: newMessages   data: {"messages": [...normalized], "session": {...}}
//   event: error         data: {"error": "..."}
//
// Offset-advance and line-normalization logic live in lib/watch.js; this
// module keeps only the SSE plumbing. 平台若声明 watch hook（如 hermes 的
// WAL 监听），直接委托；否则走通用的 find + watchParse 文件字节偏移尾随。

module.exports = function mountWatchRoutes(app) {
  app.get('/api/watch', async (req, res) => {
    const platformId = req.query.platform || defaultPlatformId();
    const platform = PLATFORMS[platformId];
    if (!platform) return res.status(400).json({ error: 'Unknown platform' });
    const agentName = sanitizeAgentName(req.query.agent || '');
    const sessionId = sanitizeSessionId(req.query.sessionId || '');
    if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
    if (platform.needsAgent && !agentName) return res.status(400).json({ error: `agent required for ${platformId}` });

    // 平台自带 watch hook（如 hermes 的 WAL 监听）→ 直接委托。
    if (typeof platform.watch === 'function') {
      return platform.watch(req, res, { sessionId });
    }

    // 文件型 SSE 尾随依赖 platform.watchParse 归一化追加行；自定义平台缺位时
    // 无法实时尾随，直接 400。
    if (typeof platform.watchParse !== 'function') {
      return res.status(400).json({ error: '平台不支持实时尾随' });
    }

    let filePath = null;
    try {
      const dir = dirFor(platform, req.query.dir);
      filePath = await platform.find(dir, sessionId, { agent: agentName });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
    if (!filePath) return res.status(404).json({ error: 'Session not found' });

    return watchFile(req, res, platform, filePath);
  });
};
