'use strict';
// 平台专属 hermes prompts 提取器（从 lib/platforms/prompts-impl.js 抽出）。
// SQLite 提示词分组，adapter 的 extractPrompts hook 使用。
const { openHermesDb, unixToIso } = require('./parse');

function extractHermesPromptGroups(dir) {
  const db = openHermesDb(dir);
  if (!db) return [];
  try {
    const rows = db
      .prepare(`
      SELECT m.session_id, m.content, m.timestamp, s.source, s.title, s.started_at, s.ended_at
      FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.role = 'user' AND m.content IS NOT NULL AND m.content != ''
      ORDER BY m.session_id, m.rowid
    `)
      .all();

    const sessionMap = new Map();
    for (const row of rows) {
      let sess = sessionMap.get(row.session_id);
      if (!sess) {
        sess = {
          id: row.session_id,
          file: 'state.db',
          timestamp: unixToIso(row.started_at),
          lastActivity: unixToIso(row.ended_at),
          slug: null,
          title: row.title || null,
          directory: row.source || '(no directory)',
          prompts: [],
        };
        sessionMap.set(row.session_id, sess);
      }
      sess.prompts.push({ text: row.content, timestamp: unixToIso(row.timestamp) });
    }

    const groupMap = new Map();
    for (const sess of sessionMap.values()) {
      const key = sess.directory;
      if (!groupMap.has(key)) groupMap.set(key, []);
      const { directory, ...rest } = sess;
      groupMap.get(key).push({ ...rest, promptCount: sess.prompts.length });
    }
    return Array.from(groupMap.entries()).map(([directory, sessions]) => ({ directory, sessions }));
  } finally {
    db.close();
  }
}

module.exports = { extractHermesPromptGroups };
