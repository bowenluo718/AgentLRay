'use strict';
// 平台公共依赖 barrel（Q6/Q7/Q10/Q11 落地）。
//
// 平台无关的共享工具统一从这里导出；内置平台（builtin/<id>/）与自定义/项目平台
// 都通过裸名 `@agentlray/shared/<sub>`（由 lib/platforms/index.js 注册的
// Module._resolveFilename 钩子解析到本目录，测试环境经 setup-env.cjs 注入）。
// 共享代码不随单一平台迁移，迁移依赖通过此处清单管理
//（见 docs/.local/design-builtin-cohesion.zh-CN.md）。
//
// 各子模块对应原顶层文件：
//   helpers.js    —— 原 lib/platforms/shared.js
//   tail-state.js —— 原 lib/platforms/tail-state.js
//   contracts.js  —— 原 lib/platforms/contracts.js
//   search.js     —— search-impl 通用函数
//   insights.js   —— insights-impl 通用函数
//   backup.js     —— backup-impl 通用函数
//   inspect.js    —— inspect-impl 通用分派
//   tool-audit.js —— tool-audit-impl 通用函数
//   watch.js      —— 原 lib/watch.js 业务逻辑 + watch-impl 的 watchFile/sseInit

module.exports = {
  // helpers（原 shared.js）
  withMetadataCache: require('./helpers').withMetadataCache,
  makeMessage: require('./helpers').makeMessage,
  fileBasedGetSession: require('./helpers').fileBasedGetSession,
  sortSessionsByTimestampDesc: require('./helpers').sortSessionsByTimestampDesc,
  topToolsOf: require('./helpers').topToolsOf,
  captureLastMessage: require('./helpers').captureLastMessage,

  // tail-state
  createTailState: require('./tail-state').createTailState,
  noteAssistant: require('./tail-state').noteAssistant,
  notePrompt: require('./tail-state').notePrompt,
  noteEndTurn: require('./tail-state').noteEndTurn,
  noteEnded: require('./tail-state').noteEnded,
  addPending: require('./tail-state').addPending,
  resolvePending: require('./tail-state').resolvePending,
  resolveAllPending: require('./tail-state').resolveAllPending,
  finishTail: require('./tail-state').finishTail,
  fileMtimeMs: require('./tail-state').fileMtimeMs,

  // contracts
  hasResumeContract: require('./contracts').hasResumeContract,
  hasCreateContract: require('./contracts').hasCreateContract,
  capabilityBits: require('./contracts').capabilityBits,

  // search（通用）
  extractSnippet: require('./search').extractSnippet,
  createSessionMatcher: require('./search').createSessionMatcher,
  lineMayMatch: require('./search').lineMayMatch,
  searchJsonlFile: require('./search').searchJsonlFile,

  // insights（通用）
  iterateSessionLines: require('./insights').iterateSessionLines,
  scanFileForInsights: require('./insights').scanFileForInsights,
  buildInsightsResponse: require('./insights').buildInsightsResponse,

  // backup（通用）
  backupCopy: require('./backup').backupCopy,

  // inspect（通用分派）
  noToolEntries: require('./inspect').noToolEntries,

  // zstd 会话日志格式工具（dsh 通用）
  scanZstdFrames: require('./zstd').scanZstdFrames,
  decompressDshLog: require('./zstd').decompressDshLog,
  readDshSessionLines: require('./zstd').readDshSessionLines,

  // gemini 记录格式工具
  foldGeminiRecords: require('./gemini-format').foldGeminiRecords,
  stringifyToolResult: require('./gemini-format').stringifyToolResult,

  // hermes 会话库读取机制（hermes 与 openclaw 共享）
  getHermesDbPath: require('./hermes-db').getHermesDbPath,
  openHermesDb: require('./hermes-db').openHermesDb,
  openHermesDbForWatch: require('./hermes-db').openHermesDbForWatch,
  unixToIso: require('./hermes-db').unixToIso,

  // 框架根在共享层的别名窗口（项目/自定义平台经 @agentlray/shared/<sub> 访问，
  // 不直接依赖 lib/ 位置）
  DSH_DIR: require('./config').DSH_DIR,
  GEMINI_DIR: require('./config').GEMINI_DIR,
  HERMES_DIR: require('./config').HERMES_DIR,
  resolveDir: require('./config').resolveDir,
  sortSessionsByStatusGroups: require('./status').sortSessionsByStatusGroups,
  normalizeErrorPattern: require('./text-utils').normalizeErrorPattern,

  // tool-audit（通用）
  toolAuditEntry: require('./tool-audit').toolAuditEntry,
  scanFileForToolAudit: require('./tool-audit').scanFileForToolAudit,
  loadPersistedToolAudit: require('./tool-audit').loadPersistedToolAudit,
  savePersistedToolAudit: require('./tool-audit').savePersistedToolAudit,

  // watch（原 lib/watch.js + watch-impl 通用）
  readNewLines: require('./watch').readNewLines,
  parseWatchLines: require('./watch').parseWatchLines,
  accumulateWatchTail: require('./watch').accumulateWatchTail,
  watchTail: require('./watch').watchTail,
  latestMessageTimestamp: require('./watch').latestMessageTimestamp,
  sseInit: require('./watch').sseInit,
  watchFile: require('./watch').watchFile,
};
