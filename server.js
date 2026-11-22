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
const { apiAuthGuard, tokenExchangeHandler, authEnabled, resolveUiToken } = require('./lib/auth');
const { shutdownHosts, setSelfIdentity } = require('./lib/hosts');
const mountProxyRoutes = require('./lib/routes/proxy');
const { startInboundSocket, boundInboundSocketPath } = require('./lib/inbound-socket');
const { HOME: HOME_DIR } = require('./lib/config');
const { isRemoteHost } = require('./lib/routes/proxy');
const mountHostsRoutes = require('./lib/routes/hosts');
const mountInboundRoutes = require('./lib/routes/inbound');
const mountNetworkRoutes = require('./lib/routes/network');
const mountDshRoutes = require('./lib/routes/dsh');
const mountModeRoutes = require('./lib/routes/mode');
const { startDshHostService, stopDshHostService } = require('./lib/dsh/host');
const log = require('./lib/logging');
const { installProcessErrorHandlers } = require('./lib/process-errors');
const pkg = require('./package.json');

const app = express();
const PORT = process.env.PORT || 3800;
// Bind to localhost by default: the dashboard exposes full AI session history
// (and ?dir= reads). Local requests are token-guarded (lib/auth.js: AGENTLRAY_UI_TOKEN,
// otherwise an auto-generated ~/.agentlray/ui-token). LAN exposure still requires
// explicit HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(__dirname, 'frontend', 'dist');
// 只服务构建后的 React UI；未构建时 SPA fallback 返回提示（legacy vanilla UI 已移除）。
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// 本机鉴权（C-1）：只保护**本机直连**（目标 local / 本机资源）。远端目标不验本机令牌——
// 链路认证由 ssh 私钥 / dsh 设备身份承担；proxy 会剥除本机凭证后再转发。
// 令牌未配置时自动生成并落 ~/.agentlray/ui-token（0600），AGENTLRAY_NO_AUTH=1 可关闭。
// 守卫只读 headers/cookie、不消费 body，不影响 proxy 的原始流语义。
const UI_TOKEN = resolveUiToken();
app.use('/api', apiAuthGuard({ token: UI_TOKEN, isRemoteHost }));

// 网关 host 路由：必须是第一个 /api 处理器——放在 /api/version 等任何本地路由之前，
// 以便带 X-Host-Id（或 ?host=）的远端请求先被拦截转发；local 请求 next() 继续往下。
// 也必须在 express.json 之前——远端转发需要原始 body 流（req.pipe），被 parser 消费则无法透传。
mountProxyRoutes(app);

// HTTP 访问日志（design-logging §5.8）：必须挂在 proxy 之后、路由之前——被 proxy 转发的
// 远端请求不会走到后续中间件，故只记本机入口请求；耗时/status 由 res.on('finish') 采集。
app.use(log.createAccessMiddleware());

// Frontend staleness detection: the SPA polls this and prompts a reload
// when the serving process (and thus possibly the code) has changed.
// version 字段供多主机跨主机版本提示（design R3-Q3/P0）。
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
// 本机身份（连接方视角）：作为连接方主动向被连接方上报，供被连接方展示「被谁连接」。
// peerId/label 已由 lib/hosts.js 默认为本机 hostname 短名，此处仅补充版本/启动标识。
setSelfIdentity({ version: pkg.version, bootId: SERVER_BOOT_ID });
// 日志初始化（design-logging §3.6）：建 logs/、首次创建时写 first-run 标记。必须在任何
// log.* 调用前执行，以便 first-run 标记带上版本与平台目录。
log.init({ version: pkg.version, platforms: Object.keys(PLATFORMS) });
app.get('/api/version', (req, res) => {
  res.json({ bootId: SERVER_BOOT_ID, version: pkg.version,
    // 入站信任通道路径（公开端点只暴露路径字符串）：连接方据此把 ssh/dsh 隧道指向本机
    // UNIX socket，被连接方因此无需关闭本机令牌鉴权（lib/inbound-socket.js）。
    // 只通告**本进程实际 bind 成功**的路径：同机 thin/full 共用 HOME，bind 失败者若仍
    // 按 HOME 算路径通告，对端会把流量打到另一个实例上。
    inboundSocket: boundInboundSocketPath(),
  });
});
// 运行时模式信号（design-thin-service Q13）：完整实例 → { mode: 'full' }。
// 与 /api/version 同列本地资源，proxy.js 不会把远端模式透传回来。
mountModeRoutes(app, { mode: 'full' });

// WebView 首次导航 `GET /?token=<token>` 换 HttpOnly cookie（C-1）：必须挂在
// express.static 之前，否则 `/` 会先被静态首页命中、兑换被绕过。
app.get('/', tokenExchangeHandler({ token: UI_TOKEN }));

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
mountInboundRoutes(app);
// 宿主网络状态上报（D-1）：本机资源；完整实例同样挂载（桌面端无原生上报 → 空状态）。
mountNetworkRoutes(app);
mountDshRoutes(app);

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
  log.boot.info('boot', {
    bootId: SERVER_BOOT_ID,
    version: pkg.version,
    mode: 'full',
    host: HOST,
    port: PORT,
    platforms: Object.keys(PLATFORMS),
    auth: authEnabled() && UI_TOKEN ? 'token' : 'off',
  });
  try {
    setStatusConfig(await loadStatusConfig());
    loadDirsConfigSync();
  } catch (error) {
    // 配置加载异常 → 维持默认时间窗口，不阻塞服务。
    log.app.warn('config load failed', { error: error?.message || String(error) });
  }
  // dsh 被连接方服务：角色含 host 时随进程常驻（design D7）——独立于「当前选中主机」，
  // 不占连接槽。启动失败（未配置账号 / 中继服务器不可达）不阻塞本地服务。
  try {
    const { started, status } = await startDshHostService();
    if (started) {
      console.log(`  dsh 被连接方: ${status.serverUrl}（设备 ${status.deviceName}，放行端口 ${status.allowedPorts.join(',')}）`);
      log.boot.info('dsh host', {
        serverUrl: status.serverUrl,
        deviceName: status.deviceName,
        allowedPorts: status.allowedPorts,
      });
    } else if (status.reason) {
      console.log(`  dsh 被连接方未启动: ${status.reason}`);
      log.boot.info('dsh host skipped', { reason: status.reason });
    }
  } catch (error) {
    console.log(`  dsh 被连接方启动失败: ${error.message}`);
    log.app.warn('dsh host start failed', { error: error?.message || String(error) });
  }
  app.listen(PORT, HOST, () => {
    console.log(`AgentLRay listening on http://${HOST}:${PORT}`);
    // 入站信任通道（ssh 入站免令牌）：同 app 再听一个 0600 UNIX socket，连接方 ssh -L 指向它。
    startInboundSocket({ app, home: HOME_DIR, log }).then(
      (sock) => {
        console.log(`  入站通道：${sock.path}（ssh 连接方自动使用，无需配置）`);
        log.boot.info('inbound socket listening', { path: sock.path });
      },
      (error) => {
        // 失败不阻塞主服务：ssh 入站退回「需 AGENTLRAY_NO_AUTH 或本机令牌」的旧行为。
        console.log(`  入站通道：未启用（${error.message}）`);
        log.boot.warn('inbound socket failed', { error: error.message });
      }
    );
    if (authEnabled() && UI_TOKEN) {
      console.log(`  本机鉴权：已启用（/api 本机请求需令牌；浏览器打开 http://${HOST}:${PORT}/?token=${UI_TOKEN} ）`);
    } else {
      console.log('  本机鉴权：已关闭（AGENTLRAY_NO_AUTH=1）');
    }
    const platformDirs = {};
    for (const [id, p] of Object.entries(PLATFORMS)) {
      let dir;
      try {
        dir = typeof p.defaultDir === 'function' ? p.defaultDir() : null;
      } catch {
        dir = null;
      }
      if (dir) {
        platformDirs[id] = dir;
        console.log(`  ${(p.label || id).padEnd(16)}: ${dir}`);
      }
    }
    log.boot.info('listening', { host: HOST, port: PORT, platforms: platformDirs });
  });
}

// 进程退出兜底：kill 所有 ssh 隧道子进程，防孤儿（design R4-Q1）；dsh 被连接方服务
// 随进程关闭（连接与 loopback 端点一并释放）。日志句柄同步关闭（保证退出前落盘）。
process.on('exit', () => {
  shutdownHosts();
  log.close();
});
// 未捕获异常 / 未处理 rejection（design-logging §5.5）：统一 error 落 app 日志，随后按
// Node 默认语义（退出码 1）退出——加监听器会抑制默认崩溃，故显式退出以保留原行为。
// 例外：控制台管道断开（EPIPE）只记日志、不退出（见 lib/process-errors.js）。
installProcessErrorHandlers();
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log.app.info('process exit', { signal: sig });
    shutdownHosts();
    void stopDshHostService();
    log.close();
    process.exit(0);
  });
}

boot();
