'use strict';
const os = require('os');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const readline = require('readline');
const { CLAUDE_CODE_DIR, HERMES_DIR, resolveDir } = require('./config');
const { collectSessionFiles } = require('./platforms');
const { searchHermesSessions } = require('./platforms/hermes');
const {
  extractSnippet,
  createSessionMatcher,
  lineMayMatch,
  searchJsonlFile,
  searchDshFile,
  searchGeminiFile,
  searchClaudeHistory,
} = require('./platforms/search-impl');

// ========= Full-text session search =========
// Multi-keyword AND search: whitespace-separated keywords must all appear
// somewhere in a session's text records; snippets come from the first keyword.
// Matching semantics are shared across every platform via SessionMatcher; only
// text extraction differs (raw JSONL stream, dsh event data, gemini fold).
// 匹配器与格式搜索器已下沉到 lib/platforms/search-impl.js（模块边界脚手架），
// 本模块仅保留依赖注册表与平台目录编排的 searchSessions。

// Per-platform ?dir override params used in all-platform mode.
const DIR_PARAMS = {
  openclaw: 'dirOpenclaw',
  codex: 'dirCodex',
  'claude-code': 'dirClaude',
  omp: 'dirOmp',
  dsh: 'dirDsh',
  gemini: 'dirGemini',
};

// Search orchestrator. `query` is the raw req.query object: q, platform,
// limit and the dir overrides (dir in single-platform mode, dirXxx in `all`).
// `agent` is the sanitized openclaw agent filter.
async function searchSessions(query, agent) {
  const q = (query.q || '').trim().toLowerCase();
  if (!q) return [];
  const platform = query.platform || 'openclaw';
  const maxResults = Math.min(parseInt(query.limit) || 50, 100);
  const keywords = q.split(/\s+/).filter(Boolean);

  const all = platform === 'all';
  const dirParamFor = (key) => (all ? query[key] : query.dir) || '';

  if (platform === 'hermes' && !all) {
    const dir = resolveDir(query.dir, HERMES_DIR);
    return searchHermesSessions(dir, q, maxResults);
  }

  // Collect candidate files per platform via the registry, in a stable order:
  // openclaw, codex, claude-code, omp, dsh, gemini. The claude-code subagents
  // dir is excluded (children surface under their parent) and gemini ids
  // resolve from the folded metadata during matching.
  const wanted = Object.keys(DIR_PARAMS).filter((id) => platform === id || all);
  const collected = await Promise.all(
    wanted.map(async (id) => {
      const agentFor = id === 'openclaw' && !all ? agent : '';
      const files = await collectSessionFiles(id, agentFor, dirParamFor(DIR_PARAMS[id]), {
        subagents: false,
        resolveIds: false,
      }).catch(() => []);
      return files.map((f) => ({ ...f, platform: id }));
    })
  );
  const byPlatform = new Map(wanted.map((id, i) => [id, collected[i]]));

  const results = [];
  const searchers = [
    [
      [
        ...(byPlatform.get('openclaw') || []),
        ...(byPlatform.get('codex') || []),
        ...(byPlatform.get('claude-code') || []),
        ...(byPlatform.get('omp') || []),
      ],
      searchJsonlFile,
    ],
    [byPlatform.get('dsh') || [], searchDshFile],
    [byPlatform.get('gemini') || [], searchGeminiFile],
  ];
  for (const [files, searchOne] of searchers) {
    for (const sf of files) {
      if (results.length >= maxResults) break;
      const hit = await searchOne(sf, keywords);
      if (hit) results.push(hit);
    }
  }

  // Claude Code retention fallback: prompt history
  if (platform === 'claude-code' || all) {
    const dir = resolveDir(dirParamFor('dirClaude'), CLAUDE_CODE_DIR);
    const liveSnippets = new Set(results.flatMap((r) => r.matches.map((m) => m.snippet)));
    const historyHits = await searchClaudeHistory(dir, keywords, liveSnippets);
    for (const hit of historyHits) {
      if (results.length >= maxResults) break;
      results.push(hit);
    }
  }

  // Hermes stores sessions in SQLite; merge its hits in all-platform mode
  if (all) {
    try {
      const remaining = Math.max(0, maxResults - results.length);
      if (remaining > 0) {
        results.push(...searchHermesSessions(resolveDir(dirParamFor('dirHermes'), HERMES_DIR), q, remaining));
      }
    } catch {
      /* no hermes db */
    }
  }

  return results;
}

module.exports = {
  extractSnippet,
  createSessionMatcher,
  searchSessions,
};
