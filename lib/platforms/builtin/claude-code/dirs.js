'use strict';
// claude-code 平台目录声明（真源，替代 lib/config 的 CLAUDE_CODE_DIR 及各散点硬编码）。
//   session     会话项目根：CLAUDE_CODE_DIR 覆盖，缺省 ~/.claude/projects。
//   historyFile 提示词历史：~/.claude/history.jsonl（claude CLI 自身文件，root 'home'）。
//   claudeJson  MCP server 配置：~/.claude.json（claude CLI 自身文件，root 'home'）。
//   commands    库安装目标：~/.claude/commands（claude CLI 自身文件，root 'home'）。
// 注：散点 root 'home' 刻意不挂 AGENTLRAY_HOME —— 它们是 claude CLI 自己的文件，
// 语义上不属于 agentlray 数据（ADR design-platform-dir-decl 修订 ADR-0003 D1）。
const { resolveDirs } = require('@agentlray/shared/config');

module.exports = {
  env: 'CLAUDE_CODE_DIR',
  session: resolveDirs({ env: 'CLAUDE_CODE_DIR', segments: ['.claude', 'projects'] }),
  historyFile: resolveDirs({ env: 'CLAUDE_CODE_HISTORY', root: 'home', segments: ['.claude', 'history.jsonl'] }),
  claudeJson: resolveDirs({ root: 'home', segments: ['.claude.json'] }),
  commands: resolveDirs({ root: 'home', segments: ['.claude', 'commands'] }),
};
