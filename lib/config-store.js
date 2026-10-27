'use strict';
// 通用"白名单 JSON 配置"存储：为各设置项（平台 CLI 命令、状态时间窗口、…）提供
// 一致的落盘/读取/校验/响应构建，避免每个配置模块重复实现。
//
// 约定：
//   - 配置存服务端 ~/.agentlray/<name>.json，key 白名单 = defaults 的键。
//   - load：文件缺失/损坏 → {}（全部回退默认）；只回传白名单内且通过 validate 的值。
//   - save：白名单过滤，非法/空值清除该 key；返回保存后的干净配置（不含 updatedAt）。
//   - validate(value) 决定单个值是否合法（如非空字符串、正有限数字）。
const path = require('path');
const fsp = require('fs/promises');

/**
 * 创建一个白名单 JSON 配置存储。
 * @param {object} opts
 * @param {string} opts.filePath     配置文件绝对路径（如 ~/.agentlray/cli-bins.json）
 * @param {Record<string, unknown>} opts.defaults  key → 默认值（键即白名单）
 * @param {(key:string, value:unknown)=>boolean} opts.validate  单值合法性校验
 * @returns {{ load: ()=>Promise<object>, save: (body:object)=>Promise<object>, defaults: object }}
 */
function createConfigStore({ filePath, defaults, validate }) {
  const keys = Object.keys(defaults);

  // 读取页面持久化配置；只回传白名单 key，非法值剔除。
  async function load() {
    const result = {};
    try {
      const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8'));
      for (const key of keys) {
        if (validate(key, parsed[key])) result[key] = parsed[key];
      }
    } catch {
      // 文件缺失或损坏 → 全部未配置。
    }
    return result;
  }

  // 保存配置：白名单过滤，非法/空值清除该 key；返回保存后的干净配置（无 updatedAt）。
  async function save(body) {
    const clean = {};
    for (const key of keys) {
      const value = body && body[key];
      if (validate(key, value)) clean[key] = value;
    }
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    const data = { ...clean, updatedAt: new Date().toISOString() };
    await fsp.writeFile(filePath, JSON.stringify(data, null, 2));
    return clean;
  }

  return { defaults, load, save };
}

/**
 * 构建 GET/PUT /api/settings/<name> 的响应：每个 key → { value, configured, default }。
 * @param {object} stored    load()/save() 返回的干净配置
 * @param {Record<string, unknown>} defaults
 */
function settingsResult(stored, defaults) {
  const result = {};
  for (const [key, def] of Object.entries(defaults)) {
    result[key] = {
      value: stored[key] ?? def,
      configured: Boolean(stored[key]),
      default: def,
    };
  }
  return result;
}

module.exports = { createConfigStore, settingsResult };
