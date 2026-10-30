'use strict';
// resume 续跑命令的构建单一真源：CLI（bin/sessions.js resume）与 web 会话详情
// 「复制恢复命令」都经此生成命令串，保证页面复制的命令即终端实际 spawn 的命令
// （P1 一致性）。可执行命令（bin）按 resolveCliBin() 运行时解析：环境变量 →
// ~/.agentlray/settings.json 的 cliBins section（web 设置面板）→ 默认命令名（内置平台为既有默认名，
// 自定义平台为 resume.bin）。
//
// 原生续跑契约：
//   - 内置平台 codex / claude-code / omp（RESUME_BINS）
//   - 自定义平台适配器声明 resume: { bin, args(id, opts) }（缺一视为未声明
//     → 无原生续跑，hasResumeContract 返回 false、buildResumeCommand 抛错）
const { resolveCliBin } = require('./cli-bins');

// 各平台 resume 的原生续跑参数生成器。args shape 与前端 resumeCommand（内置
// 三平台本地生成路径，见 frontend/src/views/sessions/lib.ts）保持一致。
const RESUME_BINS = {
  codex: { args: (id) => ['resume', id, '--yolo'] },
  'claude-code': { args: (id) => ['--dangerously-skip-permissions', '--resume', id] },
  omp: { args: (id) => ['--auto-approve', `--resume=${id}`] },
};

// 平台对象是否声明原生续跑契约（内置三平台，或自定义 resume 完整）。
function hasResumeContract(platform) {
  if (RESUME_BINS[platform.id]) return true;
  const resume = platform.resume;
  return Boolean(
    resume &&
      typeof resume === 'object' &&
      typeof resume.bin === 'string' &&
      resume.bin.trim() !== '' &&
      typeof resume.args === 'function'
  );
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// 仅对含空格/引号等特殊字符的 token 加引号，安全且可读（与前端 resume 展示一致）。
function shellToken(text) {
  const s = String(text);
  return /^[A-Za-z0-9_./:=@%,+-]+$/.test(s) && s.length > 0 ? s : shellQuote(s);
}

/**
 * 构建平台会话的 resume 命令串（含可选 cwd 前缀与追加消息）。
 * @param {object} platform registry 平台对象（内置或自定义适配器）
 * @param {string} id 会话 id
 * @param {{ cwd?: string|null, message?: string, [k: string]: unknown }} [opts]
 *   透传给自定义 resume.args(id, opts)（CLI 传完整 opts，web 只传 { cwd }），
 *   message 非空时追加为末位裸参数（与既有 CLI 语义一致）。
 * @returns {Promise<{ bin: string, args: string[], command: string }>}
 *   平台无 resume 契约时抛 Error（消息含 "no native resume command"）。
 */
async function buildResumeCommand(platform, id, opts = {}) {
  const builtin = RESUME_BINS[platform.id];
  let customBin;
  let argsFn;
  if (builtin) {
    argsFn = builtin.args;
  } else {
    if (!hasResumeContract(platform)) {
      throw new Error(
        `Platform '${platform.id}' has no native resume command. Only codex / claude-code / omp, or custom platforms declaring resume, are supported.`
      );
    }
    customBin = platform.resume.bin;
    argsFn = (resumeId, resumeOpts) => platform.resume.args(resumeId, resumeOpts);
  }
  const bin = await resolveCliBin(platform.id, customBin);
  const args = argsFn(id, opts);
  if (opts.message != null) args.push(String(opts.message));
  const command = `${opts.cwd ? `cd ${shellQuote(opts.cwd)} && ` : ''}${bin} ${args.map(shellToken).join(' ')}`;
  return { bin, args, command };
}

module.exports = { RESUME_BINS, hasResumeContract, buildResumeCommand };
