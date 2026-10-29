'use strict';
// 会话状态时间配置：web 设置面板经 GET/PUT /api/settings 读写 ~/.agentlray/
// settings.json 的 status section，并在 server / CLI 启动与页面保存时经
// lib/status.js 的 setStatusConfig() 注入，使各平台 list 与 SSE watch 的状态
// 判定共享同一套运行时时间窗口（默认 2min / 30min / 12h）。
const { readSettings, saveSections } = require('./settings');
const { DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_ACTIVE_WORK_CEIL_MS, DEFAULT_HISTORY_CEIL_MS } = require('./status');

// 平台无关的三个时间窗口 key → 默认值（毫秒）。
const STATUS_DEFAULTS = {
  recentActivityMs: DEFAULT_RECENT_ACTIVITY_MS,
  activeWorkCeilMs: DEFAULT_ACTIVE_WORK_CEIL_MS,
  historyCeilMs: DEFAULT_HISTORY_CEIL_MS,
};

function valid(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

async function readStatusSection() {
  const data = await readSettings();
  const section = data.status;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

// 白名单加载：非法值（非正有限数字）剔除；缺失 → {}（全部回退默认）。
async function loadStatusConfig() {
  const section = await readStatusSection();
  const result = {};
  for (const key of Object.keys(STATUS_DEFAULTS)) {
    if (valid(section[key])) result[key] = section[key];
  }
  return result;
}

// 保存：白名单过滤，非法/空值清除该 key；合并写入 status section，并回读干净配置。
async function saveStatusConfig(body) {
  const current = await readStatusSection();
  for (const key of Object.keys(STATUS_DEFAULTS)) {
    const value = body && body[key];
    if (valid(value)) current[key] = value;
    else delete current[key];
  }
  await saveSections({ status: current });
  return loadStatusConfig();
}

module.exports = {
  STATUS_DEFAULTS,
  loadStatusConfig,
  saveStatusConfig,
};
