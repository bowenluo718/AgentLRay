'use strict';
// 内置平台 gemini 备份文件枚举（从 lib/platforms/backup-impl.js 迁移）。
// gemini sessions live at <root>/<projectHash>/chats/session-*.jsonl
// (subagent transcripts nest one level deeper and are archived too)
const { session: GEMINI_DIR } = require('./dirs');
const { enumerateRecursive } = require('@agentlray/shared/backup');

async function enumerateGeminiFiles(root = GEMINI_DIR) {
  return enumerateRecursive(root, (rel) => rel.endsWith('.jsonl'));
}

module.exports = { enumerateGeminiFiles };
