'use strict';
// agentlray platform — 平台清单、适配器校验、启停/替代控制与内置迁移工具。
//
//   list      列出全部平台（内置 + 项目 + 自定义 + broken），与 GET /api/platforms 同源
//             （lib/platforms.listPlatformInfo 单一真源）。
//   validate  对单个适配器文件做「与加载器同一套」校验（复用 loader.validateAdapter），
//             通过后再调真实 list(defaultDir()) 报会话计数与首条 id。
//             dry-run：不写 registry、不改 PLATFORMS、不持久化任何状态。
//   mount/unmount   挂载/停用平台（写 settings.platforms.disabled，重启后生效）。
//   replace/unreplace   声明/撤销替代包内置（写 settings.platforms.replaced，重启后生效）。
//   export    把包内置/项目平台导出为用户薄适配器（迁移到 ~/.agentlray/platforms），
//             默认加入 replaced、移出 disabled；写 ~/.agentlray/platforms/<id>.js。
//
// 与 inspect.js / sessions.js 相同的输出约定：--json 输出 {schemaVersion:1,…}，
// 错误为 {schemaVersion:1, kind:'error', error:{code,message}}；退出码 0 = 成功，
// 1 = 参数/运行时/校验错误。

const fs = require('fs');
const path = require('path');
const { PLATFORMS, ALL_PLATFORMS, listPlatformInfo } = require('../lib/platforms');
const { validateAdapter, readProjectManifestReplaces } = require('../lib/platforms/loader');
const {
  setPlatformMounted,
  setPlatformReplaced,
  loadPlatformSection,
  savePlatformSection,
  catalogGet,
} = require('../lib/platform-config');

// 信任边界提示（validate / export 的 --json/文本输出各出现一次，共用此常量防漂移）。
const TRUST_NOTE = '平台适配器会以你的用户权限执行其任意代码：只投递可信的适配器文件。';

// 默认导出目录：~/.agentlray/platforms（与 loader 的 user 来源一致）。
function defaultExportDir() {
  return process.env.AGENTLRAY_PLATFORMS_DIR || path.join(require('../lib/config').HOME, '.agentlray', 'platforms');
}

const HELP = `Usage:
  agentlray platform list                       [--json]
  agentlray platform validate <file>            [--json]
  agentlray platform mount <id>                 [--json]
  agentlray platform unmount <id>               [--json]
  agentlray platform replace <id>               [--json]
  agentlray platform unreplace <id>             [--json]
  agentlray platform export <id> [--out <dir>] [--force] [--no-replace] [--json]

list:   列出全部平台，与 GET /api/platforms 同源（lib/platforms.listPlatformInfo）。
         顺序：内置（注册表插入序）→ 项目/自定义（文件名字母序）→ broken（文件名字母序）。
         broken 附带加载/校验错误便于排查；AGENTLRAY_NO_PLUGINS=1 时自定义缺席、仅一条逃生说明。
validate: 对给定适配器文件做与加载器同一套校验（导出对象 / id 正则 ^[a-z0-9][a-z0-9-]*$ /
         label 字符串 / 必需函数 defaultDir、parse、getSession【list 可为 null 语义，不改】/
         id 不冲突）。通过后再调其 list(defaultDir()) 取会话计数与首条 id；
         list 缺失、defaultDir 目录不存在或 list 抛错 → 「校验通过但会话不可读」报错。
         dry-run：不写 registry、不改 PLATFORMS、不持久化任何状态。
mount/unmount: 挂载/停用平台——写 settings.platforms.disabled，重启后生效。
         停用最后一个可查询平台 → exit 1 + 错误码 last-platform。
replace/unreplace: 声明/撤销对包内置的替代——写 settings.platforms.replaced，重启后生效。
         unreplace 后若同 id 用户/项目文件仍存在，下次加载会 broken（输出提示）。
export: 把包内置（origin=package）或项目平台（origin=project）导出为【用户薄适配器】，
         写入 --out 目录（缺省 ~/.agentlray/platforms）下的 <id>.js。默认：
           · 把该 id 加入 settings.replaced（--no-replace 关闭）；
           · 若该 id 在 settings.disabled 中，移出（迁移语义，恢复挂载）；
         --force 覆盖已存在的 <id>.js；user 来源（已是本地自定义）拒绝导出。
         薄适配器通过 AGENTLRAY_PKG_ROOT 解析包内路径，包升级后自动跟随新实现。

--json   机器可读 JSON，写 stdout。成功：list → {schemaVersion:1,kind:"platforms",
         platforms:[…]}；validate → {schemaVersion:1,kind:"platform-validate",ok:true,
         platform:{id,label},sessionCount,firstId,note}；mount/unmount/replace/unreplace/
         export → {schemaVersion:1,kind:"platform-<cmd>",…}。错误一律
         {schemaVersion:1,kind:"error",error:{code,message}}。

信任边界：${TRUST_NOTE}

Exit 0: 成功（validate 指校验通过且会话可读）。Exit 1: 参数/运行时/校验错误。
`;

function errorDocument(code, message) {
  return { schemaVersion: 1, kind: 'error', error: { code, message } };
}

function emitError(json, message, code = 'usage', help = false) {
  if (json) process.stdout.write(`${JSON.stringify(errorDocument(code, message))}\n`);
  process.stderr.write(`agentlray platform: ${message}\n${help && !json ? HELP : ''}`);
  process.exitCode = 1;
}

// 返回 { json, positionals, options }；knownFlag 白名单外的未知选项视为 usage 错误。
// 支持 --opt value（如 --out <dir>）与布尔旗标（--force/--no-replace/--json）。
function parseArgs(args, knownFlags = []) {
  const out = { json: false, positionals: [], options: {} };
  const usageError = (m) => {
    const e = new Error(m);
    e.usage = true;
    throw e;
  };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--json') {
      out.json = true;
      i++;
    } else if (arg === '--force') {
      out.options.force = true;
      i++;
    } else if (arg === '--no-replace') {
      out.options.noReplace = true;
      i++;
    } else if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (!knownFlags.includes(name)) usageError(`Unknown option '${arg}'.`);
      if (i + 1 >= args.length) usageError(`Option '${arg}' requires a value.`);
      out.options[name] = args[i + 1];
      i += 2;
    } else if (arg.startsWith('-')) {
      usageError(`Unknown option '${arg}'.`);
    } else {
      out.positionals.push(arg);
      i++;
    }
  }
  delete out.options.json; // --json 单独处理
  return out;
}

const ORIGIN_LABEL = { package: 'Builtin', project: 'Project', user: 'Custom' };

function commandList(json) {
  const platforms = listPlatformInfo();
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'platforms', platforms })}\n`);
    return;
  }
  // 纯文本行：来源/broken 清晰标注；broken 附 error（label 为 null）。
  for (const p of platforms) {
    if (p.broken) {
      process.stdout.write(`Broken   ${p.id ?? '(unnamed)'}    ${p.error ?? ''}\n`);
    } else {
      const origin = ORIGIN_LABEL[p.origin] || 'Custom';
      process.stdout.write(`${origin}    ${p.id}    ${p.label ?? ''}\n`);
    }
  }
}

// 「校验通过但会话不可读」统一错误（defaultDir 抛错 / list 缺失 / list 抛错 / 非数组）。
function sessionUnreadable(reason) {
  const e = new Error(`适配器校验通过但会话不可读：${reason}`);
  e.code = 'validate-sessions';
  return e;
}

async function commandValidate(file, json) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) {
    const e = new Error(`适配器文件不存在：${file}`);
    e.code = 'validate';
    throw e;
  }
  // 结构校验与加载器同套 → 复用 loader.validateAdapter（含 id 冲突判定，registry 用真 PLATFORMS）。
  let adapter;
  try {
    adapter = require(abs);
  } catch (err) {
    const e = new Error(`适配器文件读取/require 失败：${file}（${String((err && err.message) || err)}）`);
    e.code = 'validate';
    throw e;
  }
  const check = validateAdapter(adapter, PLATFORMS);
  if (!check.ok) {
    const e = new Error(`适配器校验失败：${check.error}`);
    e.code = 'validate';
    throw e;
  }

  // 通过后调真实 list(defaultDir())（允许相对/读到就行为）。list 可为 null 语义——
  // loader 不强制 list，但 validate 需枚举会话，缺失即「校验通过但会话不可读」。
  let dir;
  try {
    dir = adapter.defaultDir();
  } catch (err) {
    throw sessionUnreadable(`defaultDir() 抛错：${String((err && err.message) || err)}`);
  }
  let summaries;
  if (typeof adapter.list !== 'function') {
    throw sessionUnreadable('未提供 list 函数（loader 允许 list 为 null），无法枚举会话计数');
  }
  try {
    summaries = await adapter.list(dir);
  } catch (err) {
    throw sessionUnreadable(`list(${dir}) 抛错：${String((err && err.message) || err)}`);
  }
  if (!Array.isArray(summaries)) {
    throw sessionUnreadable(`list(${dir}) 未返回数组`);
  }

  const sessionCount = summaries.length;
  const firstId = sessionCount ? String(summaries[0].id) : null;
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'platform-validate',
        ok: true,
        platform: { id: adapter.id, label: adapter.label },
        sessionCount,
        firstId,
        note: TRUST_NOTE,
      })}\n`
    );
  } else {
    process.stdout.write(
      `platform validate: ok — id=${adapter.id} label=${adapter.label} sessions=${sessionCount} firstId=${firstId}\n`
    );
    process.stderr.write(`agentlray platform: 注意：${TRUST_NOTE}\n`);
  }
}

// catalog 条目解析：返回 { entry }；未知 id → 抛 unknown-platform。
function catalogEntryOf(id) {
  const entry = catalogGet(ALL_PLATFORMS, id);
  if (!entry) {
    const e = new Error(`Unknown platform '${id}'.`);
    e.code = 'unknown-platform';
    throw e;
  }
  return entry;
}

// 通用「重启后生效」输出。json → {schemaVersion:1, kind, …payload}。
function emitRestart(json, kind, payload) {
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind, ...payload, restart: true })}\n`);
}

async function commandMount(id, mounted, json) {
  await setPlatformMounted(id, mounted, ALL_PLATFORMS);
  if (json) {
    emitRestart(json, `platform-${mounted ? 'mount' : 'unmount'}`, { id, mounted });
  } else {
    process.stdout.write(`platform ${mounted ? 'mount' : 'unmount'}: ${id} — 将重启后生效。\n`);
  }
}

async function commandReplace(id, replaced, json) {
  await setPlatformReplaced(id, replaced, ALL_PLATFORMS);
  if (json) {
    emitRestart(json, `platform-${replaced ? 'replace' : 'unreplace'}`, { id, replaced });
    return;
  }
  if (replaced) {
    process.stdout.write(`platform replace: ${id} — 已声明替代包内置，将重启后生效。\n`);
    return;
  }
  // unreplace：检查同 id 的本地适配器文件是否仍存在（user 或 project 来源）。
  const userFile = path.join(defaultExportDir(), `${id}.js`);
  const projDir =
    process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR || path.join(process.env.AGENTLRAY_PKG_ROOT || '.', 'platforms');
  const projFile = path.join(projDir, `${id}.js`);
  const warn =
    fs.existsSync(userFile) || fs.existsSync(projFile)
      ? ` 注意：同 id 的适配器文件仍存在（${fs.existsSync(userFile) ? userFile : projFile}），下次加载会 broken。请删除该文件或改 id。\n`
      : '';
  process.stdout.write(`platform unreplace: ${id} — 已撤销替代，将重启后生效。\n${warn}`);
}

// 薄适配器模板按 §6.5。内部路径为包内 fixed path；导出到用户目录。
function thinAdapterSource(id, internalRelativePath) {
  return `'use strict';
// Generated by \`agentlray platform export ${id}\`. Load through AgentLRay.
const path = require('path');
const root = process.env.AGENTLRAY_PKG_ROOT;
if (!root) throw new Error('AGENTLRAY_PKG_ROOT is not set; load this adapter through AgentLRay.');
module.exports = require(path.join(root, ${JSON.stringify(internalRelativePath)}));
`;
}

// export 的薄适配器内部相对路径：包内置 → lib/platforms/builtin/<id>.js；
// 项目平台 → 仓库内 platforms/<id>.js（相对包根的源码布局）。
function internalRelativePathFor(id, origin) {
  return origin === 'project' ? path.posix.join('platforms', `${id}.js`) : path.posix.join('lib', 'platforms', 'builtin', `${id}.js`);
}

async function commandExport(id, opts, json) {
  const entry = catalogEntryOf(id);
  const origin = entry.origin;
  if (origin === 'user') {
    const e = new Error(`平台 '${id}' 来源为 user（已在 ~/.agentlray/platforms 本地自定义），无需导出。`);
    e.code = 'export-user-origin';
    throw e;
  }
  if (origin !== 'package' && origin !== 'project') {
    const e = new Error(`平台 '${id}' 来源 ${origin} 不可导出（仅 package/project 支持）。`);
    e.code = 'export-origin';
    throw e;
  }

  // 目标目录与文件
  let dir = opts.out ? path.resolve(opts.out) : defaultExportDir();
  const file = path.join(dir, `${id}.js`);
  if (fs.existsSync(file) && !opts.force) {
    const e = new Error(`导出文件已存在：${file}（用 --force 覆盖）。`);
    e.code = 'export-exists';
    throw e;
  }

  // 读当前 settings，先做内存判断（disabled 移出 + replaced 加入），最后统一写盘。
  const state = await loadPlatformSection();
  const wouldReplace = !opts.noReplace;
  const newDisabled = state.disabled.filter((x) => x !== id);
  const newReplaced = [...state.replaced];
  if (wouldReplace && !newReplaced.includes(id)) newReplaced.push(id);

  // §6.5 薄适配器：先写目标文件；settings 最后写，失败不落配置。
  fs.mkdirSync(dir, { recursive: true });
  const source = thinAdapterSource(id, internalRelativePathFor(id, origin));
  fs.writeFileSync(file, source, 'utf8');
  await savePlatformSection({ disabled: newDisabled, replaced: newReplaced });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        kind: 'platform-export',
        id,
        file,
        origin,
        replaced: wouldReplace,
        removedFromDisabled: state.disabled.includes(id),
        restart: true,
        note: TRUST_NOTE,
      })}\n`
    );
  } else {
    process.stdout.write(
      `platform export: ${id} 已导出（origin=${origin}）到 ${file}\n` +
        `  薄适配器通过 AGENTLRAY_PKG_ROOT 解析包内实现，包升级自动跟随。\n` +
        (wouldReplace ? `  已将 ${id} 加入 settings.replaced（--no-replace 可关闭）。\n` : '') +
        (state.disabled.includes(id) ? `  已将 ${id} 移出 settings.disabled，恢复挂载。\n` : '') +
        `  将重启后生效。\n` +
        `  注意：${TRUST_NOTE}\n`
    );
  }
}

async function main(args, _mode = 'platform') {
  const command = args[0] || '';
  const rest = args.slice(1);
  let json = rest.includes('--json');
  try {
    if (command === '' || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write(HELP);
      return;
    }
    if (!['list', 'validate', 'mount', 'unmount', 'replace', 'unreplace', 'export'].includes(command)) {
      const e = new Error(`Unknown subcommand '${command}'. Expected list | validate | mount | unmount | replace | unreplace | export.`);
      e.usage = true;
      throw e;
    }
    const parsed = parseArgs(rest, ['out']);
    json = parsed.json;

    if (command === 'list') {
      if (parsed.positionals.length) {
        const e = new Error("'list' 不接受位置参数。用法：agentlray platform list [--json]");
        e.usage = true;
        throw e;
      }
      commandList(json);
    } else if (command === 'validate') {
      if (parsed.positionals.length !== 1) {
        const e = new Error('validate 需要一个 <file> 参数。用法：agentlray platform validate <file> [--json]');
        e.usage = true;
        throw e;
      }
      await commandValidate(parsed.positionals[0], json);
    } else if (command === 'mount' || command === 'unmount') {
      if (parsed.positionals.length !== 1 || parsed.options.out) {
        const e = new Error(`用法：agentlray platform ${command} <id> [--json]`);
        e.usage = true;
        throw e;
      }
      await commandMount(parsed.positionals[0], command === 'mount', json);
    } else if (command === 'replace' || command === 'unreplace') {
      if (parsed.positionals.length !== 1 || parsed.options.out) {
        const e = new Error(`用法：agentlray platform ${command} <id> [--json]`);
        e.usage = true;
        throw e;
      }
      await commandReplace(parsed.positionals[0], command === 'replace', json);
    } else if (command === 'export') {
      if (parsed.positionals.length !== 1) {
        const e = new Error('export 需要一个 <id> 参数。用法：agentlray platform export <id> [--out <dir>] [--force] [--no-replace] [--json]');
        e.usage = true;
        throw e;
      }
      await commandExport(parsed.positionals[0], parsed.options, json);
    }
  } catch (error) {
    emitError(json, error.message, error.code || 'usage', error.usage === true);
  }
}

module.exports = { main, HELP };
