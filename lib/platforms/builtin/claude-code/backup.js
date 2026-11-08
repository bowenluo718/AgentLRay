'use strict';
// claude-code 平台专属备份文件枚举。通用 backupCopy/enumerateRecursive 取自
// ../../shared/backup。

const fsp = require('fs/promises');
const path = require('path');
const { session: CLAUDE_CODE_DIR, historyFile } = require('./dirs');

// Claude Code sessions live at <root>/<project-slug>/*.jsonl; the prompt
// history sits beside the projects dir (~/.claude/history.jsonl).
// 只归档一级项目目录下的会话文件：subagents/ 子目录不在备份范围（与既有
// 备份口径一致），避免重复计数。
async function enumerateClaudeCodeFiles(root = CLAUDE_CODE_DIR) {
  const files = [];
  try {
    const slugs = await fsp.readdir(root, { withFileTypes: true });
    for (const s of slugs) {
      if (!s.isDirectory()) continue;
      const slugDir = path.join(root, s.name);
      const entries = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(slugDir, f.name), rel: path.join(s.name, f.name) });
        }
      }
    }
  } catch {
    /* no claude dir */
  }
  files.push({ path: historyFile, rel: 'history.jsonl' });
  return files;
}

module.exports = { enumerateClaudeCodeFiles };
