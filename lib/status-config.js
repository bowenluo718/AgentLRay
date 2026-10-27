'use strict';
// 会话状态时间配置：web 设置面板读写 ~/.agentlray/status-config.json，并在
// server / CLI 启动时经 lib/status.js 的 setStatusConfig() 注入，使各平台 list
// 与 SSE watch 的状态判定共享同一套运行时时间窗口（默认 2min / 30min / 12h）。
const path = require('path');
const { HOME } = require('./config');
const { createConfigStore } = require('./config-store');
const { DEFAULT_RECENT_ACTIVITY_MS, DEFAULT_ACTIVE_WORK_CEIL_MS, DEFAULT_HISTORY_CEIL_MS } = require('./status');

const STATUS_CONFIG_FILE = path.join(HOME, '.agentlray', 'status-config.json');

// 平台无关的三个时间窗口 key → 默认值（毫秒）。
const STATUS_DEFAULTS = {
  recentActivityMs: DEFAULT_RECENT_ACTIVITY_MS,
  activeWorkCeilMs: DEFAULT_ACTIVE_WORK_CEIL_MS,
  historyCeilMs: DEFAULT_HISTORY_CEIL_MS,
};

// 白名单 JSON 配置存储：非法值（非正有限数字 / 缺失）清除回退默认。
const store = createConfigStore({
  filePath: STATUS_CONFIG_FILE,
  defaults: STATUS_DEFAULTS,
  validate: (key, value) => typeof value === 'number' && Number.isFinite(value) && value > 0,
});

module.exports = {
  STATUS_DEFAULTS,
  STATUS_CONFIG_FILE,
  loadStatusConfig: store.load,
  saveStatusConfig: store.save,
};
