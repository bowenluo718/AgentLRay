'use strict';
// 自定义平台适配器加载器：读 ~/.agentlray/platforms/*.js（按字母序），逐文件
// require + 校验。校验通过则写入 registry（即 PLATFORMS），失败记入 broken，
// 单文件 try/catch 隔离——坏文件不打断启动、不影响其余。
//
// 同步实现是硬要求：lib/platforms/index.js 在模块 require 期完成合并，下游
// lib/export.js、lib/otlp.js、lib/session-list.js、CLI 等都在 require 期同步
// 从 PLATFORMS 派生平台集，任何异步都会造成这些派生点看不到自定义平台。
// startup 期几十个文件的同步 require 开销可接受。
const fs = require('fs');
const path = require('path');
const { HOME } = require('../config');

const PLATFORM_DIR = path.join(HOME, '.agentlray', 'platforms');

// 平台 id 契约：小写字母/数字开头，仅小写字母、数字、连字符。
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
// 必需函数。list 保持既有 null 语义（openclaw.list 即 null）——可为 null 不强制。
const REQUIRED_FUNCS = ['defaultDir', 'parse', 'getSession'];

function errorText(err) {
  return err && err.message ? String(err.message) : String(err);
}

// 校验单个适配器。返回 { error, id? } 或 { ok: true }。id 冲突按 registry 既有键
// 判定（内置或先前已加载的自定义都在 registry 中），冲突记 broken、绝不覆盖。
function validateAdapter(adapter, registry) {
  if (adapter === null || typeof adapter !== 'object' || Array.isArray(adapter)) {
    return { id: null, error: '导出非对象（module.exports 需为对象）' };
  }
  if (typeof adapter.id !== 'string' || !ID_RE.test(adapter.id)) {
    const id = typeof adapter.id === 'string' ? adapter.id : null;
    return { id, error: `id 不合法（需匹配 ${ID_RE.source}）：${String(adapter.id)}` };
  }
  for (const fnName of REQUIRED_FUNCS) {
    if (typeof adapter[fnName] !== 'function') {
      return { id: adapter.id, error: `缺少必需函数 ${fnName}` };
    }
  }
  if (typeof adapter.label !== 'string') {
    return { id: adapter.id, error: 'label 必须是字符串' };
  }
  if (registry[adapter.id] !== undefined) {
    return { id: adapter.id, error: `id 已被占用：${adapter.id}` };
  }
  return { ok: true };
}

// 加载 ~/.agentlray/platforms/*.js 并入 registry。
// 返回 { customAdapters, brokenAdapters }：
//   customAdapters  校验通过的适配器数组（按文件名字母序，即 listPlatformInfo 输出序）
//   brokenAdapters  失败条目数组 [{ file, label, id?, error }]
// 受控内进程调用（测试/校验命令）可注入已有 registry；index.js 传 PLATFORMS。
function loadPlatformAdapters(registry) {
  const customAdapters = [];
  const brokenAdapters = [];

  if (process.env.AGENTLRAY_NO_PLUGINS === '1') {
    brokenAdapters.push({
      file: '(AGENTLRAY_NO_PLUGINS=1)',
      label: null,
      id: null,
      error: '自定义平台已禁用（AGENTLRAY_NO_PLUGINS=1）',
    });
    return { customAdapters, brokenAdapters };
  }

  let files;
  try {
    files = fs
      .readdirSync(PLATFORM_DIR)
      .filter((name) => name.endsWith('.js'))
      .sort();
  } catch {
    // 目录不存在/读取失败 → 无自定义平台
    return { customAdapters, brokenAdapters };
  }

  for (const file of files) {
    const fullPath = path.join(PLATFORM_DIR, file);
    let adapter;
    try {
      adapter = require(fullPath);
    } catch (err) {
      brokenAdapters.push({ file, label: null, id: null, error: errorText(err) });
      continue;
    }
    const check = validateAdapter(adapter, registry);
    if (!check.ok) {
      brokenAdapters.push({ file, label: null, id: check.id, error: check.error });
      continue;
    }
    registry[adapter.id] = adapter;
    customAdapters.push(adapter);
  }

  return { customAdapters, brokenAdapters };
}

module.exports = {
  PLATFORM_DIR,
  // 校验函数导出供 CLI `platform validate` 复用同一套校验（见 bin/platform.js）；
  // 语义与 loadPlatformAdapters 内部完全一致，不复制逻辑。
  validateAdapter,
  loadPlatformAdapters,
};
