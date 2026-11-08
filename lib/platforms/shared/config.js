'use strict';
// 框架配置在共享层的别名窗口：项目/自定义平台经 `@agentlray/shared/config`
// 访问 lib/config 的所需片段，不直接依赖 lib/ 位置（开箱即用）。
const { DSH_DIR, GEMINI_DIR, HERMES_DIR, resolveDir } = require('../../config');

module.exports = { DSH_DIR, GEMINI_DIR, HERMES_DIR, resolveDir };
