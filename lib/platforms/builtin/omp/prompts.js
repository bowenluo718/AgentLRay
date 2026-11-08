'use strict';
// omp 专属 prompts 提取器（P3 前置）。只含不依赖注册表的纯函数。
const fs = require('fs');
const readline = require('readline');
const { extractOmpUserPromptText } = require('./parse');

async function extractOmpPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let cwd = null;
  let timestamp = null;
  let lastActivity = null;
  let title = null;
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
      if (rec.type === 'session') {
        if (!cwd && rec.cwd) cwd = rec.cwd;
        if (!timestamp && rec.timestamp) timestamp = rec.timestamp;
        continue;
      }
      if ((rec.type === 'title' || rec.type === 'title_change') && rec.title) {
        title = rec.title;
        continue;
      }
      if (rec.type !== 'message') continue;
      const msg = rec.message || {};
      if (msg.role !== 'user') continue;
      const text = extractOmpUserPromptText(msg);
      if (text) prompts.push({ text, timestamp: rec.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { cwd, timestamp, lastActivity, title, prompts };
}

module.exports = { extractOmpPrompts };
