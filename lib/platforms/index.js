'use strict';
// 平台注册表（P0/P1 重构）：从「内联对象 + 单来源自定义加载」改为
// 「三来源（package / project / user）→ catalog」的统一单一真源。
//
//   package —— 内置 ×7 适配器（lib/platforms/builtin/*.js，逐字搬迁 + 声明字段）
//   project —— $AGENTLRAY_PROJECT_PLATFORMS_DIR 或 <repo>/platforms
//   user    —— $AGENTLRAY_PLATFORMS_DIR 或 ~/.agentlray/platforms
//
// require 期同步合并（readPlatformStateSync + loadPlatformSources）：下游
// lib/export.js、lib/otlp.js、lib/session-list.js、lib/routes、CLI 都在 require 期
// 从 PLATFORMS 派生平台集，任何异步都会使这些派生点看不到自定义平台。
//
// 下游兼容面（本文件对外契约，保持零回归）：
//   - PLATFORMS —— 已挂载（未 disabled）的 plain object，id → adapter 本体
//     （export / otlp / session-list / routes 均按此消费）
//   - collectSessionFiles(platform, agentName, dirOverride, opts)
//   - listPlatformInfo(options) —— 平台清单单一真源（路由 /api/platforms 与 CLI 共用）
//   - ALL_PLATFORMS（catalog 含 disabled）、BROKEN、isMounted、defaultPlatformId
const path = require('path');
const { resolveDir } = require('../config');
const { hasResumeContract, hasCreateContract, capabilityBits } = require('./shared/contracts');
const { readPlatformStateSync } = require('../platform-config');
const { loadPlatformSources } = require('./loader');
const { installSharedAlias } = require('./shared-alias');

// 必须先于任何 builtin require 注册 @agentlray/shared 别名，否则内置平台代码
// 里的裸名 require 无法解析。
installSharedAlias();

// 内置固定插入序：openclaw, codex, claude-code, omp
// （dsh / gemini / hermes 已迁移为项目平台，从 <repo>/platforms 经 project 来源加载）。
const openclaw = require('./builtin/openclaw/index');
const codex = require('./builtin/codex/index');
const claudeCode = require('./builtin/claude-code/index');
const omp = require('./builtin/omp/index');

// 内置固定插入序在 package 来源最前，其后项目/用户来源按文件名序
// （保证 Object.keys 序与默认平台 openclaw 不变）。
const BUILTIN_ORDER = ['openclaw', 'codex', 'claude-code', 'omp'];
const BUILTINS = { openclaw, codex, 'claude-code': claudeCode, omp };
const packageAdapters = BUILTIN_ORDER.map((id) => BUILTINS[id]);

// require 期唯一同步读：settings 的 platforms section（disabled / replaced）。
const state = readPlatformStateSync();
const disabledSet = new Set(state.disabled);

const { catalog, broken: BROKEN } = loadPlatformSources({
  packageAdapters,
  disabled: state.disabled,
  replaced: state.replaced,
});

// PLATFORMS：已挂载（未 disabled）的 plain object，id → adapter（adapter 本体）。
// 插入序 = catalog 序（内置固定序在前，其后 project / user 按文件名序）。
const PLATFORMS = {};
for (const [id, entry] of catalog) {
  if (!disabledSet.has(id)) PLATFORMS[id] = entry.adapter;
}

// ALL_PLATFORMS：catalog（含 disabled 的包内置、被替代/待替代条目）。
const ALL_PLATFORMS = catalog;

function isMounted(id) {
  return Boolean(PLATFORMS[id]);
}

// 缺省平台：第一个已挂载平台（catalog 序）。空配置下即 openclaw（与既有
// 「req.query.platform || 'openclaw'」语义零回归）。设置面板禁用经重启生效，
// require 期 PLATFORMS 仍含被禁用平台直至重启——与「重启后生效」一致。
function defaultPlatformId() {
  for (const [id] of catalog) {
    if (!disabledSet.has(id)) return id;
  }
  return null;
}

// 收集平台全部会话文件路径，解析目录覆盖。非文件型平台（hermes）返回 []。
async function collectSessionFiles(platform, agentName, dirOverride, opts = {}) {
  const p = PLATFORMS[platform];
  if (!p || !p.collectFiles) return [];
  const dir = resolveDir(dirOverride, p.defaultDir());
  return p.collectFiles(dir, { agent: agentName || '', ...opts });
}

// 兼容字段：origin !== 'user'（包内置与项目来源视为 builtin；被用户替代后 false）。
function isBuiltin(origin) {
  return origin !== 'user';
}

// --- 能力驱动的表面投影（唯一事实来源）---
// 各「平台表面」（export / otlp / tool-audit）在此只声明一次能力谓词，注册表统一作答。
// 新增表面只需在此加一行；消费方（lib/export.js、lib/otlp.js、lib/tool-audit.js）只取
// surfacePlatforms 返回的适配器子集，不再各自重推导过滤谓词（旧实现三处漂移）。
// 谓词作用于适配器本体，与 capabilityBits() 词表一致但按表面精确声明，保持零回归。
const PLATFORM_SURFACES = {
  // export：全部已挂载平台皆可导出（load 走 getSession）。
  export: () => true,
  // otlp：文件型（find + parse）且无需 agent；openclaw 排除因 find 需 agent。
  otlp: (p) => typeof p.find === 'function' && typeof p.parse === 'function' && !p.needsAgent,
  // tool-audit：声明文件枚举（collectFiles）或整体扫描 hook（computeToolAudit）。
  'tool-audit': (p) =>
    typeof p.collectFiles === 'function' || typeof p.computeToolAudit === 'function',
};

// 返回满足命名表面能力谓词的已挂载适配器数组。
function surfacePlatforms(name) {
  const pred = PLATFORM_SURFACES[name];
  if (typeof pred !== 'function') return [];
  return Object.values(PLATFORMS).filter(pred);
}

// defaultDir() 的容错调用（解析器异常不拖垮平台清单）。
function safeDefaultDir(p) {
  try {
    const d = p.defaultDir();
    return typeof d === 'string' && d ? d : null;
  } catch {
    return null;
  }
}

// PlatformInfo 单一真源：供 GET /api/platforms 与 CLI platform list 共用。
// 遍历 catalog（含 disabled），逐条计算 mounted / configuredMounted / restartRequired、
// origin / builtin / overrides / replacementPending 与能力位；broken 追加于尾。
// options.configured 为真时重新同步读 settings 的最新 platforms section，
// 用于 HTTP 层反映「未重启的配置」与「重启后生效」的差异。
function listPlatformInfo(options = {}) {
  const latest = options.configured ? readPlatformStateSync() : state;
  const latestDisabled = new Set(latest.disabled);
  const result = [];

  for (const [id, entry] of catalog) {
    const p = entry.adapter;
    const mounted = !disabledSet.has(id);
    const configuredMounted = !latestDisabled.has(id);
    result.push({
      id,
      label: typeof p.label === 'string' ? p.label : null,
      origin: entry.origin,
      builtin: isBuiltin(entry.origin),
      overrides: entry.overrides ?? null,
      replacementPending: Boolean(entry.replacementPending),
      // 替代声明（settings.platforms.replaced ∪ manifest.replaces）是否覆盖本 id：
      // 撤销替代入口需要区分「已声明但适配器缺失」（replacementPending）与「已声明且
      // 已被覆盖」（overrides === 'package'）——两者都要能撤销。
      replaced: latest.replaced.includes(id),
      mounted,
      configuredMounted,
      restartRequired: mounted !== configuredMounted,
      capabilities: capabilityBits(p),
      resume: hasResumeContract(p),
      create: hasCreateContract(p),
      bin: typeof p.bin === 'string' ? p.bin : null,
      dirSettingKey: typeof p.dirSettingKey === 'string' ? p.dirSettingKey : null,
      dirSettingLabel: typeof p.dirSettingLabel === 'string' ? p.dirSettingLabel : null,
      dirSettingHint: typeof p.dirSettingHint === 'string' ? p.dirSettingHint : null,
      dirParam: typeof p.dirParam === 'string' ? p.dirParam : null,
      // 默认数据目录的绝对路径（平台目录真源在平台文件，defaultDir() 解析）；
      // 供前端空状态展示用户应在哪里查日志。mounted 平台才可安全调用。
      defaultDir: mounted && typeof p.defaultDir === 'function' ? safeDefaultDir(p) : null,
      color: typeof p.color === 'string' ? p.color : null,
      broken: false,
    });
  }

  const brokenSorted = BROKEN.slice().sort((a, b) => String(a.file).localeCompare(String(b.file)));
  for (const b of brokenSorted) {
    result.push({
      id: b.id ?? null,
      label: null,
      origin: b.origin ?? 'user',
      builtin: isBuiltin(b.origin ?? 'user'),
      overrides: null,
      replacementPending: false,
      replaced: false,
      mounted: false,
      configuredMounted: false,
      restartRequired: false,
      capabilities: {
        list: false,
        find: false,
        parse: false,
        getSession: false,
        collectFiles: false,
        watchParse: false,
        needsAgent: false,
      },
      resume: false,
      create: false,
      bin: null,
      dirSettingKey: null,
      dirSettingLabel: null,
      dirSettingHint: null,
      dirParam: null,
      defaultDir: null,
      color: null,
      broken: true,
      error: b.error,
    });
  }

  return result;
}

module.exports = {
  PLATFORMS,
  ALL_PLATFORMS,
  BROKEN,
  isMounted,
  defaultPlatformId,
  collectSessionFiles,
  listPlatformInfo,
  PLATFORM_SURFACES,
  surfacePlatforms,
};
