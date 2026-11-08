'use strict';
// claude-code 平台专属搜索：Claude 的 retention 清理会删除会话文件，仅剩
// ~/.claude/history.jsonl 的提示词历史。searchClaudeHistory 主搜索完成后合并
// 这些已退役会话的命中。通用 extractSnippet 取自 ../../shared/search。

const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { extractSnippet } = require('../../shared/search');

// Claude Code prompt history (~/.claude/history.jsonl): surfaces prompts whose
// sessions were removed by Claude's cleanupPeriodDays retention. Grouped by
// project; prompts whose snippet already appears in a live hit are skipped.
async function searchClaudeHistory(claudeDir, keywords, liveSnippets) {
  const historyPath = path.join(os.homedir(), '.claude', 'history.jsonl');
  const byProject = new Map(); // project → matches[]
  const results = [];
  try {
    const stream = fs.createReadStream(historyPath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of rl) {
        const lower = line.toLowerCase();
        if (!keywords.every((kw) => lower.includes(kw))) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue;
        }
        const text = typeof rec.display === 'string' ? rec.display : '';
        const textLower = text.toLowerCase();
        if (!keywords.every((kw) => textLower.includes(kw))) continue;
        const snippet = extractSnippet(text, keywords[0]);
        const project = rec.project || '?';
        if (liveSnippets.has(snippet)) continue; // prompt belongs to a still-live session
        if (!byProject.has(project)) byProject.set(project, []);
        const matches = byProject.get(project);
        if (matches.length < 5) matches.push({ role: 'user', snippet, timestamp: rec.timestamp || null });
      }
    } finally {
      rl.close();
      stream.destroy();
    }
    for (const [project, matches] of byProject) {
      results.push({
        sessionId: null,
        file: 'history.jsonl',
        platform: 'claude-code',
        project,
        history: true,
        matches,
      });
    }
  } catch {
    /* no history file */
  }
  return results;
}

module.exports = { searchClaudeHistory };
