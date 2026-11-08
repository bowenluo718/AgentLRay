'use strict';
// 内置平台 gemini prompts 提取（从 lib/platforms/prompts-impl.js 迁移）。
// gemini: the folded metadata carries directories/startTime/lastUpdated;
// prompts come from user records ($rewindTo/$set folds applied first, so
// rewound prompts don't resurface).
const fsp = require('fs/promises');
const { foldGeminiRecords } = require('@agentlray/shared/gemini-format');
const { extractGeminiUserPromptText } = require('./parse');

async function extractGeminiPrompts(filePath) {
  const text = await fsp.readFile(filePath, 'utf8');
  const { metadata, messages } = foldGeminiRecords(text.split('\n').filter((l) => l.trim()));
  const prompts = [];
  let lastActivity = metadata.lastUpdated || null;
  for (const rec of messages) {
    if (rec.timestamp) lastActivity = rec.timestamp;
    const promptText = extractGeminiUserPromptText(rec);
    if (promptText) prompts.push({ text: promptText, timestamp: rec.timestamp || null });
  }
  return {
    cwd: Array.isArray(metadata.directories) && metadata.directories.length ? metadata.directories[0] : null,
    timestamp: metadata.startTime || null,
    lastActivity,
    title: metadata.summary || null,
    prompts,
  };
}

module.exports = { extractGeminiPrompts };
