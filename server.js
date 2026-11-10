const express = require('express');
const fs = require('fs');
const path = require('path');
// 平台数据库目录已下沉各平台文件（dirs.js 声明，经 @agentlray/shared/config 解析），
// 此处仅取已挂载平台做启动日志展示，不再依赖 lib/config 的平台常量。
const { PLATFORMS } = require('./lib/platforms');
const mountInsightsRoutes = require('./lib/routes/insights');
const mountPromptRoutes = require('./lib/routes/prompts');
const mountSearchRoutes = require('./lib/routes/search');
const mountSessionRoutes = require('./lib/routes/sessions');
const mountExportRoutes = require('./lib/routes/export');
const mountWatchRoutes = require('./lib/routes/watch');
const mountCliBinsRoutes = require('./lib/routes/cli-bins');
const mountSettingsRoutes = require('./lib/routes/settings');
const mountPlatformsRoutes = require('./lib/routes/platforms');
const { setStatusConfig } = require('./lib/status');
const { loadStatusConfig } = require('./lib/status-config');
const { migrateLegacySettings } = require('./lib/settings');
const { loadDirsConfigSync } = require('./lib/dirs-config');
const { csrfGuard } = require('./lib/csrf');

const app = express();
const PORT = process.env.PORT || 3800;
// Bind to localhost by default: the dashboard exposes full AI session
// history (and ?dir= reads) with zero auth — opt into LAN via HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');
// 只服务构建后的 React UI；未构建时 SPA fallback 返回提示（legacy vanilla UI 已移除）。
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// Frontend staleness detection: the SPA polls this and prompts a reload
// when the serving process (and thus possibly the code) has changed.
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
app.get('/api/version', (req, res) => {
  res.json({ bootId: SERVER_BOOT_ID });
});

if (HAS_DIST) {
  app.use(express.static(DIST_DIR, { maxAge: 0, etag: false, lastModified: false }));
}
// Reject cross-site POST/PUT/DELETE before the body is parsed (lib/csrf.js).
app.use('/api', csrfGuard);
app.use(express.json({ limit: '256kb' }));

// Disable all caching
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// Route modules (lib/routes/*): business logic lives in lib/, routes keep
// only parameter validation and response shaping. Order matters only where
// paths overlap: the export route (/api/:platform/sessions/:id/export) is
// more specific than the generic session detail route, so it mounts first.
mountInsightsRoutes(app);
mountPromptRoutes(app);
mountSearchRoutes(app);
mountExportRoutes(app);
mountSessionRoutes(app);
mountWatchRoutes(app);
mountCliBinsRoutes(app);
mountSettingsRoutes(app, { status: { setStatusConfig } });
mountPlatformsRoutes(app);

// SPA fallback: unknown paths render the React UI shell
app.get('*', (req, res) => {
  if (!HAS_DIST) {
    return res.status(503).send('AgentLRay UI 未构建：请先运行 `npm run build:ui`（frontend/dist 缺失）');
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// 启动：先做旧独立设置文件的一次性迁移（幂等），再加载状态时间配置注入
// lib/status.js，最后监听端口。迁移/加载失败不阻塞启动（回退默认窗口）。
async function boot() {
  try {
    await migrateLegacySettings();
    setStatusConfig(await loadStatusConfig());
    loadDirsConfigSync();
  } catch {
    // 迁移或配置加载异常 → 维持默认时间窗口，不阻塞服务。
  }
  app.listen(PORT, HOST, () => {
    console.log(`AgentLRay listening on http://${HOST}:${PORT}`);
    for (const [id, p] of Object.entries(PLATFORMS)) {
      let dir;
      try {
        dir = typeof p.defaultDir === 'function' ? p.defaultDir() : null;
      } catch {
        dir = null;
      }
      if (dir) console.log(`  ${(p.label || id).padEnd(16)}: ${dir}`);
    }
  });
}

boot();
