'use strict';
// 平台能力契约（纯函数，P1）：resume/create 契约与能力位推导。
// 不 require registry —— 平台对象由调用方传入（内置或自定义适配器）。
//
// resume/create 契约语义（与旧 lib/resume.js / lib/new.js 完全一致）：
//   resume: { bin: string, args(id, opts) -> string[] }，缺一视为未声明；
//   create: { bin: string, args(opts) -> string[] }，缺一视为未声明。

function hasResumeContract(platform) {
  const resume = platform && platform.resume;
  return Boolean(
    resume &&
      typeof resume === 'object' &&
      typeof resume.bin === 'string' &&
      resume.bin.trim() !== '' &&
      typeof resume.args === 'function'
  );
}

function hasCreateContract(platform) {
  const create = platform && platform.create;
  return Boolean(
    create &&
      typeof create === 'object' &&
      typeof create.bin === 'string' &&
      create.bin.trim() !== '' &&
      typeof create.args === 'function'
  );
}

// 能力位：除 list/find/parse/getSession/collectFiles/watchParse/needsAgent 外，
// 再映射 listForAgent/listAllAgents/listAgents/children/spawn/watch/search/
// insights/prompts/toolAudit/inspect/otlp（存在对应 hook 即 true）。
function capabilityBits(p) {
  return {
    list: typeof p.list === 'function',
    find: typeof p.find === 'function',
    parse: typeof p.parse === 'function',
    getSession: typeof p.getSession === 'function',
    collectFiles: typeof p.collectFiles === 'function',
    watchParse: typeof p.watchParse === 'function',
    needsAgent: Boolean(p.needsAgent),
    listForAgent: typeof p.listForAgent === 'function',
    listAllAgents: typeof p.listAllAgents === 'function',
    listAgents: typeof p.listAgents === 'function',
    children: typeof p.listChildren === 'function' || typeof p.getChild === 'function',
    spawn: typeof p.spawnMap === 'function' || typeof p.spawnTree === 'function',
    watch: typeof p.watch === 'function',
    search: typeof p.search === 'function' || typeof p.searchFile === 'function',
    insights: typeof p.computeInsights === 'function' || typeof p.insightsScanFile === 'function',
    prompts: typeof p.extractPrompts === 'function' || typeof p.extractPromptsFromFile === 'function',
    toolAudit: typeof p.computeToolAudit === 'function' || typeof p.scanToolAuditFile === 'function',
    inspect: Boolean(p.inspect),
    otlp: typeof p.otlpSession === 'function',
  };
}

module.exports = { hasResumeContract, hasCreateContract, capabilityBits };
