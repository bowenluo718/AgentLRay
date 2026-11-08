'use strict';
// openclaw 平台目录声明（真源，替代 lib/config 的 DATA_DIR / HERMES_DIR 引用）。
// 会话目录（agents 根）：OPENCLAW_DIR 覆盖，缺省 ~/.openclaw/agents。
// spawn 树需要读取 hermes 会话库（hermes-db 共享机制），其目录声明与 hermes
// 平台 session 一致（HERMES_DIR 覆盖，缺省 ~/.hermes）。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  session: resolveDirs({ env: 'OPENCLAW_DIR', segments: ['.openclaw', 'agents'] }),
  hermesHome: resolveDirs({ env: 'HERMES_DIR', segments: ['.hermes'] }),
};
