'use strict';
// 框架配置在共享层的别名窗口：内置平台（builtin/<id>/）与项目/自定义平台
//（platforms/<id>/）统一经 `@agentlray/shared/config` 访问 lib/config 的所需
// 片段，不直接依赖 lib/ 位置（开箱即用）。
const {
  DATA_DIR,
  CODEX_DIR,
  CLAUDE_CODE_DIR,
  HERMES_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  resolveDir,
  isArchivedFile,
  isSessionLogFile,
  ensureDirectory,
  readAgents,
} = require('../../config');

module.exports = {
  DATA_DIR,
  CODEX_DIR,
  CLAUDE_CODE_DIR,
  HERMES_DIR,
  OMP_DIR,
  DSH_DIR,
  GEMINI_DIR,
  resolveDir,
  isArchivedFile,
  isSessionLogFile,
  ensureDirectory,
  readAgents,
};
