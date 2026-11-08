'use strict';
const { resolveDir } = require('./config');
const { PLATFORMS } = require('./platforms');
const {
  iterateSessionLines,
  scanFileForInsights,
  buildInsightsResponse,
} = require('./platforms/shared/insights');

// ========= Insights: aggregate analytics across sessions =========
// 扫描/汇总纯实现已下沉到 lib/platforms/insights-impl.js（模块边界脚手架）。
// 编排按 adapter hook 派发（P3 全表面等价）：
//   computeInsights?     (dir, ctx) => response|null   整体接管（SQLite 型平台）
//   insightsScanFile?    (filePath, sessionId) => data  单文件扫描器（缺省 scanFileForInsights）
// 其余文件型平台统一走 collectFiles + 扫描器；无 collectFiles 且无 hook 的平台返回 null。
const insightsCache = new Map(); // key → { expires: number, data: object }
const INSIGHTS_TTL_MS = 60_000;

function getInsightsCacheKey(platform, agent, dir) {
  return `${platform}|${agent || ''}|${dir || ''}`;
}

async function computeInsights(platform, agentName, dirOverride) {
  const p = PLATFORMS[platform];
  if (!p || typeof p.defaultDir !== 'function') return null;
  const dir = resolveDir(dirOverride, p.defaultDir());

  // 1) adapter 整体接管
  if (typeof p.computeInsights === 'function') {
    return p.computeInsights(dir, { agent: agentName || '' });
  }

  // 2) 通用实现：collectFiles + 平台扫描器（缺省多格式通用扫描）
  if (typeof p.collectFiles !== 'function') return null;
  const files = await p.collectFiles(dir, { agent: agentName || '' });
  if (files.length === 0) return null;
  const scanOne = typeof p.insightsScanFile === 'function' ? p.insightsScanFile : scanFileForInsights;

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
    // hook 可为同步或 async；统一包一层 Promise 再挂 catch。
    const data = await Promise.resolve(scanOne(f.path, f.sessionId)).catch(() => null);
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
  computeInsights,
  buildInsightsResponse,
};
