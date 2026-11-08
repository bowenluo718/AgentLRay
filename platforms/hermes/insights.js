'use strict';
// 平台专属 hermes insights 扫描器（从 lib/platforms/insights-impl.js 抽出）。
//   scanHermesSessionForInsights —— SQLite 会话 insights 扫描
//   computeHermesInsights      —— SQLite 整库聚合（adapter 的 computeInsights hook）
const { normalizeErrorPattern } = require('@agentlray/shared/text-utils');
const { openHermesDb } = require('./parse');
const { buildInsightsResponse } = require('@agentlray/shared/insights');

// Scan a single Hermes session for insights (from SQLite)
function scanHermesSessionForInsights(db, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  const totalOutputTokens = 0;
  let sessionDate = null;
  const toolStats = {};
  const errorExamples = [];

  const rows = db
    .prepare(`
    SELECT role, content, tool_calls, tool_name, token_count, timestamp
    FROM messages WHERE session_id = ?
    ORDER BY rowid
  `)
    .all(sessionId);

  for (const row of rows) {
    messageCount++;
    totalInputTokens += row.token_count || 0;

    if (!sessionDate && row.timestamp) {
      sessionDate = new Date(row.timestamp * 1000).toISOString().slice(0, 10);
    }

    // Parse tool calls from assistant messages
    if (row.role === 'assistant' && row.tool_calls) {
      let calls;
      try {
        calls = JSON.parse(row.tool_calls);
      } catch {
        continue;
      }
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          const name = tc?.function?.name || tc?.name || 'unknown';
          toolCallCount++;
          if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
          toolStats[name].calls++;
        }
      }
    }

    // Tool results
    if (row.role === 'tool') {
      toolResultCount++;
      const name = row.tool_name || 'tool';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      // Detect errors from content (no is_error column in Hermes)
      const content = row.content || '';
      const isErr =
        content.includes('"isError":true') ||
        content.includes('"isError": true') ||
        (content.toLowerCase().includes('error') && content.includes('exit code') && !content.includes('exit code 0'));
      if (isErr) {
        errorCount++;
        toolStats[name].errors++;
        const snippet = content.trim().split('\n')[0].trim().slice(0, 200);
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          timestamp: row.timestamp ? new Date(row.timestamp * 1000).toISOString() : null,
        });
      }
    }
  }

  return {
    messageCount,
    toolCallCount,
    toolResultCount,
    errorCount,
    totalInputTokens,
    totalOutputTokens,
    totalCacheRead: 0,
    sessionDate,
    toolStats,
    errorExamples,
  };
}

// Aggregate insights for a SQLite-backed Hermes database. Platform adapters declare
// this as their `computeInsights` hook (整体接管，不走 collectFiles 文件扫描)。
function computeHermesInsights(dir) {
  const db = openHermesDb(dir);
  if (!db) return null;
  try {
    const sessions = db.prepare('SELECT id FROM sessions').all();
    const totalSessions = sessions.length;
    let totalMessages = 0;
    let totalToolCalls = 0;
    let totalToolResultCount = 0;
    let totalErrors = 0;
    let totalInput = 0;
    let totalOutput = 0;
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

module.exports = {
  scanHermesSessionForInsights,
  computeHermesInsights,
};
