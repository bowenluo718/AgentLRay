'use strict';
// 内置平台 hermes 适配器（P1 从 lib/platforms/index.js 逐字搬迁 + 声明字段）。
// 不 require resume.js / new.js / cli-bins.js / index.js —— 声明内联。
const { session: HERMES_DIR, env: HERMES_DIR_ENV } = require('./dirs');
const { listHermesSessions, getHermesSession, listHermesChildren, getHermesChild, searchHermesSessions } = require('./parse');
const { computeHermesInsights } = require('./insights');
const { extractHermesPromptGroups } = require('./prompts');
const { watchHermes } = require('./watch');

module.exports = {
  id: 'hermes',
  label: 'Hermes',
  // 目录设置：数据目录 tab（settings.json ui section 的 hermesDir）。
  dirSettingKey: 'hermesDir',
  dirSettingLabel: 'Hermes 数据目录',
  dirSettingHint: 'Hermes 数据目录',
  dirParam: 'dirHermes',
  dirEnv: HERMES_DIR_ENV,
  color: '#f78166',
  // resume / create / bin 声明（与旧 RESUME_BINS / NEW_BINS / CLI_BIN_DEFAULTS 逐字对齐）。
  resume: { bin: 'hermes', args: (id) => ['--resume', id, '--yolo'] },
  create: {
    bin: 'hermes',
    // hermes：提示词走 -z/--oneshot（headless 提示词须用），无提示词回落交互式。
    args: (opts) =>
      opts && opts.message != null && String(opts.message).length > 0
        ? ['--yolo', '-z']
        : ['--yolo'],
  },
  bin: 'hermes',
  defaultDir: () => HERMES_DIR,
  // SQLite-backed: no session files to find/collect/tail; the watch route
  // has a dedicated WAL-watch branch.
  list: (dir) => listHermesSessions(dir),
  find: null,
  parse: null,
  getSession: (dir, sessionId) => getHermesSession(dir, sessionId),
  // hermes 子会话 = parent_session_id 指向主会话的独立会话记录。
  listChildren: (dir, sessionId) => listHermesChildren(dir, sessionId),
  getChild: (dir, sessionId, name) => getHermesChild(dir, sessionId, name),
  collectFiles: null,
  watchParse: null,
  // WAL 文件监听型的 SSE 尾随（SQLite 支撑，无文件可尾随）。
  watch: (req, res, ctx) => watchHermes(req, res, ctx.sessionId),
  // 搜索面：SQLite 型平台整体接管（无 collectFiles 文件枚举）。
  search: (dir, ctx) => searchHermesSessions(dir, ctx.q, ctx.maxResults),
  // Insights 面：SQLite 扫描整体接管。
  computeInsights: (dir) => computeHermesInsights(dir),
  // Prompts 面：SQLite 提示词分组整体接管。
  extractPrompts: (dir) => extractHermesPromptGroups(dir),
};
