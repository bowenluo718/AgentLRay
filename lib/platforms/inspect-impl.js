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

// 平台 → 单记录分析 hook 映射：适配器以 `inspect` 字段整体声明，
// 编排层（lib/inspect.js）只认这次映射的结果，不再硬编码平台 id。
const rawToolEntriesByPlatform = {
  omp: ompRawToolEntries,
  codex: codexRawToolEntries,
  'claude-code': claudeCodeRawToolEntries,
};

const noToolEntries = () => ({ calls: [], results: [] });

function rawToolEntries(record, platform) {
  return (rawToolEntriesByPlatform[platform] || noToolEntries)(record);
}

module.exports = {
  normalizers,
  rawToolEntries,
  rawToolEntriesByPlatform,
};
