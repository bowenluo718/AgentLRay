'use strict';
// 文本工具在共享层的别名窗口：平台经 `@agentlray/shared/text-utils`
// 访问 lib/text-utils 的所需片段，不直接依赖 lib/ 位置。
const { normalizeErrorPattern } = require('../../text-utils');

module.exports = { normalizeErrorPattern };
