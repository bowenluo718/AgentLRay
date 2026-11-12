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
      // openclaw 的 user 消息 content 是纯字符串（真实用户输入直接落盘），
      // assistant 消息才是数组块——与 parse.js 的 _parseSessionMetadataRaw 同口径，
      // 字符串与数组都要兼容，否则字符串 content 会因 Array.isArray 为 false 被丢光。
      const content = Array.isArray(msg.content) ? msg.content : [];
      const raw =
        typeof msg.content === 'string'
          ? msg.content
          : content
              .filter((c) => c.type === 'text')
              .map((c) => c.text || '')
              .join(' ');
      const text = stripOpenClawNoise(raw.trim());
      if (text) prompts.push({ text, timestamp: record.timestamp || null });
    }
  } finally {
    rl.close();
    stream.destroy();
  }
  return { timestamp, lastActivity, prompts };
}

module.exports = { extractOpenClawPrompts };
