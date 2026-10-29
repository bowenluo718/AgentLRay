'use strict';
// 页面（web 看板）持久化的 UI 偏好 —— 平台选择的服务端落盘与读取。
//
// 前端把 localStorage「agent-xray-settings」里的平台选择（单平台 platform /
// 多平台集合 selectedPlatforms）同步到 GET/PUT /api/settings 的 ui section；
// CLI（bin/sessions.js）在未传 --platform 时读取同一 section 作为默认，保证
// 终端命令与页面视角一致。所有设置聚合存 ~/.agentlray/settings.json。
const { readSettings, saveSections } = require('./settings');

// 读取页面持久化的平台选择；未配置 → null（CLI 据此回退：list = all，
// show/resume = 报错要求显式 --platform）。
async function loadUiSettings() {
  const data = await readSettings();
  const ui = data.ui;
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return null;
  return {
    platform: typeof ui.platform === 'string' ? ui.platform : null,
    selectedPlatforms: Array.isArray(ui.selectedPlatforms) ? ui.selectedPlatforms : [],
  };
}

async function saveUiSettings({ platform, selectedPlatforms }) {
  const saved = { platform, selectedPlatforms };
  await saveSections({ ui: saved });
  return saved;
}

module.exports = { loadUiSettings, saveUiSettings };
