'use strict';
// agentlray sessions — 终端会话查询与续跑工具。
//
//   list   按条件查询会话列表（全部平台；openclaw 缺省 --agent = 合并全部 agents）
//   show   查看单个会话详细信息（会话元信息 + 消息时间线；openclaw 缺省 --agent 跨 agent 查找）
//   resume 生成并（可选）执行续跑命令（内置 codex / claude-code / omp / dsh /
//          gemini / hermes；自定义平台可经适配器 resume opt-in 接入）
//
// 与 inspect.js 相同的输出约定：--json 输出 {schemaVersion:1,…}，错误为
// {schemaVersion:1, kind:'error', error:{code,message}}；退出码 0 = 命令成功
// 完成（对 resume 指命令已执行、非任务成功），1 = 参数/运行时错误。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PLATFORMS, ALL_PLATFORMS } = require('../lib/platforms');
const { resolveDir } = require('../lib/config');
const { hasResumeContract, buildResumeCommand } = require('../lib/resume');
const { hasCreateContract, buildNewCommand, spawnNewSession } = require('../lib/new');
const { setStatusConfig } = require('../lib/status');
const { loadStatusConfig } = require('../lib/status-config');
const { loadUiSettings } = require('../lib/ui-settings');
const { migrateLegacySettings } = require('../lib/settings');
const { STATUS, STATUS_LABELS } = require('../lib/status');
const {
  parsePlatformSelection,
  listSessionsBySelection,
  filterAndPage,
} = require('../lib/session-list');

const HELP = `Usage:
  agentlray sessions list   [--platform <p|p1,p2|all>] [--agent NAME] [--dir PATH]
                            [--status <s,...>] [--match TEXT]
                            [--since ISO] [--until ISO] [--limit N] [--offset N] [--json]
  agentlray sessions show   [--platform <p>] --id <SESSION_ID> [--agent NAME] [--dir PATH]
                            [--tail N] [--full] [--json]
  agentlray sessions resume [--platform <p>] --id <SESSION_ID>
                            [--dir PATH] [--cwd PATH] [--message TEXT] [--run] [--json]
  agentlray sessions new    [message...] [--platform <p>] [--dir PATH] [--run] [--json]

list:   按条件查询会话列表，支持一次查多个平台：--platform 逗号分隔多值（omp,codex）
        或 all（全部 7 平台）。openclaw 未传 --agent 时默认查询该平台全部 agents 的
        合并会话（单平台展平为一段、每条带 agent 来源；多平台聚合每个 agent 一段）。
        结果按各平台既有分组排序（状态组内时间降序）；每条含 firstUserMessage 首条
        用户消息与 lastMessage（最后一条 user/assistant 内容）。JSON：单平台输出
        {platform,agent,total,offset,limit,sessions}；多平台输出 {platform,all,
        platformIds,total,offset,limit,platforms:[{platform,agent,total,offset,limit,
        sessions}]}，纯文本以 "== platform [/agent] ==" 分段。
show:   查看单个会话的元信息与归一化消息时间线（openclaw 未传 --agent 时跨全部
        agents 查找该 id，JSON 含 agent 归属）。
resume: 生成该会话在原 CLI 中的续跑命令（codex resume / claude --resume /
        omp --resume= / 自定义平台 resume 生成器），默认只打印命令不执行；加
        --run 才真正 spawn 平台 CLI 执行并透传 stdin/stdout 与退出码。统一语义：
        **同 id 续跑、不接受派生**——codex/claude 原生同 id 续写；omp 目标若正被
        运行中的 omp 实例以 --resume 持有（会话非空闲，续跑必派生），--run 会拒绝
        并在提示中给出持有进程 pid，请先结束该实例（退出其终端令会话 dispose）再
        续跑。内置仅 codex/claude-code/omp 有原生续跑契约；自定义平台需适配器声明
        resume（bin + args(id,opts)），缺省则 resume 报错。
new:   生成并（可选）执行「新建会话」命令（spawn 平台 CLI 开一个全新会话，
       带提示词 + 工作目录；默认只打印命令不执行，--run 才真正 fire-and-forget
       spawn，输出丢弃、不跟踪进程、不等待退出）。内置 codex / claude-code / omp /
       gemini / hermes 可建（dsh 是交互式 TUI，无法 headless 传提示词 → 不支持
       新建）；自定义平台需适配器声明 create（bin + args(opts)），缺省则 new 报错。
       提示词 = new 后剩余位置参数 join(' ')，可空（空 = 无提示词裸启/开交互式）。

公共参数：
  --platform <p>  可选。list/show 支持逗号分隔多平台或 all（全部平台）；resume/new 支持
                  内置 codex|claude-code|omp（resume）或 codex|claude-code|omp|gemini|hermes
                  （new）或声明了对应契约的自定义平台。缺省使用页面持久化的平台数据（看板
                  /api/settings 落盘的 ~/.agentlray/settings.json）：list 用持久化的多选集合（单平台模式用
                  platform，未持久化或全选时 = all）；show/resume/new 用持久化的单平台，无该数据则
                  报错要求显式指定。
  --id <ID>       会话 id（show/resume）
  --agent <name>  openclaw 下的 agent 名（缺省 = 该平台全部 agents 的合并会话；其他平台忽略）
  --dir <path>    list/show 覆盖平台默认数据目录（仅单平台查询有效；多平台各自用默认目录）；
                  new 作为执行目录 cwd（缺省取平台默认目录 defaultDir()）
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
  --run           resume 真正执行，而非只打印命令；new 真正 fire-and-forget spawn
  --json          机器可读 JSON 输出（错误为 {schemaVersion:1,kind:"error",...}）

Exit 0: 命令执行成功（resume/new 指已生成/已触发，非任务成功）。Exit 1: 参数或运行时错误。
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

// 平台存在于 catalog 但未挂载（停用/替代待生效，重启后生效）的提示与 lib/session-list
// 保持一致：让 CLI 用户知道是配置问题而非拼写问题。
function resolvePlatform(id) {
  const platform = id && PLATFORMS[id];
  if (!platform) {
    if (id && ALL_PLATFORMS.has(id)) {
      throw new Error(
        `Platform '${id}' 当前未挂载（已在平台管理中停用或替代待生效）：重启后生效，可用 agentlray platform mount ${id} 恢复。`
      );
    }
    throw new Error(
      `Unknown platform '${id}'. Expected one of: ${Object.keys(PLATFORMS).join(', ')}.`
    );
  }
  return platform;
}

// --platform 缺省时，用页面持久化的平台数据（web 看板经 GET/PUT /api/settings 落盘的
// ~/.agentlray/settings.json 的 ui section）推导默认选择。list 接受多选/全部；show/resume 需单平台。
async function resolveDefaultPlatform(command) {
  const ui = await loadUiSettings();
  if (command === 'list') {
    // 页面持久化优先：selectedPlatforms 非空 → 按该集合查询（全选 → all）；
    // 单平台模式（selectedPlatforms 空）→ 用 platform；无持久化 → all（与前端默认一致）。
    if (ui && Array.isArray(ui.selectedPlatforms) && ui.selectedPlatforms.length > 0) {
      const picked = ui.selectedPlatforms.filter((name) => PLATFORMS[name]);
      if (picked.length === 0) return 'all';
      return picked.length === Object.keys(PLATFORMS).length ? 'all' : picked.join(',');
    }
    if (ui && PLATFORMS[ui.platform]) return ui.platform;
    return 'all';
  }
  const def = ui && PLATFORMS[ui.platform] ? ui.platform : null;
  if (!def) {
    const e = new Error(
      `未提供 --platform，且没有页面持久化的平台数据（~/.agentlray/settings.json）。` +
        `请先在看板页面选择平台，或显式传 --platform。`
    );
    e.usage = true;
    throw e;
  }
  return def;
}

function sanitizeNonNegInt(value, flag) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`'${flag}' expects a nonnegative integer.`);
  return value;
}

// 终端纯文本对齐：按码点位宽 padEnd（CJK 在等宽终端为双宽，这里只做近似对齐）。
function pad(text, width) {
  return String(text).padEnd(width);
}

function labelFor(status) {
  return STATUS_LABELS[status] || status;
}

// omp 特有的续跑治理（检测运行中持有实例 / 自动终止 / 派生兜底）已迁入
// lib/platforms/omp-resume-impl.js，经 builtin/omp.js 的 resumeHooks 对 CLI 暴露；
// 此处不再保留任何 omp 专属逻辑。

// --- list ---

// 纯文本表格。header/width/cell 与原单平台实现一致；withAgent 时（openclaw
// 全 agent 合并视图）在行首加一列 agent 来源。
function renderSessionsTable(shown, withAgent = false) {
  const header = withAgent
    ? ['agent', '状态', '会话 id', '最后活动', '消息数', '标题', '首条用户消息', '最后消息', '目录']
    : ['状态', '会话 id', '最后活动', '消息数', '标题', '首条用户消息', '最后消息', '目录'];
  const width = withAgent
    ? { 0: 18, 1: 6, 2: 6, 3: 10, 4: 5, 5: 6, 6: 14, 7: 14, 8: 6 }
    : { 0: 6, 1: 6, 2: 10, 3: 5, 4: 6, 5: 14, 6: 14, 7: 6 };
  function cell(s, i) {
    if (withAgent) {
      switch (i) {
        case 0: return s.agent || '';
        case 1: return labelFor(s.status);
        case 2: return s.id || '';
        case 3: return s.lastActivity || s.timestamp || '';
        case 4: return String(s.messageCount || 0);
        case 5: return s.title || s.firstUserMessage || '';
        case 6: return s.firstUserMessage || '';
        case 7: return s.lastMessage ? `${s.lastMessage.role}: ${s.lastMessage.text}` : '';
        case 8: return s.cwd || '';
        default: return '';
      }
    }
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

async function listSinglePlatform(opts, json, id) {
  // needsAgent 平台未传 --agent：默认查该平台全部 agents 的合并会话（展平为一份，
  // 每条带 agent 来源；过滤/分页在合并集上全局生效）。
  const platform = PLATFORMS[id];
  const allAgents = Boolean(platform && platform.needsAgent && !opts.agent);
  let sessions = [];
  let total = 0;
  let offset = 0;
  let limit = null;

  if (allAgents) {
    // 走平台适配器 listAllAgents hook：扁平合并全部 agents（同 lib/session-list.js
    // listOpenclawSessionsFlat 的委托实现），过滤/分页在合并集上全局生效。
    const all = await platform.listAllAgents(resolveDir(opts.dir, platform.defaultDir()), {
      includeArchived: false,
    });
    const paged = filterAndPage(all, opts);
    sessions = paged.shown;
    total = paged.total;
    offset = paged.offset;
    limit = paged.limit;
  } else {
    const result = await listSessionsBySelection({ all: false, ids: [id] }, opts);
    const entry = result.platforms[0];
    sessions = entry ? entry.sessions : [];
    total = result.total;
    offset = result.offset;
    limit = result.limit;
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'sessions',
        platform: id,
        agent: opts.agent || null,
        allAgents,
        total,
        offset,
        limit,
        sessions,
      })}\n`
    );
    return;
  }

  if (sessions.length === 0) {
    if (offset === 0) {
      process.stdout.write(`(no sessions for ${id}${opts.agent ? ` / ${opts.agent}` : ''})\n`);
    }
    return;
  }
  renderSessionsTable(sessions, allAgents);
}

async function listMultiPlatforms(opts, json, selection) {
  if (opts.dir != null) {
    throw new Error('--dir 仅支持单平台模式；多平台查询各自使用默认数据目录（可用各平台环境变量覆盖）。');
  }
  const result = await listSessionsBySelection(selection, opts);

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'sessions',
        platform: selection.all ? 'all' : selection.ids.join(','),
        all: selection.all,
        platformIds: selection.ids,
        total: result.total,
        offset: result.offset,
        limit: result.limit,
        platforms: result.platforms,
      })}\n`
    );
    return;
  }

  result.platforms.forEach((g, i) => {
    if (i > 0) process.stdout.write('\n');
    process.stdout.write(`== ${g.platform}${g.agent ? ` / ${g.agent}` : ''} ==\n`);
    if (g.sessions.length === 0) {
      process.stdout.write(`(no sessions for ${g.platform}${g.agent ? ` / ${g.agent}` : ''})\n`);
      return;
    }
    renderSessionsTable(g.sessions);
  });
}

async function listSessions(opts, json) {
  const selection = parsePlatformSelection(opts.platform);
  if (selection.all || selection.ids.length > 1) {
    await listMultiPlatforms(opts, json, selection);
  } else {
    await listSinglePlatform(opts, json, selection.ids[0]);
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
  let payload;
  let foundAgent = null;
  if (platform.needsAgent) {
    if (opts.agent) {
      payload = await platform.getSession(dir, opts.id, { agent: opts.agent });
      foundAgent = opts.agent;
    } else if (typeof platform.getSessionAcrossAgents === 'function') {
      const across = await platform.getSessionAcrossAgents(dir, opts.id);
      if (across) {
        payload = { session: across.session, messages: across.messages };
        foundAgent = across.agent;
      } else {
        payload = null;
      }
    } else {
      payload = null;
    }
  } else {
    payload = await platform.getSession(dir, opts.id);
  }
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
        agent: platform.needsAgent ? foundAgent : null,
        session,
        messages: opts.tail != null ? messages.slice(-Math.max(0, opts.tail)) : messages,
      })}\n`
    );
    return;
  }

  const header = `# Session ${session.id || opts.id} (${platform.id}${foundAgent ? ` / ${foundAgent}` : ''})`;
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

// 原生续跑参数生成器与命令串构建的统一真源在 lib/resume.js（RESUME_BINS +
// hasResumeContract + buildResumeCommand），CLI 与 web「复制恢复命令」共用。

function runChild(bin, args, cwd) {
  return new Promise((resolvePromise) => {
    let code;
    // 数组参数 + shell:true 会触发 Node DEP0190：参数仅拼接不转义，--message 等
    // 用户输入可被注入 cmd.exe 执行（K1）。因此 win32 改为先 resolve 出可执行文件
    // 的完整路径（.cmd/.bat/.exe 依次探测），再以无 shell 方式 spawn——既消除注入面，
    // 又让 .cmd 脚本无需经 cmd.exe 即可执行（Node 直接 spawn .cmd 也能跑）。
    const exec = resolveExecutablePath(bin);
    const child = spawn(exec, args, { cwd: cwd || undefined, stdio: 'inherit' });
    child.on('error', (error) => resolvePromise({ error }));
    child.on('close', (exitCode) => {
      code = typeof exitCode === 'number' ? exitCode : 1;
      resolvePromise({ code });
    });
  });
}

// win32 将裸命令名/相对路径 resolve 为可执行文件全路径（绝对路径原样返回）。
// 按 PATH 顺序探测 <dir>/<name>、<dir>/<name>.cmd/.bat/.exe/.com；全部 miss 时
// 回退传入原值（spawn 报 ENOENT，错误信息含原命令名，便于诊断）。POSIX 直接返回
// 原值（PATH 解析交给 spawn 自身，行为与改动前一致）。
function resolveExecutablePath(bin) {
  if (process.platform !== 'win32' || !bin) return bin;
  if (path.isAbsolute(bin)) {
    return binWithSuffix(bin);
  }
  const ext = path.extname(bin);
  const suffixes = ext ? [''] : ['.cmd', '.bat', '.exe', '.com'];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = path.join(dir, bin + suffix);
      try {
        fs.accessSync(candidate);
        return candidate;
      } catch {
        /* keep scanning */
      }
    }
  }
  return bin;
}

function binWithSuffix(bin) {
  if (path.extname(bin)) return bin;
  const suffixes = ['.cmd', '.bat', '.exe', '.com'];
  for (const suffix of suffixes) {
    try {
      fs.accessSync(bin + suffix);
      return bin + suffix;
    } catch {
      /* keep scanning */
    }
  }
  return bin;
}

async function resumeSession(opts, json) {
  const platform = resolvePlatform(opts.platform);
  if (opts.id == null || opts.id === '') throw new Error('--id <SESSION_ID> 是必填项。');
  // 无原生续跑契约的平台快速失败（内置六平台，或自定义 resume opt-in；契约判断
  // 与命令串构建统一在 lib/resume.js，避免此处与 web 端点各维护一份）。
  if (!hasResumeContract(platform)) {
    throw new Error(
      `Platform '${platform.id}' has no native resume command. Only codex / claude-code / omp / dsh / gemini / hermes, or custom platforms declaring resume, are supported.`
    );
  }

  const dir = resolveDir(opts.dir, platform.defaultDir());
  const payload = await platform.getSession(dir, opts.id);
  if (!payload) throw new Error(`Session '${opts.id}' not found on platform '${platform.id}'.`);
  const cwd = opts.cwd != null ? opts.cwd : payload.session?.cwd || null;
  if (opts.run && cwd && !fs.existsSync(cwd)) {
    throw new Error(`Session cwd 不存在：${cwd}（目录已被移除或未在会话记录中保留），无法在该目录续跑。`);
  }

  // 平台声明 resumeHooks（P2 起 omp 的续跑治理迁于此）：prepare 在续跑前做
  // 平台专属的自查/清理并返回 { note, livePid, terminated, state }，after 在
  // 续跑结束后做兜底校验（如 omp 是否仍派生新会话）。未声明 = 无特殊治理。
  let note = null;
  let livePid = null;
  let terminated = false;
  let resumeState = null;
  const resumeHooks = platform.resumeHooks;
  if (resumeHooks && typeof resumeHooks.prepare === 'function') {
    const prepared = await resumeHooks.prepare({ run: opts.run, dir, id: opts.id, cwd });
    if (prepared) {
      note = prepared.note ?? null;
      livePid = prepared.livePid ?? null;
      terminated = Boolean(prepared.terminated);
      resumeState = prepared.state ?? null;
    }
  }

  // 构建命令串（bin/args/command 单一真源，见 lib/resume.js buildResumeCommand）。
  const { bin, args, command } = await buildResumeCommand(platform, opts.id, { ...opts, cwd });

  if (!opts.run) {
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'resume',
          platform: platform.id,
          id: opts.id,
          cwd,
          bin,
          args,
          command,
          livePid,
          note,
          terminated: false,
          executed: false,
        })}\n`
      );
      return;
    }
    process.stdout.write(`${command}\n`);
    return;
  }

  const result = await runChild(bin, args, cwd);
  if (result.error) throw new Error(`Failed to run '${bin}': ${result.error.message}`);

  // 兜底：即便检测到非持有、放行续跑，若 OMP 仍派生了新会话（并发等极端情况），如实提醒。
  // 平台声明 resumeHooks.after 时委托（omp 派生检测），未声明无此校验。
  let forked = null;
  if (resumeHooks && typeof resumeHooks.after === 'function') {
    const after = await resumeHooks.after({ run: opts.run, id: opts.id, state: resumeState });
    if (after) forked = after.forked ?? null;
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'resume',
        platform: platform.id,
        id: opts.id,
        cwd,
        bin,
        args,
        command,
        livePid,
        note,
        terminated,
        forked,
        executed: true,
        exitCode: result.code,
      })}\n`
    );
  }
  process.exitCode = result.code;
}

// --- new ---

// 新建会话（create）参数生成器与命令串构建统一在 lib/new.js（NEW_BINS +
// hasCreateContract + buildNewCommand + spawnNewSession），CLI 与 web「新建任务」共用。
async function newSession(opts, json) {
  const platform = resolvePlatform(opts.platform);
  // 无新建契约的平台快速失败（内置五平台，或自定义 create opt-in）。
  if (!hasCreateContract(platform)) {
    throw new Error(
      `Platform '${platform.id}' has no native create command. Only codex / claude-code / omp / gemini / hermes, or custom platforms declaring create, are supported.`
    );
  }
  // message = new 后剩余位置参数 join(' ')，可空（空 = 无提示词裸启/开交互式）。
  const message = opts.message != null ? opts.message : null;
  // cwd = --dir 覆盖，否则平台默认目录（lib/config.js resolveDir：非绝对/含 .. 回退默认）。
  const cwd = resolveDir(opts.dir, platform.defaultDir());

  if (!opts.run) {
    const { bin, args, command } = await buildNewCommand(platform, { cwd, message });
    if (json) {
      process.stdout.write(
        `${JSON.stringify({
          schemaVersion: 1,
          kind: 'new',
          platform: platform.id,
          message,
          cwd,
          bin,
          args,
          command,
          executed: false,
        })}\n`
      );
      return;
    }
    process.stdout.write(`${command}\n`);
    return;
  }

  // --run：fire-and-forget spawn（lib/new.js），spawn error → 抛错退出码 1。
  const result = await spawnNewSession(platform, { cwd, message });
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'new',
        platform: platform.id,
        message,
        cwd,
        bin: result.bin,
        args: result.args,
        command: result.command,
        executed: true,
        // fire-and-forget：不跟踪退出码；如实标注不提供查询/终止（进程生命周期管理明确不做）。
        exitCode: null,
      })}\n`
    );
    return;
  }
  process.stdout.write(`已触发新建会话：${result.command}\n`);
  process.stdout.write(`输出在平台 CLI 侧，本工具不跟踪该进程。\n`);
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

// 从 new 子命令的 rest 中抽取「提示词消息」（非选项的位置参数），同时保留选项参数
// 供 parseOptions 解析。选项 flag 及其消费的值（string 型取下一个非 -- 参数）被剔除；
// 其余未识别的 token（含消息正文）并入 positionals。消息可空。
function splitNewArgs(rest) {
  const positionals = [];
  const filtered = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const eq = arg.indexOf('=');
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const def = OPTION_DEFS[flag];
    if (def) {
      filtered.push(arg);
      if (def.type === 'string' && eq === -1 && i + 1 < rest.length && !/^--/.test(rest[i + 1])) {
        filtered.push(rest[i + 1]); // 消费选项值（如 --dir /tmp 的 /tmp）
        i++;
      }
      continue;
    }
    positionals.push(arg); // 未知 token / 位置参数 → 消息正文
  }
  return { positionals, filtered };
}

async function main(args, _mode = 'sessions') {
  // 子命令位于第一个位置参数（list | show | resume | new | help）；mode 恒为 'sessions'。
  const command = (args[0] || '').toLowerCase() === 'continue' ? 'resume' : (args[0] || '');
  const rest = args.slice(1);
  let json = rest.includes('--json');
  try {
    if (command === '' || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write(HELP);
      return;
    }
    if (!['list', 'show', 'resume', 'new'].includes(command)) {
      const e = new Error(`Unknown subcommand '${command}'. Expected list | show | resume | new.`);
      e.usage = true;
      throw e;
    }
    // 入口幂等迁移旧独立设置文件 → ~/.agentlray/settings.json（Q-B：CLI 单独运行时
    // 升级也能读到页面/旧文件落的配置；settings.json 已存在则无操作）。
    await migrateLegacySettings();
    // new 的提示词 = 位置参数 join(' ')，可空；先拆分再解析选项。
    const newSplit = command === 'new' ? splitNewArgs(rest) : { filtered: rest, positionals: [] };
    const opts = parseOptions(newSplit.filtered, OPTION_DEFS);
    if (command === 'new') opts.message = newSplit.positionals.join(' ');
    json = Boolean(opts.json);
    // --platform 非必填：缺省使用页面持久化的平台数据（看板 /api/settings 落盘的文件）。
    if (opts.platform == null) opts.platform = await resolveDefaultPlatform(command);
    // list 依赖状态判定；启动即加载页面持久化的状态时间配置（无则默认），
    // 保证终端与 web 看板视角一致。
    if (command === 'list') {
      try {
        setStatusConfig(await loadStatusConfig());
      } catch {
        // 配置损坏/缺失回退默认窗口。
      }
    }
    if (command === 'list') await listSessions(opts, json);
    else if (command === 'show') await showSession(opts, json);
    else if (command === 'new') await newSession(opts, json);
    else await resumeSession(opts, json);
  } catch (error) {
    emitError(json, error.message, error.usage === true);
  }
}

module.exports = {
  main,
  HELP,
  resumeSession,
  listSessions,
  showSession,
  newSession,
  resolveExecutablePath,
};
