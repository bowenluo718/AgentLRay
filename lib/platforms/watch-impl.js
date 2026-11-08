'use strict';
// 实时 SSE 尾随的实现细节（从 lib/routes/watch.js 抽出，供路由与平台 hook 共用）。
//  - sseInit：SSE 响应头 + send 辅助。
//  - watchHermes：hermes 的 WAL 文件监听 SSE（builtin/hermes.js 的 watch hook 包装此函数）。
//  - watchFile：文件型平台的字节偏移尾随（通用路由直接使用）。
const fs = require('fs');
const { HERMES_DIR, sessionMetaCache, resolveDir } = require('../config');
const { getHermesDbPath, openHermesDbForWatch, normalizeHermesMessage } = require('./hermes');
const { readNewLines, parseWatchLines, accumulateWatchTail, watchTail, latestMessageTimestamp } = require('../watch');
const { deriveStatus } = require('../status');
const { finishTail, noteEnded, resolveAllPending } = require('./tail-state');

function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  return function send(eventName, data) {
    res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

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

// File-based platforms: byte-offset tail via fs.watch
async function watchFile(req, res, platform, filePath) {
  const send = sseInit(res);

  // 实时状态所需（每条 newMessages 事件按 now 重算）
  let watchTailState = null;
  let watchLastActivityAt = null;

  // Do initial full parse to know current message count + byte offset
  let byteOffset = 0;
  let initialMessageCount = 0;
  try {
    // readNewLines(…, 0) is platform-aware (dsh zstd frames vs plain JSONL)
    // and reports the offset actually consumed — a torn trailing zstd frame
    // stays pending for the first change event.
    const { lines, newOffset } = await readNewLines(filePath, 0);
    byteOffset = newOffset;
    // Count existing messages without sending them (client already has them)
    const { messages: existingMsgs } = parseWatchLines(platform, lines);
    initialMessageCount = existingMsgs.length;
    // 会话尾部证据基线（SSE 端状态推送）：连接时全量已解析批次初始化，随后按增量累积。
    watchTailState = watchTail(existingMsgs);
    watchLastActivityAt = latestMessageTimestamp(existingMsgs);
  } catch (e) {
    send('error', { error: e.message });
    return res.end();
  }

  send('connected', { messageCount: initialMessageCount });

  // Watch for file changes
  let watcher;
  let debounceTimer = null;
  let closed = false;

  const onFileChange = async () => {
    if (closed) return;
    try {
      const { lines, newOffset } = await readNewLines(filePath, byteOffset);
      if (lines.length === 0) return;
      byteOffset = newOffset;
      const { messages, sessionMeta } = parseWatchLines(platform, lines);
      // OMP 会话级关闭标记（custom 记录不归一化出消息，需单独识别，让显式结束时即时置 stopped）
      if (platform.id === 'omp') {
        for (const line of lines) {
          let rec;
          try {
            rec = JSON.parse(line);
          } catch {
            continue;
          }
          if (rec && rec.type === 'custom' && rec.customType === 'session_exit' && rec.timestamp) {
            noteEnded(watchTailState, rec.timestamp);
            // ask 等交互工具的结果闭环：清除未应答调用，避免残留把会话误判成"待用户输入"。
            resolveAllPending(watchTailState);
          }
        }
      }
      if (messages.length > 0) accumulateWatchTail(watchTailState, messages);
      const batchLast = latestMessageTimestamp(messages);
      // lastActivity 单调不回退：跨批次时间戳倒挂时取历史最大值（避免活跃会话被瞬时误判老化）
      if (batchLast && (!watchLastActivityAt || batchLast > watchLastActivityAt)) {
        watchLastActivityAt = batchLast;
      }
      const status = deriveStatus(
        finishTail(watchTailState),
        { lastActivity: watchLastActivityAt },
        Date.now()
      );
      // 恒推 session.status：无新消息（结束/闲置标记）批次也推，让状态即时收敛；前端按需合并
      const payload = { messages };
      payload.session = Object.assign(sessionMeta || {}, { status });
      send('newMessages', payload);
      // Invalidate metadata cache so next session list refresh picks up changes
      sessionMetaCache.delete(filePath);
    } catch (e) {
      send('error', { error: e.message });
    }
  };

  try {
    watcher = fs.watch(filePath, (eventType) => {
      if (eventType === 'change') {
        // Debounce: batch rapid writes (e.g. multiple lines written close together)
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(onFileChange, 80);
      }
    });
  } catch (e) {
    send('error', { error: `Cannot watch file: ${e.message}` });
    return res.end();
  }

  // Keepalive ping every 15s to prevent proxy timeouts
  const pingTimer = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  // Cleanup on client disconnect
  req.on('close', () => {
    closed = true;
    clearTimeout(debounceTimer);
    clearInterval(pingTimer);
    if (watcher) watcher.close();
  });
}

module.exports = { sseInit, watchHermes, watchFile };
