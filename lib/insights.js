'use strict';
const { HERMES_DIR, resolveDir } = require('./config');
const { openHermesDb } = require('./platforms/hermes');
const { collectSessionFiles } = require('./platforms');
const {
  iterateSessionLines,
  scanFileForInsights,
  scanHermesSessionForInsights,
  buildInsightsResponse,
} = require('./platforms/insights-impl');

// ========= Insights: aggregate analytics across sessions =========
// 扫描/汇总纯实现已下沉到 lib/platforms/insights-impl.js（模块边界脚手架），
// 本模块保留缓存与依赖注册表/平台的 computeInsights 编排。
const insightsCache = new Map(); // key → { expires: number, data: object }
const INSIGHTS_TTL_MS = 60_000;

function getInsightsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

async function computeInsights(platform, agentName, dirOverride) {
  // Hermes uses SQLite
  if (platform === 'hermes') {
    const dir = resolveDir(dirOverride, HERMES_DIR);
    const db = openHermesDb(dir);
    if (!db) return null;
    try {
      const sessions = db.prepare('SELECT id FROM sessions').all();
      const totalSessions = sessions.length;
      let totalMessages = 0,
        totalToolCalls = 0,
        totalToolResultCount = 0,
        totalErrors = 0;
      let totalInput = 0,
        totalOutput = 0;
      const toolStats = {};
      const allErrors = [];
      const dailyTrend = {};

      for (const s of sessions) {
        const data = scanHermesSessionForInsights(db, s.id);
        totalMessages += data.messageCount;
        totalToolCalls += data.toolCallCount;
        totalToolResultCount += data.toolResultCount;
        totalErrors += data.errorCount;
        totalInput += data.totalInputTokens;
        totalOutput += data.totalOutputTokens;

        for (const [name, st] of Object.entries(data.toolStats)) {
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls += st.calls;
          toolStats[name].errors += st.errors;
          toolStats[name].totalDurationMs += st.totalDurationMs;
        }
        allErrors.push(...data.errorExamples);

        if (data.sessionDate) {
          if (!dailyTrend[data.sessionDate]) dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0 };
          dailyTrend[data.sessionDate].sessions++;
          dailyTrend[data.sessionDate].errors += data.errorCount;
          dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
        }
      }

      return buildInsightsResponse(
        totalSessions,
        totalMessages,
        totalToolCalls,
        totalToolResultCount,
        totalErrors,
        totalInput,
        totalOutput,
        0,
        0,
        toolStats,
        allErrors,
        dailyTrend
      );
    } finally {
      db.close();
    }
  }

  // JSONL-based platforms: openclaw, codex, claude-code, omp, dsh, gemini
  const files = await collectSessionFiles(platform, agentName, dirOverride);
  if (files.length === 0) return null;

  const totalSessions = files.length;
  let totalMessages = 0,
    totalToolCalls = 0,
    totalToolResultCount = 0,
    totalErrors = 0;
  let totalInput = 0,
    totalOutput = 0,
    totalCacheRead = 0,
    totalCost = 0;
  const toolStats = {};
  const allErrors = [];
  const dailyTrend = {};

  for (const f of files) {
    const data = await scanFileForInsights(f.path, f.sessionId).catch(() => null);
    if (!data) continue;

    totalMessages += data.messageCount;
    totalToolCalls += data.toolCallCount;
    totalToolResultCount += data.toolResultCount;
    totalErrors += data.errorCount;
    totalInput += data.totalInputTokens;
    totalOutput += data.totalOutputTokens;
    totalCacheRead += data.totalCacheRead;
    totalCost += data.totalCost || 0;

    for (const [name, st] of Object.entries(data.toolStats)) {
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls += st.calls;
      toolStats[name].errors += st.errors;
      toolStats[name].totalDurationMs += st.totalDurationMs;
    }
    allErrors.push(...data.errorExamples);

    if (data.sessionDate) {
      if (!dailyTrend[data.sessionDate])
        dailyTrend[data.sessionDate] = { sessions: 0, errors: 0, toolCalls: 0, cost: 0 };
      dailyTrend[data.sessionDate].sessions++;
      dailyTrend[data.sessionDate].errors += data.errorCount;
      dailyTrend[data.sessionDate].toolCalls += data.toolCallCount;
      dailyTrend[data.sessionDate].cost += data.totalCost || 0;
    }
  }

  return buildInsightsResponse(
    totalSessions,
    totalMessages,
    totalToolCalls,
    totalToolResultCount,
    totalErrors,
    totalInput,
    totalOutput,
    totalCacheRead,
    totalCost,
    toolStats,
    allErrors,
    dailyTrend
  );
}

module.exports = {
  insightsCache,
  INSIGHTS_TTL_MS,
  getInsightsCacheKey,
  iterateSessionLines,
  scanFileForInsights,
  scanHermesSessionForInsights,
  computeInsights,
  buildInsightsResponse,
};
