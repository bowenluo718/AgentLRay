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
// Returns { messages, sessionMeta, ended } — sessionMeta is the last session
// record seen (if any), messages the concatenated normalized fan-out, ended the
// 最近一个声明式「会话结束标记」的回调时间戳（若本批次出现）。
function parseWatchLines(platform, lines) {
  const messages = [];
  let sessionMeta = null;
  let ended = null;
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
    if (parsed.ended) ended = parsed.ended;
    if (parsed.messages) messages.push(...parsed.messages);
  }
  return { messages, sessionMeta, ended };
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

// SSE 响应头 + send 辅助。send(event, data, id) 时多写一行 `id:`（B-1 断线补拉）：
// id 取文件字节偏移，浏览器会记住并在自动重连时回传 Last-Event-ID，服务端据此续读。
function sseInit(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable nginx buffering
  res.flushHeaders();
  return function send(eventName, data, id) {
    const idLine = id === undefined || id === null ? '' : `id: ${id}\n`;
    res.write(`${idLine}event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
  };
}

// 断线补拉起读偏移（B-1）：`?after=<bytes>` 优先，其次浏览器自动重连回传的
// Last-Event-ID 头。非法/负数 → null（按全量基线处理）。
function resumeOffset(req) {
  const raw = (req.query && req.query.after) || req.get?.('last-event-id') || req.headers?.['last-event-id'];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
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
  // 断线补拉起读偏移（B-1）：请求带 after/Last-Event-ID 时从该字节偏移续读，
  // 跳过全量基线（客户端已持有历史消息），连接后立即补发断线期间新增的消息。
  let resumeFrom = resumeOffset(req);
  // 是否真正的「续读」模式（区别于全量基线）：after=0 / 偏移失效时不算续读。
  let resuming = false;
  // 续读模式下断线期间新增的批次（在后面解析阶段赋值，连接建立后立即补发）。
  let pendingBacklog = null;
  try {
    const stat = await fsp.stat(filePath).catch(() => null);
    // 文件被轮转/截断（偏移超出当前大小）→ 偏移失效，回落全量基线。
    if (resumeFrom !== null && (!stat || resumeFrom > stat.size)) resumeFrom = null;
    // after=0 等价于从头读：与全量基线同义（否则会把整个文件当增量补发）。
    resuming = resumeFrom !== null && resumeFrom > 0;
    // readNewLines(…, start) is platform-aware (dsh zstd frames vs plain JSONL)
    // and reports the offset actually consumed — a torn trailing zstd frame
    // stays pending for the first change event.
    const { lines, newOffset } = await readNewLines(filePath, resumeFrom ?? 0);
    byteOffset = newOffset;
    // Count existing messages without sending them (client already has them)
    const { messages: existingMsgs, sessionMeta: baselineMeta, ended: baselineEnded } =
      parseWatchLines(platform, lines);
    initialMessageCount = existingMsgs.length;
    // 会话尾部证据基线（SSE 端状态推送）：全量模式用已解析批次初始化；续读模式从空基线
    // 开始（历史批次已由客户端持有，状态由后续增量与 REST 拉取收敛）。
    watchTailState = resuming ? createTailState() : watchTail(existingMsgs);
    watchLastActivityAt = resuming ? null : latestMessageTimestamp(existingMsgs);
    // 续读模式：resumeFrom 之后的行需立即作为增量补发（而不是当作基线丢弃）。
    // 会话元数据（cwd/model 等）与显式结束标记取自本段批次，避免补发时丢失。
    if (resuming) {
      if (baselineEnded) {
        noteEnded(watchTailState, baselineEnded);
        resolveAllPending(watchTailState);
      }
      if (existingMsgs.length > 0) {
        pendingBacklog = { messages: existingMsgs, sessionMeta: baselineMeta };
      }
    }
  } catch (e) {
    send('error', { error: e.message });
    return res.end();
  }

  send('connected', { messageCount: initialMessageCount, offset: byteOffset }, byteOffset);

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
      const { messages, sessionMeta, ended } = parseWatchLines(platform, lines);
      // 声明式会话结束标记（自定义关闭记录经平台 watchParse 归一化出 ended）：
      // 显式结束时即时置 stopped；同时清除未应答调用（ask 等交互工具的结果闭环），
      // 避免残留把会话误判成"待用户输入"。共享层不识别具体平台 id
      if (ended) {
        noteEnded(watchTailState, ended);
        resolveAllPending(watchTailState);
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
      // id = 本次消费到的字节偏移：客户端记录后，重连时服务端可从该处续读（B-1）。
      send('newMessages', payload, byteOffset);
      // Invalidate metadata cache so next session list refresh picks up changes
      sessionMetaCache.delete(filePath);
    } catch (e) {
      send('error', { error: e.message });
    }
  };

  // 续读补发：连接建立后立即把断线期间新增批次推给客户端。直接推送 backlog（而非再读
  // 一次文件）：读取/解析已在基线阶段完成，偏移已推进到最新，不会重复也不会漏。
  if (pendingBacklog && pendingBacklog.messages.length > 0) {
    const backlogMsgs = pendingBacklog.messages;
    const backlogMeta = pendingBacklog.sessionMeta;
    pendingBacklog = null;
    accumulateWatchTail(watchTailState, backlogMsgs);
    const backlogLast = latestMessageTimestamp(backlogMsgs);
    if (backlogLast && (!watchLastActivityAt || backlogLast > watchLastActivityAt)) {
      watchLastActivityAt = backlogLast;
    }
    const status = deriveStatus(finishTail(watchTailState), { lastActivity: watchLastActivityAt }, Date.now());
    // 与全量基线同口径：session 元数据随补发批次一起给出（client 合并后不丢 cwd/model）。
    send('newMessages', { messages: backlogMsgs, session: Object.assign(backlogMeta || {}, { status }) }, byteOffset);
  }

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
