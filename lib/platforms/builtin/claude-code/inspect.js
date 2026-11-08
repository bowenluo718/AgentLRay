'use strict';
// claude-code 平台专属 inspect：从原始记录提取工具调用/结果的 id（content-block
// 形状）。通用 noToolEntries 取自 ../../shared/inspect。

function claudeCodeRawToolEntries(record) {
  const calls = [],
    results = [];
  if (!['user', 'assistant'].includes(record.type) || !Array.isArray(record.message?.content)) {
    return { calls, results };
  }
  for (const part of record.message.content) {
    if (part?.type === 'tool_use') calls.push(part.id || null);
    if (part?.type === 'tool_result') results.push({ id: part.tool_use_id || null, error: part.is_error === true });
  }
  return { calls, results };
}

module.exports = { claudeCodeRawToolEntries };
