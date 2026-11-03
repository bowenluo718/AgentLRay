'use strict';
// 新建会话（create）命令的构建与 fire-and-forget spawn 单一真源：CLI（bin/sessions.js
// new）与 web 任务看板「新建任务」都经此生成命令串。与 lib/resume.js 完全对称——
// 可执行命令（bin）同样经 resolveCliBin() 运行时解析：环境变量 →
// ~/.agentlray/settings.json 的 cliBins section（web 设置面板）→ 默认命令名（内置
// 平台为既有默认名，自定义平台为 create.bin）。
//
// 原生新建契约：
//   - 内置平台 codex / claude-code / omp / gemini / hermes（NEW_BINS）。dsh 是
//     交互式 TUI，无法 headless 传提示词 → 不可新建。
//   - 自定义平台适配器声明 create: { bin, args(opts) }（缺一视为未声明
//     → 无新建能力，hasCreateContract 返回 false、buildNewCommand 抛错）
//
// 参数模型：各平台 args 返回「前置参数」数组，提示词 message（非空时）由框架追加为
// 末位裸参数（与 resume 的 message 语义一致）；cwd 用 cd '...' &&（POSIX）/
// Set-Location（PowerShell）前缀（assembleShellCommand 装配）。
//
// spawn 治理：fire-and-forget——输出丢弃（stdio ignore）、不跟踪进程（unref）、
// 不等待退出；仅捕获首发的 'error'（ENOENT 等）用于报「命令不存在」。
const { spawn } = require('child_process');
const { resolveCliBin } = require('./cli-bins');
const { assembleShellCommand } = require('./resume');

// 各平台 create 的前置参数生成器（message 由 buildNewCommand 追加末位）。
// 形态经各平台 --help 实测定格：
//   - omp v18.8.4 `--help`：ARGUMENTS MESSAGES（位置参数，提示词）+ `--auto-approve`
//     （Auto-approve all tool calls）→ `omp --auto-approve '<prompt>'`（用户权威锚点）；
//     MESSAGES 可省 → 无提示词时 `omp --auto-approve` 即交互式会话。
//   - hermes `--help`：提示词**不是**位置参数（裸位置参被 argparse 判为非法子命令
//     "invalid choice"），headless 提示词须用 `-z/--oneshot PROMPT`（One-shot mode,
//     面向 scripts/pipes）；`--yolo` = Bypass all dangerous command approval prompts。
//     故 hermes 带提示词为 `hermes --yolo -z '<prompt>'`；无提示词时不能带 -z
//     （"-z/--oneshot: expected one argument"），回落 `hermes --yolo`（交互式）。
//   - claude-code 2.1.282 `--help`：Usage `claude [options] [command] [prompt]`；
//     `-p, --print` 为**布尔开关**（"Print response and exit"，提示词走位置参数），
//     `--dangerously-skip-permissions` = "Bypass all permission checks"；无 --cwd
//     （用进程 CWD，与 cd 前缀一致）。故带提示词为
//     `claude --dangerously-skip-permissions -p '<prompt>'`；无提示词时省略 -p
//     （"starts an interactive session by default"）→ 交互式会话。
//   - codex / gemini：本机未安装对应 CLI，形态为设计 §3.2 的推断（**未实测**），
//     见 docs/usage.zh-CN.md「新建任务」章节的说明。
const NEW_BINS = {
  codex: { args: () => ['exec', '--full-auto'] },
  'claude-code': {
    args: (opts) => (opts && opts.message != null && String(opts.message).length > 0
      ? ['--dangerously-skip-permissions', '-p']
      : ['--dangerously-skip-permissions']),
  },
  omp: { args: () => ['--auto-approve'] },
  gemini: { args: () => ['-p', '--approval-mode=yolo'] },
  // hermes：提示词走 -z/--oneshot（占位），由框架追加为末位裸参 → --yolo -z '<prompt>'
  hermes: {
    args: (opts) => (opts && opts.message != null && String(opts.message).length > 0
      ? ['--yolo', '-z']
      : ['--yolo']),
  },
};

// 平台对象是否声明原生新建契约（内置五平台，或自定义 create 完整）。
function hasCreateContract(platform) {
  if (NEW_BINS[platform.id]) return true;
  const create = platform.create;
  return Boolean(
    create &&
      typeof create === 'object' &&
      typeof create.bin === 'string' &&
      create.bin.trim() !== '' &&
      typeof create.args === 'function'
  );
}

/**
 * 构建平台会话的 create 命令串（含可选 cwd 前缀与追加提示词）。
 * @param {object} platform registry 平台对象（内置或自定义适配器）
 * @param {{ cwd?: string|null, message?: string }} [opts]
 *   opts 透传给自定义 create.args(opts)；message 非空时追加为末位裸参数。
 * @returns {Promise<{ bin: string, args: string[], command: string }>}
 *   平台无 create 契约时抛 Error（消息含 "no native create command"）。
 */
async function buildNewCommand(platform, opts = {}) {
  const builtin = NEW_BINS[platform.id];
  let customBin;
  let argsFn;
  if (builtin) {
    argsFn = builtin.args;
  } else {
    if (!hasCreateContract(platform)) {
      throw new Error(
        `Platform '${platform.id}' has no native create command. Only codex / claude-code / omp / gemini / hermes, or custom platforms declaring create, are supported.`
      );
    }
    customBin = platform.create.bin;
    argsFn = (newOpts) => platform.create.args(newOpts);
  }
  const bin = await resolveCliBin(platform.id, customBin);
  const args = argsFn(opts);
  // 提示词非空（有实际内容）才追加为末位裸参；空串/未传 = 无提示词裸启（开交互式）。
  if (opts.message != null && String(opts.message).length > 0) args.push(String(opts.message));
  const command = assembleShellCommand(bin, args, opts);
  return { bin, args, command };
}

// fire-and-forget 粒度：给 spawn 的 'error'（ENOENT 等）留一个窄窗口上报（libuv
// 在下一轮事件循环即可反馈 exec 失败，实测 <10ms），超窗视为已成功触发。
const SPAWN_GRACE_MS = 50;

/**
 * fire-and-forget 触发平台 CLI 开新会话：输出丢弃、不跟踪进程、不等待退出。
 * spawn 成功即立即 resolve（不阻塞调用方）。
 * @param {object} platform registry 平台对象（内置或自定义适配器）
 * @param {{ cwd?: string|null, message?: string }} [opts]
 * @returns {Promise<{ ok: true, bin: string, args: string[], command: string }>}
 *   平台无 create 契约时抛错；spawn error（ENOENT 等）时抛错（调用方借此报
 *   「命令不存在」），错误对象挂原 spawn error。
 */
async function spawnNewSession(platform, opts = {}) {
  const { bin, args, command } = await buildNewCommand(platform, opts);
  const child = spawn(bin, args, { cwd: opts.cwd || undefined, stdio: 'ignore', detached: true });
  child.unref(); // detached 便于后端进程退出后 CLI 继续运行，unref 不阻塞本进程退出
  await new Promise((resolvePromise, reject) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      child.removeListener('error', onError);
      resolvePromise();
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      child.removeListener('error', onError);
      reject(new Error(`Failed to run '${bin}': ${error.message}`, { cause: error }));
    };
    child.once('error', onError);
    setTimeout(settle, SPAWN_GRACE_MS);
  });
  return { ok: true, bin, args, command };
}

module.exports = { NEW_BINS, hasCreateContract, buildNewCommand, spawnNewSession };
