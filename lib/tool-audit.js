'use strict';
const { PLATFORMS, collectSessionFiles } = require('./platforms');
const { scanFileForToolAudit, readClaudeMcpServers, loadPersistedToolAudit, savePersistedToolAudit } = require('./platforms/tool-audit-impl');

// --- Tool Audit: per-tool usage/health across platforms ---
// Streams every session file once, collecting toolCall records/content-parts
// (name, callId, timestamp) and toolResult records (callId, timestamp, isError).
// callId pairing yields durations and attributes results to the real tool name
// (claude tool_result / codex outputs don't carry one). configuredUnused
// surfaces claude MCP servers (~/.claude.json mcpServers keys) never matched
// by any used tool name containing mcp__<server>.
// 单文件扫描与持久化纯实现已下沉到 lib/platforms/tool-audit-impl.js（模块边界脚手架）。

// Every file-based platform is auditable (hermes has no session files).
const TOOL_AUDIT_PLATFORMS = Object.values(PLATFORMS)
  .filter((p) => p.collectFiles)
  .map((p) => p.id);
const TOOL_AUDIT_TTL_MS = 5 * 60 * 1000;
const toolAuditCache = new Map(); // key → { expires, data }

async function computeToolAudit(platform, dirs) {
  const platforms = platform === 'all' ? TOOL_AUDIT_PLATFORMS : [platform];
  const tools = new Map(); // name → { platforms, calls, errors, totalMs, msCount, lastUsedMs, sessions }

  for (const p of platforms) {
    const files = await collectSessionFiles(p, '', dirs[p] || '');
    for (const f of files) {
      await scanFileForToolAudit(f.path, tools, p).catch(() => {});
    }
  }

  const usedNames = [...tools.keys()].map((n) => n.toLowerCase());
  const configuredUnused = [];
  for (const server of await readClaudeMcpServers()) {
    const marker = `mcp__${server.toLowerCase()}`;
    if (!usedNames.some((n) => n.includes(marker))) configuredUnused.push({ name: server, source: 'claude-mcp' });
  }

  return {
    generatedAt: new Date().toISOString(),
    tools: [...tools.entries()]
      .map(([name, t]) => ({
        name,
        platforms: [...t.platforms],
        calls: t.calls,
        errors: t.errors,
        errorRate: t.calls > 0 ? Math.round((t.errors / t.calls) * 10000) / 10000 : 0,
        avgMs: t.msCount > 0 ? Math.round(t.totalMs / t.msCount) : null,
        lastUsed: t.lastUsedMs ? new Date(t.lastUsedMs).toISOString() : null,
        sessions: t.sessions,
      }))
      .sort((a, b) => b.calls - a.calls),
    configuredUnused,
  };
}

module.exports = {
  TOOL_AUDIT_PLATFORMS,
  TOOL_AUDIT_TTL_MS,
  toolAuditCache,
  scanFileForToolAudit,
  readClaudeMcpServers,
  loadPersistedToolAudit,
  savePersistedToolAudit,
  computeToolAudit,
};
