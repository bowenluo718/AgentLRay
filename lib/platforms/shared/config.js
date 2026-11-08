'use strict';
// 平台目录声明解析层：内置平台（builtin/<id>/）与项目/自定义平台
//（platforms/<id>/）统一经 `@agentlray/shared/config` 解析各自目录，不直接依赖
// lib/config 的平台常量（那些已下沉到各平台文件，见 design-platform-dir-decl）。
//
// 目录声明（decl）为分段对象，由 resolveDirs 统一拼绝对路径：
//   { root?: 'agentlray'|'home', env?: string, altEnv?: string, segments?: string[], altSegments?: string[] }
//   - root 'agentlray'（默认）：基座 AGENTLRAY_HOME || os.homedir() —— 平台独占
//     会话目录（与既有 config HOME 语义一致）。
//   - root 'home'：基座 os.homedir() —— CLI 自身文件（~/.claude/*、~/.hermes/state.db
//     等），刻意不挂 AGENTLRAY_HOME（ADR design-platform-dir-decl 修订 D1）。
//   - env：优先读该环境变量（字节保留既有 OPENCLAW_DIR/CODEX_DIR/… 契约）；
//     非法/非绝对/含 '..' → 回退默认段。
//   - altEnv：env 缺失时的次级源，家目录语义（如 DSH_HOME 指 dsh 根），拼其专属
//     段 altSegments（缺省回退 segments）——与基于 root 的 segments 不得混用。
//   - segments：path.join(base, ...segments)；altSegments：altEnv 前缀下的专属段。
//
// 非平台工具（resolveDir/isArchivedFile 等）仍透传 lib/config（不随平台迁移）。
const os = require('os');
const path = require('path');
const {
  HOME,
  resolveDir,
  isArchivedFile,
  isSessionLogFile,
  ensureDirectory,
  readAgents,
} = require('../../config');

const AGENTLRAY_HOME = HOME; // AGENTLRAY_HOME || os.homedir()

// 目录声明基座。
function declBase(decl) {
  return decl && decl.root === 'home' ? os.homedir() : AGENTLRAY_HOME;
}

// 环境变量覆盖值：合法（绝对路径、不含 '..'）才采纳，否则回退 null。
function envOverride(decl) {
  const key = decl && decl.env;
  if (!key) return null;
  const val = process.env[key];
  if (!val || typeof val !== 'string' || !path.isAbsolute(val) || val.includes('..')) return null;
  return val;
}

// 解析单条目录声明 → 绝对路径字符串。
function resolveDirs(decl) {
  const d = decl || {};
  const root = declBase(d);
  const override = envOverride(d);
  if (override) return override;
  // altEnv：次级环境变量 → 把其路径 + segments 拼出（DSH_DIR 的 DSH_HOME 情形：
  // DSH_HOME 本指 dsh 家目录，会话目录在其 /sessions 下）。
  if (d.altEnv) {
    const alt = process.env[d.altEnv];
    if (alt && typeof alt === 'string' && alt.length > 0) {
      // altEnv 是"家目录"语义（如 DSH_HOME 指 dsh 根），拼其专属段 altSegments
      // （缺省回退 segments），不能复用基于 root 的 segments（如 '.dsh'）。
      return path.join(alt, ...(d.altSegments || d.segments || []));
    }
  }
  return path.join(root, ...(d.segments || []));
}

module.exports = {
  // 目录声明解析（平台目录真源，替代 lib/config 的平台常量）
  resolveDirs,
  AGENTLRAY_HOME,
  // 非平台工具透传（不随平台迁移）
  HOME,
  resolveDir,
  isArchivedFile,
  isSessionLogFile,
  ensureDirectory,
  readAgents,
};
