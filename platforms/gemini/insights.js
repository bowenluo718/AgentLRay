'use strict';
// 内置平台 gemini insights 单文件扫描（随 gemini 平台内聚）。
// 与共享通用扫描器 scanFileForInsights 返回相同结构，被 lib/insights.js 的
// 汇聚逻辑消费。只处理 gemini 的记录形状：
//   - type === 'session'：会话时间戳
//   - type === 'gemini'：assistant 记录，内联 toolCalls[]（result 挂在 call 上）
// 沿用「逐行盲扫」处理最终形状（与既共享分支行为一致，零回归，不引入 fold）。
const { iterateSessionLines } = require('../../lib/platforms/shared/insights');
const { extractErrorSnippet, normalizeErrorPattern } = require('../../lib/text-utils');
const { stringifyToolResult } = require('../../lib/platforms/shared/tool-result');

async function scanGeminiFileForInsights(filePath, sessionId) {
  let messageCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheRead = 0;
  let totalCost = 0;
  let sessionDate = null;
  const toolStats = {}; // name → { calls, errors, totalDurationMs }
  const errorExamples = []; // { toolName, snippet, pattern }

  for await (const line of iterateSessionLines(filePath)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    // Session timestamp
    if (rec.type === 'session' && rec.timestamp) {
      sessionDate = rec.timestamp.slice(0, 10);
      continue;
    }

    // Gemini CLI format: type === 'gemini' assistant records with inline toolCalls.
    // (user records also appear; their top-level content is a string/Part[], and
    // they count as messages — mirror the shared scanner's accounting.)
    if (rec.type !== 'gemini') continue;

    messageCount++;
    if (!sessionDate && rec.timestamp) sessionDate = rec.timestamp.slice(0, 10);
    if (rec.tokens) {
      totalInputTokens += rec.tokens.input || 0;
      totalOutputTokens += rec.tokens.output || 0;
      totalCacheRead += rec.tokens.cached || 0;
    }
    for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
      toolCallCount++;
      const name = call.name || 'unknown';
      if (!toolStats[name]) toolStats[name] = { calls: 0, errors: 0, totalDurationMs: 0 };
      toolStats[name].calls++;
      const hasResult = call.result !== undefined && call.result !== null;
      if (hasResult || call.status === 'error' || call.status === 'cancelled') toolResultCount++;
      if (call.status === 'error' || call.status === 'cancelled') {
        errorCount++;
        toolStats[name].errors++;
        const snippet = extractErrorSnippet(
          hasResult ? stringifyToolResult(call.result) : `Tool call ${call.status}`
        );
        const pattern = normalizeErrorPattern(snippet);
        errorExamples.push({
          toolName: name,
          snippet,
          pattern,
          sessionId,
          messageId: call.id || rec.id || null,
          timestamp: call.timestamp || rec.timestamp || null,
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
    totalCacheRead,
    totalCost,
    sessionDate,
    toolStats,
    errorExamples,
  };
}

module.exports = { scanGeminiFileForInsights };
