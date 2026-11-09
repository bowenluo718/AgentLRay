'use strict';
// openclaw 平台目录声明（真源，替代 lib/config 的 DATA_DIR 引用）。
// 会话目录（agents 根）：OPENCLAW_DIR 覆盖，缺省 ~/.openclaw/agents。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  session: resolveDirs({ env: 'OPENCLAW_DIR', segments: ['.openclaw', 'agents'] }),
};
