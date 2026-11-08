'use strict';
// codex 平台专属 prompts 提取器（从 lib/platforms/prompts-impl.js 提取）。
const fs = require('fs');
const readline = require('readline');
const { extractCodexUserPromptText } = require('./parse');

async function extractCodexPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
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
      const payload = rec.payload || {};
      if (rec.type === 'session_meta') {
        if (!cwd && payload.cwd) cwd = payload.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if (rec.type !== 'response_item' || payload.type !== 'message' || payload.role !== 'user') continue;
      if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
      const text = extractCodexUserPromptText(payload);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, prompts };
}

module.exports = {
  extractCodexPrompts,
};
