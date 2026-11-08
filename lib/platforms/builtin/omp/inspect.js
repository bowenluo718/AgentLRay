'use strict';
// omp 专属 inspect 原始工具条目提取（P3 全表面等价）。
// 从原始记录提取工具调用/结果的 id（多平台形状）。返回
// { calls: string[], results: { id, error }[] } 用于校验适配器 normalizer 的
// 工具覆盖与原始证据一致。
function ompRawToolEntries(record) {
  const calls = [],
    results = [];
  if (record.type !== 'message') return { calls, results };
  const message = record.message || {};
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    for (const part of message.content) if (part?.type === 'toolCall') calls.push(part.id || null);
  }
  if (message.role === 'toolResult')
    results.push({ id: message.toolCallId || null, error: message.isError === true });
  return { calls, results };
}

module.exports = { ompRawToolEntries };
