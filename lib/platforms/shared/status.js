'use strict';
// 会话状态排序在共享层的别名窗口：平台经 `@agentlray/shared/status`
// 访问 lib/status 的 sortSessionsByStatusGroups，不直接依赖 lib/ 位置。
const { sortSessionsByStatusGroups } = require('../../status');

module.exports = { sortSessionsByStatusGroups };
