'use strict';
// 平台清单端点：GET /api/platforms —— 内置 + 自定义 + broken 的一体列表。
// 数据来自 lib/platforms/index.js 的 listPlatformInfo() 单一真源，与 P2 的
// CLI platform list 同源；capabilities 按 adapter 实例函数存在性推导。
const { listPlatformInfo } = require('../platforms');

module.exports = function mountPlatformsRoutes(app) {
  app.get('/api/platforms', (_req, res) => {
    res.json(listPlatformInfo());
  });
};
