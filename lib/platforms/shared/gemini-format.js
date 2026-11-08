'use strict';
// Gemini CLI 记录格式工具（Q25/Q26=A 下沉自 gemini.js）。
//  - foldGeminiRecords —— 把记录流折叠为 { metadata, messages }（处理 $rewindTo/$set/id 覆盖）
//  - stringifyToolResult —— 工具结果文本化
// 供共享通用扫描器（shared/insights）与 gemini 平台解析（platforms/gemini/parse.js）共用。
function foldGeminiRecords(lines) {
  let metadata = {};
  const messagesMap = new Map(); // id → record, insertion-ordered

  const addMessage = (rec) => {
    if (messagesMap.has(rec.id)) messagesMap.delete(rec.id); // move to the end
    messagesMap.set(rec.id, rec);
  };

  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;

    if (typeof rec.$rewindTo === 'string') {
      // Drop the rewind target and everything after it
      let found = false;
      for (const id of [...messagesMap.keys()]) {
        if (id === rec.$rewindTo) found = true;
        if (found) messagesMap.delete(id);
      }
      if (!found) messagesMap.clear();
      continue;
    }

    if (rec.$set && typeof rec.$set === 'object') {
      if (Array.isArray(rec.$set.messages)) {
        // Checkpoint: replace the whole history
        messagesMap.clear();
        for (const msg of rec.$set.messages) {
          if (msg && typeof msg.id === 'string') addMessage(msg);
        }
      }
      metadata = { ...metadata, ...rec.$set };
      continue;
    }

    if (typeof rec.id === 'string') {
      addMessage(rec);
      continue;
    }

    if (typeof rec.sessionId === 'string') {
      // Metadata line — legacy single-line records also carry messages[]
      metadata = { ...metadata, ...rec };
      if (Array.isArray(rec.messages)) {
        for (const msg of rec.messages) {
          if (msg && typeof msg.id === 'string') addMessage(msg);
        }
      }
    }
  }

  return { metadata, messages: [...messagesMap.values()] };
}

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
  foldGeminiRecords,
  stringifyToolResult,
};
