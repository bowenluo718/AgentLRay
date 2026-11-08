'use strict';
// codex 平台专属单记录 inspect 分析（从 lib/platforms/inspect-impl.js 提取）。
function codexRawToolEntries(record) {
  const calls = [],
    results = [];
  if (record.type !== 'response_item') return { calls, results };
  const payload = record.payload || {};
  if (['function_call', 'custom_tool_call'].includes(payload.type)) calls.push(payload.call_id || null);
  if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
    const exitCode = payload.output?.metadata?.exit_code;
    results.push({ id: payload.call_id || null, error: Number.isInteger(exitCode) && exitCode !== 0 });
  }
  return { calls, results };
}

module.exports = {
  codexRawToolEntries,
};
