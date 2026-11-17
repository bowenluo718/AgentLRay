'use strict';
// dsh 传输相关路由（design-dsh-host-connection「前后端契约」）：
// - GET  /api/dsh/status   本机 dsh 状态（角色 / 服务器 / 是否在线 / 被连 peer）
// - GET  /api/dsh/devices  中继服务器上当前账号可见的设备（连接方选目标用；本机排除）
// - POST /api/dsh/test     测试「未保存」的 dsh 连接目标（等价 ssh 的 POST /api/hosts/test）
//
// 这些是本机网关资源（dsh 配置与设备身份都在本机），不随当前查看的远端二次转发
// （proxy.js 已把 /api/dsh 列入本地资源）。
const { loadDshSettings } = require('../dsh/settings');
const { listDshDevices, openDshTunnel } = require('../dsh/client');
const { dshHostStatus } = require('../dsh/host');
const { probeVersion } = require('../transport');

module.exports = function mountDshRoutes(app) {
  // GET /api/dsh/status → 本机 dsh 状态。
  app.get('/api/dsh/status', async (_req, res) => {
    try {
      const settings = await loadDshSettings();
      const host = dshHostStatus();
      res.json({
        role: settings.role,
        serverUrl: settings.serverUrl,
        email: settings.email,
        hasPassword: settings.hasPassword,
        deviceName: settings.deviceName,
        allowedPorts: settings.allowedPorts,
        // host 服务是否在跑 + 是否已连上中继服务器。
        running: Boolean(host.running),
        connected: Boolean(host.online),
        deviceId: host.deviceId ?? null,
        peers: host.peers ?? [],
        lastError: host.lastError ?? null,
      });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // GET /api/dsh/devices → 中继服务器设备列表（供连接方选择目标；本机设备已排除）。
  app.get('/api/dsh/devices', async (_req, res) => {
    try {
      res.json(await listDshDevices());
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // POST /api/dsh/test → 测试未保存的 dsh 目标：建隧道 → 探测 /api/version → 关。
  app.post('/api/dsh/test', async (req, res) => {
    const body = req.body || {};
    const deviceId = String(body.deviceId ?? '').trim();
    if (!deviceId) return res.status(400).json({ error: 'deviceId 必填' });
    const remoteAgentLrayPort = Number(body.remoteAgentLrayPort || 3800);
    if (!Number.isInteger(remoteAgentLrayPort) || remoteAgentLrayPort < 1 || remoteAgentLrayPort > 65535) {
      return res.status(400).json({ error: 'remoteAgentLrayPort 需为 1–65535 的整数' });
    }
    let tunnel = null;
    try {
      tunnel = await openDshTunnel({ deviceId, remoteAgentLrayPort, scope: 'probe' });
      const version = await probeVersion(tunnel.baseUrl, { timeoutMs: 5000, attempts: 3 });
      res.json({ ok: true, status: 'connected', bootId: version?.bootId ?? null, error: null });
    } catch (error) {
      res.json({ ok: false, status: 'error', bootId: null, error: error.message });
    } finally {
      if (tunnel) await tunnel.close().catch(() => undefined);
    }
  });
};
