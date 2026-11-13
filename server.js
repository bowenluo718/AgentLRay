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
const { loadDirsConfigSync } = require('./lib/dirs-config');
const { csrfGuard } = require('./lib/csrf');
const { shutdownHosts } = require('./lib/hosts');
const mountProxyRoutes = require('./lib/routes/proxy');
const mountHostsRoutes = require('./lib/routes/hosts');
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3800;
// Bind to localhost by default: the dashboard exposes full AI session
// history (and ?dir= reads) with zero auth — opt into LAN via HOST=0.0.0.0
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');
// 只服务构建后的 React UI；未构建时 SPA fallback 返回提示（legacy vanilla UI 已移除）。
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// 网关 host 路由：必须是第一个 /api 处理器——放在 /api/version 等任何本地路由之前，
// 以便带 X-Host-Id（或 ?host=）的远端请求先被拦截转发；local 请求 next() 继续往下。
// 也必须在 express.json 之前——远端转发需要原始 body 流（req.pipe），被 parser 消费则无法透传。
mountProxyRoutes(app);

// Frontend staleness detection: the SPA polls this and prompts a reload
// when the serving process (and thus possibly the code) has changed.
// version 字段供多主机跨主机版本提示（design R3-Q3/P0）。
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
app.get('/api/version', (req, res) => {
  res.json({ bootId: SERVER_BOOT_ID, version: pkg.version });
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
mountHostsRoutes(app);

// SPA fallback: unknown paths render the React UI shell
app.get('*', (req, res) => {
  if (!HAS_DIST) {
    return res.status(503).send('AgentLRay UI 未构建：请先运行 `npm run build:ui`（frontend/dist 缺失）');
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// 启动：加载状态时间配置注入 lib/status.js 与目录配置，最后监听端口。
// 配置加载失败不阻塞启动（回退默认窗口）。
async function boot() {
  try {
    setStatusConfig(await loadStatusConfig());
    loadDirsConfigSync();
  } catch {
    // 配置加载异常 → 维持默认时间窗口，不阻塞服务。
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

// 进程退出兜底：kill 所有 ssh 隧道子进程，防孤儿（design R4-Q1）。
process.on('exit', shutdownHosts);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdownHosts();
    process.exit(0);
  });
}

boot();
