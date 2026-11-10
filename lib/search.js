'use strict';
const { dirFor } = require('./dirs-config');
const { PLATFORMS, defaultPlatformId } = require('./platforms');
const { extractSnippet, createSessionMatcher, searchJsonlFile } = require('./platforms/shared/search');

// ========= Full-text session search =========
// Multi-keyword AND search: whitespace-separated keywords must all appear
// somewhere in a session's text records; snippets come from the first keyword.
// Matching semantics are shared across every platform via SessionMatcher; only
// text extraction differs (raw JSONL stream, dsh event data, gemini fold).
//
// 编排（P3 全表面等价）：遍历已挂载平台 catalog，不再硬编码内置平台表。
// 每个平台的搜索能力全部由 adapter hook 声明：
//   search?           (dir, ctx) => hits[]      整体接管（SQLite 型平台，如 hermes）
//   searchFile?       (fileInfo, keywords) => hit|null  单文件搜索器（缺省 searchJsonlFile）
//   searchSupplement? (dir, ctx) => hits[]      主搜索后的补充（如 claude 历史记录）
// 目录覆盖：all 模式用平台声明的 dirParam（?dirCodex 等），单平台模式用 ?dir。
// 自定义平台只要声明 collectFiles（+ 可选 searchFile）即可进入搜索面。

// Search orchestrator. `query` is the raw req.query object: q, platform,
// limit and the dir overrides (dir in single-platform mode, dirXxx in `all`).
// `agent` is the sanitized openclaw agent filter.
async function searchSessions(query, agent) {
  const q = (query.q || '').trim().toLowerCase();
  if (!q) return [];
  // 缺省平台：openclaw 停用/未挂载时回退 catalog 首个可查询平台（设计文档 D5）。
  const platform = query.platform || defaultPlatformId() || 'openclaw';
  const maxResults = Math.min(parseInt(query.limit) || 50, 100);
  const keywords = q.split(/\s+/).filter(Boolean);

  const all = platform === 'all';
  const ids = all ? Object.keys(PLATFORMS) : [platform];
  const resolveDirFor = (p) => dirFor(p, all ? (query[p.dirParam] || '') : query.dir);
  const agentFor = (p) => (!all && p.needsAgent ? agent : '');

  const results = [];
  const remaining = () => maxResults - results.length;

  // 1) 主搜索：按 catalog 顺序逐平台。
  for (const id of ids) {
    const p = PLATFORMS[id];
    if (!p || typeof p.defaultDir !== 'function') continue;
    if (remaining() <= 0) break;
    const dir = resolveDirFor(p);

    if (typeof p.search === 'function') {
      // hook 允许同步返回数组或 Promise；统一包一层再挂 catch。
      const hits = await Promise.resolve(
        p.search(dir, { q, keywords, maxResults: remaining(), agent: agentFor(p) })
      ).catch(() => []);
      for (const hit of hits) {
        if (remaining() <= 0) break;
        results.push({ ...hit, platform: id });
      }
      continue;
    }
    if (typeof p.collectFiles !== 'function') continue; // 无文件型平台必须自行声明 search

    const files = await Promise.resolve(
      p.collectFiles(dir, { agent: agentFor(p), subagents: false, resolveIds: false })
    ).catch(() => []);
    const searchOne = typeof p.searchFile === 'function' ? p.searchFile : searchJsonlFile;
    for (const sf of files) {
      if (remaining() <= 0) break;
      const hit = await searchOne({ ...sf, platform: id }, keywords);
      if (hit) results.push({ ...hit, platform: id });
    }
  }

  // 2) 补充搜索：主搜索完成后逐平台执行（保持既有顺序：文件命中在前）。
  for (const id of ids) {
    const p = PLATFORMS[id];
    if (!p || typeof p.searchSupplement !== 'function') continue;
    if (remaining() <= 0) break;
    const liveSnippets = new Set(results.flatMap((r) => r.matches.map((m) => m.snippet)));
    const hits = await Promise.resolve(
      p.searchSupplement(resolveDirFor(p), {
        q,
        keywords,
        liveSnippets,
        maxResults: remaining(),
        agent: agentFor(p),
      })
    ).catch(() => []);
    for (const hit of hits) {
      if (remaining() <= 0) break;
      results.push({ ...hit, platform: id });
    }
  }

  return results;
}

module.exports = {
  extractSnippet,
  createSessionMatcher,
  searchSessions,
};
