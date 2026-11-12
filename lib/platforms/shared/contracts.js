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
    // otlp 能力位与注册表 PLATFORM_SURFACES.otlp 同口径（find + parse + !needsAgent，
    // 文件型且无需 agent 的平台可导出 OTLP）。历史实现查不存在的 otlpSession hook，
    // 全平台恒为 false，与 surfacePlatforms('otlp') 脱节——此处收敛到同一谓词。
    otlp: typeof p.find === 'function' && typeof p.parse === 'function' && !p.needsAgent,
  };
}

// 生成「声明了某契约的平台 id 名单」文案（单一真源）：按 contractFn 过滤 platforms 数组，
// 以 ' / ' 连接。platforms 由调用方传入（有注册表上下文处传 Object.values(PLATFORMS)），
// 此纯函数不 require registry，守「共享层不依赖注册表」红线。
function formatContractPlatforms(platforms, contractFn) {
  const ids = (platforms || [])
    .filter((p) => p && contractFn(p))
    .map((p) => p.id)
    .filter(Boolean);
  return ids.length > 0 ? ids.join(' / ') : 'no platforms';
}

// exec-spawn 契约：平台声明可作为「外部 exec 子命令目标」（openclaw 的 exec 调用 spawn）。
// 契约：execSpawn: { commands: string[] }。返回命中的命令名数组（小写，去空白），
// 未声明返回 []。纯函数，供注册表 resolveExecSpawn 与前端的 exec-spawn 目标派生使用。
function execSpawnCommands(platform) {
  const es = platform && platform.execSpawn;
  if (!es || typeof es !== 'object' || !Array.isArray(es.commands)) return [];
  return es.commands
    .map((c) => (typeof c === 'string' ? c.trim().toLowerCase() : ''))
    .filter(Boolean);
}

module.exports = {
  hasResumeContract,
  hasCreateContract,
  capabilityBits,
  formatContractPlatforms,
  execSpawnCommands,
};
