const { loadStatusConfig, saveStatusConfig, STATUS_DEFAULTS } = require('../status-config');
const { settingsResult } = require('../config-store');

// 会话状态时间配置：web 设置面板读写 ~/.agentlray/status-config.json。
// GET 返回各 key 当前生效窗口（含默认回退与 configured 标记）；
// PUT 保存白名单内窗口（毫秒，空/非正数 = 清除该 key，回退默认），保存即经
// lib/status.js setStatusConfig 注入，页面保存后对后续状态判定立即生效。
module.exports = function mountStatusConfigRoutes(app, { status } = {}) {
  app.get('/api/settings/status', async (_req, res) => {
    try {
      const stored = await loadStatusConfig();
      res.json(settingsResult(stored, STATUS_DEFAULTS));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/settings/status', async (req, res) => {
    try {
      const saved = await saveStatusConfig(req.body || {});
      // 保存即注入，页面保存后后续状态判定立即用新窗口。
      if (status && typeof status.setStatusConfig === 'function') {
        status.setStatusConfig(saved);
      }
      res.json(settingsResult(saved, STATUS_DEFAULTS));
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
