'use strict';
// 内置平台 gemini 搜索实现（从 lib/platforms/search-impl.js 迁移）。
// Gemini records keep text at the top level (content: string | Part[]) and
// fold history via $rewindTo/$set — reuse the shared fold, then match.
const fsp = require('fs/promises');
const { createSessionMatcher } = require('@agentlray/shared/search');
const { foldGeminiRecords } = require('./format');

async function searchGeminiFile(sf, keywords) {
  let folded;
  try {
    const text = await fsp.readFile(sf.path, 'utf8');
    folded = foldGeminiRecords(text.split('\n').filter((l) => l.trim()));
  } catch {
    return null;
  }
  const matcher = createSessionMatcher(keywords);
  const sessionId = folded.metadata.sessionId || sf.file.replace(/\.jsonl$/, '');
  for (const rec of folded.messages) {
    if (matcher.done) break;
    const parts = [];
    if (typeof rec.content === 'string') parts.push(rec.content);
    else if (Array.isArray(rec.content)) {
      for (const p of rec.content) if (p && typeof p.text === 'string') parts.push(p.text);
    }
    matcher.consider(parts.join(' '), rec.type === 'gemini' ? 'assistant' : rec.type || '', rec.timestamp || null);
  }
  if (!matcher.satisfied) return null;
  return { sessionId, file: sf.file, platform: 'gemini', matches: matcher.matches };
}

module.exports = { searchGeminiFile };
