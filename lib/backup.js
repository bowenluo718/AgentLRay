'use strict';
const path = require('path');
const { ARCHIVE_DIR } = require('./config');
const { PLATFORMS } = require('./platforms');
// 纯文件枚举/复制已下沉到 lib/platforms/backup-impl.js（模块边界脚手架），此处 re-export。
const { backupCopy } = require('./platforms/backup-impl');

// --- Backup ---
// Incremental session backup: copies platform session logs into
// ARCHIVE_DIR/<platform>/<relative-path-from-platform-root>. A file is skipped
// when its archived copy already exists with the same size and an mtime no
// older than the source. Hermes is excluded (live SQLite db); openclaw too.
//
// 编排（P3 全表面等价）：遍历已挂载的平台 catalog，只处理声明了 backupFiles hook
// 的平台（(dir) => [{ path, rel }]）；byPlatform 的键与平台顺序均由 catalog 决定，
// 不再硬编码内置 5 平台表。

// Run every platform backup and return the summary object served by POST /api/backup
async function runFullBackup() {
  const byPlatform = {};
  const jobs = [];
  for (const p of Object.values(PLATFORMS)) {
    if (typeof p.backupFiles !== 'function' || typeof p.defaultDir !== 'function') continue;
    const counter = { copied: 0, skipped: 0 };
    byPlatform[p.id] = counter;
    jobs.push(
      (async () => {
        const destRoot = path.join(ARCHIVE_DIR, p.id);
        // hook 可为同步或 async；统一包一层 Promise 再挂 catch。
        const files = await Promise.resolve(p.backupFiles(p.defaultDir())).catch(() => []);
        for (const f of files) {
          await backupCopy(f.path, path.join(destRoot, f.rel), counter);
        }
      })()
    );
  }
  await Promise.all(jobs);

  let copied = 0;
  let skipped = 0;
  for (const c of Object.values(byPlatform)) {
    copied += c.copied;
    skipped += c.skipped;
  }
  return { copied, skipped, total: copied + skipped, byPlatform, archiveDir: ARCHIVE_DIR };
}

// Auto-backup: once shortly after startup, then daily. Failures are logged, never fatal.
const AUTO_BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runAutoBackup() {
  try {
    const summary = await runFullBackup();
    console.log(`[backup] copied=${summary.copied} skipped=${summary.skipped} total=${summary.total}`);
  } catch (error) {
    console.log(`[backup] failed: ${error.message}`);
  }
}

module.exports = {
  runFullBackup,
  AUTO_BACKUP_INTERVAL_MS,
  runAutoBackup,
  // re-export 纯实现（模块边界脚手架）
  backupCopy,
};
