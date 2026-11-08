'use strict';
// 平台清单与控制端点（P0）：
//   GET /api/platforms            —— 内置 + 项目 + 自定义 + broken 一体列表
//                                 （configured:true 反映「未重启的配置」，
//                                 restartRequired 标记挂载态与配置态差异）
//   PUT /api/platforms/:id/mount  —— 挂载/停用（body.mounted 缺省 true；false 停用）；
//                                  成功响应 = GET 列表同形状（见 respondList）
//   DELETE /api/platforms/:id/mount —— 停用（等效 body.mounted=false）
//   PUT /api/platforms/:id/replace —— 声明/撤销替代（body.replaced 缺省 true）
//   DELETE /api/platforms/:id/replace —— 撤销替代
// 数据来自 lib/platforms/index.js 的 listPlatformInfo() 单一真源，与 CLI platform list
// 同源；capabilities 按 adapter 实例函数存在性推导。挂载/替代写 platforms section，
// 重启后生效（返回 restart:true）。
const { listPlatformInfo, ALL_PLATFORMS } = require('../platforms');
const { setPlatformMounted, setPlatformReplaced } = require('../platform-config');

// 写操作成功响应 = GET 列表的同一形状（listPlatformInfo），供前端一次失效后直接复用。
// 前端 PlatformInfo.syncPlatforms（store）依赖数组形状；只回 {id,mounted,restart} 会让
// store 把对象当数组处理。任何未预料的读失败也回落到最小确认对象（不 500 成功写入）。
async function respondList(res) {
  try {
    res.json(listPlatformInfo({ configured: true }));
  } catch (error) {
    res.json({ id: null, restart: true, error: error.message });
  }
}

module.exports = function mountPlatformsRoutes(app) {
  app.get('/api/platforms', (_req, res) => {
    res.json(listPlatformInfo({ configured: true }));
  });

  // 404：未知平台；422：最后一个可查询平台不可停用。
  const handleError = (res, error) => {
    if (error.code === 'unknown-platform') return res.status(404).json({ error: error.message });
    if (error.code === 'last-platform') return res.status(422).json({ error: error.message });
    res.status(500).json({ error: error.message });
  };

  app.put('/api/platforms/:id/mount', async (req, res) => {
    try {
      const mounted = req.body ? req.body.mounted !== false : true;
      await setPlatformMounted(req.params.id, mounted, ALL_PLATFORMS);
      await respondList(res);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.delete('/api/platforms/:id/mount', async (req, res) => {
    try {
      await setPlatformMounted(req.params.id, false, ALL_PLATFORMS);
      await respondList(res);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.put('/api/platforms/:id/replace', async (req, res) => {
    try {
      const replaced = req.body ? req.body.replaced !== false : true;
      await setPlatformReplaced(req.params.id, replaced, ALL_PLATFORMS);
      await respondList(res);
    } catch (error) {
      handleError(res, error);
    }
  });

  app.delete('/api/platforms/:id/replace', async (req, res) => {
    try {
      await setPlatformReplaced(req.params.id, false, ALL_PLATFORMS);
      await respondList(res);
    } catch (error) {
      handleError(res, error);
    }
  });
};
