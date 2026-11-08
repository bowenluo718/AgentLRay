'use strict';
// dsh 平台专属 prompt 提取器（自 prompts-impl.js 迁出）。
// dsh: header carries cwd/createdAt (epoch ms); prompts come from
// user/message events. Compressed logs are decompressed by the shared reader.
const { readDshSessionLines } = require('@agentlray/shared/zstd');
const { extractDshUserPromptText } = require('./parse');

async function extractDshPrompts(filePath) {
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  const lines = await readDshSessionLines(filePath);
  for (const line of lines) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.type === 'session') {
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!timestamp && typeof rec.createdAt === 'number') timestamp = new Date(rec.createdAt).toISOString();
      continue;
    }
    const timeIso = typeof rec.time === 'number' ? new Date(rec.time).toISOString() : null;
    if (timeIso) lastActivity = timeIso;
    if (rec.type !== 'user/message') continue;
    const text = extractDshUserPromptText(rec.data || {});
    if (text) prompts.push({ text, timestamp: timeIso });
  }
  return { cwd, timestamp, lastActivity, prompts };
}

module.exports = { extractDshPrompts };
