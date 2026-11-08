const os = require('os');
const path = require('path');
const fsp = require('fs/promises');

const HOME = process.env.AGENTLRAY_HOME || os.homedir();
// 平台会话目录已下沉到各平台文件的目录声明（platforms/<id>/dirs.js 或
// lib/platforms/builtin/<id>/dirs.js，经 @agentlray/shared/config 的 resolveDirs
// 解析），本模块不再持有平台目录/env 常量。
// Persisted analysis results live here (prompt analysis + tool audit)
const ANALYSIS_DIR = path.join(HOME, '.agentlray', 'analysis');

const SESSION_ID_RE = /^[0-9a-zA-Z._:-]+$/;
const AGENT_NAME_RE = /^[A-Za-z0-9._-]+$/;

// ========= Session Metadata Cache =========
// Key: absolute file path  →  { mtime: number, data: sessionMetadataObject }
const sessionMetaCache = new Map();

function resolveDir(queryDir, defaultDir) {
  if (!queryDir || typeof queryDir !== 'string') return defaultDir;
  if (!path.isAbsolute(queryDir)) return defaultDir;
  if (queryDir.includes('..')) return defaultDir;
  return queryDir;
}

function isArchivedFile(fileName) {
  return fileName.includes('.jsonl.reset.') || fileName.includes('.jsonl.deleted.');
}

function isSessionLogFile(fileName) {
  return fileName.endsWith('.jsonl') || isArchivedFile(fileName);
}

function sanitizeAgentName(name) {
  return AGENT_NAME_RE.test(name) ? name : null;
}

function sanitizeSessionId(id) {
  return SESSION_ID_RE.test(id) ? id : null;
}

async function ensureDirectory(dirPath) {
  const stat = await fsp.stat(dirPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
}

async function readAgents(baseDir) {
  const dir = baseDir;
  await ensureDirectory(dir);
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

module.exports = {
  HOME,
  ANALYSIS_DIR,
  SESSION_ID_RE,
  AGENT_NAME_RE,
  sessionMetaCache,
  resolveDir,
  isArchivedFile,
  isSessionLogFile,
  sanitizeAgentName,
  sanitizeSessionId,
  ensureDirectory,
  readAgents,
};
