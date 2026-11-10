'use strict';
// 内置平台 gemini 适配器（从 lib/platforms/builtin/gemini.js 迁移，扁平 → builtin/gemini/）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const fsp = require('fs/promises');
const path = require('path');
const { session: GEMINI_DIR, env: GEMINI_DIR_ENV } = require('./dirs');
const {
  findGeminiSessionFile,
  readGeminiMetadataLine,
  listGeminiSessions,
  normalizeGeminiRecord,
  parseGeminiSessionFile,
  listGeminiChildren,
  getGeminiChild,
} = require('./parse');
const { fileBasedGetSession } = require('@agentlray/shared/helpers');
const { searchGeminiFile } = require('./search');
const { extractGeminiPrompts } = require('./prompts');

module.exports = {
  id: 'gemini',
  label: 'Gemini CLI',
  // 目录设置：数据目录 tab（settings.json ui section 的 geminiDir）。
  dirSettingKey: 'geminiDir',
  dirSettingLabel: 'Gemini CLI 临时目录',
  dirSettingHint: 'Gemini CLI 项目临时目录',
  dirParam: 'dirGemini',
  dirEnv: GEMINI_DIR_ENV,
  color: '#4285f4',
  // resume / create / bin 声明（与旧 RESUME_BINS / NEW_BINS / CLI_BIN_DEFAULTS 逐字对齐）。
  resume: { bin: 'gemini', args: (id) => ['-r', id, '--approval-mode=yolo'] },
  create: { bin: 'gemini', args: () => ['-p', '--approval-mode=yolo'] },
  bin: 'gemini',
  defaultDir: () => GEMINI_DIR,
  list: listGeminiSessions,
  find: findGeminiSessionFile,
  parse: parseGeminiSessionFile,
  getSession: fileBasedGetSession(findGeminiSessionFile, parseGeminiSessionFile),
  // Gemini 子会话：chats/<sessionId>/ 下的 .jsonl 文件（与 omp/claude-code 同形）。
  listChildren: (dir, sessionId) => listGeminiChildren(dir, sessionId),
  getChild: (dir, sessionId, name) => getGeminiChild(dir, sessionId, name),
  collectFiles: async (dir, opts = {}) => {
    const files = [];
    // gemini sessions live at <dir>/<projectHash>/chats/session-*.jsonl
    const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const p of projects) {
      if (!p.isDirectory()) continue;
      const chatsDir = path.join(dir, p.name, 'chats');
      const entries = await fsp.readdir(chatsDir, { withFileTypes: true }).catch(() => []);
      for (const f of entries) {
        if (f.isFile() && /^session-.*\.jsonl$/.test(f.name)) {
          const filePath = path.join(chatsDir, f.name);
          const stem = f.name.replace(/\.jsonl$/, '');
          let sessionId = stem;
          if (opts.resolveIds !== false) {
            const meta = await readGeminiMetadataLine(filePath);
            sessionId = (meta && meta.sessionId) || stem;
          }
          files.push({ path: filePath, file: f.name, sessionId });
        }
      }
    }
    return files;
  },
  watchParse: (rec) => {
    // Appended records carry an id; a re-appended id supersedes the
    // earlier one, which the client-side reload handles. Metadata lines
    // ({sessionId, …}) and $set/$rewindTo folds carry no new messages.
    if (typeof rec.id === 'string') {
      const normalized = normalizeGeminiRecord(rec);
      return normalized.length ? { messages: normalized } : null;
    }
    if (typeof rec.sessionId === 'string') {
      return { session: { id: rec.sessionId, cwd: null, timestamp: rec.startTime || null } };
    }
    return null;
  },
  // 搜索面：gemini 记录需先 fold（$set/$rewindTo 合并）再匹配。
  searchFile: (sf, keywords) => searchGeminiFile(sf, keywords),
  // Prompts 面：gemini fold 后提取。
  extractPromptsFromFile: (filePath) => extractGeminiPrompts(filePath),
};
