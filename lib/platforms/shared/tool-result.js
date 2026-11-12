'use strict';
// Gemini CLI 工具结果文本化工具（Q25/Q26=A 下沉自 gemini.js）。
//  - stringifyToolResult —— 工具结果文本化
// foldGeminiRecords（记录流折叠）已随 gemini 平台内聚到 platforms/gemini/format.js：
// 它只被 gemini 平台消费。stringifyToolResult 仅被 gemini 平台消费
// （platforms/gemini/parse.js、platforms/gemini/insights.js），共享通用扫描器
// shared/insights.js 已不再依赖（gemini 扫描分支收敛进 gemini 平台 hook）。
function stringifyToolResult(result) {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result)) {
    const text = result.map((p) => (p && typeof p === 'object' && typeof p.text === 'string' ? p.text : '')).join('');
    if (text) return text;
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  if (typeof result === 'object' && typeof result.text === 'string') return result.text;
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

module.exports = {
  stringifyToolResult,
};
