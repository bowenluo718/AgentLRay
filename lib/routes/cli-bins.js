'use strict';
// 兼容只读端点：新前端一律走单一 GET/PUT /api/settings；本端点仅保留
// GET /api/settings/cli-bins 供外部调用读取，不提供 PUT。deprecated——
// 独立设置文件已聚合到 ~/.agentlray/settings.json（Q-A 结论）。
const { loadCliBins, resolveCliBin, cliBinDefaults } = require('../cli-bins');

module.exports = function mountCliBinsRoutes(app) {
  app.get('/api/settings/cli-bins', async (_req, res) => {
    try {
      const stored = await loadCliBins();
      const result = {};
      for (const [id, def] of Object.entries(cliBinDefaults())) {
        result[id] = {
          bin: await resolveCliBin(id),
          configured: Boolean(stored[id]),
          default: def,
        };
      }
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
