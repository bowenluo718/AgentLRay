const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { session: OMP_DIR } = require('./dirs');
const { ompOutcome } = require('./outcome');
const { withMetadataCache, makeMessage, topToolsOf, captureLastMessage } = require('@agentlray/shared/helpers');
const {
  createTailState,
  noteAssistant,
  notePrompt,
  noteEndTurn,
  noteEnded,
  addPending,
  resolvePending,
  resolveAllPending,
  finishTail,
  fileMtimeMs,
} = require('@agentlray/shared/tail-state');
const { sortSessionsByStatusGroups } = require('@agentlray/shared/status');

function ompSessionIdFromFile(fileName) {
  // 2026-07-27T09-38-24-417Z_019fa2f0-9821-7000-b125-0afafe16410a.jsonl
  const base = fileName.replace(/\.jsonl$/, '');
  const idx = base.indexOf('_');
  return idx >= 0 ? base.slice(idx + 1) : base;
}

async function findOmpSessionFile(baseDir, sessionId) {
  const dir = baseDir || OMP_DIR;
  // Files live one level deep: {dir}/{cwd-slug}/{timestamp}_{uuid}.jsonl
  const slugs = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const s of slugs) {
    if (!s.isDirectory()) continue;
    const slugDir = path.join(dir, s.name);
    const files = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base.endsWith('_' + sessionId) || base === sessionId) {
        return path.join(slugDir, f.name);
      }
    }
  }
  return null;
}

// Returns the real human prompt text from an OMP user message, or null for
// injected noise (<system-notice>, command echoes) and empty content
function extractOmpUserPromptText(msg) {
  if (msg.attribution && msg.attribution !== 'user') return null;
  // user content 可能为数组块或纯字符串——字符串直接取，否则会因 Array.isArray
  // 为 false 而把纯文本提示词丢光（与 claude-code/codex/openclaw 口径一致）。
  const content = Array.isArray(msg.content) ? msg.content : [];
  const raw =
    typeof msg.content === 'string'
      ? msg.content
      : content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ');
  const text = raw.trim();
  if (!text) return null;
  if (text.startsWith('<attachment>')) return extractOmpAttachmentTask(text);
  if (text.startsWith('<')) return null;
  return text;
}

// Orca dispatched-worker 模板：首条 user 消息是 <attachment>…</attachment>，内含
// worker CLI 说明 + 真实任务描述。提取任务描述作为标题/首消息（优先 # Task: 标题，
// 其次 # Target 段首条任务项），避免整条模板被当注入噪音丢弃。
function extractOmpAttachmentTask(text) {
  const task = /^# Task:\s*(.+)$/m.exec(text);
  if (task && task[1].trim()) return task[1].trim();
  const target = /^#{1,3} Target[^\n]*\n(.*?)(?=^#{1,3} |\Z)/ms.exec(text);
  if (target) {
    for (const line of target[1].split('\n')) {
      const s = line.trim();
      if (!s || s.startsWith('#')) continue;
      return s.startsWith('- ') ? s.slice(2).trim() : s;
    }
  }
  return null;
}

const parseOmpSessionMetadata = withMetadataCache(_parseOmpSessionMetadataRaw);

async function _parseOmpSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionMeta = null;
  let title = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
  let lastMessage = null;
  const toolNames = {};
  const tail = createTailState();
  const mtimeMs = await fileMtimeMs(filePath, fsp);

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (rec.timestamp) lastTimestamp = rec.timestamp;

      if (rec.type === 'session' && !sessionMeta) {
        sessionMeta = {
          id: rec.id || ompSessionIdFromFile(fileName),
          timestamp: rec.timestamp || null,
          cwd: rec.cwd || null,
        };
        continue;
      }

      if ((rec.type === 'title' || rec.type === 'title_change') && rec.title) {
        title = rec.title;
        continue;
      }

      // 会话级关闭标记（custom 记录），非回合结束。
      // omp 的 ask 等交互工具结果闭环也是 session_exit（parent 指向其 tool_execution_start）：
      // 在此一并清除全部未应答调用，避免已结束的 ask 残留 pending 把会话误判成"待用户输入"。
      if (rec.type === 'custom' && rec.customType === 'session_exit' && rec.timestamp) {
        noteEnded(tail, rec.timestamp);
        resolveAllPending(tail);
        continue;
      }

      if (rec.type !== 'message') continue;
      messageCount++;
      const msg = rec.message || {};
      if (msg.role === 'user') {
        userCount++;
        const text = extractOmpUserPromptText(msg);
        if (text) {
          if (!firstUserMessage) firstUserMessage = text;
          lastMessage = captureLastMessage(lastMessage, 'user', text);
          // 只把"真实用户 prompt"记为最后 prompt（工具回执/注入噪音不算）。
          notePrompt(tail, rec.timestamp);
        }
      } else if (msg.role === 'assistant') {
        assistantCount++;
        noteAssistant(tail, rec.timestamp);
        const content = Array.isArray(msg.content) ? msg.content : [];
        const assistantText = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join('\n');
        lastMessage = captureLastMessage(lastMessage, 'assistant', assistantText);
        for (const c of content) {
          if (c.type === 'toolCall') {
            toolCallCount++;
            const name = c.name || 'unknown';
            toolNames[name] = (toolNames[name] || 0) + 1;
            addPending(tail, c.id, rec.timestamp, c.name);
          }
        }
        // stopReason==='stop'/'aborted' 表示回合完成；'toolUse' 是工具调用中，不算回合结束。
        if (msg.stopReason === 'stop' || msg.stopReason === 'aborted') {
          noteEndTurn(tail, rec.timestamp);
        }
      } else if (msg.role === 'toolResult') {
        toolResultCount++;
        resolvePending(tail, msg.toolCallId);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = topToolsOf(toolNames);

  return {
    id: sessionMeta?.id || ompSessionIdFromFile(fileName),
    timestamp: sessionMeta?.timestamp || null,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    lastMessage,
    title: title || firstUserMessage || null,
    cwd: sessionMeta?.cwd || null,
    tail: finishTail(tail),
    mtimeMs,
    file: fileName,
  };
}

async function listOmpSessions(baseDir) {
  const dir = baseDir || OMP_DIR;
  const sessions = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  for (const s of entries) {
    if (!s.isDirectory()) continue;
    const slugDir = path.join(dir, s.name);
    const files = await fsp.readdir(slugDir, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const filePath = path.join(slugDir, f.name);
      sessions.push(
        (async () => {
          const meta = await parseOmpSessionMetadata(filePath, f.name);
          // OMP 子会话目录：会话文件去掉 .jsonl 后缀的同名目录（见 findOmpSpawnDir）。
          const spawnDir = filePath.replace(/\.jsonl$/, '');
          let childrenCount = 0;
          try {
            const subEntries = await fsp.readdir(spawnDir, { withFileTypes: true });
            childrenCount = subEntries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).length;
          } catch {
            /* 无子会话目录 */
          }
          meta.childrenCount = childrenCount;
          return meta;
        })()
      );
    }
  }

  const resolved = await Promise.all(sessions);
  return sortSessionsByStatusGroups(resolved, { nowMs: Date.now(), sortBy: 'timestamp' });
}

// Maps one OMP record to an array of normalized messages (an assistant record
// fans out into reasoning / text / toolCall entries, codex-style), or null for
// metadata records (title, session, model_change, custom, custom_message,
// ttsr_injection, thinking_level_change)
function normalizeOmpRecord(rec) {
  if (rec.type !== 'message') return null;
  const msg = rec.message || {};
  const content = Array.isArray(msg.content) ? msg.content : [];

  if (msg.role === 'user') {
    return [
      makeMessage({
        id: rec.id || null,
        timestamp: rec.timestamp || null,
        role: 'user',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
      }),
    ];
  }

  if (msg.role === 'assistant') {
    const messages = [];
    const thinkingText = content
      .filter((c) => c.type === 'thinking')
      .map((c) => c.thinking || '')
      .join('\n\n')
      .trim();
    if (thinkingText) {
      messages.push(
        makeMessage({
          timestamp: rec.timestamp || null,
          role: 'reasoning',
          content: [{ type: 'text', text: thinkingText }],
        })
      );
    }
    messages.push(
      makeMessage({
        id: rec.id || null,
        timestamp: rec.timestamp || null,
        role: 'assistant',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        usage: msg.usage || null,
        model: msg.model || null,
        provider: msg.provider || null,
      })
    );
    for (const c of content) {
      if (c.type !== 'toolCall') continue;
      messages.push(
        makeMessage({
          id: c.id || null,
          timestamp: rec.timestamp || null,
          role: 'toolCall',
          toolCallId: c.id || null,
          toolName: c.name || null,
          details: c.arguments || null,
        })
      );
    }
    return messages;
  }

  if (msg.role === 'toolResult') {
    return [
      makeMessage({
        id: rec.id || null,
        timestamp: rec.timestamp || null,
        role: 'toolResult',
        content: content.filter((c) => c.type === 'text').map((c) => ({ type: 'text', text: c.text || '' })),
        toolCallId: msg.toolCallId || null,
        toolName: msg.toolName || null,
        details: msg.details || null,
        isError: Boolean(msg.isError),
        ompOutcome: ompOutcome(msg),
      }),
    ];
  }

  return null;
}

async function parseOmpSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
  let model = null;
  const messages = [];

  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      if (rec.type === 'session') {
        session = {
          id: rec.id || null,
          cwd: rec.cwd || null,
          timestamp: rec.timestamp || null,
          version: rec.version || null,
          model: null,
        };
      } else if (rec.type === 'model_change') {
        if (rec.model) model = rec.model;
      } else if (rec.type === 'message') {
        if (rec.message && rec.message.model) model = rec.message.model;
        const msgs = normalizeOmpRecord(rec);
        if (msgs) messages.push(...msgs);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (session) session.model = model;
  return { session, messages };
}

// OMP subagents: a session that spawns children keeps them as
// <slug>/<timestamp>_<sessionId>/<AgentName>.jsonl next to its own file.
async function findOmpSpawnDir(baseDir, sessionId) {
  const filePath = await findOmpSessionFile(baseDir, sessionId);
  if (!filePath) return null;
  const spawnDir = filePath.replace(/\.jsonl$/, '');
  try {
    const st = await fsp.stat(spawnDir);
    return st.isDirectory() ? spawnDir : null;
  } catch {
    return null;
  }
}

module.exports = {
  ompSessionIdFromFile,
  findOmpSessionFile,
  extractOmpUserPromptText,
  parseOmpSessionMetadata,
  listOmpSessions,
  normalizeOmpRecord,
  parseOmpSessionFile,
  findOmpSpawnDir,
};
