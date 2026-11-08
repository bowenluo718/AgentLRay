'use strict';
const { resolveDir } = require('./config');
const { PLATFORMS } = require('./platforms');
const {
  scanFileForToolAudit,
  loadPersistedToolAudit,
  savePersistedToolAudit,
} = require('./platforms/shared/tool-audit');
const { readClaudeMcpServers } = require('./platforms/builtin/claude-code/tool-audit');

// --- Tool Audit: per-tool usage/health across platforms ---
// Streams every session file once, collecting toolCall records/content-parts
// (name, callId, timestamp) and toolResult records (callId, timestamp, isError).
// callId pairing yields durations and attributes results to the real tool name
// (claude tool_result / codex outputs don't carry one). configuredUnused
// surfaces claude MCP servers (~/.claude.json mcpServers keys) never matched
// by any used tool name containing mcp__<server>.
// 单文件扫描与持久化纯实现已下沉到 lib/platforms/tool-audit-impl.js（模块边界脚手架）。

// 可审计平台：已挂载且声明文件枚举（collectFiles）或整体扫描 hook（computeToolAudit）。
// 不再硬编码内置平台表——自定义平台声明任一能力即自动进入审计面。
const TOOL_AUDIT_PLATFORMS = Object.values(PLATFORMS)
  .filter((p) => typeof p.collectFiles === 'function' || typeof p.computeToolAudit === 'function')
  .map((p) => p.id);
const TOOL_AUDIT_TTL_MS = 5 * 60 * 1000;
const toolAuditCache = new Map(); // key → { expires, data }

async function computeToolAudit(platform, dirs) {
  const platforms = platform === 'all' ? TOOL_AUDIT_PLATFORMS : [platform];
  const tools = new Map(); // name → { platforms, calls, errors, totalMs, msCount, lastUsedMs, sessions }

  for (const p of platforms) {
    const adapter = PLATFORMS[p];
    if (!adapter || typeof adapter.defaultDir !== 'function') continue;
    const dir = resolveDir(dirs[p], adapter.defaultDir());

    // 1) adapter 整体接管（扫描结果直接累加进共享 tools）
    if (typeof adapter.computeToolAudit === 'function') {
      await adapter.computeToolAudit(dir, { tools, platform: p }).catch(() => {});
      continue;
    }
    // 2) 通用实现：collectFiles + 平台扫描器（缺省 scanFileForToolAudit）
    if (typeof adapter.collectFiles !== 'function') continue;
    const files = await adapter.collectFiles(dir, { agent: '' });
    const scanOne =
      typeof adapter.scanToolAuditFile === 'function' ? adapter.scanToolAuditFile : scanFileForToolAudit;
    for (const f of files) {
      // hook 可为同步或 async；统一包一层 Promise 再挂 catch。
      await Promise.resolve(scanOne(f.path, tools, p)).catch(() => {});
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
