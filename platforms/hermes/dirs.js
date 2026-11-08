'use strict';
// hermes 平台目录声明（真源，替代 lib/config 的 HERMES_DIR）。
// 数据目录：HERMES_DIR 覆盖，缺省 ~/.hermes（SQLite state.db 位于其下）。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  session: resolveDirs({ env: 'HERMES_DIR', segments: ['.hermes'] }),
};
