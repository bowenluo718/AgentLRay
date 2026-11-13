'use strict';
// 入站 peer 路由（inbound peers）：被连接方视角的「谁在连我」。
// - GET /api/inbound → 当前存活入站连接概览（{ count, peers }）。
// - POST /api/inbound/hello → 连接方上报/心跳（upsert 刷新 lastSeen）。
// 作为本机本地资源挂载（server.js 与 hosts 路由并列），proxy 已把 /api/inbound
// 视为本地资源（不随当前查看的远端二次转发）。
const { registerPeer, snapshot, HEARTBEAT_TTL_MS } = require('../inbound');
const pkg = require('../../package.json');

module.exports = function mountInboundRoutes(app) {
  // GET /api/inbound → 当前活跃入站连接概览。
  app.get('/api/inbound', (_req, res) => {
    res.json(snapshot());
  });

  // POST /api/inbound/hello → 连接方上报/心跳。
  app.post('/api/inbound/hello', (req, res) => {
    try {
      registerPeer(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    res.json({ ok: true, ttl: HEARTBEAT_TTL_MS / 1000, serverVersion: pkg.version });
  });
};
