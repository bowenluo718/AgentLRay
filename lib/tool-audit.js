'use strict';
const { dirFor } = require('./dirs-config');
const { PLATFORMS, surfacePlatforms } = require('./platforms');
const { collectFiles, iterateFiles } = require('./analyze');
const {
  scanFileForToolAudit,
  loadPersistedToolAudit,
  savePersistedToolAudit,
} = require('./platforms/shared/tool-audit');

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
// 能力谓词由注册表统一声明（surfacePlatforms('tool-audit')）。
const TOOL_AUDIT_PLATFORMS = surfacePlatforms('tool-audit').map((p) => p.id);
const TOOL_AUDIT_TTL_MS = 5 * 60 * 1000;
const toolAuditCache = new Map(); // key → { expires, data }

async function computeToolAudit(platform, dirs) {
  const platforms = platform === 'all' ? TOOL_AUDIT_PLATFORMS : [platform];
  const tools = new Map(); // name → { platforms, calls, errors, totalMs, msCount, lastUsedMs, sessions }

  for (const p of platforms) {
    const adapter = PLATFORMS[p];
    if (!adapter || typeof adapter.defaultDir !== 'function') continue;
    const dir = dirFor(adapter, dirs[p]);

    // 1) adapter 整体接管（扫描结果直接累加进共享 tools）
    if (typeof adapter.computeToolAudit === 'function') {
      await adapter.computeToolAudit(dir, { tools, platform: p }).catch(() => {});
      continue;
    }
    // 2) 通用实现：collectFiles + 平台扫描器（缺省 scanFileForToolAudit）
    if (typeof adapter.collectFiles !== 'function') continue;
    const files = await collectFiles(adapter, dir, { agent: '' });
    const scanOne =
      typeof adapter.scanToolAuditFile === 'function' ? adapter.scanToolAuditFile : scanFileForToolAudit;
    // 逐文件扫描走共享遍历 seam（容错），单个坏文件不拖垮整批。
    await iterateFiles(files, async (f) => {
      await scanOne(f.path, tools, p);
      return true; // 工具审计的扫描是副作用累积（写入 shared tools），无失败即继续
    });
  }

  const usedNames = [...tools.keys()].map((n) => n.toLowerCase());

  // configuredUnused（H1）：由各声明 configuredTools 的平台贡献「已配置但可能未被使用」的工具，
  // 不再无条件注入 claude MCP 名单（避免污染 dsh/hermes/自定义平台的审计结果）。
  const configuredUnused = [];
  for (const p of platforms) {
    const adapter = PLATFORMS[p];
    if (!adapter || typeof adapter.configuredTools !== 'function') continue;
    let configured;
    try {
      configured = (await adapter.configuredTools()) || [];
    } catch {
      continue; // 单平台 configuredTools 异常不拖垮整个审计
    }
    for (const item of configured) {
      if (!item || typeof item.name !== 'string') continue;
      const markers = Array.isArray(item.markers) && item.markers.length > 0 ? item.markers : [item.name.toLowerCase()];
      const used = usedNames.some((n) => markers.some((m) => n.includes(m)));
      if (!used) configuredUnused.push({ name: item.name, source: item.source || p });
    }
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
  loadPersistedToolAudit,
  savePersistedToolAudit,
  computeToolAudit,
};
