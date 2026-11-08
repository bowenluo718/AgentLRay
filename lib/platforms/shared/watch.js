'use strict';
// 实时 SSE 尾随的通用实现（Q23=B：原 lib/watch.js 业务逻辑 + watch-impl 的
// sseInit/watchFile 下沉至此，消除 watch.js ⇄ watch-impl.js 循环）。
//  - readNewLines / parseWatchLines —— 字节偏移尾随 + 平台行归一化
//  - accumulateWatchTail / watchTail / latestMessageTimestamp —— 会话尾部证据状态机
//  - sseInit —— SSE 响应头 + send 辅助
//  - watchFile —— 文件型平台的字节偏移尾随（通用路由直接使用）
// 平台专属的 watchHermes（hermes WAL SSE）内聚进 platforms/hermes/watch.js。
const fs = require('fs');
const fsp = require('fs/promises');
const { sessionMetaCache } = require('../../config');
const { scanZstdFrames, decompressDshLog } = require('./zstd');
const {
  createTailState,
  noteAssistant,
  notePrompt,
  addPending,
  resolvePending,
  finishTail,
  noteEnded,
  resolveAllPending,
} = require('./tail-state');
const { deriveStatus } = require('../../status');

// ========= /api/watch business logic =========
// Byte-offset tail of a session log plus platform-aware line normalization.
// The SSE plumbing (headers, fs.watch, ping/cleanup timers) stays in the
// route; these two functions carry the state machines that need direct tests.

// Read new lines from a byte offset, returning { lines, newOffset }.
//
// Plain JSONL: only advance past the last complete line — a torn trailing
// line (the writer was mid-append when fs.watch fired) is retried on the next
// change event once its remaining bytes land.
//
// dsh zstd logs append whole zstd frames: decompress every complete new frame
// and leave a torn trailing frame for the next read (mirrors the JSONL rule).
async function readNewLines(filePath, byteOffset) {
  const stat = await fsp.stat(filePath);
  if (stat.size <= byteOffset) return { lines: [], newOffset: byteOffset };
  const buf = Buffer.alloc(stat.size - byteOffset);
  const fd = await fsp.open(filePath, 'r');
  try {
    await fd.read(buf, 0, buf.length, byteOffset);
  } finally {
    await fd.close();
  }
  if (filePath.endsWith('.zstd')) {
    const { frames } = scanZstdFrames(buf);
    const consumed = frames.length ? frames[frames.length - 1].end : 0;
    const text = decompressDshLog(buf.subarray(0, consumed));
    const lines = text.split('\n').filter((l) => l.trim());
    return { lines, newOffset: byteOffset + consumed };
  }
  const lastNewline = buf.lastIndexOf(0x0a);
  if (lastNewline === -1) return { lines: [], newOffset: byteOffset };
  const text = buf.subarray(0, lastNewline + 1).toString('utf8');
  const lines = text.split('\n').filter((l) => l.trim());
  return { lines, newOffset: byteOffset + lastNewline + 1 };
}

// Normalize raw log lines through the platform's watchParse adapter.
// Returns { messages, sessionMeta } — sessionMeta is the last session record
// seen (if any), messages the concatenated normalized fan-out.
function parseWatchLines(platform, lines) {
  const messages = [];
  let sessionMeta = null;
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = platform.watchParse(rec, line);
    if (!parsed) continue;
    if (parsed.session) sessionMeta = parsed.session;
    if (parsed.messages) messages.push(...parsed.messages);
  }
  return { messages, sessionMeta };
}

// ========= 实时会话状态（SSE newMessages 推送） =========
// 把平台归一化消息喂进会话尾部证据状态机（与列表端同一套四态口径 lib/status.js）。
// 连接时用"全量已解析批次"初始化基线，随后每个增量批次继续累积，路由层再按 now 推导
// status——避免为每次推送重新解析整个日志。
function accumulateWatchTail(tailState, messages) {
  for (const msg of messages || []) {
    const ts = msg && msg.timestamp;
    if (!ts) continue;
    const role = msg.role;
    if (role === 'toolCall') {
      // OMP/Codex 归一化约定：工具调用是独立 role 消息（assistant 活动的一部分）。
      noteAssistant(tailState, ts);
      addPending(tailState, msg.toolCallId || msg.id, ts, msg.toolName);
      continue;
    }
    if (role === 'reasoning') {
      noteAssistant(tailState, ts); // assistant 侧思考也算活动
      continue;
    }
    if (role === 'assistant') {
      noteAssistant(tailState, ts);
      const content = Array.isArray(msg.content) ? msg.content : [];
      for (const c of content) {
        if (c && (c.type === 'toolCall' || c.type === 'tool_use')) {
          addPending(tailState, c.id || c.toolCallId, ts, c.name);
        }
      }
      continue;
    }
    if (role === 'user') {
      const content = Array.isArray(msg.content) ? msg.content : [];
      const hasRealText = content.some(
        (c) => c && c.type === 'text' && typeof c.text === 'string' && c.text.trim().length > 0
      );
      if (hasRealText) notePrompt(tailState, ts);
      continue;
    }
    if (role === 'toolResult') {
      if (msg.toolCallId) resolvePending(tailState, msg.toolCallId);
    }
  }
  return tailState;
}

/** 从一批消息初始化会话尾部证据（连接时全量基线）。 */
function watchTail(messages) {
  return accumulateWatchTail(createTailState(), messages || []);
}

/** 批量内的最新活动时间（lastActivity 依据）。取最大值，数值比较免疫混合时区/毫秒格式。 */
function latestMessageTimestamp(messages) {
  let latest = null;
  let latestMs = -Infinity;
  for (const msg of messages || []) {
    const ts = msg && msg.timestamp;
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
      latest = ts;
    }
  }
  return latest;
}

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

module.exports = {
  readNewLines,
  parseWatchLines,
  accumulateWatchTail,
  watchTail,
  latestMessageTimestamp,
  sseInit,
  watchFile,
};
