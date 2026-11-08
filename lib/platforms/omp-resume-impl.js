'use strict';
// omp 特有的续跑治理（P2）：统一语义「同 id 续跑、不接受派生」。目标会话若正被
// 运行中的 omp 实例以 --resume 持有（非空闲），续跑必派生——prepare 在 --run 时自动
// 终止持有实例并确认其退出，after 兜底校验运行期间是否仍派生新会话。
// 由 builtin/omp.js 以 resumeHooks 声明，供 bin/sessions.js resume 通用调用。
const fs = require('fs');
const path = require('path');
const { findOmpSessionFile } = require('./omp');

// 检测目标 omp 会话是否正被"运行中的 omp 实例"持有（`omp --resume <path|id>`）。
// 这类会话在 OMP 中处于"非空闲"，新续跑会触发派生（二进制内置 requireIdle→fork 逻辑），
// 与文件尾是否有 session_exit 无关（早前"先追加 session_exit 收尾"方案已实证无效）。
// 返回持有进程的 pid，未检测到返回 null。排除本工具自身进程树（cmdline 含 agentlray）。
function liveOmpPidForSession(sessionFilePath, sessionId) {
  // 依赖 /proc 扫描，仅 Linux 可用；Windows 等平台暂不支持检测运行中的 omp 持有实例。
  if (process.platform !== 'linux') {
    process.stderr.write('agentlray sessions: 注意：Windows 暂不支持检测运行中的 omp 持有实例。\n');
    return null;
  }
  let entries;
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null; // /proc 不可读（如受限容器）：尽力而为，不阻塞
  }
  for (const raw of entries) {
    if (!/^\d+$/.test(raw)) continue;
    let cmd;
    try {
      cmd = fs.readFileSync(`/proc/${raw}/cmdline`, 'utf8');
    } catch {
      continue; // 进程瞬时退出
    }
    if (!cmd.includes('omp') || !cmd.includes('--resume')) continue;
    // 排除本工具自身进程（node .../bin/agentlray.js 或 agent-lray 垫片）
    if (cmd.includes('bin/agentlray.js') || cmd.includes('agent-lray')) continue;
    if (cmd.includes(sessionFilePath) || cmd.includes(sessionId)) return Number(raw);
  }
  return null;
}

// 收尾续跑后，在 slug 目录里找本次运行期间新建、且 parentSession 指向目标 id 的派生会话。
function findOmpFork(slugDir, targetId, filesBefore) {
  let entries;
  try {
    entries = fs.readdirSync(slugDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl') || filesBefore.has(e.name)) continue;
    let record = null;
    try {
      const text = fs.readFileSync(path.join(slugDir, e.name), 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (r.type === 'session') {
          record = r;
          break;
        }
      }
    } catch {
      continue;
    }
    if (record && record.parentSession === targetId && record.id !== targetId) return record.id;
  }
  return null;
}

// 忙等：CLI 进程内同步睡眠（不引入额外依赖）。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// 自动结束"以 --resume 持有目标 omp 会话"的运行中实例，以便安全地同 id 续跑。
// 优先 SIGTERM（让 OMP 有机会收尾、写 session_exit），等待退出；超时 SIGKILL 兜底。
// 返回是否已确认进程不再存活。
function terminateOmpHolder(pid, { termWaitMs = 8000, killWaitMs = 3000 } = {}) {
  // Windows 无 SIGTERM/SIGKILL 语义、无 /proc 僵尸判定，暂不支持自动终止；
  // 打印提示并视为未确认退出（返回 false），由调用方走「无法自动终止」路径。
  if (process.platform !== 'linux') {
    process.stderr.write(
      'agentlray sessions: 注意：Windows 暂不支持自动终止 omp 持有实例，请手动结束。\n'
    );
    return false;
  }
  const alive = () => {
    // 仅用 process.kill(pid, 0) 探测进程存活。僵尸进程（STAT=Z，已终止仅待父
    // 进程回收）对 kill(pid,0) 仍返回存活，会误判为仍持有会话资源导致同 id 续跑
    // 被拒——故 Linux 分支保留 /proc/<pid>/stat 的 Z 态判定（本函数仅 Linux 执行）。
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const idx = stat.indexOf(') ');
      if (idx !== -1 && stat[idx + 2] === 'Z') return false; // 僵尸：视为已退出
    } catch {
      // 竞态：进程刚好消失
    }
    return true;
  };
  if (!alive()) return true;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    // 竞态：刚好退出；交由下方 alive 判定
  }
  const STEP = 200;
  let waited = 0;
  while (alive() && waited < termWaitMs) {
    sleepSync(STEP);
    waited += STEP;
  }
  if (alive()) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // 同上，竞态退出
    }
    waited = 0;
    while (alive() && waited < killWaitMs) {
      sleepSync(STEP);
      waited += STEP;
    }
  }
  return !alive();
}

// 续跑前：检出并（--run 时）自动终止持有实例。返回
// { note, livePid, terminated, state }；state 为续跑中需跨 after 携带的不透明
// 数据（--run 时含 slugDir/filesBefore，否则 null），CLI 原样回传。无法自动
// 终止时抛错。
async function prepare(ctx) {
  const { run, dir, id } = ctx;
  let note = null;
  let livePid = null;
  let terminated = false;
  let state = null;
  const ompFile = await findOmpSessionFile(dir, id);
  livePid = ompFile ? liveOmpPidForSession(ompFile, id) : null;
  if (livePid) {
    if (run) {
      // 统一语义：同 id 续跑、不接受派生。持有者在则不派生地续跑——先自动
      // 终止该实例（SIGTERM→SIGKILL 兜底），确认其退出后再续跑。
      terminated = terminateOmpHolder(livePid);
      const still = ompFile ? liveOmpPidForSession(ompFile, id) : null;
      if (!terminated || still) {
        throw new Error(
          `无法自动终止运行中的 omp 实例（pid=${livePid}），目标会话仍被持有，不能安全地同 id 续跑（避免 OMP 派生新会话）。请手动结束该实例后再试。`
        );
      }
      note = `已自动终止运行中的 omp 实例（pid=${livePid}），继续同 id 续跑。`;
    } else {
      note = `目标 omp 会话正被运行中的 omp 实例（pid=${livePid}）以 --resume 持有：--run 将自动终止该实例后再同 id 续跑（不接受派生）。`;
      process.stderr.write(`agentlray sessions: 注意：${note}\n`);
    }
  }
  if (run && ompFile) {
    state = { slugDir: path.dirname(ompFile), filesBefore: new Set(fs.readdirSync(path.dirname(ompFile))) };
  }
  return { note, livePid, terminated, state };
}

// 续跑后：兜底校验是否仍派生新会话（并发等极端情况）。返回 { forked }，
// forked 为派生会话 id 或 null。
function after(ctx) {
  const { id, state } = ctx;
  if (!state || !state.slugDir) return { forked: null };
  const forked = findOmpFork(state.slugDir, id, state.filesBefore);
  if (forked) {
    process.stderr.write(
      `agentlray sessions: 警告：OMP 仍派生了新会话 ${forked}（parentSession=${id}），未能做到同 id 续跑。\n`
    );
  }
  return { forked };
}

// 组装 resumeHooks 契约：{ prepare, after }。
function createOmpResumeHooks() {
  return { prepare, after };
}

module.exports = {
  createOmpResumeHooks,
  liveOmpPidForSession,
  findOmpFork,
  terminateOmpHolder,
};
