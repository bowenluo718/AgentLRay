const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { CLAUDE_CODE_DIR } = require('../config');
const { withMetadataCache, makeMessage, topToolsOf } = require('./shared');
const {
  createTailState,
  noteAssistant,
  notePrompt,
  noteEndTurn,
  addPending,
  resolvePending,
  finishTail,
  fileMtimeMs,
} = require('./tail-state');
const { sortSessionsByStatusGroups } = require('../status');

async function listClaudeCodeProjects(baseDir) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

async function findClaudeCodeSessionFile(baseDir, sessionId) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  const projects = await listClaudeCodeProjects(dir);
  for (const project of projects) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(dirPath, f.name);
      }
    }
    // Check subagents subdirectory
    const subDir = path.join(dirPath, 'subagents');
    const subFiles = await fsp.readdir(subDir, { withFileTypes: true }).catch(() => []);
    for (const f of subFiles) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const base = f.name.replace(/\.jsonl$/, '');
      if (base === sessionId || base.endsWith(sessionId)) {
        return path.join(subDir, f.name);
      }
    }
  }
  return null;
}

function parseClaudeCodeSessionIdFromFilename(fileName) {
  return fileName.replace(/\.jsonl$/, '');
}

// Returns the real human prompt text from a Claude Code user record, or null if
// the record is noise (tool results, slash commands, injected reminders, etc.)
function extractClaudeCodeUserPromptText(rec) {
  if (rec.isMeta === true) return null;
  const content = rec.message?.content;
  let text = null;
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    const textBlocks = content.filter((b) => b.type === 'text' && (b.text || '').trim());
    const hasToolResult = content.some((b) => b.type === 'tool_result');
    if (hasToolResult && textBlocks.length === 0) return null;
    text = textBlocks.map((b) => b.text).join('\n');
  }
  if (!text) return null;
  if (text.includes('<command-name>') || text.includes('<command-message>') || text.includes('<local-command-stdout>'))
    return null;
  if (text.includes('<task-notification>')) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith('Caveat:')) return null;
  if (trimmed === '[Request interrupted by user]' || trimmed === '[Request interrupted by user for tool use]')
    return null;
  // System reminders are appended to real prompts — strip them rather than drop the message
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return text || null;
}

const parseClaudeCodeSessionMetadata = withMetadataCache(_parseClaudeCodeSessionMetadataRaw);

async function _parseClaudeCodeSessionMetadataRaw(filePath, fileName) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = null;
  let sessionTimestamp = null;
  let sessionCwd = null;
  let sessionSlug = null;
  let messageCount = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let lastTimestamp = null;
  let firstUserMessage = null;
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

      const t = rec.type;

      if (t === 'user') {
        messageCount++;
        userCount++;
        const content = rec.message?.content;
        // 提取真实用户 prompt（过滤工具回执 / 注入噪音），并作为"最后 prompt"证据
        const promptText = extractClaudeCodeUserPromptText(rec);
        if (promptText) {
          if (!firstUserMessage) firstUserMessage = promptText.slice(0, 120);
          // 只把"真实用户 prompt"记为最后 prompt（工具回执/注入噪音不算）。
          notePrompt(tail, rec.timestamp);
        }
        // user 消息里的 tool_result 块是对应 assistant tool_use 的应答，用它清除待应答调用
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_result') {
              toolResultCount++;
              // tool_result 块的 tool_use_id 与 assistant tool_use 块的 id 严格对应
              resolvePending(tail, block.tool_use_id);
            }
          }
        }
        if (!sessionId && rec.sessionId) sessionId = rec.sessionId;
        if (!sessionCwd && rec.cwd) sessionCwd = rec.cwd;
        if (!sessionSlug && rec.slug) sessionSlug = rec.slug;
      } else if (t === 'assistant') {
        messageCount++;
        assistantCount++;
        noteAssistant(tail, rec.timestamp);
        const content = rec.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use') {
              toolCallCount++;
              const name = block.name || 'unknown';
              toolNames[name] = (toolNames[name] || 0) + 1;
              addPending(tail, block.id, rec.timestamp);
            }
          }
        }
        // stop_reason==='end_turn' 表示回合正常完成；'tool_use' 是工具调用中，不算回合结束。
        if (rec.message?.stop_reason === 'end_turn') {
          noteEndTurn(tail, rec.timestamp);
        }
      } else if (t === 'system' && rec.subtype === 'turn_duration') {
        // 带 timestamp 的 turn_duration 系统记录在回合结束时落盘，作为回合结束证据。
        noteEndTurn(tail, rec.timestamp);
      }

      if (rec.timestamp) lastTimestamp = rec.timestamp;
      if (!sessionTimestamp && rec.timestamp && (t === 'user' || t === 'assistant')) {
        sessionTimestamp = rec.timestamp;
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  const topTools = topToolsOf(toolNames);

  return {
    id: sessionId || parseClaudeCodeSessionIdFromFilename(fileName),
    timestamp: sessionTimestamp,
    lastActivity: lastTimestamp,
    messageCount,
    userCount,
    assistantCount,
    toolCallCount,
    toolResultCount,
    topTools,
    firstUserMessage: firstUserMessage || null,
    cwd: sessionCwd,
    slug: sessionSlug,
    tail: finishTail(tail),
    mtimeMs,
    file: fileName,
  };
}

async function listClaudeCodeSessions(baseDir) {
  const dir = baseDir || CLAUDE_CODE_DIR;
  const sessions = [];
  const projects = await listClaudeCodeProjects(dir);

  for (const project of projects) {
    const dirPath = path.join(dir, project);
    const files = await fsp.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      sessions.push(parseClaudeCodeSessionMetadata(path.join(dirPath, f.name), f.name));
    }
  }

  const resolved = await Promise.all(sessions);
  return sortSessionsByStatusGroups(resolved, { nowMs: Date.now(), sortBy: 'timestamp' });
}

function normalizeClaudeCodeRecord(rec) {
  const t = rec.type;
  const base = { id: rec.uuid || null, timestamp: rec.timestamp || null };

  if (t === 'user') {
    const msg = rec.message || {};
    const content = msg.content;

    if (typeof content === 'string') {
      // Plain user text message
      return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text: content }] });
    }

    if (Array.isArray(content)) {
      // Check if this is purely tool_result blocks
      const hasToolResult = content.some((b) => b.type === 'tool_result');
      const hasText = content.some((b) => b.type === 'text');

      if (hasToolResult && !hasText) {
        // This is a tool result message — return as toolResult
        const textParts = content
          .filter((b) => b.type === 'tool_result')
          .map((b) => {
            const inner = b.content;
            if (typeof inner === 'string') return inner;
            if (Array.isArray(inner))
              return inner
                .filter((ib) => ib.type === 'text')
                .map((ib) => ib.text || '')
                .join('\n');
            return JSON.stringify(inner);
          });
        const toolResultBlock = content.find((b) => b.type === 'tool_result');
        const isError = toolResultBlock?.is_error || false;
        return makeMessage({
          ...base,
          role: 'toolResult',
          content: [{ type: 'text', text: textParts.join('\n\n') }],
          toolCallId: toolResultBlock?.tool_use_id || null,
          details:
            rec.toolUseResult && typeof rec.toolUseResult === 'object'
              ? {
                  stdout: rec.toolUseResult.stdout ? String(rec.toolUseResult.stdout).slice(0, 200) : null,
                  stderr: rec.toolUseResult.stderr ? String(rec.toolUseResult.stderr).slice(0, 200) : null,
                }
              : typeof rec.toolUseResult === 'string'
                ? { error: rec.toolUseResult }
                : null,
          isError,
        });
      }

      // Mixed content or text-only array — extract text
      const textParts = content.filter((b) => b.type === 'text').map((b) => b.text || '');
      return makeMessage({ ...base, role: 'user', content: [{ type: 'text', text: textParts.join('\n\n') }] });
    }

    // Fallback: no content
    return makeMessage({ ...base, role: 'user' });
  }

  if (t === 'assistant') {
    const msg = rec.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];

    const textParts = content.filter((b) => b.type === 'text').map((b) => b.text || '');
    const toolUseBlocks = content.filter((b) => b.type === 'tool_use');

    // Build content array matching our unified format
    const unifiedContent = textParts.map((text) => ({ type: 'text', text }));
    // Add toolUse blocks as 'toolCall' type (matching OpenClaw format)
    for (const block of toolUseBlocks) {
      unifiedContent.push({
        type: 'toolCall',
        id: block.id,
        name: block.name,
        arguments: block.input || {},
      });
    }

    return makeMessage({
      ...base,
      role: 'assistant',
      content: unifiedContent,
      usage: msg.usage || null,
      model: msg.model || null,
    });
  }

  return null;
}

async function parseClaudeCodeSessionFile(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let session = null;
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

      const t = rec.type;

      if (!session && rec.sessionId) {
        session = {
          id: rec.sessionId,
          cwd: rec.cwd || null,
          timestamp: null,
          version: rec.version || null,
        };
      }

      // Update session cwd if we find it on a later record
      if (session && !session.cwd && rec.cwd) {
        session.cwd = rec.cwd;
      }

      if (!session?.timestamp && rec.timestamp && (t === 'user' || t === 'assistant')) {
        session.timestamp = rec.timestamp;
      }

      if (t === 'user' || t === 'assistant') {
        const msg = normalizeClaudeCodeRecord(rec);
        if (msg) messages.push(msg);
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return { session, messages };
}

// Claude Code subagents: a session that spawns children keeps them as
// <slug>/<sessionId>/subagents/agent-<id>.jsonl next to its own file, with
// an optional sibling agent-<id>.meta.json ({agentType, description, ...}).
async function findClaudeSpawnDir(baseDir, sessionId) {
  const filePath = await findClaudeCodeSessionFile(baseDir, sessionId);
  if (!filePath) return null;
  const spawnDir = path.join(path.dirname(filePath), sessionId, 'subagents');
  try {
    const st = await fsp.stat(spawnDir);
    return st.isDirectory() ? spawnDir : null;
  } catch {
    return null;
  }
}

module.exports = {
  listClaudeCodeProjects,
  findClaudeCodeSessionFile,
  parseClaudeCodeSessionIdFromFilename,
  extractClaudeCodeUserPromptText,
  parseClaudeCodeSessionMetadata,
  listClaudeCodeSessions,
  normalizeClaudeCodeRecord,
  parseClaudeCodeSessionFile,
  findClaudeSpawnDir,
};
