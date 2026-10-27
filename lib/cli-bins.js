'use strict';
// 平台 CLI 可执行命令（resume 续跑时 spawn 的目标）的配置与解析。
//
// 解析优先级（高 → 低）：
//   1. 环境变量 AGENTLRAY_<PLATFORM>_BIN（如 AGENTLRAY_CLAUDE_CODE_BIN）
//   2. 服务端配置文件 ~/.agentlray/cli-bins.json（web 设置面板写入，
//      GET/PUT /api/settings/cli-bins）
//   3. 默认命令名（codex / claude / omp，从 PATH 解析）
//
// 唯一默认命令名来源：CLI（bin/sessions.js）与 web 后端都经 resolveCliBin()
// 读取，保证终端续跑与页面设置视角一致。环境变量名见 CLI_BIN_ENV。
const path = require('path');
const { HOME } = require('./config');
const { createConfigStore } = require('./config-store');

// 平台 id → 默认命令名（PATH 上解析不到时回退的裸命令名）。
const CLI_BIN_DEFAULTS = {
  codex: 'codex',
  'claude-code': 'claude',
  omp: 'omp',
};

// 平台 id → 环境变量名。
const CLI_BIN_ENV = {
  codex: 'AGENTLRAY_CODEX_BIN',
  'claude-code': 'AGENTLRAY_CLAUDE_CODE_BIN',
  omp: 'AGENTLRAY_OMP_BIN',
};

const CLI_BINS_FILE = path.join(HOME, '.agentlray', 'cli-bins.json');

// 白名单 JSON 配置存储：非法值（空串 / 非字符串 / 缺失）清除回退默认。
const store = createConfigStore({
  filePath: CLI_BINS_FILE,
  defaults: CLI_BIN_DEFAULTS,
  validate: (key, value) => typeof value === 'string' && value.trim() !== '',
});

function isSupportedPlatform(id) {
  return Object.prototype.hasOwnProperty.call(CLI_BIN_DEFAULTS, id);
}

// 解析单个平台的实际可执行命令：环境变量 → 配置文件 → 默认命令名。
// 非 resume 平台（openclaw/hermes/dsh/gemini）返回其默认名（实际不会被 spawn）。
async function resolveCliBin(platformId) {
  if (!isSupportedPlatform(platformId)) return CLI_BIN_DEFAULTS[platformId];
  const fromEnv = process.env[CLI_BIN_ENV[platformId]];
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
  const stored = await store.load();
  return stored[platformId] || CLI_BIN_DEFAULTS[platformId];
}

module.exports = {
  CLI_BIN_DEFAULTS,
  CLI_BIN_ENV,
  CLI_BINS_FILE,
  loadCliBins: store.load,
  saveCliBins: store.save,
  resolveCliBin,
};
