'use strict';
// openclaw prompt 提取器（从 lib/platforms/prompts-impl.js 迁出）。
const fs = require('fs');
const readline = require('readline');
const { stripOpenClawNoise } = require('./parse');

async function extractOpenClawPrompts(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let timestamp = null;
  let lastActivity = null;
  const prompts = [];
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!timestamp && record.type === 'session') timestamp = record.timestamp || null;
      if (record.type !== 'message') continue;
      if (record.timestamp) lastActivity = record.timestamp;
      const msg = record.message || {};
      if (msg.role !== 'user') continue;
      const content = Array.isArray(msg.content) ? msg.content : [];
      const text = stripOpenClawNoise(
        content
          .filter((c) => c.type === 'text')
          .map((c) => c.text || '')
          .join(' ')
          .trim()
      );
      if (text) prompts.push({ text, timestamp: record.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { timestamp, lastActivity, prompts };
}

module.exports = { extractOpenClawPrompts };
