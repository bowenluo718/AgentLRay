'use strict';
// 纯 inspect 记录规范化（模块边界脚手架，P3 前置）。只含不依赖注册表的实现：
//   normalizers —— 平台 → normalizeRecord 映射
//   rawToolEntries —— 从原始记录提取工具调用/结果的 id（多平台形状）
// 本文件禁止 require lib/platforms/index.js（registry）与 lib/inspect.js 等编排模块。

const { normalizeOmpRecord } = require('./omp');
const { normalizeCodexRecord } = require('./codex');
const { normalizeClaudeCodeRecord } = require('./claude');

const normalizers = {
  omp: normalizeOmpRecord,
  codex: (record) => (record.type === 'response_item' ? normalizeCodexRecord(record) : null),
  'claude-code': normalizeClaudeCodeRecord,
};

// Extract per-platform tool call/result ids from one raw record. Returns
// { calls: string[], results: { id, error }[] } used to verify the adapter
// normalizer's tool coverage against raw evidence.
function rawToolEntries(record, platform) {
  const calls = [],
    results = [];
  if (platform === 'codex' && record.type === 'response_item') {
    const payload = record.payload || {};
    if (['function_call', 'custom_tool_call'].includes(payload.type)) calls.push(payload.call_id || null);
    if (['function_call_output', 'custom_tool_call_output'].includes(payload.type)) {
      const exitCode = payload.output?.metadata?.exit_code;
      results.push({ id: payload.call_id || null, error: Number.isInteger(exitCode) && exitCode !== 0 });
    }
  } else if (platform === 'omp' && record.type === 'message') {
    const message = record.message || {};
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) if (part?.type === 'toolCall') calls.push(part.id || null);
    }
    if (message.role === 'toolResult')
      results.push({ id: message.toolCallId || null, error: message.isError === true });
  } else if (
    platform === 'claude-code' &&
    ['user', 'assistant'].includes(record.type) &&
    Array.isArray(record.message?.content)
  ) {
    for (const part of record.message.content) {
      if (part?.type === 'tool_use') calls.push(part.id || null);
      if (part?.type === 'tool_result') results.push({ id: part.tool_use_id || null, error: part.is_error === true });
    }
  }
  return { calls, results };
}

module.exports = {
  normalizers,
  rawToolEntries,
};
