const { loadCliBins, saveCliBins, resolveCliBin, CLI_BIN_DEFAULTS } = require('../cli-bins');

// 平台 CLI 命令配置：web 设置面板读写 ~/.agentlray/cli-bins.json。
// GET/PUT 的 bin 字段反映「实际生效命令」= 环境变量 → 配置文件 → 默认名，
// 与后端 bin/sessions.js resume 的 resolveCliBin() 完全一致——前端复制恢复
// 命令因此与终端实际 spawn 一致（P1 一致性）。
module.exports = function mountCliBinsRoutes(app) {
  async function buildResponse(stored) {
    const result = {};
    for (const [id, def] of Object.entries(CLI_BIN_DEFAULTS)) {
      result[id] = {
        bin: await resolveCliBin(id),
        configured: Boolean(stored[id]),
        default: def,
      };
    }
    return result;
  }

  app.get('/api/settings/cli-bins', async (_req, res) => {
    try {
      const stored = await loadCliBins();
      res.json(await buildResponse(stored));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/settings/cli-bins', async (req, res) => {
    try {
      const saved = await saveCliBins(req.body || {});
      res.json(await buildResponse(saved));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
