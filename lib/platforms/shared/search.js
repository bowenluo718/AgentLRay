'use strict';
// 搜索通用实现（原 search-impl.js 的通用部分）。
//  - extractSnippet / createSessionMatcher / lineMayMatch —— 关键词匹配与摘要
//  - searchJsonlFile —— 通用 JSONL 平台的流式搜索（openclaw/codex/claude-code/omp）
// 平台专属的 searchDshFile / searchGeminiFile / searchClaudeHistory 内聚进各
// builtin/<id>/search.js。
const fs = require('fs');
const readline = require('readline');

const MAX_MATCHES_PER_SESSION = 3;

// A ±(40/60)-char window around the first keyword's first occurrence.
function extractSnippet(text, keyword) {
  const idx = text.toLowerCase().indexOf(keyword);
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + keyword.length + 60);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

// Accumulates keyword sightings + snippets for one session.
// A session satisfies the query when every keyword appeared somewhere in it
// and at least one snippet (first keyword) was captured.
function createSessionMatcher(keywords) {
  const matches = [];
  const seen = new Set();
  return {
    matches,
    // Stop scanning: snippet quota reached and every keyword seen
    get done() {
      return matches.length >= MAX_MATCHES_PER_SESSION && seen.size === keywords.length;
    },
    // Include this session in the results
    get satisfied() {
      return matches.length > 0 && seen.size === keywords.length;
    },
    consider(text, role, timestamp) {
      const textLower = text.toLowerCase();
      for (const kw of keywords) {
        if (textLower.includes(kw)) seen.add(kw);
      }
      if (matches.length < MAX_MATCHES_PER_SESSION && textLower.includes(keywords[0])) {
        matches.push({ role, snippet: extractSnippet(text, keywords[0]), timestamp });
      }
    },
  };
}

// Quick line-level pre-filter: skip lines that can't contain any keyword.
function lineMayMatch(line, keywords) {
  const lower = line.toLowerCase();
  return keywords.some((kw) => lower.includes(kw));
}

// Generic JSONL platforms (openclaw, codex, claude-code, omp): stream the raw
// file; message text lives under rec.message?.content or rec.payload?.content.
async function searchJsonlFile(sf, keywords) {
  const matcher = createSessionMatcher(keywords);
  const stream = fs.createReadStream(sf.path, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let sessionId = sf.sessionId || sf.file.split('.jsonl')[0];

  try {
    for await (const line of rl) {
      if (matcher.done) break;
      if (!lineMayMatch(line, keywords)) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }

      // Extract session id
      if (rec.type === 'session' && rec.id) sessionId = rec.id;
      if (rec.sessionId) sessionId = rec.sessionId;

      // Extract text content for matching
      const msg = rec.message || rec.payload || {};
      const role = msg.role || rec.type || '';
      const content = Array.isArray(msg.content)
        ? msg.content
        : typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : [];
      const text = content
        .filter((c) => c.type === 'text' || c.type === 'input_text')
        .map((c) => c.text || '')
        .join(' ');

      matcher.consider(text, role, rec.timestamp || null);
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  if (!matcher.satisfied) return null;
  return {
    sessionId,
    file: sf.file,
    platform: sf.platform,
    ...(sf.agent ? { agent: sf.agent } : {}),
    matches: matcher.matches,
  };
}

module.exports = {
  extractSnippet,
  createSessionMatcher,
  lineMayMatch,
  searchJsonlFile,
};
