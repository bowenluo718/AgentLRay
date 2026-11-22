#!/usr/bin/env node
'use strict';
// 独立薄服务（thin service，design-thin-service）：仅用于远程连接的轻量网关。
//
// 定位：跑在**连接方**（移动端代理侧），去连**完整 AgentLRay**（远端桌面数据源）。
// 自身不携带平台注册/状态机/insights/搜索等全栈，从数据模型上排除系统配置：
//   - 本地只挂：proxy（透传远端数据面/操控写操作）+ hosts（主机管理）+ dsh（连接配置）
//     + version + mode + SPA。
//   - 不挂：settings / cli-bins / platforms 写面 / insights / prompts / search /
//     sessions / export / watch / inbound（这些一律经 proxy 转发给远端，或被 403）。
//
// 状态信号：GET /api/mode → { mode: 'thin', version }，前端据此裁剪系统配置入口。
// 启动：默认 PORT=3801 / HOST=127.0.0.1；先监听再后台自动连接 AGENTLRAY_THIN_HOST
// 或 hosts.json 第一台（失败仅记状态，前端首帧直落该主机）。
const express = require('express');
const fs = require('fs');
const path = require('path');
const { csrfGuard } = require('../lib/csrf');
const { apiAuthGuard, tokenExchangeHandler, authEnabled, resolveUiToken } = require('../lib/auth');
const { startInboundSocket, boundInboundSocketPath } = require('../lib/inbound-socket');
const { HOME: HOME_DIR } = require('../lib/config');
const { shutdownHosts, setSelfIdentity, autoConnectThinHost } = require('../lib/hosts');
const mountProxyRoutes = require('../lib/routes/proxy');
const { isRemoteHost } = require('../lib/routes/proxy');
const mountHostsRoutes = require('../lib/routes/hosts');
const mountNetworkRoutes = require('../lib/routes/network');
const mountDshRoutes = require('../lib/routes/dsh');
const mountModeRoutes = require('../lib/routes/mode');
const log = require('../lib/logging');
const { installProcessErrorHandlers } = require('../lib/process-errors');
const pkg = require('../package.json');

const app = express();
// 薄服务默认 3801（与完整实例 3800 区隔，二者可同机并存）。
const PORT = process.env.PORT || 3801;
// 本机访问令牌（lib/auth.js）：未配置时自动生成 ~/.agentlray/ui-token（0600），
// AGENTLRAY_NO_AUTH=1 可关闭；LAN 需显式 HOST=0.0.0.0（会暴露全部会话，文档显著提示）。
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// 本机鉴权（C-1）：只保护**本机直连**（目标 local / 本机资源）。远端目标不验本机令牌——
// 链路认证由隧道承担；proxy 剥除本机凭证后再转发。令牌未配置时自动生成
// （~/.agentlray/ui-token，0600），AGENTLRAY_NO_AUTH=1 可关闭。只读 headers/cookie、
// 不消费 body，不影响原始流透传。
const UI_TOKEN = resolveUiToken();
app.use('/api', apiAuthGuard({ token: UI_TOKEN, isRemoteHost }));

// 网关 host 路由：必须第一个挂载（在任何 body parser 之前），远端转发需要原始 body 流。
// thin 选项开启系统配置面拦截（settings 全部 403、platforms 写面 403）。
mountProxyRoutes(app, { thin: true });

// HTTP 访问日志（design-logging §5.8）：挂在 proxy 之后、路由之前——被转发的远端请求
// 不会走到这里，故只记本机入口请求；耗时/status 由 res.on('finish') 采集。
app.use(log.createAccessMiddleware());

// 本机身份 + 版本探测：薄服务作为连接方，也会向被连远端上报自身（inbound peers）。
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
setSelfIdentity({ version: pkg.version, bootId: SERVER_BOOT_ID });
// 日志初始化（design-logging §3.6）：薄服务是独立进程，也建 logs/ 并写 boot 日志；
// 平台目录为空（薄服务不携带平台解析栈）。
log.init({ version: pkg.version, platforms: [] });
app.get('/api/version', (_req, res) => {
  res.json({ bootId: SERVER_BOOT_ID, version: pkg.version,
    // 入站信任通道路径（公开端点只暴露路径字符串）：连接方据此把 ssh/dsh 隧道指向本机
    // UNIX socket，被连接方因此无需关闭本机令牌鉴权（lib/inbound-socket.js）。
    // 只通告**本进程实际 bind 成功**的路径：同机 thin/full 共用 HOME，bind 失败者若仍
    // 按 HOME 算路径通告，对端会把流量打到另一个实例上。
    inboundSocket: boundInboundSocketPath(),
  });
});
// 模式信号：薄服务 → { mode: 'thin', version }（本地资源，绝不透传远端模式）。
mountModeRoutes(app, { mode: 'thin' });

// WebView `GET /?token=` 换 cookie：必须挂在 express.static 之前（同完整实例）。
app.get('/', tokenExchangeHandler({ token: UI_TOKEN }));

if (HAS_DIST) {
  app.use(express.static(DIST_DIR, { maxAge: 0, etag: false, lastModified: false }));
}
// 跨站 POST/PUT/DELETE 在解析 body 前拒绝（与完整实例一致）。
app.use('/api', csrfGuard);
app.use(express.json({ limit: '256kb' }));

// 全程禁缓存（与完整实例一致）。
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.set('Surrogate-Control', 'no-store');
  next();
});

// 连接相关最小配置面（系统配置面由 proxy 拦截，此处不挂）。
// - hosts：thin 无 local 宿主（Q14），只返回远端；
// - dsh：强制 client（Q24），只出站连远端，不启被连接方服务。
mountHostsRoutes(app, { includeLocal: false });
// 宿主网络状态上报（D-1/A-4）：Android 原生壳在网络回调里 POST，服务端据此 kick 全部主机。
mountNetworkRoutes(app);
mountDshRoutes(app, { forceClient: true });

// SPA fallback：薄服务复用同一 dist 前端，未知路径渲染 React 外壳。
app.get('*', (_req, res) => {
  if (!HAS_DIST) {
    return res.status(503).send('AgentLRay UI 未构建：请先运行 `npm run build:ui`（frontend/dist 缺失）');
  }
  res.sendFile(path.join(DIST_DIR, 'index.html'));
});

// 先监听再后台自动连接：避免慢隧道阻塞页面首屏；连接结果写入主机运行时，
// 前端 GET /api/hosts 读到后直落该主机（无「先连后加载」等待）。
app.listen(PORT, HOST, () => {
  console.log(`AgentLRay thin listening on http://${HOST}:${PORT}`);
  // 入站信任通道：薄服务只做连接方，但同机若有进程 ssh -L 指向本机也应免令牌。
  startInboundSocket({ app, home: HOME_DIR, log }).then(
    (sock) => console.log(`  入站通道：${sock.path}（ssh 连接方自动使用，无需配置）`),
    (error) => console.log(`  入站通道：未启用（${error.message}）`)
  );
  console.log('  薄服务：仅远程连接，不携带平台解析栈，系统配置面已关闭');
  if (authEnabled() && UI_TOKEN) {
    console.log(`  本机鉴权：已启用（浏览器打开 http://${HOST}:${PORT}/?token=${UI_TOKEN} 兑换 cookie）`);
  } else {
    console.log('  本机鉴权：已关闭（AGENTLRAY_NO_AUTH=1）');
  }
  log.boot.info('boot', {
    bootId: SERVER_BOOT_ID,
    version: pkg.version,
    mode: 'thin',
    host: HOST,
    port: PORT,
    auth: authEnabled() && UI_TOKEN ? 'token' : 'off',
  });
  autoConnectThinHost()
    .then(({ ok, hostId, runtime }) => {
      if (!hostId) {
        console.log('  未配置远程主机：请在页面「添加主机」后连接');
        log.boot.info('auto connect skipped', { reason: '未配置远程主机' });
        return;
      }
      if (ok) {
        const v = runtime?.version?.version ? ` (v${runtime.version.version})` : '';
        console.log(`  已自动连接主机 ${hostId}${v}`);
        log.boot.info('auto connect', { hostId, ok: true, remoteVersion: runtime?.version?.version ?? null });
      } else {
        const detail = runtime?.error?.message ?? '未知错误';
        console.log(`  自动连接主机 ${hostId} 失败: ${detail}`);
        log.app.warn('auto connect failed', {
          hostId,
          code: runtime?.error?.code ?? null,
          retryable: runtime?.error?.retryable ?? null,
          error: detail,
        });
      }
    })
    .catch((error) => {
      console.log(`  自动连接失败: ${error.message}`);
      log.app.warn('auto connect failed', { error: error?.message || String(error) });
    });
});

// 进程退出兜底：kill 所有 ssh/dsh 隧道子进程，防孤儿。日志句柄同步关闭（保证退出前落盘）。
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
    log.close();
    process.exit(0);
  });
}
