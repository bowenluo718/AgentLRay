'use strict';
// gemini 平台目录声明（真源，替代 lib/config 的 GEMINI_DIR）。
// 会话目录：GEMINI_DIR 覆盖，缺省 ~/.gemini/tmp（其下 <hash>/chats/ 由 adapter 自拼）。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  env: 'GEMINI_DIR',
  session: resolveDirs({ env: 'GEMINI_DIR', segments: ['.gemini', 'tmp'] }),
};
