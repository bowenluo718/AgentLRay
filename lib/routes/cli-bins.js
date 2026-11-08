'use strict';
// 兼容端点（只读）：legacy 冻结快照 public/js/app.js 的「复制恢复命令」按钮读
// GET /api/settings/cli-bins（app.js:3501）。新前端一律走单一 GET/PUT
// /api/settings；legacy 无写入口，本端点只保留读取、不提供 PUT。deprecated——
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
