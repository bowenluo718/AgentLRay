'use strict';
// 统一设置文件：所有服务端设置聚合到单一 ~/.agentlray/settings.json。
// 结构：{ ui, cliBins, status, kanban, llm, updatedAt }——各 section 由对应
// lib 模块（ui-settings / cli-bins / status-config / kanban-config / llm）负责
// 白名单与校验，本模块只做整文件读、原子写与旧独立文件的一次性迁移。
//
// 约定：
//   - settings.json 缺失/损坏 → readSettings() 返回 {}（各 section 全部回退默认）。
//   - saveSections(partial) 读-改-原子写（tmp + rename），仅改写传入的 section，
//     未涉及的 section 与旧版本升级无关的键保持不动。
//   - migrateLegacySettings() 幂等：settings.json 已存在则不动作；否则把旧 5 个
//     <name>.json 内容并入 settings.json，成功后删除旧文件。server 与 CLI 入口
//     各调一次（Q-B 结论），保证纯 CLI 用户升级后也读到旧配置。
const path = require('path');
const fsp = require('fs/promises');
const { HOME } = require('./config');

const SETTINGS_FILE = path.join(HOME, '.agentlray', 'settings.json');

// 旧版独立设置文件 → 新聚合文件 section 键。
const LEGACY_SECTION_BY_FILE = {
  'ui-settings.json': 'ui',
  'cli-bins.json': 'cliBins',
  'status-config.json': 'status',
  'kanban-config.json': 'kanban',
  'llm.json': 'llm',
};

async function readSettings() {
  try {
    const parsed = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    // 文件缺失或损坏 → 全部未配置。
    return {};
  }
}

// 原子写：tmp + rename，崩溃绝不截断（沿用 llm.js 旧实现的做法）。
async function writeSettings(data) {
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  const tmpPath = `${SETTINGS_FILE}.tmp`;
  await fsp.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await fsp.rename(tmpPath, SETTINGS_FILE);
  return data;
}

// 合并写入若干 section（未传入的 section 原样保留）。
async function saveSections(sections) {
  const current = await readSettings();
  for (const [key, value] of Object.entries(sections || {})) {
    if (value !== undefined) current[key] = value;
  }
  current.updatedAt = new Date().toISOString();
  await writeSettings(current);
  return current;
}

// 幂等迁移旧版独立设置文件 → settings.json；无任何旧文件则不建文件。
// 跨进程（server 与 CLI 同时首启）的极小概率竞争：读旧文件与删旧文件之间的
// 差距在毫秒级，最坏退化为其中一方读到已删文件而跳过该 section，可接受。
async function migrateLegacySettings() {
  if (await fsp.access(SETTINGS_FILE).then(() => true, () => false)) return;
  const sections = {};
  let found = false;
  for (const [name, key] of Object.entries(LEGACY_SECTION_BY_FILE)) {
    try {
      const parsed = JSON.parse(await fsp.readFile(path.join(HOME, '.agentlray', name), 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        sections[key] = parsed;
        found = true;
      }
    } catch {
      // 旧文件缺失/损坏 → 跳过该 section。
    }
  }
  if (!found) return;
  await writeSettings({ ...sections, updatedAt: new Date().toISOString() });
  for (const name of Object.keys(LEGACY_SECTION_BY_FILE)) {
    await fsp.rm(path.join(HOME, '.agentlray', name)).catch(() => {});
  }
}

// 构建 GET/PUT /api/settings 响应中「value/configured/default」型 section
// （status / kanban）：未配置回退默认、标注是否显式配置。
function settingsResult(stored, defaults) {
  const result = {};
  for (const [key, def] of Object.entries(defaults)) {
    result[key] = {
      value: stored[key] ?? def,
      configured: Boolean(stored[key]),
      default: def,
    };
  }
  return result;
}

module.exports = {
  SETTINGS_FILE,
  LEGACY_SECTION_BY_FILE,
  readSettings,
  writeSettings,
  saveSections,
  migrateLegacySettings,
  settingsResult,
};
