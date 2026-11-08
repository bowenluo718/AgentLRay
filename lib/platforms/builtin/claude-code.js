'use strict';
// 内置平台 claude-code 适配器（P1 从 lib/platforms/index.js 逐字搬迁 + 声明字段）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const fsp = require('fs/promises');
const path = require('path');
const { CLAUDE_CODE_DIR } = require('../../config');
const {
  findClaudeCodeSessionFile,
  listClaudeCodeSessions,
  normalizeClaudeCodeRecord,
  parseClaudeCodeSessionFile,
  parseClaudeCodeSessionMetadata,
  findClaudeSpawnDir,
} = require('../claude');
const { fileBasedGetSession } = require('../shared');

module.exports = {
  id: 'claude-code',
  label: 'Claude Code',
  // 目录设置：数据目录 tab（settings.json ui section 的 claudeCodeDir）。
  dirSettingKey: 'claudeCodeDir',
  dirSettingLabel: 'Claude Code 会话目录',
  dirSettingHint: 'Claude Code 项目会话目录',
  // dirParam 必须是 dirClaude（前端/路由既有映射）。
  dirParam: 'dirClaude',
  color: '#d2a8ff',
  // resume / create / bin 声明（与旧 RESUME_BINS / NEW_BINS / CLI_BIN_DEFAULTS 逐字对齐）。
  resume: { bin: 'claude', args: (id) => ['--dangerously-skip-permissions', '--resume', id] },
  create: {
    bin: 'claude',
    args: (opts) =>
      opts && opts.message != null && String(opts.message).length > 0
        ? ['--dangerously-skip-permissions', '-p']
        : ['--dangerously-skip-permissions'],
  },
  bin: 'claude',
  defaultDir: () => CLAUDE_CODE_DIR,
  list: listClaudeCodeSessions,
  find: findClaudeCodeSessionFile,
  parse: parseClaudeCodeSessionFile,
  getSession: fileBasedGetSession(findClaudeCodeSessionFile, parseClaudeCodeSessionFile),
  // Claude Code subagents: children live as <slug>/<sessionId>/subagents/agent-*.jsonl。
  listChildren: async (dir, sessionId) => {
    const spawnDir = await findClaudeSpawnDir(dir, sessionId);
    if (!spawnDir) return [];
    const entries = await fsp.readdir(spawnDir, { withFileTypes: true });
    const children = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.startsWith('agent-') || !e.name.endsWith('.jsonl')) continue;
      const stem = e.name.replace(/\.jsonl$/, '');
      const meta = await parseClaudeCodeSessionMetadata(path.join(spawnDir, e.name), e.name).catch(() => null);
      let agentMeta = null;
      try {
        agentMeta = JSON.parse(await fsp.readFile(path.join(spawnDir, stem + '.meta.json'), 'utf8'));
      } catch {
        /* absent or corrupt meta.json */
      }
      children.push({
        name: stem,
        file: e.name,
        title: meta?.title || null,
        timestamp: meta?.timestamp || null,
        lastActivity: meta?.lastActivity || null,
        messageCount: meta?.messageCount || 0,
        toolCallCount: meta?.toolCallCount || 0,
        agentType: agentMeta?.agentType || null,
        description: agentMeta?.description || null,
      });
    }
    children.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
    return children;
  },
  // 无 spawn 目录返回 null（路由 → 'No subagents for this session'）；子文件缺失抛 ENOENT。
  getChild: async (dir, sessionId, name) => {
    const spawnDir = await findClaudeSpawnDir(dir, sessionId);
    if (!spawnDir) return null;
    return parseClaudeCodeSessionFile(path.join(spawnDir, name + '.jsonl'));
  },
  collectFiles: async (dir, opts = {}) => {
    const files = [];
    // Claude Code sessions live at <dir>/<project-slug>/*.jsonl
    const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(dir, p.name);
      const entries = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(projDir, f.name), file: f.name, sessionId: f.name.replace(/\.jsonl$/, '') });
        }
      }
      if (opts.subagents === false) continue;
      const subDir = path.join(projDir, 'subagents');
      const subEntries = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
      for (const f of subEntries) {
        if (f.isFile() && f.name.endsWith('.jsonl')) {
          files.push({ path: path.join(subDir, f.name), file: f.name, sessionId: f.name.replace(/\.jsonl$/, '') });
        }
      }
    }
    return files;
  },
  watchParse: (rec) => {
    const normalized = normalizeClaudeCodeRecord(rec);
    return normalized ? { messages: [normalized] } : null;
  },
};
