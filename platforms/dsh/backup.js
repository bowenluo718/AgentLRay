'use strict';
// dsh 平台专属备份文件枚举（自 backup-impl.js 迁出）。
// dsh sessions live at <root>/<projectKey>/<sessionId>/session.jsonl[.zstd].
const { enumerateRecursive } = require('@agentlray/shared/backup');
const { DSH_DIR } = require('@agentlray/shared/config');

async function enumerateDshFiles(root = DSH_DIR) {
  return enumerateRecursive(root, (rel) => rel.endsWith('.jsonl') || rel.endsWith('.jsonl.zstd'));
}

module.exports = { enumerateDshFiles };
