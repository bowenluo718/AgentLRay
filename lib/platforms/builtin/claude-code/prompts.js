'use strict';
// claude-code 平台专属 prompts 提取器：content-block 格式的 prompt 提取。
// 通用记录规范化（extractClaudeCodeUserPromptText）取自同平台 ./parse。

const fs = require('fs');
const readline = require('readline');
const { extractClaudeCodeUserPromptText } = require('./parse');

async function extractClaudeCodePrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let slug = null;
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (rec.timestamp) lastActivity = rec.timestamp;
      if (!timestamp && rec.timestamp && (rec.type === 'user' || rec.type === 'assistant')) timestamp = rec.timestamp;
      if (rec.type !== 'user') continue;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!slug && rec.slug) slug = rec.slug;
      const text = extractClaudeCodeUserPromptText(rec);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, slug, timestamp, lastActivity, prompts };
}

module.exports = { extractClaudeCodePrompts };
