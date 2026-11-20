'use strict';
// 运行时模式信号单一真源（design-thin-service Q13）：
//   GET /api/mode
//     - 完整实例 → { mode: 'full' }
//     - 薄服务   → { mode: 'thin', version }
// 前端启动先取 mode，据此一次性裁剪系统配置入口（单 dist，无构建期分叉）。
// /api/mode 与 /api/hosts、/api/version 同列本地资源——proxy.js 已列入 LOCAL_ONLY_RE，
// 绝不被转发到远端，否则薄服务会误把远端模式当自己的。
const pkg = require('../../package.json');

module.exports = function mountModeRoutes(app, { mode = 'full' } = {}) {
  app.get('/api/mode', (_req, res) => {
    // 完整实例只回 { mode }；薄服务额外带 version（APP 端展示/兼容探测用）。
    res.json(mode === 'thin' ? { mode, version: pkg.version } : { mode });
  });
};
