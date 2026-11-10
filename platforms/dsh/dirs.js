'use strict';
// dsh 平台目录声明（真源，替代 lib/config 的 DSH_DIR）。
// 会话目录：DSH_DIR 优先；缺省 DSH_HOME 时为 dsh 根 + /sessions（DSH_HOME 本指
// dsh 家目录，会话目录在其 /sessions 下，altSegments 仅 ['sessions']）；再缺省
// ~/.dsh/sessions。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  env: ['DSH_DIR', 'DSH_HOME'],
  session: resolveDirs({ env: 'DSH_DIR', altEnv: 'DSH_HOME', segments: ['.dsh', 'sessions'], altSegments: ['sessions'] }),
};
