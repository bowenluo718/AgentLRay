'use strict';
// 内置平台 codex 适配器（P1 从 lib/platforms/index.js 逐字搬迁 + 声明字段）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const fsp = require('fs/promises');
const path = require('path');
const { session: CODEX_DIR, env: CODEX_DIR_ENV } = require('./dirs');
const {
  codexSessionIdFromFile,
  findCodexSessionFile,
  listCodexSessions,
  normalizeCodexRecord,
  parseCodexSessionFile,
} = require('./parse');
const { fileBasedGetSession } = require('@agentlray/shared/helpers');
const { extractCodexPrompts } = require('./prompts');
const { codexRawToolEntries } = require('./inspect');

module.exports = {
  id: 'codex',
  label: 'Codex',
  // 目录设置：数据目录 tab（settings.json ui section 的 codexDir）。
  dirSettingKey: 'codexDir',
  dirSettingLabel: 'Codex 会话目录',
  dirSettingHint: 'Codex 会话日志目录',
  dirParam: 'dirCodex',
  dirEnv: CODEX_DIR_ENV,
  color: '#58a6ff',
  // resume / create / bin 声明（与旧 RESUME_BINS / NEW_BINS / CLI_BIN_DEFAULTS 逐字对齐）。
  resume: { bin: 'codex', args: (id) => ['resume', id, '--yolo'] },
  create: { bin: 'codex', args: () => ['exec', '--full-auto'] },
  bin: 'codex',
  defaultDir: () => CODEX_DIR,
  list: listCodexSessions,
  find: findCodexSessionFile,
  parse: parseCodexSessionFile,
  getSession: fileBasedGetSession(findCodexSessionFile, parseCodexSessionFile),
  collectFiles: async (dir) => {
    const files = [];
    // Codex sessions live at <dir>/YYYY/MM/DD/rollout-*.jsonl
    const years = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const y of years) {
      if (!y.isDirectory()) continue;
      const months = await fsp.readdir(path.join(dir, y.name), { withFileTypes: true }).catch(() => []);
      for (const m of months) {
        if (!m.isDirectory()) continue;
        const days = await fsp.readdir(path.join(dir, y.name, m.name), { withFileTypes: true }).catch(() => []);
        for (const d of days) {
          if (!d.isDirectory()) continue;
          const dirPath = path.join(dir, y.name, m.name, d.name);
          const entries = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
          for (const f of entries) {
            if (f.isFile() && f.name.endsWith('.jsonl')) {
              // Session ids are the trailing UUID, not the full rollout-* stem
              const uuid = f.name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
              files.push({
                path: path.join(dirPath, f.name),
                file: f.name,
                sessionId: uuid ? uuid[1] : codexSessionIdFromFile(f.name),
              });
            }
          }
        }
      }
    }
    return files;
  },
  watchParse: (rec) => {
    const normalized = normalizeCodexRecord(rec);
    return normalized ? { messages: [normalized] } : null;
  },
  // Prompts 面：codex rollout 记录格式专用提取器。
  extractPromptsFromFile: (filePath) => extractCodexPrompts(filePath),
  // 离线 inspect 面：仅 response_item 参与规范化。
  inspect: {
    normalize: (record) => (record.type === 'response_item' ? normalizeCodexRecord(record) : null),
    rawToolEntries: codexRawToolEntries,
    adapterFiles: ['builtin/codex/index.js', 'builtin/codex/parse.js', 'builtin/codex/inspect.js'],
  },
};
