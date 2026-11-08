'use strict';
// codex 平台专属备份文件枚举（从 lib/platforms/backup-impl.js 提取）。
const { session: CODEX_DIR } = require('./dirs');
const { enumerateRecursive } = require('@agentlray/shared/backup');

// Codex sessions live at <root>/YYYY/MM/DD/rollout-*.jsonl
async function enumerateCodexFiles(root = CODEX_DIR) {
  return enumerateRecursive(root, (rel) => rel.endsWith('.jsonl'));
}

module.exports = {
  enumerateCodexFiles,
};
