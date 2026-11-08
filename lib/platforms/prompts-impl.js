'use strict';
// 纯 prompts 提取器（模块边界脚手架，P3 前置）。各平台 prompt 提取纯函数。
// 本文件禁止 require lib/platforms/index.js（registry）与 lib/prompts.js 等编排模块。

const fs = require('fs');
const fsp = require('fs/promises');
const readline = require('readline');
const { stripOpenClawNoise } = require('./openclaw');
const { extractCodexUserPromptText } = require('./codex');
const { extractOmpUserPromptText } = require('./omp');
const { extractDshUserPromptText, readDshSessionLines } = require('./dsh');
const { extractGeminiUserPromptText, foldGeminiRecords } = require('./gemini');
const { extractClaudeCodeUserPromptText } = require('./claude');
const { openHermesDb, unixToIso } = require('./hermes');

async function extractOpenClawPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!timestamp && record.type === 'session') timestamp = record.timestamp || null;
      if (record.type !== 'message') continue;
      if (record.timestamp) lastActivity = record.timestamp;
      const msg = record.message || {};
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = stripOpenClawNoise(
        content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ')
          .trim()
      );
      if (text) prompts.push({ text, timestamp: record.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { timestamp, lastActivity, prompts };
}

async function extractCodexPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      const payload = rec.payload || {};
      if (rec.type === 'session_meta') {
        if (!cwd && payload.cwd) cwd = payload.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if (rec.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;
      if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
      const text = extractCodexUserPromptText(payload);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, prompts };
}

// dsh: header carries cwd/createdAt (epoch ms); prompts come from
// user/message events. Compressed logs are decompressed by the adapter.
async function extractDshPrompts(filePath) {
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  const lines = await readDshSessionLines(filePath);
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!timestamp && typeof rec.createdAt === 'number') timestamp = new Date(rec.createdAt).toISOString();
      continue;
    }
    const timeIso = typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null;
    if (timeIso) lastActivity = timeIso;
    if (rec.type !== 'user/message') continue;
    const text = extractDshUserPromptText(rec.data || {});
    if (text) prompts.push({ text, timestamp: timeIso });
  }
  return { cwd, timestamp, lastActivity, prompts };
}

// gemini: the folded metadata carries directories/startTime/lastUpdated;
// prompts come from user records ($rewindTo/$set folds applied first, so
// rewound prompts don't resurface).
async function extractGeminiPrompts(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const { metadata, messages } = foldGeminiRecords(text.split('\n').filter((l) => l.trim()));
  const prompts = [];
  let lastActivity = metadata.lastUpdated || null;
  for (const rec of messages) {
    if (rec.timestamp) lastActivity = rec.timestamp;
    const promptText = extractGeminiUserPromptText(rec);
    if (promptText) prompts.push({ text: promptText, timestamp: rec.timestamp || null });
  }
  return {
    cwd: Array.isArray(metadata.directories) && metadata.directories.length ? metadata.directories[0] : null,
    timestamp: metadata.startTime || null,
    lastActivity,
    title: metadata.summary || null,
    prompts,
  };
}

async function extractOmpPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  let title = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (rec.type === 'session') {
        if (!cwd && rec.cwd) cwd = rec.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if ((rec.type === 'title' || rec.type === 'title_change') && rec.title) {
        title = rec.title;
        continue;
      }
      if (rec.type !== 'message') continue;
      const msg = rec.message || {};
      if (msg.role !== 'user') continue;
      const text = extractOmpUserPromptText(msg);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, title, prompts };
}

async function extractClaudeCodePrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let slug = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (!timestamp && rec.timestamp && (rec.type === 'user' || rec.type === 'assistant')) timestamp = rec.timestamp;
      if (rec.type !== 'user') continue;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!slug && rec.slug) slug = rec.slug;
      const text = extractClaudeCodeUserPromptText(rec);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, slug, timestamp, lastActivity, prompts };
}

// Generic JSONL prompt extractor for custom/unknown platforms. Covers the
// common record shapes used across adapters:
//   - claude-code-like: rec.type === 'user' with rec.message?.content (string
//     or block array) — real prompt via extractClaudeCodeUserPromptText
//   - simple adapters:  rec.type === 'user' with top-level string rec.content
//   - openclaw-like:    rec.type === 'message' with msg.role === 'user' —
//     noise stripped via stripOpenClawNoise
// Custom platforms are self-contained (cannot require repo internals), so this
// extractor lives here in AgentLRay source; the Prompts view dispatches any
// platform without a dedicated builtin extractor to it. Returns the same shape
// as the builtin extractors so sessions group by directory like the rest.
async function extractGenericJsonlPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let slug = null;
  let timestamp = null;
  let lastActivity = null;
  let title = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!slug && rec.slug) slug = rec.slug;
      if (!title && (rec.title || rec.customTitle)) title = rec.title || rec.customTitle;
      if (rec.type === 'session') {
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      let text = null;
      if (rec.type === 'user') {
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        if (rec.message && rec.message.content != null) {
          // claude-code/co-mind-like shape (string or block array)
          text = extractClaudeCodeUserPromptText(rec);
        } else if (typeof rec.content === 'string') {
          // simple adapters: top-level string content
          text = stripOpenClawNoise(rec.content) || null;
        }
      } else if (rec.type === 'message') {
        const msg = rec.message || rec.payload || {};
        if (msg.role !== 'user') continue;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        const content = Array.isArray(msg.content) ? msg.content : [];
        const raw = content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ')
          .trim();
        text = stripOpenClawNoise(raw) || null;
      }
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, slug, timestamp, lastActivity, title, prompts };
}

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

module.exports = {
  extractOpenClawPrompts,
  extractCodexPrompts,
  extractDshPrompts,
  extractGeminiPrompts,
  extractOmpPrompts,
  extractClaudeCodePrompts,
  extractGenericJsonlPrompts,
  extractHermesPromptGroups,
};
