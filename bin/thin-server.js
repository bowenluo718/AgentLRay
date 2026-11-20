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
const { shutdownHosts, setSelfIdentity, autoConnectThinHost } = require('../lib/hosts');
const mountProxyRoutes = require('../lib/routes/proxy');
const mountHostsRoutes = require('../lib/routes/hosts');
const mountDshRoutes = require('../lib/routes/dsh');
const mountModeRoutes = require('../lib/routes/mode');
const pkg = require('../package.json');

const app = express();
// 薄服务默认 3801（与完整实例 3800 区隔，二者可同机并存）。
const PORT = process.env.PORT || 3801;
// 无鉴权（沿用现状 CSRF）：LAN 需显式 HOST=0.0.0.0（会暴露全部会话，文档显著提示）。
const HOST = process.env.HOST || '127.0.0.1';
const DIST_DIR = path.join(__dirname, '..', 'frontend', 'dist');
const HAS_DIST = fs.existsSync(path.join(DIST_DIR, 'index.html'));

// 网关 host 路由：必须第一个挂载（在任何 body parser 之前），远端转发需要原始 body 流。
// thin 选项开启系统配置面拦截（settings 全部 403、platforms 写面 403）。
mountProxyRoutes(app, { thin: true });

// 本机身份 + 版本探测：薄服务作为连接方，也会向被连远端上报自身（inbound peers）。
const SERVER_BOOT_ID = `${Date.now().toString(36)}-${process.pid}`;
setSelfIdentity({ version: pkg.version, bootId: SERVER_BOOT_ID });
app.get('/api/version', (_req, res) => {
  res.json({ bootId: SERVER_BOOT_ID, version: pkg.version });
});
// 模式信号：薄服务 → { mode: 'thin', version }（本地资源，绝不透传远端模式）。
mountModeRoutes(app, { mode: 'thin' });

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
  console.log('  薄服务：仅远程连接，不携带平台解析栈，系统配置面已关闭');
  autoConnectThinHost()
    .then(({ ok, hostId, runtime }) => {
      if (!hostId) {
        console.log('  未配置远程主机：请在页面「添加主机」后连接');
        return;
      }
      if (ok) {
        const v = runtime?.version?.version ? ` (v${runtime.version.version})` : '';
        console.log(`  已自动连接主机 ${hostId}${v}`);
      } else {
        console.log(`  自动连接主机 ${hostId} 失败: ${runtime?.error ?? '未知错误'}`);
      }
    })
    .catch((error) => {
      console.log(`  自动连接失败: ${error.message}`);
    });
});

// 进程退出兜底：kill 所有 ssh/dsh 隧道子进程，防孤儿。
process.on('exit', shutdownHosts);
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    shutdownHosts();
    process.exit(0);
  });
}
