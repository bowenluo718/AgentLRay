'use strict';
// 平台 CLI 可执行命令（resume 续跑时 spawn 的目标）的配置与解析。
//
// 配置存 ~/.agentlray/settings.json 的 cliBins section（web 设置面板经
// GET/PUT /api/settings 写入）。解析优先级（高 → 低）：
//   1. 环境变量 AGENTLRAY_<PLATFORM>_BIN（如 AGENTLRAY_CLAUDE_CODE_BIN）
//   2. cliBins section（web 设置面板写入，含手工配置的自定义平台 <id> 键）
//   3. 默认命令名（来自已挂载平台的 bin 声明，见 cliBinDefaults）
//
// 唯一默认命令名来源：CLI（bin/sessions.js）与 web 后端都经 resolveCliBin()
// 读取，保证终端续跑与页面设置视角一致。默认命令名不再有模块级 CLI_BIN_DEFAULTS
// 常量表，而是由注册表已挂载平台的 bin 声明（lib/platforms/builtin/*.js）推导——
// 内置六平台 bin 与旧默认名逐字一致（codex/claude/omp/dsh/gemini/hermes）。
const { readSettings, saveSections } = require('./settings');
const { PLATFORMS } = require('./platforms');

// 平台 id → 默认命令名：遍历已挂载 PLATFORMS 的 bin 声明（跳过 null / 空串；
// openclaw 无 bin）。供设置面板 / 兼容端点的默认命令展示与 resolveCliBin 回退。
function cliBinDefaults() {
  const result = {};
  for (const [id, p] of Object.entries(PLATFORMS)) {
    if (p && typeof p.bin === 'string' && p.bin.trim() !== '') result[id] = p.bin;
  }
  return result;
}

async function readCliBinsSection() {
  const data = await readSettings();
  const section = data.cliBins;
  return section && typeof section === 'object' && !Array.isArray(section) ? section : {};
}

// 读取 cliBins section 原始键值（含自定义平台 <id> 键，便于手工配置覆盖）；
// 非法值（空串 / 非字符串）剔除；缺失 → {}。
async function loadRawBins() {
  const section = await readCliBinsSection();
  const result = {};
  for (const [key, value] of Object.entries(section)) {
    if (typeof value === 'string' && value.trim() !== '') result[key] = value;
  }
  return result;
}

// 白名单加载：只回已挂载平台（cliBinDefaults 键集）的合法配置（设置面板视角）。
async function loadCliBins() {
  const raw = await loadRawBins();
  const result = {};
  for (const key of Object.keys(cliBinDefaults())) {
    if (raw[key] !== undefined) result[key] = raw[key];
  }
  return result;
}

// 保存：白名单过滤（仅已挂载平台），非法/空值清除该 key，合并写入 section
// （保留未涉及的内置 key 与手写的自定义 <id> 键）。
async function saveCliBins(body) {
  const current = await readCliBinsSection();
  for (const key of Object.keys(cliBinDefaults())) {
    const value = body && body[key];
    if (typeof value === 'string' && value.trim() !== '') current[key] = value.trim();
    else delete current[key];
  }
  await saveSections({ cliBins: current });
  return loadCliBins();
}

// 通用环境变量名推导：平台 id 非字母数字 → `_` 后大写（如 my-copilot →
// AGENTLRAY_MY_COPILOT_BIN）。内置六平台结果与既有 CLI_BIN_ENV 一致。
function envVarFor(platformId) {
  return `AGENTLRAY_${String(platformId).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_BIN`;
}

// 解析单个平台的实际可执行命令：环境变量 → cliBins section → 回退默认命令名。
// platformId 为注册表平台 id（内置 codex/claude-code/omp 或自定义平台）；
// fallbackDefault 为回退的裸命令名——resume/create 调用方传其 resume.bin /
// create.bin（优先），缺省取平台 bin 声明（cliBinDefaults）。
async function resolveCliBin(platformId, fallbackDefault) {
  let fallback;
  if (fallbackDefault != null) {
    fallback = String(fallbackDefault);
  } else {
    const p = PLATFORMS[platformId];
    fallback = p && typeof p.bin === 'string' && p.bin.trim() !== '' ? p.bin : cliBinDefaults()[platformId];
  }
  const fromEnv = process.env[envVarFor(platformId)];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const stored = await loadRawBins();
  return stored[platformId] || fallback;
}

module.exports = {
  cliBinDefaults,
  loadCliBins,
  saveCliBins,
  resolveCliBin,
};
