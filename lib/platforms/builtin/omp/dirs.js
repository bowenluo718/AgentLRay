'use strict';
// omp 平台目录声明（真源，替代 lib/config 的 OMP_DIR）。
// 会话目录：OMP_DIR 覆盖，缺省 ~/.omp/agent/sessions。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  session: resolveDirs({ env: 'OMP_DIR', segments: ['.omp', 'agent', 'sessions'] }),
  // 库安装目标（slash 命令）：~/.omp/agent/commands（omp 自身文件，root 'home'）。
  commands: resolveDirs({ root: 'home', segments: ['.omp', 'agent', 'commands'] }),
};
