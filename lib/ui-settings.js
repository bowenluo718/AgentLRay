'use strict';
// 页面（web 看板）持久化的 UI 偏好 —— 平台选择的服务端落盘与读取。
//
// 前端把 localStorage「agent-xray-settings」里的平台选择（单平台 platform /
// 多平台集合 selectedPlatforms）同步到 GET/PUT /api/settings/ui；CLI
// （bin/sessions.js）在未传 --platform 时读取同一文件作为默认，保证终端命令
// 与页面视角一致。存放于 ~/.agentlray/ui-settings.json（与 llm.json /
// hidden-prompts.json 同级）。
const path = require('path');
const fsp = require('fs/promises');
const { HOME } = require('./config');

const UI_SETTINGS_FILE = path.join(HOME, '.agentlray', 'ui-settings.json');

// 读取页面持久化的平台选择；文件缺失或损坏 → null（CLI 据此回退：list = all，
// show/resume = 报错要求显式 --platform）。
async function loadUiSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(UI_SETTINGS_FILE, 'utf8'));
    return {
      platform: typeof parsed.platform === 'string' ? parsed.platform : null,
      selectedPlatforms: Array.isArray(parsed.selectedPlatforms) ? parsed.selectedPlatforms : [],
    };
  } catch {
    return null;
  }
}

async function saveUiSettings({ platform, selectedPlatforms }) {
  await fsp.mkdir(path.dirname(UI_SETTINGS_FILE), { recursive: true });
  const data = { platform, selectedPlatforms, updatedAt: new Date().toISOString() };
  await fsp.writeFile(UI_SETTINGS_FILE, JSON.stringify(data, null, 2));
  return data;
}

module.exports = { UI_SETTINGS_FILE, loadUiSettings, saveUiSettings };
