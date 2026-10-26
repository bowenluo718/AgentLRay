'use strict';
// agentlray sessions — 终端会话查询与续跑工具。
//
//   list   按条件查询会话列表（全部平台；openclaw 需 --agent）
//   show   查看单个会话详细信息（会话元信息 + 消息时间线）
//   resume 生成并（可选）执行续跑命令（仅 codex / claude-code / omp 有原生续跑）
//
// 与 inspect.js 相同的输出约定：--json 输出 {schemaVersion:1,…}，错误为
// {schemaVersion:1, kind:'error', error:{code,message}}；退出码 0 = 命令成功
// 完成（对 resume 指命令已执行、非任务成功），1 = 参数/运行时错误。

const fs = require('fs');
const path = require('path');
const { randomBytes } = require('crypto');
const { spawn } = require('child_process');
const { PLATFORMS } = require('../lib/platforms');
const { resolveDir } = require('../lib/config');
const { listSessionsForAgent } = require('../lib/platforms/openclaw');
const { findOmpSessionFile } = require('../lib/platforms/omp');
const { STATUS, STATUS_LABELS } = require('../lib/status');

const HELP = `Usage:
  agentlray sessions list   --platform <p> [--agent NAME] [--dir PATH]
                            [--status <s,...>] [--match TEXT]
                            [--since ISO] [--until ISO] [--limit N] [--offset N] [--json]
  agentlray sessions show   --platform <p> --id <SESSION_ID> [--agent NAME] [--dir PATH]
                            [--tail N] [--full] [--json]
  agentlray sessions resume --platform <codex|claude-code|omp> --id <SESSION_ID>
                            [--dir PATH] [--cwd PATH] [--message TEXT] [--run] [--json]

list:   按条件查询会话列表（openclaw/codex/claude-code/hermes/omp/dsh/gemini；
        openclaw 必须传 --agent）。结果按各平台既有分组排序（状态组内时间降序）；
        每条含 firstUserMessage 首条用户消息与 lastMessage（最后一条 user/assistant 内容）。
show:   查看单个会话的元信息与归一化消息时间线。
resume: 生成该会话在原 CLI 中的续跑命令（codex resume / claude --resume /
        omp --resume=），默认只打印命令不执行；加 --run 才真正 spawn 平台 CLI
        执行并透传 stdin/stdout 与退出码。统一语义：**同 id 续跑、不接受派生**——
        codex/claude 原生同 id 续写；omp 目标会话若仍打开（尾部无 session_exit），
        --run 会先追加 session_exit 收尾再以原 id 原地续跑（不再派生）。仅这三
        平台有原生续跑契约，其余平台 resume 报错。

公共参数：
  --platform <p>  平台 id（list/show 为全部 7 平台；resume 仅 codex|claude-code|omp）
  --id <ID>       会话 id（show/resume）
  --agent <name>  openclaw 下的 agent 名（该平台必填；其他平台忽略）
  --dir <path>    覆盖该平台默认数据目录（绝对路径）
  --status <s,…>  按状态过滤 list：awaiting-input|working|waiting|stopped，可逗号多值
  --match <text>  按 title / 首条用户消息 / 最后一条消息 / 会话 id 子串匹配（忽略大小写）
  --since <ISO>   list 只保留 lastActivity（缺省回退 timestamp）≥ 该时刻的会话
  --until <ISO>   list 只保留 lastActivity（缺省回退 timestamp）≤ 该时刻的会话
  --limit <N>     最多输出 N 条（过滤后分页；默认不限）
  --offset <N>    跳过前 N 条（过滤后分页；默认 0）
  --tail <N>      show 只打印最后 N 条消息
  --full          show 输出完整消息文本（默认每条文本截断到 2000 字符）
  --cwd <path>    resume 使用的执行目录（默认取会话记录 cwd）
  --message <txt> resume 追加的续发消息（作为提示词参数传给平台 CLI）
  --run           resume 真正执行，而非只打印命令
  --json          机器可读 JSON 输出（错误为 {schemaVersion:1,kind:"error",...}）

Exit 0: 命令执行成功（resume 指已生成/已执行，非任务成功）。Exit 1: 参数或运行时错误。
`;

// --- 小工具 ---

function parseOptions(args, defs) {
  // defs: { '--flag': { key, type: 'string'|'int'|'boolean' } }
  const out = {};
  const usageError = (m) => { const e = new Error(m); e.usage = true; return e; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const def = defs[flag];
    if (!def) throw usageError(`Unknown option '${flag}'.`);
    if (def.type === 'boolean') {
      if (inline !== null) throw usageError(`Option '${flag}' does not take a value.`);
      out[def.key] = true;
      continue;
    }
    let value = inline;
    if (value === null) value = args[++i];
    if (value === undefined || value === '') throw usageError(`Missing value for '${flag}'.`);
    if (/^--/.test(value)) throw usageError(`Missing value for '${flag}'.`);
    if (flag === '--platform') value = value.toLowerCase();
    out[def.key] = def.type === 'int' ? parseInt(value, 10) : value;
  }
  return out;
}

function errorDocument(code, message) {
  return { schemaVersion: 1, kind: 'error', error: { code, message } };
}

function emitError(json, message, help = false) {
  if (json) process.stdout.write(`${JSON.stringify(errorDocument('usage', message))}\n`);
  process.stderr.write(`agentlray sessions: ${message}\n${help && !json ? HELP : ''}`);
  process.exitCode = 1;
}

function resolvePlatform(id) {
  const platform = id && PLATFORMS[id];
  if (!platform) {
    throw new Error(
      `Unknown platform '${id}'. Expected one of: ${Object.keys(PLATFORMS).join(', ')}.`
    );
  }
  return platform;
}

function tsMs(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function sanitizeNonNegInt(value, flag) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`'${flag}' expects a nonnegative integer.`);
  return value;
}

// 终端纯文本对齐：按码点位宽 padEnd（CJK 在等宽终端为双宽，这里只做近似对齐）。
function pad(text, width) {
  return String(text).padEnd(width);
}

function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

// 仅对含空格/引号等特殊字符的 token 加引号，安全且可读（与前端 resume 展示一致）。
function shellToken(text) {
  const s = String(text);
  return /^[A-Za-z0-9_./:=@%,+-]+$/.test(s) && s.length > 0 ? s : shellQuote(s);
}

function labelFor(status) {
  return STATUS_LABELS[status] || status;
}

// 只读 JSONL 尾部最后一条非空记录（避免整文件读取）。解析失败返回 null。
function tailRecord(filePath, bytes = 65536) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const text = buf.toString('utf8').trimEnd();
    const idx = text.lastIndexOf('\n');
    const last = idx === -1 ? text : text.slice(idx + 1);
    if (!last.trim()) return null;
    return JSON.parse(last);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// OMP 18.8.4 实测（2026-10-26）：对"已结束（尾部 session_exit）"的会话续跑是原地续写；
// 对"仍打开（无 session_exit）"的会话会新建带 parentSession 的派生会话。统一语义：
// 不接受派生——同 id 续跑；目标未结束时先追加 session_exit 收尾再续跑。
// 返回 { ended: true|false|null, finalized, willFork, note }。
function ompResumeState(filePath) {
  if (!filePath) return { ended: null, finalized: false, willFork: null, note: null };
  const last = tailRecord(filePath);
  if (!last) return { ended: null, finalized: false, willFork: null, note: null };
  const ended = last.type === 'custom' && last.customType === 'session_exit';
  return { ended, last, finalized: false, willFork: false, note: null };
}

const OMP_FINALIZE_REASON = 'agentlray-resume-finalize';

// 在目标 omp 会话文件尾部追加 session_exit 标记（"先结束"），随后同 id 续跑即为原地续写。
// 仅在确认会话"仍打开"时调用；返回追加的 record。
function finalizeOmpSession(filePath, lastRecord) {
  const ts = new Date().toISOString();
  const record = {
    type: 'custom',
    customType: 'session_exit',
    data: { reason: OMP_FINALIZE_REASON, kind: 'normal', recordedAt: ts },
    id: randomBytes(4).toString('hex'),
    parentId: (lastRecord && lastRecord.id) || null,
    timestamp: ts,
  };
  fs.appendFileSync(filePath, `\n${JSON.stringify(record)}\n`);
  return record;
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

// --- list ---

async function listSessions(opts, json) {
  const platform = resolvePlatform(opts.platform);
  let sessions;
  if (platform.id === 'openclaw') {
    if (!opts.agent) throw new Error('openclaw 平台需要 --agent <name> 才能列出会话。');
    const dir = resolveDir(opts.dir, platform.defaultDir());
    sessions = await listSessionsForAgent(dir, opts.agent, false);
  } else {
    if (!platform.list) throw new Error(`Platform '${platform.id}' does not support listing.`);
    const dir = resolveDir(opts.dir, platform.defaultDir());
    sessions = await platform.list(dir);
  }

  let filtered = sessions;

  if (opts.status) {
    const wanted = new Set(
      opts.status.split(',').map((s) => s.trim()).filter(Boolean)
    );
    for (const s of wanted) {
      if (!Object.values(STATUS).includes(s)) {
        throw new Error(`Unknown status '${s}'. Expected: ${Object.values(STATUS).join(', ')}.`);
      }
    }
    filtered = filtered.filter((s) => wanted.has(s.status));
  }

  if (opts.match) {
    const needle = String(opts.match).toLowerCase();
    filtered = filtered.filter((s) =>
      [s.id, s.title, s.firstUserMessage, s.lastMessage && s.lastMessage.text].some(
        (v) => v && String(v).toLowerCase().includes(needle)
      )
    );
  }

  const sinceMs = opts.since != null ? tsMs(opts.since) : null;
  const untilMs = opts.until != null ? tsMs(opts.until) : null;
  if (opts.since != null && sinceMs === null) throw new Error(`Invalid --since timestamp '${opts.since}'.`);
  if (opts.until != null && untilMs === null) throw new Error(`Invalid --until timestamp '${opts.until}'.`);
  if (sinceMs !== null || untilMs !== null) {
    filtered = filtered.filter((s) => {
      const activity = tsMs(s.lastActivity) ?? tsMs(s.timestamp);
      if (activity === null) return false;
      if (sinceMs !== null && activity < sinceMs) return false;
      if (untilMs !== null && activity > untilMs) return false;
      return true;
    });
  }

  const offset = opts.offset != null ? sanitizeNonNegInt(opts.offset, '--offset') : 0;
  const limit = opts.limit != null ? sanitizeNonNegInt(opts.limit, '--limit') : 0;
  const shown = limit > 0 ? filtered.slice(offset, offset + limit) : filtered.slice(offset);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'sessions',
        platform: platform.id,
        agent: opts.agent || null,
        total: filtered.length,
        offset,
        limit: limit || null,
        sessions: shown,
      })}\n`
    );
    return;
  }

  if (shown.length === 0) {
    if (offset === 0) {
      process.stdout.write(`(no sessions for ${platform.id}${opts.agent ? ` / ${opts.agent}` : ''})\n`);
    }
    return;
  }

  const header = ['状态', '会话 id', '最后活动', '消息数', '标题', '首条用户消息', '最后消息', '目录'];
  const width = { 0: 6, 1: 6, 2: 10, 3: 5, 4: 6, 5: 14, 6: 14, 7: 6 };
  function cell(s, i) {
    switch (i) {
      case 0: return labelFor(s.status);
      case 1: return s.id || '';
      case 2: return s.lastActivity || s.timestamp || '';
      case 3: return String(s.messageCount || 0);
      case 4: return s.title || s.firstUserMessage || '';
      case 5: return s.firstUserMessage || '';
      case 6: return s.lastMessage ? `${s.lastMessage.role}: ${s.lastMessage.text}` : '';
      case 7: return s.cwd || '';
      default: return '';
    }
  }
  for (const s of shown) {
    header.forEach((_, i) => {
      const len = [...cell(s, i)].length;
      if (len > width[i]) width[i] = Math.min(len, 120);
    });
  }
  process.stdout.write(`${header.map((h, i) => pad(h, width[i])).join('  ').trimEnd()}\n`);
  for (const s of shown) {
    const row = header.map((_, i) => pad(cell(s, i), width[i]));
    process.stdout.write(`${row.join('  ').trimEnd()}\n`);
  }
}

// --- show ---

function messageText(m) {
  const parts = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text || '');
  return parts.join('\n');
}

function messageBlock(m, maxText) {
  let role = m.role || 'unknown';
  const line = [m.timestamp || ''].filter(Boolean);
  if (m.model) line.unshift(`[${m.model}]`);
  const meta = role === 'toolCall' ? `${m.toolName || ''}${m.toolCallId ? ` ${m.toolCallId}` : ''}`.trim()
    : role === 'toolResult' ? (m.isError ? '[error]' : '[ok]')
    : role === 'reasoning' ? '[thinking]' : '';
  const head = `# ${role}${meta ? ` ${meta}` : ''}${line.length ? `  ${line.join(' ')}` : ''}`;
  const lines = [head];

  // 文本内容
  const text = messageText(m);
  if (text) {
    const body = maxText > 0 && [...text].length > maxText ? `${[...text].slice(0, maxText).join('')}…` : text;
    for (const l of body.split('\n')) lines.push(`   ${l}`);
  }

  // 内嵌在消息 content 里的 toolCall 块（claude 风格），单独角色消息已由 meta 覆盖
  for (const c of m.content || []) {
    if (c.type !== 'toolCall') continue;
    const argsText = c.arguments != null ? JSON.stringify(c.arguments) : '';
    const body = maxText > 0 && [...argsText].length > maxText ? `${[...argsText].slice(0, maxText).join('')}…` : argsText;
    lines.push(`   → call ${c.name || ''}${c.id ? ` ${c.id}` : ''}${body ? `  ${body}` : ''}`);
  }

  if (!text && !(m.content || []).some((c) => c.type === 'toolCall') && m.details != null) {
    const body = maxText > 0 ? JSON.stringify(m.details).slice(0, maxText) : JSON.stringify(m.details);
    lines.push(`   ${body}`);
  }
  return lines.join('\n');
}

async function showSession(opts, json) {
  const platform = resolvePlatform(opts.platform);
  if (opts.id == null || opts.id === '') throw new Error('--id <SESSION_ID> 是必填项。');
  const dir = resolveDir(opts.dir, platform.defaultDir());
  const payload = platform.needsAgent
    ? opts.agent
      ? await platform.getSession(dir, opts.id, { agent: opts.agent })
      : (() => { throw new Error(`openclaw 平台需要 --agent <name>。`); })()
    : await platform.getSession(dir, opts.id);
  if (!payload) throw new Error(`Session '${opts.id}' not found on platform '${platform.id}'.`);

  const session = payload.session || {};
  const messages = payload.messages || [];
  const maxText = opts.full ? 0 : 2000;
  if (opts.tail != null) sanitizeNonNegInt(opts.tail, '--tail');

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'session',
        platform: platform.id,
        session,
        messages: opts.tail != null ? messages.slice(-Math.max(0, opts.tail)) : messages,
      })}\n`
    );
    return;
  }

  const header = `# Session ${session.id || opts.id} (${platform.id})`;
  process.stdout.write(`${header}\n`);
  for (const [key, value] of Object.entries(session)) {
    if (value === null || value === undefined || value === '' || Array.isArray(value)) continue;
    process.stdout.write(`  ${key.padEnd(13)}${typeof value === 'object' ? JSON.stringify(value) : value}\n`);
  }
  process.stdout.write(`  ${'messages'.padEnd(13)}${messages.length}\n`);

  const tail = opts.tail != null ? Math.max(0, opts.tail) : 0;
  const shown = tail > 0 ? messages.slice(-tail) : messages;
  if (shown.length === 0) {
    process.stdout.write('(no messages)\n');
    return;
  }
  process.stdout.write('\n');
  let index = messages.length - shown.length; // 每条原始序号，便于与 --json 对照
  for (const m of shown) {
    process.stdout.write(`\n[${index + 1}]\n${messageBlock(m, maxText)}\n`);
    index++;
  }
}

// --- resume ---

const RESUME_BINS = {
  codex: { bin: 'codex', args: (id) => ['resume', id, '--yolo'] },
  'claude-code': { bin: 'claude', args: (id) => ['--dangerously-skip-permissions', '--resume', id] },
  omp: { bin: 'omp', args: (id) => ['--auto-approve', `--resume=${id}`] },
};

function runChild(bin, args, cwd) {
  return new Promise((resolvePromise) => {
    let code;
    const child = spawn(bin, args, { cwd: cwd || undefined, stdio: 'inherit' });
    child.on('error', (error) => resolvePromise({ error }));
    child.on('close', (exitCode) => {
      code = typeof exitCode === 'number' ? exitCode : 1;
      resolvePromise({ code });
    });
  });
}

async function resumeSession(opts, json) {
  const platform = resolvePlatform(opts.platform);
  const spec = RESUME_BINS[platform.id];
  if (!spec) {
    throw new Error(
      `Platform '${platform.id}' has no native resume command. Only codex / claude-code / omp are supported.`
    );
  }
  if (opts.id == null || opts.id === '') throw new Error('--id <SESSION_ID> 是必填项。');

  const dir = resolveDir(opts.dir, platform.defaultDir());
  const payload = await platform.getSession(dir, opts.id);
  if (!payload) throw new Error(`Session '${opts.id}' not found on platform '${platform.id}'.`);
  const cwd = opts.cwd != null ? opts.cwd : payload.session?.cwd || null;

  // 统一语义：同 id 续跑、不接受派生。OMP 目标未结束时，--run 先追加 session_exit
  // 收尾（"先结束再续跑"），从而让 OMP 原地续写而非派生。
  let willFork = null;
  let note = null;
  let finalized = false;
  let slugDir = null;
  let filesBefore = null;
  let ompFile = null;
  if (platform.id === 'omp') {
    ompFile = await findOmpSessionFile(dir, opts.id);
    const state = ompResumeState(ompFile);
    willFork = state.willFork;
    if (state.ended === false) {
      if (opts.run) {
        finalizeOmpSession(ompFile, state.last);
        finalized = true;
        note = `目标 omp 会话未结束，已先追加 session_exit（${OMP_FINALIZE_REASON}）收尾，再以原 id 原地续跑（本工具不接受派生）。`;
        process.stderr.write(`agentlray sessions: ${note}\n`);
      } else {
        note = '目标 omp 会话未结束：--run 会先追加 session_exit 收尾，再以原 id 原地续跑（不做派生）。';
        process.stderr.write(`agentlray sessions: ${note}\n`);
      }
    }
    if (opts.run && ompFile) {
      slugDir = path.dirname(ompFile);
      filesBefore = new Set(fs.readdirSync(slugDir));
    }
  }

  const args = spec.args(opts.id);
  if (opts.message != null) args.push(String(opts.message));
  const command = `${cwd ? `cd ${shellQuote(cwd)} && ` : ''}${spec.bin} ${args.map(shellToken).join(' ')}`;

  if (!opts.run) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'resume',
          platform: platform.id,
          id: opts.id,
          cwd,
          bin: spec.bin,
          args,
          command,
          willFork,
          finalized,
          note,
          executed: false,
        })}\n`
      );
      return;
    }
    process.stdout.write(`${command}\n`);
    return;
  }

  const result = await runChild(spec.bin, args, cwd);
  if (result.error) throw new Error(`Failed to run '${spec.bin}': ${result.error.message}`);

  // 收尾后若 OMP 仍派生新会话（并发写入等极端情况），如实提醒，不掩盖。
  let forked = null;
  if (platform.id === 'omp' && slugDir) {
    forked = findOmpFork(slugDir, opts.id, filesBefore);
    if (forked) {
      process.stderr.write(
        `agentlray sessions: 警告：OMP 仍派生了新会话 ${forked}（parentSession=${opts.id}），未能做到同 id 续跑。\n`
      );
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'resume',
        platform: platform.id,
        id: opts.id,
        cwd,
        bin: spec.bin,
        args,
        command,
        willFork,
        finalized,
        note,
        forked,
        executed: true,
        exitCode: result.code,
      })}\n`
    );
  }
  process.exitCode = result.code;
}

// --- entry ---

const OPTION_DEFS = {
  '--platform': { key: 'platform', type: 'string' },
  '--id': { key: 'id', type: 'string' },
  '--agent': { key: 'agent', type: 'string' },
  '--dir': { key: 'dir', type: 'string' },
  '--status': { key: 'status', type: 'string' },
  '--match': { key: 'match', type: 'string' },
  '--since': { key: 'since', type: 'string' },
  '--until': { key: 'until', type: 'string' },
  '--limit': { key: 'limit', type: 'int' },
  '--offset': { key: 'offset', type: 'int' },
  '--tail': { key: 'tail', type: 'int' },
  '--full': { key: 'full', type: 'boolean' },
  '--cwd': { key: 'cwd', type: 'string' },
  '--message': { key: 'message', type: 'string' },
  '--run': { key: 'run', type: 'boolean' },
  '--json': { key: 'json', type: 'boolean' },
};

async function main(args, _mode = 'sessions') {
  // 子命令位于第一个位置参数（list | show | resume | help）；mode 恒为 'sessions'。
  const command = (args[0] || '').toLowerCase() === 'continue' ? 'resume' : (args[0] || '');
  const rest = args.slice(1);
  let json = rest.includes('--json');
  try {
    if (command === '' || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write(HELP);
      return;
    }
    if (!['list', 'show', 'resume'].includes(command)) {
      const e = new Error(`Unknown subcommand '${command}'. Expected list | show | resume.`);
      e.usage = true;
      throw e;
    }
    const opts = parseOptions(rest, OPTION_DEFS);
    json = Boolean(opts.json);
    if (command === 'list') await listSessions(opts, json);
    else if (command === 'show') await showSession(opts, json);
    else await resumeSession(opts, json);
  } catch (error) {
    emitError(json, error.message, error.usage === true);
  }
}

module.exports = { main, HELP, resumeSession, listSessions, showSession };
