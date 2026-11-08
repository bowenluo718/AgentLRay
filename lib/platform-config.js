'use strict';
// 平台启停/替代的控制面（P0）。读写 ~/.agentlray/settings.json 的 platforms section：
//   { disabled: string[], replaced: string[] }
// 本模块只依赖 lib/settings（SETTINGS_FILE/readSettings/saveSections）与 lib/config，
// 禁止 require lib/platforms —— catalog 一律由调用方以参数传入（防 require 环）。
const fs = require('fs');
const { SETTINGS_FILE, readSettings, saveSections } = require('./settings');

// 平台 id 契约（与 loader 同一正则，本模块本地持有以独立于 lib/platforms）。
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;

// 规范化 id 列表：过滤非法/非字符串、去重、保序。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const v of value) {
    if (typeof v !== 'string' || !ID_RE.test(v)) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

// 解析 platforms section（缺失/损坏 → 空）。容忍顶层非对象。
function parseSection(data) {
  const platforms = data && typeof data === 'object' && !Array.isArray(data) ? data.platforms : null;
  const section = platforms && typeof platforms === 'object' && !Array.isArray(platforms) ? platforms : {};
  return {
    disabled: normalizeIdList(section.disabled),
    replaced: normalizeIdList(section.replaced),
  };
}

// registry 唯一 require 期同步读：fs.readFileSync + JSON.parse。
// 缺失/损坏/非法 id → 容错回 { disabled: [], replaced: [] }。
function readPlatformStateSync() {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    parsed = null;
  }
  return parseSection(parsed);
}

async function loadPlatformSection() {
  let data;
  try {
    data = await readSettings();
  } catch {
    data = null;
  }
  return parseSection(data);
}

async function savePlatformSection(section) {
  const clean = parseSection({ platforms: section });
  await saveSections({ platforms: clean });
  return clean;
}

// 可查询谓词：平台具备任一列表 hook（list / listForAgent / listAllAgents）。
function isQueryable(p) {
  return Boolean(
    p &&
      (typeof p.list === 'function' ||
        typeof p.listForAgent === 'function' ||
        typeof p.listAllAgents === 'function')
  );
}

// catalog 访问辅助：兼容 Map 与 plain object 两种形态。
function catalogGet(catalog, id) {
  if (!catalog) return undefined;
  return catalog instanceof Map ? catalog.get(id) : catalog[id];
}
function catalogHas(catalog, id) {
  return catalogGet(catalog, id) !== undefined;
}
function catalogValues(catalog) {
  if (!catalog) return [];
  return catalog instanceof Map ? [...catalog.values()] : Object.values(catalog);
}

// 挂载/停用：更新 disabled。守卫：catalog − (disabled ∪ {id}) 至少 1 个可查询平台
// （连续 unmount 最后一个可查询平台也拒绝）。重启后生效。
async function setPlatformMounted(id, mounted, catalog) {
  if (!catalogHas(catalog, id)) {
    const e = new Error(`Unknown platform '${id}'.`);
    e.code = 'unknown-platform';
    throw e;
  }
  const state = await loadPlatformSection();
  const disabled = normalizeIdList(state.disabled.filter((x) => x !== id));
  if (!mounted) disabled.push(id);
  // 按操作后的效果校验：剩余可查询平台至少 1 个。
  // catalog 值可能是 {adapter, origin, …} 包装（index.js ALL_PLATFORMS）或裸适配器
  // （测试/调用方自定义）——统一先解包 adapter 再判查询能力。
  const entries = catalogValues(catalog).map((p) => (p && p.adapter ? p.adapter : p));
  const queryable = entries.filter((p) => !disabled.includes(p.id) && isQueryable(p));
  if (queryable.length < 1) {
    const e = new Error('Cannot disable the last queryable platform.');
    e.code = 'last-platform';
    throw e;
  }
  await savePlatformSection({ disabled, replaced: state.replaced });
  return { id, mounted, restart: true };
}

// 替代声明：更新 replaced。重启后生效。
async function setPlatformReplaced(id, replaced, catalog) {
  if (!catalogHas(catalog, id)) {
    const e = new Error(`Unknown platform '${id}'.`);
    e.code = 'unknown-platform';
    throw e;
  }
  const state = await loadPlatformSection();
  const replacedList = normalizeIdList(state.replaced.filter((x) => x !== id));
  if (replaced) replacedList.push(id);
  await savePlatformSection({ disabled: state.disabled, replaced: replacedList });
  return { id, replaced, restart: true };
}

module.exports = {
  ID_RE,
  normalizeIdList,
  readPlatformStateSync,
  loadPlatformSection,
  savePlatformSection,
  isQueryable,
  setPlatformMounted,
  setPlatformReplaced,
  catalogGet,
  catalogHas,
  catalogValues,
};
