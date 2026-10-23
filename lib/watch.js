const fsp = require('fs/promises');
const { scanZstdFrames, decompressDshLog } = require('./platforms/dsh');
const {
  createTailState,
  noteAssistant,
  notePrompt,
  addPending,
  resolvePending,
  finishTail,
} = require('./platforms/tail-state');

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
      addPending(tailState, msg.toolCallId || msg.id, ts);
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
          addPending(tailState, c.id || c.toolCallId, ts);
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

module.exports = {
  readNewLines,
  parseWatchLines,
  accumulateWatchTail,
  watchTail,
  latestMessageTimestamp,
};
