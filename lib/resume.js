'use strict';
// resume 续跑命令的构建单一真源：CLI（bin/sessions.js resume）与 web 会话详情
// 「复制恢复命令」都经此生成命令串，保证页面复制的命令即终端实际 spawn 的命令
// （P1 一致性）。可执行命令（bin）按 resolveCliBin() 运行时解析：环境变量 →
// ~/.agentlray/settings.json 的 cliBins section（web 设置面板）→ 默认命令名。
//
// 原生续跑契约（P0/P1 起来自适配器声明，不再有模块级 RESUME_BINS 表）：
//   内置六平台 codex / claude-code / omp / dsh / gemini / hermes 在各自
//   lib/platforms/builtin/*.js 声明 resume: { bin, args(id, opts) }；
//   自定义平台适配器同样声明 resume。缺一视为未声明 → 无原生续跑，
//   hasResumeContract 返回 false、buildResumeCommand 抛错。
const { hasResumeContract } = require('./platforms/contracts');
const { resolveCliBin } = require('./cli-bins');

// POSIX：单引号字面量，内嵌单引号用 '\'' 转义。
function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// PowerShell：单引号字面量同样不插值，内嵌单引号用 ''（双写）转义。
// Windows 路径含反斜杠与空格，单引号包裹时反斜杠原样保留，安全。
function psShellQuote(text) {
  return `'${String(text).replace(/'/g, `''`)}'`;
}

// 仅对含空格/引号等特殊字符的 token 加引号，安全且可读（与前端 resume 展示一致）。
function shellToken(text, quoteFn = shellQuote) {
  const s = String(text);
  return /^[A-Za-z0-9_./:=@%,+-]+$/.test(s) && s.length > 0 ? s : quoteFn(s);
}

/**
 * 装配平台 CLI 的 shell 命令串（resume / create 共用单一真源）。
 * win32 输出 PowerShell 语法（可选 Set-Location 前导 + & 调用运算符，bin 也经
 * psShellQuote 包裹——自定义 bin / cliBins 配置可能含空格如 C:\Program Files\…），
 * POSIX 保持 `cd '<cwd>' && bin args` 形态（cwd 经 shellQuote、args 经 shellToken）。
 * @param {string} bin 可执行命令（已按 resolveCliBin 解析）
 * @param {string[]} args 参数数组
 * @param {{ cwd?: string|null }} [opts] 可选工作目录
 * @returns {string} 可直接在对应 shell 执行的命令串
 */
function assembleShellCommand(bin, args, opts = {}) {
  const isWin = process.platform === 'win32';
  return isWin
    ? `${opts.cwd ? `Set-Location ${psShellQuote(opts.cwd)}; ` : ''}& ${shellToken(bin, psShellQuote)} ${args.map((a) => shellToken(a, psShellQuote)).join(' ')}`
    : `${opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : ''}${bin} ${args.map((a) => shellToken(a, shellQuote)).join(' ')}`;
}

/**
 * 构建平台会话的 resume 命令串（含可选 cwd 前缀与追加消息）。
 * @param {object} platform registry 平台对象（内置或自定义适配器，须声明 resume）
 * @param {string} id 会话 id
 * @param {{ cwd?: string|null, message?: string, [k: string]: unknown }} [opts]
 *   透传给自定义 resume.args(id, opts)（CLI 传完整 opts，web 只传 { cwd }），
 *   message 非空时追加为末位裸参数（与既有 CLI 语义一致）。
 * @returns {Promise<{ bin: string, args: string[], command: string }>}
 *   平台无 resume 契约时抛 Error（消息含 "no native resume command"）。
 */
async function buildResumeCommand(platform, id, opts = {}) {
  if (!hasResumeContract(platform)) {
    throw new Error(
      `Platform '${platform.id}' has no native resume command. Only codex / claude-code / omp / dsh / gemini / hermes, or custom platforms declaring resume, are supported.`
    );
  }
  const resume = platform.resume;
  const bin = await resolveCliBin(platform.id, resume.bin);
  const args = resume.args(id, opts);
  if (opts.message != null) args.push(String(opts.message));
  // 命令装配统一走 assembleShellCommand（win32 PowerShell / POSIX，与新建 create 共用）。
  const command = assembleShellCommand(bin, args, opts);
  return { bin, args, command };
}

module.exports = {
  hasResumeContract,
  buildResumeCommand,
  // 供 lib/new.js 与外部复用的引号/装配工具（新增导出，向后兼容）。
  shellQuote,
  psShellQuote,
  shellToken,
  assembleShellCommand,
};
