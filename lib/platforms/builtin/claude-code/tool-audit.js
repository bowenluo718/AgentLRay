'use strict';
// claude-code 平台专属 tool-audit：~/.claude.json 的 MCP server 名。通用
// toolAuditEntry/scanFileForToolAudit 取自 ../../shared/tool-audit。

const os = require('os');
const fsp = require('fs/promises');
const path = require('path');

// Claude MCP server names from ~/.claude.json: top-level mcpServers keys plus
// per-project mcpServers keys. A missing or corrupt file yields an empty list.
async function readClaudeMcpServers() {
  let cfg;
  try {
    cfg = JSON.parse(await fsp.readFile(path.join(os.homedir(), '.claude.json'), 'utf8'));
  } catch {
    return [];
  }
  if (!cfg || typeof cfg !== 'object') return [];
  const names = new Set();
  if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
    for (const name of Object.keys(cfg.mcpServers)) names.add(name);
  }
  if (cfg.projects && typeof cfg.projects === 'object') {
    for (const proj of Object.values(cfg.projects)) {
      if (proj && proj.mcpServers && typeof proj.mcpServers === 'object') {
        for (const name of Object.keys(proj.mcpServers)) names.add(name);
      }
    }
  }
  return [...names];
}

module.exports = { readClaudeMcpServers };
