'use strict';
const fsp = require('fs/promises');
const path = require('path');
const { session: DSH_DIR } = require('./dirs');
const { withMetadataCache, makeMessage, topToolsOf, captureLastMessage } = require('@agentlray/shared/helpers');
const {
  createTailState,
  noteAssistant,
  notePrompt,
  noteEndTurn,
  addPending,
  resolvePending,
  finishTail,
  fileMtimeMs,
} = require('@agentlray/shared/tail-state');
const { scanZstdFrames, decompressDshLog, readDshSessionLines } = require('@agentlray/shared/zstd');
const { sortSessionsByStatusGroups } = require('@agentlray/shared/status');

// --- DeepSeek Harness (dsh) platform adapter ---
// Sessions live at <root>/<projectKey>/<sessionId>/<log>, root defaulting to
// ~/.dsh/sessions. The durable log is persisted as a versioned file and the
// harness bumps the format version (and the file name) over time:
//   session.jsonl[.zstd]    → format version 0 (legacy)
//   session.v3.jsonl[.zstd] → format version 3
//   session.v4.jsonl[.zstd] → format version 4 (current)
// A session dir may retain several of these (older files are frozen); the
// current durable log is the highest version present — that is the file we
// read. The plain/compressed twin follows the session compression setting
// (compression:'none' keeps session.jsonl, the default writes .zstd).
//
// The log is a JSONL event stream: line 1 is a header record
// ({type:'session', version, id, createdAt, cwd, origin?, …}), every other
// line is a SessionEvent envelope ({type, seq, time, data, surfaceOp?}) or a
// packed chunk row (text-chunks / reasoning-chunks / tool-call-chunks).
// Versions 0/3/4 share the same envelope and message shapes for the events we
// consume (user/message, assistant/message, tool/call, tool/result,
// turn/end); later versions add event types we ignore rather than reshape
// existing ones. Unsupported versions are rejected loudly.
//
// zstd caveat: the compressed artifact is a CONCATENATION of independent
// Zstandard frames (one for the header, one per durable append batch), and
// Node's zstdDecompressSync only reads the FIRST frame. We scan frame
// boundaries (RFC 8878 structure, no block decoding) and decompress each
// frame separately. A truncated trailing frame (crash residue) is tolerated
// and dropped. The scan/decompress/read helpers live in
// ../../shared/zstd.

// Format versions whose envelope + message shapes match what we parse. The
// harness bumped 0 → 3 → 4 while keeping these events structurally identical;
// later versions are rejected loudly rather than rendered as partial data.
const SUPPORTED_SESSION_FORMAT_VERSIONS = new Set([0, 3, 4]);
const SURFACE_EVENT_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);
const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks']);

function msToIso(ms) {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function parseDshHeader(line) {
  let header;
  try {
    header = JSON.parse(line);
  } catch {
    return null;
  }
  if (!header || header.type !== 'session') return null;
  if (!SUPPORTED_SESSION_FORMAT_VERSIONS.has(header.version)) {
    throw new Error(
      `Unsupported dsh session format version ${header.version} (this AgentLRay build reads versions ${[...SUPPORTED_SESSION_FORMAT_VERSIONS].join('/')})`
    );
  }
  return header;
}

// Rank a session-dir file name as a dsh durable-log format version:
// session.jsonl[.zstd] → 0, session.v<N>.jsonl[.zstd] → N, anything else → -1.
function dshLogFileVersion(name) {
  const m = /^session\.v(\d+)\.jsonl(?:\.zstd)?$/.exec(name);
  if (m) return Number(m[1]);
  if (name === 'session.jsonl' || name === 'session.jsonl.zstd') return 0;
  return -1;
}

// The current durable log in a session dir: the highest format version among
// its log files (a dir may keep frozen legacy files next to the live one).
// Returns the file name or null. Callers scan one session dir at a time.
function chooseDshLogFile(files) {
  let best = null;
  let bestVersion = -1;
  for (const f of files) {
    if (!f.isFile()) continue;
    const v = dshLogFileVersion(f.name);
    if (v > bestVersion) {
      bestVersion = v;
      best = f.name;
    }
  }
  return best;
}

async function findDshSessionFile(baseDir, sessionId) {
  const dir = baseDir || DSH_DIR;
  const projects = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const sessionDir = path.join(dir, p.name, sessionId);
    const entries = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
    const logFile = chooseDshLogFile(entries);
    if (logFile) return path.join(sessionDir, logFile);
  }
  return null;
}

// Real human prompt text from a user/message event's data, or null for
// non-user injections (hooks, spliced inbox items) and empty content.
function extractDshUserPromptText(data) {
  if (!data || (data.source && data.source.kind && data.source.kind !== 'user')) return null;
  const content = Array.isArray(data.content) ? data.content : [];
  const text = content
    .filter((c) => c.type === 'text')
    .map((c) => c.text || '')
    .join(' ')
    .trim();
  if (!text) return null;
  if (text.startsWith('<')) return null;
  return text;
}

function tryParseJson(value) {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function flattenToolResultContent(blocks) {
  const parts = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'tool-result') {
      for (const inner of Array.isArray(block.content) ? block.content : []) {
        if (inner.type === 'text') parts.push({ type: 'text', text: inner.text || '' });
      }
    }
  }
  return parts;
}

// 从工具结果事件里解析出对应的原始 tool call id（source.callId 或
// tool-result 块自身携带的 toolCallId），用于配对 addPending/resolvePending。
function toolResultCallId(data) {
  const message = data.message || {};
  const blocks = Array.isArray(message.content) ? message.content : [];
  return (
    (message.source && message.source.callId) ||
    (blocks.find((b) => b.type === 'tool-result') || {}).toolCallId ||
    null
  );
}

// Maps one dsh session event to an array of normalized messages (an
// assistant/message fans out into reasoning / text entries, codex-style;
// tool calls are emitted from the dedicated tool/call events), or null for
// trace/boundary records. `toolNamesByCallId` pairs tool/result rows with the
// real tool name.
function normalizeDshEvent(event, toolNamesByCallId) {
  const timestamp = msToIso(event.time);
  const data = event.data || {};

  if (event.type === 'user/message') {
    const content = Array.isArray(data.content) ? data.content : [];
    return [
      makeMessage({
        id: data.id || null,
        timestamp,
        role: 'user',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
      }),
    ];
  }

  if (event.type === 'assistant/message') {
    const message = data.message || {};
    const content = Array.isArray(message.content) ? message.content : [];
    if (content.length === 0) return null; // known-empty stream: derives to no message
    const source = message.source || {};
    const messages = [];
    const reasoningText = content
      .filter((c) => c.type === 'reasoning')
      .map((c) => c.text || '')
      .join('\n\n')
      .trim();
    if (reasoningText) {
      messages.push(
        makeMessage({
          timestamp,
          role: 'reasoning',
          content: [{ type: 'text', text: reasoningText }],
        })
      );
    }
    const usage = data.usage
      ? {
          input: data.usage.inputTokens || 0,
          output: data.usage.outputTokens || 0,
          cacheRead: data.usage.cacheReadTokens || 0,
          reasoning: data.usage.reasoningTokens || 0,
        }
      : null;
    messages.push(
      makeMessage({
        id: message.id || null,
        timestamp,
        role: 'assistant',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        usage,
        model: source.model || null,
        provider: source.provider || null,
      })
    );
    // tool-call blocks are intentionally skipped: the paired tool/call events
    // that follow carry the same callId/name/arguments and render as
    // standalone toolCall records (codex/omp style).
    return messages;
  }

  if (event.type === 'tool/call') {
    if (data.callId && data.name) toolNamesByCallId.set(data.callId, data.name);
    return [
      makeMessage({
        id: data.callId || null,
        timestamp,
        role: 'toolCall',
        toolCallId: data.callId || null,
        toolName: data.name || null,
        details: tryParseJson(data.arguments),
      }),
    ];
  }

  if (event.type === 'tool/result') {
    const message = data.message || {};
    const blocks = Array.isArray(message.content) ? message.content : [];
    const callId = toolResultCallId(data);
    const isError = Boolean(data.error) || blocks.some((b) => b.type === 'tool-result' && b.isError);
    return [
      makeMessage({
        id: message.id || null,
        timestamp,
        role: 'toolResult',
        content: flattenToolResultContent(blocks),
        toolCallId: callId,
        toolName: (callId && toolNamesByCallId.get(callId)) || null,
        details: data.error ? { error: data.error.name || 'error', code: data.error.code ?? null } : null,
        isError,
      }),
    ];
  }

  if (event.type === 'turn/end') {
    const kind = data.reason && data.reason.kind;
    if (kind && kind !== 'completed') {
      return [
        makeMessage({
          timestamp,
          role: 'error',
          content: [{ type: 'text', text: `Turn ${data.turn ?? '?'} ended without completing: ${kind}` }],
          toolName: `turn ${kind}`,
          isError: true,
        }),
      ];
    }
    return null;
  }

  // Chunks, boundaries, packed rows and log-only events derive to no message.
  return null;
}

// Parse event lines (header excluded) into the normalized message list,
// honoring compaction: a surface event with surfaceOp {op:'replace',start,end}
// masks the surface positions [start, end) — masked messages are dropped so
// compacted content never renders twice.
function normalizeDshEvents(lines) {
  const toolNamesByCallId = new Map();
  const items = []; // { surfaceIndex: number|null, messages, compacted? }
  let surfaceCount = 0;

  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event.type !== 'string') continue;
    if (event.type === 'session' || CHUNK_ROW_TYPES.has(event.type)) continue;

    let surfaceIndex = null;
    if (SURFACE_EVENT_TYPES.has(event.type)) {
      const op = event.surfaceOp;
      if (op && typeof op === 'object' && op.op === 'replace') {
        for (const item of items) {
          if (item.surfaceIndex !== null && item.surfaceIndex >= op.start && item.surfaceIndex < op.end) {
            item.compacted = true;
          }
        }
        surfaceIndex = op.start;
        surfaceCount = op.start + 1;
      } else {
        surfaceIndex = surfaceCount++;
      }
    }

    const messages = normalizeDshEvent(event, toolNamesByCallId);
    if (messages && messages.length) items.push({ surfaceIndex, messages });
  }

  const out = [];
  for (const item of items) {
    if (!item.compacted) out.push(...item.messages);
  }
  return out;
}

const parseDshSessionMetadata = withMetadataCache(_parseDshSessionMetadataRaw);

async function _parseDshSessionMetadataRaw(filePath, fileName, sessionDirName) {
  let header = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimeMs = null;
  let firstUserMessage = null;
  let lastMessage = null;
  let parseError = null;
  const toolNames = {};
  const tokens = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
  const tail = createTailState();
  const mtimeMs = await fileMtimeMs(filePath, fsp);

  let lines = [];
  try {
    lines = await readDshSessionLines(filePath);
  } catch (error) {
    parseError = error.message;
  }

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session' && !header) {
      try {
        header = parseDshHeader(line);
      } catch (error) {
        parseError = error.message;
      }
      continue;
    }
    if (typeof rec.time === 'number' && (lastTimeMs === null || rec.time > lastTimeMs)) lastTimeMs = rec.time;

    const data = rec.data || {};
    if (rec.type === 'user/message') {
      messageCount++;
      userCount++;
      const text = extractDshUserPromptText(data);
      if (text) {
        if (!firstUserMessage) firstUserMessage = text;
        lastMessage = captureLastMessage(lastMessage, 'user', text);
        // 只把"真实用户 prompt"记为最后 prompt（spliced inbox / hook 注入、空内容不算）。
        notePrompt(tail, msToIso(rec.time));
      }
    } else if (rec.type === 'assistant/message') {
      messageCount++;
      assistantCount++;
      noteAssistant(tail, msToIso(rec.time));
      const amessage = data.message || {};
      const atext = (Array.isArray(amessage.content) ? amessage.content : [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text || '')
        .join('\n');
      lastMessage = captureLastMessage(lastMessage, 'assistant', atext);
      if (data.usage) {
        tokens.input += data.usage.inputTokens || 0;
        tokens.output += data.usage.outputTokens || 0;
        tokens.cacheRead += data.usage.cacheReadTokens || 0;
        tokens.reasoning += data.usage.reasoningTokens || 0;
      }
    } else if (rec.type === 'tool/call') {
      toolCallCount++;
      const name = data.name || 'unknown';
      toolNames[name] = (toolNames[name] || 0) + 1;
      addPending(tail, data.callId, msToIso(rec.time), name);
    } else if (rec.type === 'tool/result') {
      toolResultCount++;
      resolvePending(tail, toolResultCallId(data));
    } else if (rec.type === 'turn/end') {
      // 回合级结束标记（非会话关闭）：completed / aborted / … 都标志该回合收官。
      noteEndTurn(tail, msToIso(rec.time));
    }
  }

  const topTools = topToolsOf(toolNames);

  return {
    id: header?.id || sessionDirName,
    timestamp: msToIso(header?.createdAt) || null,
    lastActivity: msToIso(lastTimeMs),
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    lastMessage,
    title: firstUserMessage || null,
    cwd: header?.cwd || null,
    origin: header?.origin || null,
    tokens,
    tail: finishTail(tail),
    mtimeMs,
    file: fileName,
    ...(parseError ? { error: parseError } : {}),
  };
}

async function listDshSessions(baseDir) {
  const dir = baseDir || DSH_DIR;
  const sessions = [];
  let projects;
  try {
    projects = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const projDir = path.join(dir, p.name);
    const sessionDirs = await fsp.readdir(projDir, { withFileTypes: true }).catch(() => []);
    for (const s of sessionDirs) {
      if (!s.isDirectory()) continue;
      const sessionDir = path.join(projDir, s.name);
      const files = await fsp.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
      const logFile = chooseDshLogFile(files);
      if (!logFile) continue;
      sessions.push(
        parseDshSessionMetadata(path.join(sessionDir, logFile), logFile, s.name).catch(() => null)
      );
    }
  }

  const resolved = (await Promise.all(sessions)).filter(Boolean);
  return sortSessionsByStatusGroups(resolved, { nowMs: Date.now(), sortBy: 'timestamp' });
}

async function parseDshSessionFile(filePath) {
  const lines = await readDshSessionLines(filePath);
  let session = null;
  if (lines.length > 0) {
    const header = parseDshHeader(lines[0]);
    if (header) {
      session = {
        id: header.id || null,
        cwd: header.cwd || null,
        timestamp: msToIso(header.createdAt),
        version: header.version,
        origin: header.origin || null,
        model: null,
      };
    }
  }
  const messages = normalizeDshEvents(lines.slice(session ? 1 : 0));
  if (session) {
    const modeled = messages.find((m) => m.role === 'assistant' && m.model);
    if (modeled) session.model = modeled.model;
  }
  return { session, messages };
}

module.exports = {
  dshLogFileVersion,
  chooseDshLogFile,
  findDshSessionFile,
  extractDshUserPromptText,
  parseDshSessionMetadata,
  listDshSessions,
  normalizeDshEvents,
  parseDshSessionFile,
  // zstd 格式工具已下沉 shared/zstd，此处重导出保持 parse 模块既有公开面。
  scanZstdFrames: require('@agentlray/shared/zstd').scanZstdFrames,
  decompressDshLog: require('@agentlray/shared/zstd').decompressDshLog,
  readDshSessionLines: require('@agentlray/shared/zstd').readDshSessionLines,
};
