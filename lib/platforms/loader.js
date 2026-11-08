'use strict';
// 平台适配器加载器（P0/P1）：把 package 内置 + project 目录 + user 目录三来源
// 合并进 catalog，按 §2.2/§2.3 处理同 id。加载为同步实现——lib/platforms/index.js
// 在模块 require 期完成合并，下游 lib/export.js、lib/otlp.js、lib/session-list.js、
// CLI 等都在 require 期同步从 PLATFORMS 派生平台集，任何异步都会使这些派生点
// 看不到自定义平台。startup 期几十个文件的同步 require 开销可接受。
//
// 三来源：
//   package —— index.js 传入的内置适配器数组（origin: 'package'）
//   project —— $AGENTLRAY_PROJECT_PLATFORMS_DIR 或 <repo>/platforms（origin: 'project'）
//   user    —— $AGENTLRAY_PLATFORMS_DIR 或 ~/.agentlray/platforms（origin: 'user'）
//
// 同 id 规则（§2.2/§2.3）：
//   新 id 加入；同来源重复 broken；project/user 覆盖 package 仅当 replaced.has(id)；
//   user 覆盖 project 允许；未声明替代的同 id 一律 broken（含「先 export/replace」提示）。
//   AGENTLRAY_NO_PLUGINS=1 跳过 project+user，只保留 package。
//   manifest.replaces 并入生效替代集合（settings.replaced ∪ manifest.replaces）。
const fs = require('fs');
const path = require('path');
const { HOME } = require('../config');

// 包根：加载前设置，供 project 来源缺省目录（<repo>/platforms）解析。
process.env.AGENTLRAY_PKG_ROOT = path.resolve(__dirname, '..', '..');

const PLATFORM_DIR = path.join(HOME, '.agentlray', 'platforms');

// 平台 id 契约：小写字母/数字开头，仅小写字母、数字、连字符。
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// 必需函数。list 保持既有 null 语义（openclaw.list 即 null）；parse 放宽为可 null
// （SQLite 型平台如 hermes 无会话文件可解析）。getSession 仍强制。
const REQUIRED_FUNCS = ['defaultDir', 'getSession'];

function errorText(err) {
  return err && err.message ? String(err.message) : String(err);
}

// catalog 访问辅助（兼容 Map 与 plain object）。
function catalogHas(catalog, id) {
  if (!catalog) return false;
  return catalog instanceof Map ? catalog.has(id) : catalog[id] !== undefined;
}
function catalogGet(catalog, id) {
  if (!catalog) return undefined;
  return catalog instanceof Map ? catalog.get(id) : catalog[id];
}

// 校验单个适配器。返回 { error, id? } 或 { ok: true }。
// catalog 为已装载的来源集合（Map 或 plain object）；replaced 为替代声明集合（Set）。
// 同 id 判定：
//   - 未声明替代时，与既有（包内置或先前来源）冲突 → broken，提示「先 export/replace」；
//   - 声明替代且目标是包内置 → 允许覆盖（本函数不落盘，由调用方 register）。
function validateAdapter(adapter, catalog, { replaced } = {}) {
  const replacedSet = replaced || new Set();
  if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { id: null, error: '导出非对象（module.exports 需为对象）' };
  }
  if (typeof adapter.id !== 'string' || !ID_RE.test(adapter.id)) {
    const id = typeof adapter.id === 'string' ? adapter.id : null;
    return { id, error: `id 不合法（需匹配 ${ID_RE.source}）：${String(adapter.id)}` };
  }
  for (const fnName of REQUIRED_FUNCS) {
    if (typeof adapter[fnName] !== 'function') {
      return { id: adapter.id, error: `缺少必需函数 ${fnName}` };
    }
  }
  if (typeof adapter.label !== 'string') {
    return { id: adapter.id, error: 'label 必须是字符串' };
  }
  if (catalogHas(catalog, adapter.id)) {
    const existing = catalogGet(catalog, adapter.id);
    const existingOrigin = existing && typeof existing === 'object' ? existing.origin : null;
    // 覆盖包内置需已声明替代；否则 broken（提示先 export/replace）。
    if (existingOrigin === 'package') {
      if (!replacedSet.has(adapter.id)) {
        return {
          id: adapter.id,
          error: `id 已被占用：${adapter.id}。请先 agentlray platform export <id> 或 platform replace <id>`,
        };
      }
      // 已声明替代 → 允许覆盖，交由调用方 register 落 catalog。
      return { ok: true };
    }
    // project/user 之间的同 id：由 loadDirIntoCatalog 决定覆盖关系（user 覆盖
    // project / 同源重复 broken），validateAdapter 不在此拦截。
    return { ok: true };
  }
  return { ok: true };
}

// 遗留 API：仅加载 user 来源并入给定 registry（plain object，id → adapter），
// 返回 { customAdapters, brokenAdapters }（旧形状）。供既有测试与工具复用。
// registry 预置包内置（index.js 传入 PLATFORMS）；同 id 冲突一律 broken。
function loadPlatformAdapters(registry) {
  const customAdapters = [];
  const brokenAdapters = [];

  if (process.env.AGENTLRAY_NO_PLUGINS === '1') {
    brokenAdapters.push({
      file: '(AGENTLRAY_NO_PLUGINS=1)',
      label: null,
      id: null,
      error: '自定义平台已禁用（AGENTLRAY_NO_PLUGINS=1）',
    });
    return { customAdapters, brokenAdapters };
  }

  const userDir = process.env.AGENTLRAY_PLATFORMS_DIR || PLATFORM_DIR;
  let files;
  try {
    files = fs.readdirSync(userDir).filter((name) => name.endsWith('.js')).sort();
  } catch {
    return { customAdapters, brokenAdapters };
  }

  for (const file of files) {
    const fullPath = path.join(userDir, file);
    let adapter;
    try {
      adapter = require(fullPath);
    } catch (err) {
      brokenAdapters.push({ file, label: null, id: null, error: errorText(err) });
      continue;
    }
    const check = validateAdapter(adapter, registry, { replaced: new Set() });
    if (!check.ok) {
      brokenAdapters.push({ file, label: null, id: check.id, error: check.error });
      continue;
    }
    // 遗留 API 的 registry 是不带 origin 的 plain object（预置包内置）；validateAdapter
    // 依 origin 放行 project/user 覆盖，但这里一律拒绝与已存在 id 冲突（保持旧行为）。
    if (registry[adapter.id]) {
      brokenAdapters.push({ file, label: null, id: adapter.id, error: `id 已被占用：${adapter.id}` });
      continue;
    }
    registry[adapter.id] = adapter;
    customAdapters.push(adapter);
  }

  return { customAdapters, brokenAdapters };
}

// 新核心 API：三来源合并 → { catalog, broken }。
// catalog: Map<id, { adapter, origin, overrides, replacementPending }>
//   —— 含全部有效条目（含 disabled 的包内置、被替代的包内置、replacementPending）。
// broken:   [{ id?, file, origin, broken: true, error, mounted: false }]
function loadPlatformSources({ packageAdapters, disabled = [], replaced = [] }) {
  const disabledSet = new Set(disabled);
  const replacedSet = new Set(replaced);
  const catalog = new Map();
  const broken = [];

  const addBroken = (file, origin, id, error) => {
    broken.push({ id: id ?? null, file, origin, broken: true, error, mounted: false });
  };

  const register = (id, adapter, origin, overrides = null) => {
    catalog.set(id, { adapter, origin, overrides, replacementPending: false });
  };

  // 1. package 来源（固定顺序：调用方传入的内置数组序）
  const pkg = Array.isArray(packageAdapters) ? packageAdapters : [];
  for (const adapter of pkg) {
    if (!adapter || typeof adapter.id !== 'string') continue;
    register(adapter.id, adapter, 'package');
  }

  // 项目目录（优先用于 manifest 读取与来源加载；NO_PLUGINS 时跳过）。
  const projectDir =
    process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR || path.join(process.env.AGENTLRAY_PKG_ROOT, 'platforms');
  const noPlugins = process.env.AGENTLRAY_NO_PLUGINS === '1';

  // manifest.replaces → 并入生效替代集合（与 settings.replaced 求并集）。
  // manifest 缺失/损坏 → 忽略不失败（不影响目录内已加载的平台）。
  // 必须在加载 project/user 目录【之前】读取，使项目适配器的同 id 覆盖判定
  // 能立即看到 manifest 声明的替代，而不会在该轮被误判 broken。
  if (!noPlugins) {
    const manifestIds = readProjectManifestReplaces(projectDir);
    for (const id of manifestIds) {
      if (ID_RE.test(id)) replacedSet.add(id);
    }
  }

  // 2/3. project + user 来源
  if (noPlugins) {
    addBroken('(AGENTLRAY_NO_PLUGINS=1)', 'user', null, '自定义平台已禁用（AGENTLRAY_NO_PLUGINS=1）');
  } else {
    const userDir = process.env.AGENTLRAY_PLATFORMS_DIR || PLATFORM_DIR;
    loadDirIntoCatalog(projectDir, 'project', catalog, broken, addBroken, register, replacedSet);
    loadDirIntoCatalog(userDir, 'user', catalog, broken, addBroken, register, replacedSet);
  }

  // 4. 替代回退：声明了替代但未被 project/user 覆盖（文件缺失/损坏/未覆盖）→
  //    包内置保留，标记 replacementPending。
  for (const id of replacedSet) {
    const entry = catalog.get(id);
    if (entry && entry.origin === 'package') {
      entry.replacementPending = true;
    }
  }

  return { catalog, broken };
}

// 读取项目目录的 manifest.json 的 replaces 数组。缺失/损坏/缺字段 → 空数组（不抛错）。
function readProjectManifestReplaces(projectDir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(projectDir, 'manifest.json'), 'utf8'));
  } catch {
    return [];
  }
  const replaces = parsed && typeof parsed === 'object' && Array.isArray(parsed.replaces) ? parsed.replaces : [];
  return replaces.filter((v) => typeof v === 'string');
}

function loadDirIntoCatalog(dir, origin, catalog, broken, addBroken, register, replacedSet) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort();
  } catch {
    return; // 目录不存在/读取失败 → 无该来源
  }
  for (const file of files) {
    const fullPath = path.join(dir, file);
    let adapter;
    try {
      adapter = require(fullPath);
    } catch (err) {
      addBroken(file, origin, null, errorText(err));
      continue;
    }
    const check = validateAdapter(adapter, catalog, { replaced: replacedSet });
    if (!check.ok) {
      addBroken(file, origin, check.id, check.error);
      continue;
    }
    const id = adapter.id;
    if (catalog.has(id)) {
      const existing = catalog.get(id);
      if (existing.origin === origin) {
        // 同来源重复 id：后加载者 broken，先加载者保留
        addBroken(file, origin, id, `id 已被占用：${id}`);
        continue;
      }
      if (existing.origin === 'package') {
        // project/user 覆盖 package：validateAdapter 已确认 replacedSet.has(id)
        register(id, adapter, origin, 'package');
        continue;
      }
      // existing.origin === 'project'（user 覆盖 project 允许，更本地者生效）
      register(id, adapter, origin, existing.origin);
      continue;
    }
    register(id, adapter, origin);
  }
}

module.exports = {
  PLATFORM_DIR,
  ID_RE,
  REQUIRED_FUNCS,
  errorText,
  // 校验函数导出供 CLI `platform validate` 复用同一套校验（见 bin/platform.js）。
  validateAdapter,
  readProjectManifestReplaces,
  loadPlatformAdapters,
  loadPlatformSources,
};
