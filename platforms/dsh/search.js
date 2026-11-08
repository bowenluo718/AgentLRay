'use strict';
// dsh 平台专属搜索器（自 search-impl.js 迁出）。
// dsh logs may be zstd-compressed and nest text under event.data — read them
// via the shared zstd line reader instead of a raw stream.
const { createSessionMatcher, lineMayMatch } = require('@agentlray/shared/search');
const { readDshSessionLines } = require('@agentlray/shared/zstd');

async function searchDshFile(sf, keywords) {
  let lines;
  try {
    lines = await readDshSessionLines(sf.path);
  } catch {
    return null;
  }
  const matcher = createSessionMatcher(keywords);
  let sessionId = sf.sessionId;
  for (const line of lines) {
    if (matcher.done) break;
    if (!lineMayMatch(line, keywords)) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session' && rec.id) sessionId = rec.id;
    const data = rec.data || {};
    const msg = rec.type === 'user/message' ? data : data.message || {};
    const role = msg.role || rec.type || '';
    const content = Array.isArray(msg.content) ? msg.content : [];
    const text = content
      .filter((c) => c.type === 'text' || c.type === 'reasoning')
      .map((c) => c.text || '')
      .join(' ');
    matcher.consider(text, role, typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null);
  }
  if (!matcher.satisfied) return null;
  return { sessionId, file: sf.file, platform: 'dsh', matches: matcher.matches };
}

module.exports = { searchDshFile };
