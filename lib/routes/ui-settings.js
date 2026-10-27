// 页面持久化 UI 偏好（平台选择）：GET 返回、PUT 存储到 ~/.agentlray/ui-settings.json。
// CLI（bin/sessions.js）未传 --platform 时读取同一文件，保证终端与页面视角一致。
const { loadUiSettings, saveUiSettings } = require('../ui-settings');
const { PLATFORMS } = require('../platforms');

module.exports = function mountUiSettingsRoutes(app) {
  app.get('/api/settings/ui', async (_req, res) => {
    try {
      const ui = await loadUiSettings();
      res.json(ui || { platform: null, selectedPlatforms: [] });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  app.put('/api/settings/ui', async (req, res) => {
    try {
      const body = req.body || {};
      // 只收平台注册表白名单内的 id，防脏数据落盘。
      const platform = typeof body.platform === 'string' && PLATFORMS[body.platform] ? body.platform : null;
      let selectedPlatforms = [];
      if (Array.isArray(body.selectedPlatforms)) {
        selectedPlatforms = body.selectedPlatforms.filter((p) => PLATFORMS[p]);
      }
      if (body.platform !== undefined && platform === null) {
        return res.status(400).json({ error: 'platform must be one of: ' + Object.keys(PLATFORMS).join(', ') });
      }
      if (body.selectedPlatforms !== undefined && !Array.isArray(body.selectedPlatforms)) {
        return res.status(400).json({ error: 'selectedPlatforms must be an array' });
      }
      const saved = await saveUiSettings({ platform, selectedPlatforms });
      res.json({ platform: saved.platform, selectedPlatforms: saved.selectedPlatforms });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
