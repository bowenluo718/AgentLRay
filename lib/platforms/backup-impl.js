'use strict';
// 纯备份文件枚举/复制（模块边界脚手架，P3 全表面等价）。只含不依赖注册表的实现：
//   backupCopy —— 增量复制（size+mtime 判当前）
//   enumerate*Files —— 各平台备份文件枚举，返回 [{ path, rel }]
// 平台适配器把 enumerate*Files 声明为 backupFiles hook，编排（lib/backup.js）只依赖
// registry + 本文件的 backupCopy，不再出现内置平台表。
// 本文件禁止 require lib/platforms/index.js（registry）与 lib/backup.js 等编排模块。

const os = require('os');
const fsp = require('fs/promises');
const path = require('path');
const { CODEX_DIR, CLAUDE_CODE_DIR, OMP_DIR, DSH_DIR, GEMINI_DIR } = require('../config');

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

// Codex sessions live at <root>/YYYY/MM/DD/rollout-*.jsonl
async function enumerateCodexFiles(root = CODEX_DIR) {
  return enumerateRecursive(root, (rel) => rel.endsWith('.jsonl'));
}

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
  files.push({ path: path.join(os.homedir(), '.claude', 'history.jsonl'), rel: 'history.jsonl' });
  return files;
}

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

// dsh sessions live at <root>/<projectKey>/<sessionId>/session.jsonl[.zstd]
async function enumerateDshFiles(root = DSH_DIR) {
  return enumerateRecursive(root, (rel) => rel.endsWith('.jsonl') || rel.endsWith('.jsonl.zstd'));
}

// gemini sessions live at <root>/<projectHash>/chats/session-*.jsonl
// (subagent transcripts nest one level deeper and are archived too)
async function enumerateGeminiFiles(root = GEMINI_DIR) {
  return enumerateRecursive(root, (rel) => rel.endsWith('.jsonl'));
}

module.exports = {
  backupCopy,
  enumerateCodexFiles,
  enumerateClaudeCodeFiles,
  enumerateOmpFiles,
  enumerateDshFiles,
  enumerateGeminiFiles,
};
