'use strict';
// 平台 CLI 可执行命令（resume 续跑时 spawn 的目标）的配置与解析。
//
// 配置存 ~/.agentlray/settings.json 的 cliBins section（web 设置面板经
// GET/PUT /api/settings 写入）。解析优先级（高 → 低）：
//   1. 环境变量 AGENTLRAY_<PLATFORM>_BIN（如 AGENTLRAY_CLAUDE_CODE_BIN）
//   2. cliBins section（web 设置面板写入，含手工配置的自定义平台 <id> 键）
//   3. 默认命令名（codex / claude / omp / dsh / gemini / hermes，从 PATH 解析）
//
// 唯一默认命令名来源：CLI（bin/sessions.js）与 web 后端都经 resolveCliBin()
// 读取，保证终端续跑与页面设置视角一致。环境变量名见 CLI_BIN_ENV；envVarFor
// 是本模块内的通用推导（平台 id → AGENTLRAY_<ID>_BIN），与 lib/config.js 无关。
const { readSettings, saveSections } = require('./settings');

// 平台 id → 默认命令名（内置六平台，PATH 上解析不到时回退的裸命令名；
// 自定义平台在 resolveCliBin 的 fallbackDefault 参数传入，见 resume.bin）。
const CLI_BIN_DEFAULTS = {
  codex: 'codex',
  'claude-code': 'claude',
  omp: 'omp',
  dsh: 'dsh',
  gemini: 'gemini',
  hermes: 'hermes',
};

// 平台 id → 环境变量名（内置六平台；与 envVarFor 通用推导规则结果一致）。
const CLI_BIN_ENV = {
  codex: 'AGENTLRAY_CODEX_BIN',
  'claude-code': 'AGENTLRAY_CLAUDE_CODE_BIN',
  omp: 'AGENTLRAY_OMP_BIN',
  dsh: 'AGENTLRAY_DSH_BIN',
  gemini: 'AGENTLRAY_GEMINI_BIN',
  hermes: 'AGENTLRAY_HERMES_BIN',
};

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

// 白名单加载：只回内置六平台的合法配置（web 设置面板 / 兼容端点的存储视角）。
async function loadCliBins() {
  const raw = await loadRawBins();
  const result = {};
  for (const key of Object.keys(CLI_BIN_DEFAULTS)) {
    if (raw[key] !== undefined) result[key] = raw[key];
  }
  return result;
}

// 保存：白名单过滤（仅内置六平台），非法/空值清除该 key，合并写入 section
// （保留未涉及的内置 key 与手写的自定义 <id> 键）。
async function saveCliBins(body) {
  const current = await readCliBinsSection();
  for (const key of Object.keys(CLI_BIN_DEFAULTS)) {
    const value = body && body[key];
    if (typeof value === 'string' && value.trim() !== '') current[key] = value.trim();
    else delete current[key];
  }
  await saveSections({ cliBins: current });
  return loadCliBins();
}

// 通用环境变量名推导：平台 id 非字母数字 → `_` 后大写（如 my-copilot →
// AGENTLRAY_MY_COPILOT_BIN）。内置六平台结果与 CLI_BIN_ENV 一致。
function envVarFor(platformId) {
  return `AGENTLRAY_${String(platformId).replace(/[^A-Za-z0-9]+/g, '_').toUpperCase()}_BIN`;
}

// 解析单个平台的实际可执行命令：环境变量 → cliBins section → 回退默认命令名。
// platformId 为注册表平台 id（内置 codex/claude-code/omp 或自定义平台）；
// fallbackDefault 为回退的裸命令名——缺省取内置默认名（既有调用点语义不变），
// 自定义平台调用方传其 resume.bin。
async function resolveCliBin(platformId, fallbackDefault) {
  const fallback =
    fallbackDefault != null ? String(fallbackDefault) : CLI_BIN_DEFAULTS[platformId];
  const fromEnv = process.env[envVarFor(platformId)];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const stored = await loadRawBins();
  return stored[platformId] || fallback;
}

module.exports = {
  CLI_BIN_DEFAULTS,
  CLI_BIN_ENV,
  loadCliBins,
  saveCliBins,
  resolveCliBin,
};
