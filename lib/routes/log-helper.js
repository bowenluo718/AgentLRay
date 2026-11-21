'use strict';
// 路由层日志辅助（design-logging §5.6/§5.7）：统一 500 异常记录与写操作白名单日志。
// 集中在此避免每个 route 文件重复实现，同时保持「无集中错误中间件」的既有结构。
const log = require('../logging');

/**
 * 非预期异常（500）统一记录到 app 日志后回 500。预期 4xx 分支不调用此函数（避免噪音）。
 * 访问日志（access）已记录该请求的 method/path/status，此处只补错误明细。
 */
function logAndFail(res, error) {
  log.app.error('route error', { error: error?.message || String(error) });
  res.status(500).json({ error: error.message });
}

/**
 * 写操作白名单日志（design-logging §3.4）：只记「动作 + 资源类型 + 资源 id + 变更字段名」，
 * **绝不记字段值**——否则 llm.apiKey / hosts identityKey 等会明文落盘。
 * @param {string} action 动作（create/update/delete/connect/disconnect/mount/replace…）
 * @param {string} target 资源类型（settings/host/platform…）
 * @param {string|null} id 资源 id（无则 null）
 * @param {string[]} fields 变更字段名（只记名字）
 */
function logWrite(action, target, id, fields) {
  log.app.info('write', {
    action,
    target,
    id: id ?? null,
    fields: Array.isArray(fields) ? fields : [],
  });
}

module.exports = { logAndFail, logWrite };
