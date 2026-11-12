'use strict';
// 内置平台 gemini tool-audit 单文件扫描（随 gemini 平台内聚）。
// 复用共享 toolAuditEntry 聚合语义，只处理 gemini 的记录形状：
//   - type === 'gemini'：assistant 记录，内联 toolCalls[]（result 挂在 call 上）
// 与共享通用扫描器 scanFileForToolAudit 的 gemini 分支行为一致（无独立 result
// 时间戳，durations 保持未知），被 lib/tool-audit.js 的 dispatch 消费。
const { iterateSessionLines } = require('../../lib/platforms/shared/insights');
const { toolAuditEntry } = require('../../lib/platforms/shared/tool-audit');

async function scanGeminiFileForToolAudit(filePath, tools, platform) {
  const pending = new Map(); // callId → { name, tsMs }
  const seen = new Set(); // tool names used in this file

  const onCall = (name, callId, ts) => {
    const t = toolAuditEntry(tools, name, platform);
    t.calls++;
    seen.add(name);
    const tsMs = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(tsMs) && tsMs > t.lastUsedMs) t.lastUsedMs = tsMs;
    if (callId) pending.set(callId, { name, tsMs: Number.isFinite(tsMs) ? tsMs : null });
  };

  const onResult = (callId, ts, isError, name, durationMs) => {
    const call = callId ? pending.get(callId) : undefined;
    if (call) pending.delete(callId);
    const toolName = (call && call.name) || name;
    if (!toolName) return; // unpaired result without a name: nothing to attribute
    const t = toolAuditEntry(tools, toolName, platform);
    seen.add(toolName);
    if (isError) t.errors++;
    let ms = typeof durationMs === 'number' && durationMs >= 0 ? durationMs : null;
    if (ms === null && call && call.tsMs !== null && ts) {
      const endMs = Date.parse(ts);
      if (Number.isFinite(endMs) && endMs >= call.tsMs) ms = endMs - call.tsMs;
    }
    if (ms !== null) {
      t.totalMs += ms;
      t.msCount++;
    }
  };

  for await (const line of iterateSessionLines(filePath)) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }

    // Gemini CLI format: type === 'gemini' records with inline toolCalls
    // (result is stored inline on the call record — no separate completion
    // timestamp exists, so durations stay unknown).
    if (rec.type !== 'gemini') continue;
    for (const call of Array.isArray(rec.toolCalls) ? rec.toolCalls : []) {
      const ts = call.timestamp || rec.timestamp || null;
      onCall(call.name || 'unknown', call.id || null, ts);
      const hasResult = call.result !== undefined && call.result !== null;
      if (hasResult || call.status === 'error' || call.status === 'cancelled') {
        onResult(call.id || null, null, call.status === 'error' || call.status === 'cancelled', call.name || null, null);
      }
    }
  }

  for (const name of seen) tools.get(name).sessions++;
}

module.exports = { scanGeminiFileForToolAudit };
