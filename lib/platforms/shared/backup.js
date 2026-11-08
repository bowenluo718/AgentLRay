'use strict';
// 备份通用实现（原 backup-impl.js 的通用部分）。
//  - backupCopy —— 增量复制（size+mtime 判当前）
//  - enumerateRecursive —— 递归枚举 root 下满足 predicate 的文件（各平台 enumerate* 共享）
// 平台专属的 enumerate<平台>Files 内聚进各 builtin/<id>/backup.js，由此处取 enumerateRecursive。
const fsp = require('fs/promises');
const path = require('path');

// Copy src → dest unless the archived copy is already current; count the outcome
async function backupCopy(srcPath, destPath, counter) {
  let srcStat;
  try {
    srcStat = await fsp.stat(srcPath);
  } catch {
    return;
  }
  try {
    const destStat = await fsp.stat(destPath);
    if (destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
      counter.skipped++;
      return;
    }
  } catch {
    /* not archived yet */
  }
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  await fsp.copyFile(srcPath, destPath);
  counter.copied++;
}

// 递归枚举 root 下满足 predicate 的文件，rel 为相对 root 的归档路径。
async function enumerateRecursive(root, predicate) {
  try {
    const entries = await fsp.readdir(root, { recursive: true });
    return entries
      .filter((rel) => typeof rel === 'string' && predicate(rel))
      .map((rel) => ({ path: path.join(root, rel), rel }));
  } catch {
    return []; // 目录不存在/读取失败 → 无文件
  }
}

module.exports = {
  backupCopy,
  enumerateRecursive,
};
