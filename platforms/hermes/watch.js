'use strict';
// 平台专属 hermes 实时 SSE 尾随（从 lib/platforms/watch-impl.js 抽出）。
// WAL 文件监听型 SSE（SQLite 支撑，adapter 的 watch hook 包装此函数）。
const fs = require('fs');
const { HERMES_DIR, resolveDir } = require('@agentlray/shared/config');
const { getHermesDbPath, openHermesDbForWatch, normalizeHermesMessage } = require('./parse');
const { sseInit } = require('@agentlray/shared/watch');

// Hermes: WAL file watch-based SSE against the SQLite db
function watchHermes(req, res, sessionId) {
  const send = sseInit(res);

  const hermesDir = resolveDir(req.query.dir, HERMES_DIR);
  const dbPath = getHermesDbPath(hermesDir);
  const walPath = dbPath + '-wal';

  // Keep one persistent read-only connection
  let db = null;
  let lastTimestamp = 0;
  try {
    if (fs.existsSync(dbPath)) {
      db = openHermesDbForWatch(dbPath);
      const row = db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId);
      send('connected', { messageCount: row ? row.cnt : 0 });
      const lastMsg = db.prepare('SELECT MAX(timestamp) as ts FROM messages WHERE session_id = ?').get(sessionId);
      lastTimestamp = lastMsg?.ts || 0;
    } else {
      send('connected', { messageCount: 0 });
    }
  } catch (e) {
    send('error', { error: e.message });
  }

  const newMsgStmt = db
    ? db.prepare('SELECT * FROM messages WHERE session_id = ? AND timestamp > ? ORDER BY timestamp ASC')
    : null;

  function checkNewMessages() {
    if (!db || !newMsgStmt) return;
    try {
      const newRows = newMsgStmt.all(sessionId, lastTimestamp);
      if (newRows.length > 0) {
        lastTimestamp = newRows[newRows.length - 1].timestamp;
        const newMsgs = newRows.map(normalizeHermesMessage).filter(Boolean);
        if (newMsgs.length > 0) {
          send('newMessages', { messages: newMsgs });
        }
      }
    } catch (e) {
      send('error', { error: e.message });
    }
  }

  // Watch WAL file for changes (Hermes writes trigger WAL updates)
  let closed = false;
  let debounceTimer = null;
  let watcher = null;
  try {
    watcher = fs.watch(walPath, (eventType) => {
      if (eventType === 'change') {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(checkNewMessages, 50);
      }
    });
  } catch {
    // WAL file may not exist yet — watch dbPath as fallback
    try {
      watcher = fs.watch(dbPath, (eventType) => {
        if (eventType === 'change') {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(checkNewMessages, 50);
        }
      });
    } catch {}
  }

  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(pingTimer);
    if (watcher)
      try {
        watcher.close();
      } catch {}
    if (db) {
      try {
        db.close();
      } catch {}
      db = null;
    }
  });
}

module.exports = { watchHermes };
