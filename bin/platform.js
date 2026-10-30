'use strict';
// agentlray platform — 平台清单与适配器校验工具。
//
//   list     列出全部平台（内置 + 自定义 + broken），与 GET /api/platforms 同源
//            （lib/platforms.listPlatformInfo 单一真源）。
//   validate 对单个适配器文件做「与加载器同一套」校验（复用 loader.validateAdapter），
//            通过后再调真实 list(defaultDir()) 报会话计数与首条 id。
//            dry-run：不写 registry、不改 PLATFORMS、不持久化任何状态。
//
// 与 inspect.js / sessions.js 相同的输出约定：--json 输出 {schemaVersion:1,…}，
// 错误为 {schemaVersion:1, kind:'error', error:{code,message}}；退出码 0 = 成功，
// 1 = 参数/运行时/校验错误。

const fs = require('fs');
const path = require('path');
const { PLATFORMS, listPlatformInfo } = require('../lib/platforms');
const { validateAdapter } = require('../lib/platforms/loader');

// 信任边界提示（validate 的 --json/文本输出各出现一次，共用此常量防漂移）。
const TRUST_NOTE = '平台适配器会以你的用户权限执行其任意代码：只投递可信的适配器文件。';

const HELP = `Usage:
  agentlray platform list              [--json]
  agentlray platform validate <file>   [--json]

list:    列出全部平台，与 GET /api/platforms 同源（lib/platforms.listPlatformInfo）。
         顺序：内置（注册表插入序）→ 自定义（文件名字母序）→ broken（文件名字母序）。
         broken 附带加载/校验错误便于排查；AGENTLRAY_NO_PLUGINS=1 时自定义缺席、仅一条逃生说明。
validate: 对给定适配器文件做与加载器同一套校验（导出对象 / id 正则 ^[a-z0-9][a-z0-9-]*$ /
         label 字符串 / 必需函数 defaultDir、parse、getSession【list 可为 null 语义，不改】/
         id 不冲突）。通过后再调其 list(defaultDir()) 取会话计数与首条 id；
         list 缺失、defaultDir 目录不存在或 list 抛错 → 「校验通过但会话不可读」报错。
         dry-run：不写 registry、不改 PLATFORMS、不持久化任何状态。

--json   机器可读 JSON，写 stdout。成功：list → {schemaVersion:1,kind:"platforms",
         platforms:[…]}；validate → {schemaVersion:1,kind:"platform-validate",ok:true,
         platform:{id,label},sessionCount,firstId,note}。错误一律
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

// 解析 --json 与位置参数；未知选项视为 usage 错误（风格同 sessions.js 的 parseOptions）。
function parseArgs(args) {
  const out = { json: false, positionals: [] };
  const usageError = (m) => {
    const e = new Error(m);
    e.usage = true;
    throw e;
  };
  for (const arg of args) {
    if (arg === '--json') {
      out.json = true;
    } else if (arg.startsWith('-')) {
      usageError(`Unknown option '${arg}'.`);
    } else {
      out.positionals.push(arg);
    }
  }
  return out;
}

function commandList(json) {
  const platforms = listPlatformInfo();
  if (json) {
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, kind: 'platforms', platforms })}\n`);
    return;
  }
  // 纯文本行：内置/自定义/broken 清晰标注；broken 附 error（label 为 null）。
  for (const p of platforms) {
    if (p.broken) {
      process.stdout.write(`Broken   ${p.id ?? '(unnamed)'}    ${p.error ?? ''}\n`);
    } else {
      process.stdout.write(`${p.builtin ? 'Builtin' : 'Custom'}   ${p.id}    ${p.label ?? ''}\n`);
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

async function main(args, _mode = 'platform') {
  const command = args[0] || '';
  const rest = args.slice(1);
  let json = rest.includes('--json');
  try {
    if (command === '' || ['help', '--help', '-h'].includes(command)) {
      process.stdout.write(HELP);
      return;
    }
    if (!['list', 'validate'].includes(command)) {
      const e = new Error(`Unknown subcommand '${command}'. Expected list | validate.`);
      e.usage = true;
      throw e;
    }
    const parsed = parseArgs(rest);
    json = parsed.json;
    if (command === 'list') {
      if (parsed.positionals.length) {
        const e = new Error("'list' 不接受位置参数。用法：agentlray platform list [--json]");
        e.usage = true;
        throw e;
      }
      commandList(json);
    } else {
      if (parsed.positionals.length !== 1) {
        const e = new Error('validate 需要一个 <file> 参数。用法：agentlray platform validate <file> [--json]');
        e.usage = true;
        throw e;
      }
      await commandValidate(parsed.positionals[0], json);
    }
  } catch (error) {
    emitError(json, error.message, error.code || 'usage', error.usage === true);
  }
}

module.exports = { main, HELP };
