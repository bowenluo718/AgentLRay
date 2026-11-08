'use strict';
// omp 专属备份文件枚举（P3 全表面等价）。返回 [{ path, rel }]。
const fsp = require('fs/promises');
const path = require('path');
const { OMP_DIR } = require('@agentlray/shared/config');

// OMP sessions live at <root>/<slug>/*.jsonl；slug 下的子 Agent 目录（spawned
// children）不在备份范围（与既有备份口径一致）。
async function enumerateOmpFiles(root = OMP_DIR) {
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
    /* no omp dir */
  }
  return files;
}

module.exports = { enumerateOmpFiles };
