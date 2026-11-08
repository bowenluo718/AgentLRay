const { ARCHIVE_DIR } = require('./config');
// 纯文件枚举/复制已下沉到 lib/platforms/backup-impl.js（模块边界脚手架），此处 re-export。
const { backupCopy, backupCodex, backupClaudeCode, backupOmp, backupDsh, backupGemini } = require('./platforms/backup-impl');

// --- Backup ---
// Incremental session backup: copies platform session logs into
// ARCHIVE_DIR/<platform>/<relative-path-from-platform-root>. A file is skipped
// when its archived copy already exists with the same size and an mtime no
// older than the source. Hermes is excluded (live SQLite db); openclaw too.

// Run every platform backup and return the summary object served by POST /api/backup
async function runFullBackup() {
  const byPlatform = {
    codex: { copied: 0, skipped: 0 },
    'claude-code': { copied: 0, skipped: 0 },
    omp: { copied: 0, skipped: 0 },
    dsh: { copied: 0, skipped: 0 },
    gemini: { copied: 0, skipped: 0 },
  };
  await Promise.all([
    backupCodex(byPlatform.codex),
    backupClaudeCode(byPlatform['claude-code']),
    backupOmp(byPlatform.omp),
    backupDsh(byPlatform.dsh),
    backupGemini(byPlatform.gemini),
  ]);
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
  backupCodex,
  backupClaudeCode,
  backupOmp,
  backupDsh,
  backupGemini,
};
