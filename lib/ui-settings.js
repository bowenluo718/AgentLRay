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
  const data = await readSettings();
  const current = data.ui && typeof data.ui === 'object' && !Array.isArray(data.ui) ? data.ui : {};
  // 浅合并而非整体替换：平台选择只覆盖自己的两个键，保留 ui section 中可能存在的
  // 其他偏好（历史版本/其他入口写入的目录等），避免与前端 persistState 互相覆盖。
  await saveSections({ ui: { ...current, platform, selectedPlatforms } });
  return { platform, selectedPlatforms };
}

module.exports = { loadUiSettings, saveUiSettings };
