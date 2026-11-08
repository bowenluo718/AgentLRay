'use strict';
// codex 平台目录声明（真源，替代 lib/config 的 CODEX_DIR）。
// 会话目录：CODEX_DIR 覆盖，缺省 ~/.codex/sessions。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  session: resolveDirs({ env: 'CODEX_DIR', segments: ['.codex', 'sessions'] }),
  // 库安装目标（slash 命令）：~/.codex/prompts（codex 自身文件，root 'home'）。
  prompts: resolveDirs({ root: 'home', segments: ['.codex', 'prompts'] }),
};
