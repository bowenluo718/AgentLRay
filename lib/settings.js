'use strict';
// 统一设置文件：所有服务端设置聚合到单一 ~/.agentlray/settings.json。
// 结构：{ ui, cliBins, status, kanban, llm, updatedAt }——各 section 由对应
// lib 模块（ui-settings / cli-bins / status-config / kanban-config / llm）负责
// 白名单与校验，本模块只做整文件读与原子写。
//
// 约定：
//   - settings.json 缺失/损坏 → readSettings() 返回 {}（各 section 全部回退默认）。
//   - saveSections(partial) 读-改-原子写（tmp + rename），仅改写传入的 section，
//     未涉及的 section 与旧版本升级无关的键保持不动。
const path = require('path');
const fsp = require('fs/promises');
const { HOME } = require('./config');

const SETTINGS_FILE = path.join(HOME, '.agentlray', 'settings.json');

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
  readSettings,
  writeSettings,
  saveSections,
  settingsResult,
};
