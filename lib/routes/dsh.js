'use strict';
// dsh 传输相关路由（design-dsh-host-connection「前后端契约」）：
// - GET  /api/dsh/config   本机 dsh 配置（角色 / 中继服务器 / 账号 / 设备名 / 放行端口）
// - PUT  /api/dsh/config   保存 dsh 配置 + 热切换被连接方服务（入口在主机连接弹框）
// - GET  /api/dsh/status   本机 dsh 状态（角色 / 服务器 / 是否在线 / 被连 peer）
// - GET  /api/dsh/devices  中继服务器上当前账号可见的设备（连接方选目标用；本机排除）
// - POST /api/dsh/test     测试「未保存」的 dsh 连接目标（等价 ssh 的 POST /api/hosts/test）
//
// 这些是本机网关资源（dsh 配置与设备身份都在本机），不随当前查看的远端二次转发
// （proxy.js 已把 /api/dsh 列入本地资源）。
const { loadDshSettings, saveDshSettings } = require('../dsh/settings');
const { listDshDevices, openDshTunnel } = require('../dsh/client');
const { dshHostStatus, applyDshRuntime } = require('../dsh/host');
const {
  scopeLoginStatus,
  discoverProviders,
  startQrLogin,
  pollQrLogin,
  loginWithAccount,
  logout,
} = require('../dsh/auth');
const { probeVersion } = require('../transport');
const log = require('../logging');
const { logAndFail, logWrite } = require('./log-helper');

// 可编辑的 dsh 配置视图 + 登录态（authStatus：design-dsh-login-methods D5/D24，
// 任一 scope 有 token 即已登录）。账号密码不落盘 → 视图不含 email/password 字段。
async function configView(s) {
  const auth = await scopeLoginStatus();
  return {
    role: s.role,
    serverUrl: s.serverUrl,
    deviceName: s.deviceName,
    allowedPorts: s.allowedPorts,
    authStatus: {
      loggedIn: auth.loggedIn,
      roles: auth.roles,
    },
  };
}

module.exports = function mountDshRoutes(app, options = {}) {
  // 薄服务强制 client（design-thin-service Q24）：只出站连远端，不启被连接方服务，
  // /api/dsh/config 的 role 固定 client（无论存储值/请求值）。完整实例保持原行为。
  const forceClient = Boolean(options.forceClient);
  const coerceRole = (role) => (forceClient ? 'client' : role);

  // GET /api/dsh/config → 本机 dsh 配置 + 登录态（authStatus）。
  // 不记日志：access 日志已覆盖该请求，读操作无审计需求（design-logging §3.4 只规定写白名单）。
  app.get('/api/dsh/config', async (_req, res) => {
    try {
      const s = await loadDshSettings();
      res.json(await configView({ ...s, role: coerceRole(s.role) }));
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // PUT /api/dsh/config → 落盘配置字段 + 可选登录（design-dsh-login-methods D16）：
  // - 只落配置字段（role/serverUrl/deviceName/allowedPorts），不写 email/passwordEnc。
  // - 若带 email+password → 同时 authorizeWithAccount 登录生成 token（不落账号密码）。
  //   登录失败（密码错/连不上）→ 配置已落但报错、保持未登录（D16 不回滚配置）。
  // - 保存后热切换被连接方服务：角色含 host 则起服务、角色为 client 则停服务、
  //   放行端口立即刷新（applyDshRuntime）。
  app.put('/api/dsh/config', async (req, res) => {
    try {
      const body = req.body || {};
      // 薄服务强制 client：忽略请求里的 role，落库/热切换都按 client 处理（不启被连接方服务）。
      const patch = forceClient ? { ...body, role: 'client' } : body;
      const saved = await saveDshSettings(patch);
      // 写操作白名单：只记变更字段名（绝不记字段值——serverUrl 不算敏感，但统一走白名单）。
      logWrite('update', 'dsh-config', null, ['role', 'serverUrl', 'deviceName', 'allowedPorts']);
      // 账号密码登录：body 带 email+password 才触发（只登录，不落账号密码）。
      if (body.email !== undefined || body.password !== undefined) {
        try {
          await loginWithAccount(saved.role, String(body.email || '').trim(), String(body.password || ''));
        } catch (loginError) {
          // 登录失败：配置已落（D16 不回滚），报认证/网络错误并保持未登录。
          const code = loginError && loginError.code;
          const status = loginError && loginError.status;
          if (code === 'AUTH_INVALID' || status === 401 || status === 403) {
            return res.status(400).json({ error: loginError.message, code });
          }
          return res.status(502).json({ error: loginError.message, code });
        }
      }
      await applyDshRuntime(saved);
      const view = await configView(saved);
      // 响应审计：返回的配置视图 + 登录态（不记 token）。
      log.app.info('dsh config saved', { role: view.role, serverUrl: view.serverUrl, deviceName: view.deviceName, allowedPorts: view.allowedPorts, loggedIn: view.authStatus.loggedIn, roles: view.authStatus.roles });
      res.json(view);
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // GET /api/dsh/status → 本机 dsh 状态。
  app.get('/api/dsh/status', async (_req, res) => {
    try {
      const settings = await loadDshSettings();
      const host = dshHostStatus();
      res.json({
        ...(await configView({ ...settings, role: coerceRole(settings.role) })),
        // host 服务是否在跑 + 是否已连上中继服务器。
        running: Boolean(host.running),
        connected: Boolean(host.online),
        deviceId: host.deviceId ?? null,
        peers: host.peers ?? [],
        lastError: host.lastError ?? null,
      });
    } catch (error) {
      logAndFail(res, error);
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

  // ---- dsh 认证（design-dsh-login-methods）----

  // GET /api/dsh/auth/providers → 动态发现登录方式（D2/D3）。both 禁扫码 → 空 providers。
  // 可选 ?role= 覆盖配置 role（前端 draft.role 可能未落盘，评审 P1）；
  // 可选 ?serverUrl= 覆盖目标服务器（前端 draft.serverUrl，Q2；非法→400）。
  app.get('/api/dsh/auth/providers', async (req, res) => {
    try {
      res.json(await discoverProviders(coerceRole(String(req.query.role || '')), String(req.query.serverUrl || '')));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // POST /api/dsh/auth/qr/start → 发起扫码登录会话（无状态转发，D21）。
  // serverUrl 可选覆盖目标服务器（Q3，须与 qr/poll 同一地址；非法→400）。
  app.post('/api/dsh/auth/qr/start', async (req, res) => {
    const body = req.body || {};
    const role = coerceRole(body.role);
    if (role !== 'host' && role !== 'client') {
      return res.status(400).json({ error: 'role 需为 host 或 client（both 不支持扫码）' });
    }
    try {
      res.json(await startQrLogin(role, String(body.provider || 'zhihu'), body.serverUrl));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // POST /api/dsh/auth/qr/poll → 轮询扫码结果（无状态转发）。complete 时 token 落该 role scope。
  // serverUrl 须与 qr/start 传同一地址（token 以该 baseUrl 为键落盘）。
  app.post('/api/dsh/auth/qr/poll', async (req, res) => {
    const body = req.body || {};
    const role = coerceRole(body.role);
    const qrId = String(body.qrId || '');
    if ((role !== 'host' && role !== 'client') || !qrId) {
      return res.status(400).json({ error: 'role 需为 host/client 且 qrId 必填' });
    }
    try {
      res.json(await pollQrLogin(role, qrId, body.serverUrl));
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // POST /api/dsh/auth/logout → 清所有 scope 的 token，回未登录态（D7/D25）。不清旧账号密码。
  app.post('/api/dsh/auth/logout', async (_req, res) => {
    try {
      res.json(await logout());
    } catch (error) {
      logAndFail(res, error);
    }
  });
};
