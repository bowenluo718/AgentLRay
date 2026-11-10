'use strict';
// 内置平台 dsh 适配器（P1 从 lib/platforms/index.js 逐字搬迁 + 声明字段）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const fsp = require('fs/promises');
const path = require('path');
const { session: DSH_DIR, env: DSH_DIR_ENV } = require('./dirs');
const { findDshSessionFile, chooseDshLogFile, listDshSessions, listDshChildren, getDshChild, normalizeDshEvents, parseDshSessionFile } = require('./parse');
const { searchDshFile } = require('./search');
const { extractDshPrompts } = require('./prompts');
const { fileBasedGetSession } = require('@agentlray/shared/helpers');

module.exports = {
  id: 'dsh',
  label: 'DeepSeek Harness',
  // 目录设置：数据目录 tab（settings.json ui section 的 dshDir）。
  dirSettingKey: 'dshDir',
  dirSettingLabel: 'DeepSeek Harness 会话目录',
  dirSettingHint: 'DeepSeek Harness 会话目录（同时识别 DSH_HOME）',
  dirParam: 'dirDsh',
  dirEnv: DSH_DIR_ENV,
  color: '#4d6bfe',
  // dsh 无 resume 也无 create（交互式 TUI，无法 headless 传提示词 → 不可续跑/新建），
  // 故不声明 bin（cliBinDefaults 据此不把 dsh 列入可配置 CLI 命令）。
  defaultDir: () => DSH_DIR,
  list: listDshSessions,
  find: findDshSessionFile,
  parse: parseDshSessionFile,
  getSession: fileBasedGetSession(findDshSessionFile, parseDshSessionFile),
  // dsh 子会话 = header.parentSession 指向本会话的会话（origin:'subagent'，delegation≥1）。
  listChildren: (dir, sessionId) => listDshChildren(dir, sessionId),
  getChild: (dir, sessionId, name) => getDshChild(dir, sessionId, name),
  collectFiles: async (dir) => {
    const files = [];
    // dsh sessions live at <dir>/<projectKey>/<sessionId>/<versioned durable
    // log>; pick the highest format version present (one file per session)
    const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const projDir = path.join(dir, p.name);
      const sessionDirs = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
      for (const s of sessionDirs) {
        if (!s.isDirectory()) continue;
        const sessionDir = path.join(projDir, s.name);
        const entries = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
        const logFile = chooseDshLogFile(entries);
        if (logFile) files.push({ path: path.join(sessionDir, logFile), file: logFile, sessionId: s.name });
      }
    }
    return files;
  },
  watchParse: (rec, line) => {
    if (rec.type === 'session') {
      return {
        session: {
          id: rec.id,
          cwd: rec.cwd || null,
          timestamp: typeof rec.createdAt === 'number' ? new Date(rec.createdAt).toISOString() : null,
        },
      };
    }
    const normalized = normalizeDshEvents([line]);
    return normalized.length ? { messages: normalized } : null;
  },
  // 搜索面：dsh 日志可能 zstd 压缩且文本嵌在 event.data，用专用单文件搜索器。
  searchFile: (sf, keywords) => searchDshFile(sf, keywords),
  // Prompts 面：dsh event 格式专用提取器（支持 zstd）。
  extractPromptsFromFile: (filePath) => extractDshPrompts(filePath),
};
