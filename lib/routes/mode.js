'use strict';
// 运行时模式信号单一真源（design-thin-service Q13）：
//   GET /api/mode
//     - 完整实例 → { mode: 'full' }
//     - 薄服务   → { mode: 'thin', version, capabilities }
// 前端启动先取 mode，据此一次性裁剪系统配置入口（单 dist，无构建期分叉）。
// /api/mode 与 /api/hosts、/api/version 同列本地资源——proxy.js 已列入 LOCAL_ONLY_RE，
// 绝不被转发到远端，否则薄服务会误把远端模式当自己的。
//
// capabilities（design-android-mobile-app §5.4/§5.5）：薄服务下发的客户端能力位，供前端
// 裁剪传输选项与下载方式。
//   - transports：可用连接方式。Android 薄服务注入 AGENTLRAY_DISABLE_SSH=1 → 仅 ['dsh']；
//     桌面薄服务未设 → ['ssh','dsh']（维持既有二选一）。
//   - nativeSave：WebView blob 下载不可用时启用原生保存桥接（Capacitor saveFile）。
//     Android 原生按自身能力注入 AGENTLRAY_NATIVE_SAVE=1 开启；桌面/浏览器不设。
// 老客户端忽略未知字段，向后兼容。
const pkg = require('../../package.json');

/** 从环境变量派生能力位；测试可通过 options.capabilities 覆盖。 */
function deriveCapabilities() {
  const sshDisabled = String(process.env.AGENTLRAY_DISABLE_SSH || '').trim() === '1';
  const nativeSave = String(process.env.AGENTLRAY_NATIVE_SAVE || '').trim() === '1';
  return {
    transports: sshDisabled ? ['dsh'] : ['ssh', 'dsh'],
    nativeSave,
  };
}

module.exports = function mountModeRoutes(app, { mode = 'full', capabilities } = {}) {
  app.get('/api/mode', (_req, res) => {
    // 完整实例只回 { mode }；薄服务额外带 version + capabilities（APP 端裁剪/兼容探测用）。
    if (mode === 'thin') {
      res.json({ mode, version: pkg.version, capabilities: capabilities ?? deriveCapabilities() });
    } else {
      res.json({ mode });
    }
  });
};
