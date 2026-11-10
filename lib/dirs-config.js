'use strict';
// 平台数据目录配置（settings.json 的 dirs section）与解析。
//
// 结构：{ <dirSettingKey>: '/abs/path', ... }（如 codexDir / openclawDir）。
// 解析优先级（高 → 低）：平台 env 生效（平台 dirEnv 声明）> settings.json 的
// dirs section > 平台 defaultDir()（其内部 resolveDirs 已含 env 与默认段）。
//
// 背景：平台 defaultDir() 在 require 期即把 env 合并进常量，运行时无法从返回值
// 区分「env 生效」还是「默认段」。故平台 adapter 声明 dirEnv（env 变量名或数组，
// 真源在各平台 dirs.js），本模块据此判断 env 是否生效——env 生效时配置目录被
// 忽略（不覆盖 env，ADR design-platform-dir-decl D 目录真源在平台文件）。
//
// 缓存策略：启动时（server 与 CLI 入口）调 loadDirsConfigSync() 填充模块级缓存；
// saveDirsConfig 写后同步刷新。跨进程 CLI 改 settings.json 的 dirs 由各自进程
// 启动时重载，web 端保存即时刷新。route 层用同步 dirFor() 即可（避免大量 async
// 化，search 的多平台聚合在循环内同步调用）。
const fs = require('fs');
const path = require('path');
const { SETTINGS_FILE, readSettings, writeSettings, saveSections } = require('./settings');
const { resolveDir } = require('./config');
const { PLATFORMS } = require('./platforms');

// 白名单可配置目录键集：已挂载且声明了 dirSettingKey 的平台键（设置面板视角）。
function dirSettingKeys() {
  const keys = Object.create(null);
  for (const [id, p] of Object.entries(PLATFORMS)) {
    if (p && typeof p.dirSettingKey === 'string' && p.dirSettingKey.trim() !== '') {
      keys[p.dirSettingKey] = true;
    }
  }
  return keys;
}

// 从 settings.json 同步读 dirs section（缺失/损坏 → {}）。
function readDirsSectionSync() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    return {};
  }
  const section = data && data.dirs;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

async function readDirsSection() {
  const data = await readSettings();
  const section = data.dirs;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

// 目录值合法性：绝对路径且不含 '..'（与 lib/config resolveDir 口径一致）。
function isValidDir(value) {
  return path.isAbsolute(value) && !value.includes('..');
}

// 平台 env 是否生效：dirEnv 声明的任一 env 有合法（绝对路径、不含 '..'）值。
// 自定义平台未声明 dirEnv → 视为无 env 生效，配置目录可覆盖 defaultDir。
function dirEnvActive(platform) {
  const envs = Array.isArray(platform.dirEnv) ? platform.dirEnv : platform.dirEnv ? [platform.dirEnv] : [];
  for (const key of envs) {
    const val = process.env[key];
    if (typeof val === 'string' && path.isAbsolute(val) && !val.includes('..')) return true;
  }
  return false;
}

// 模块级白名单配置缓存：{ dirSettingKey: '/path' }。
let cachedDirs = {};
let loaded = false;

// 启动时加载（同步）：读 settings.json dirs section + 白名单 + 合法值过滤。
// 供 server / CLI 入口调用；写操作后也调以刷新。
function loadDirsConfigSync() {
  const raw = readDirsSectionSync();
  const keys = dirSettingKeys();
  const result = {};
  for (const [key, value] of Object.entries(raw)) {
    if (keys[key] && typeof value === 'string' && value.trim() !== '') {
      result[key] = value.trim();
    }
  }
  cachedDirs = result;
  loaded = true;
  return cachedDirs;
}

function loadDirsConfig() {
  if (!loaded) loadDirsConfigSync();
  return cachedDirs;
}

// 保存：白名单 + 绝对路径/不含 '..' 校验 + env 生效平台忽略 + 空/非法 = 该键
// 清除。只处理 body 显式含的键（设置面板按平台聚合 draft，未编辑平台不发）。
// env 生效平台的配置丢弃（env 优先，Q11-B）：即便之前已配置，env 注入后也不保留。
// 写后刷新模块级缓存。
async function saveDirsConfig(body) {
  const current = await readDirsSection();
  const keys = dirSettingKeys();
  for (const [id, p] of Object.entries(PLATFORMS)) {
    const key = p && typeof p.dirSettingKey === 'string' ? p.dirSettingKey : null;
    if (!key || !keys[key]) continue;
    if (dirEnvActive(p)) {
      delete current[key];
      continue;
    }
    const value = body && body[key];
    if (value === undefined) continue; // 未编辑的平台保留现有配置
    if (typeof value === 'string' && isValidDir(value.trim())) current[key] = value.trim();
    else delete current[key];
  }
  // 空目录配置 = 干净默认：从 settings.json 移除 dirs section（而非写 dirs:{}），
  // 与「空串 = 回默认 / 无任何配置不建文件」的语义一致。
  if (Object.keys(current).length === 0) {
    const onDisk = await readSettings();
    delete onDisk.dirs;
    onDisk.updatedAt = new Date().toISOString();
    await writeSettings(onDisk);
  } else {
    await saveSections({ dirs: current });
  }
  return loadDirsConfigSync();
}

// 平台实际会话目录（同步）：env（已并入 defaultDir）> settings.json dirs section
// > defaultDir 默认段。供 route 层统一解析，替代旧 resolveDir(query, defaultDir)
// 的 query 驱动（前端不再组装 dir query，目录真源挪到服务端此函数）。
function dirForPlatform(platform) {
  const key = platform && typeof platform.dirSettingKey === 'string' ? platform.dirSettingKey : null;
  if (!key || dirEnvActive(platform)) return platform.defaultDir();
  const config = loadDirsConfig();
  const configured = config[key];
  if (configured) return configured;
  return platform.defaultDir();
}

// route 层目录解析统一入口：显式 queryDir 合法则覆盖（API 向后兼容层，前端不再
// 使用），否则回落到 dirForPlatform（env > settings.json dirs > 默认段）。
// 与旧 resolveDir(query, defaultDir) 的覆盖语义一致。
function dirFor(platform, queryDir) {
  return resolveDir(queryDir, dirForPlatform(platform));
}

module.exports = {
  dirSettingKeys,
  isValidDir,
  dirEnvActive,
  loadDirsConfigSync,
  loadDirsConfig,
  saveDirsConfig,
  dirForPlatform,
  dirFor,
};
