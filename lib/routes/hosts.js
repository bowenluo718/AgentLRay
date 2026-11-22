'use strict';
// 主机管理路由：/api/hosts CRUD + /api/hosts/:id/test 测试连接。
// - hosts.json 由 lib/hosts.js 读写；返回列表含内建 `local`（恒 connected，不落盘）。
// - test：对指定主机建隧道 → 探测 /api/version → 返回 { ok, bootId, error? }，测完即关
//   （不影响当前选中主机）。local 恒 ok。
const {
  LOCAL_ID,
  listHosts,
  getHost,
  createHost,
  updateHost,
  deleteHost,
  openHost,
  closeHost,
  closeAllExcept,
  testHostSpec,
  kickHost,
  forgetHostTrust,
  getRuntime,
  getLastHostId,
  setLastHostId,
  rememberLastHost,
} = require('../hosts');
const { isRemoteCompatible } = require('../version-compat');
const { logAndFail, logWrite } = require('./log-helper');

function publicHost(host) {
  const rt = getRuntime(host.id);
  const ssh = host.ssh
    ? {
        host: host.ssh.host,
        user: host.ssh.user,
        port: host.ssh.port,
        remoteAgentLrayPort: host.ssh.remoteAgentLrayPort,
        identityFile: host.ssh.identityFile,
        // 私钥内容只写不读：回传是否已配置，绝不明文/密文。
        hasIdentityKey: Boolean(host.ssh.identityKeyEnc),
        useAgent: host.ssh.useAgent,
      }
    : null;
  // dsh 目标：中继服务器上的设备 id + 远端 AgentLRay 端口（无凭据，明文安全）。
  const dsh = host.dsh
    ? {
        deviceId: host.dsh.deviceId,
        remoteAgentLrayPort: host.dsh.remoteAgentLrayPort,
      }
    : null;
  // 运行时探测到的远端 /api/version 载荷（bootId + 版本号）。
  const remoteVersion = rt?.version?.version ?? null;
  const isLocal = host.id === LOCAL_ID;
  // A-1 链路状态机：phase 为稳定语义（connecting/connected/reconnecting/failed/
  // disconnected）；status 保留旧字符串（reconnecting/failed 直接透出），既有消费方不受影响。
  // error 仍是字符串消息（既有消费方按文本渲染），稳定错误码另放 errorCode/errorRetryable。
  const error = rt?.error ?? null;
  return {
    id: host.id,
    label: host.label,
    type: host.type,
    ssh,
    dsh,
    status: rt?.status ?? (isLocal ? 'connected' : 'disconnected'),
    phase: rt?.phase ?? (isLocal ? 'connected' : 'disconnected'),
    error: error?.message ?? null,
    errorCode: error?.code ?? null,
    errorRetryable: error?.retryable ?? null,
    attempt: rt?.attempt ?? 0,
    nextRetryAt: rt?.nextRetryAt ?? null,
    version: rt?.version ?? null,
    // 远端上报版本号（未知 → null）与兼容判定（false → 前端提示升级，不阻断连接）。
    // 判定单一真源在 lib/version-compat.js；前端只消费结果。
    remoteVersion,
    compatible: isRemoteCompatible(remoteVersion),
  };
}

module.exports = function mountHostsRoutes(app, options = {}) {
  // 薄服务无 `local` 宿主（design-thin-service Q14）：GET /api/hosts 只返回远端，
  // 前端 thin 不初始化为 local，自动连记忆/首台主机，无主机时显示空态引导。
  const includeLocal = options.includeLocal !== false;

  // GET /api/hosts → { lastHostId, hosts }（thin 无 local 宿主；每项含运行时 status/version）。
  // lastHostId 为 hosts.json 顶层「记忆主机」，薄服务 boot 据此恢复上次主机（design-android §7.7）。
  app.get('/api/hosts', async (_req, res) => {
    try {
      const hosts = await listHosts();
      const local = includeLocal ? [publicHost({ id: LOCAL_ID, label: '本机', type: 'ssh', ssh: null })] : [];
      const lastHostId = await getLastHostId();
      res.json({ lastHostId, hosts: [...local, ...hosts.map((h) => publicHost(h))] });
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // POST /api/hosts → 新建（body: { id, label, type, ssh }）。
  app.post('/api/hosts', async (req, res) => {
    try {
      const host = await createHost(req.body || {});
      logWrite('create', 'host', host.id, Object.keys(req.body || {}));
      res.json(publicHost(host));
    } catch (error) {
      res.status(error.code === 'duplicate' ? 409 : 400).json({ error: error.message });
    }
  });

  // PUT /api/hosts/:id → 编辑（全量替换字段；id 不可改；已连接先关隧道待重连）。
  // 透传可选 body 顶层 lastHostId：前端保存主机表单时可顺带记忆上次主机（design-android §7.7）。
  app.put('/api/hosts/:id', async (req, res) => {
    try {
      const body = req.body || {};
      const host = await updateHost(req.params.id, body);
      if (typeof body.lastHostId === 'string' && body.lastHostId) {
        await setLastHostId(body.lastHostId);
      }
      logWrite('update', 'host', req.params.id, Object.keys(body));
      res.json(publicHost(host));
    } catch (error) {
      res.status(error.code === 'not-found' ? 404 : 400).json({ error: error.message });
    }
  });

  // DELETE /api/hosts/:id → 删除（关隧道 + 移除）。local 不可删。
  app.delete('/api/hosts/:id', async (req, res) => {
    const id = req.params.id;
    if (id === LOCAL_ID) return res.status(400).json({ error: '本机不可删除' });
    try {
      if (!(await getHost(id))) return res.status(404).json({ error: `主机不存在: ${id}` });
      await deleteHost(id);
      logWrite('delete', 'host', id);
      res.json({ id });
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // POST /api/hosts/test → 测试「未保存」的主机配置（表单「测试连接」）：
  // 按 body 里的 ssh 规格建隧道 → 探测 → 关，不持久化、不影响当前选中主机。
  app.post('/api/hosts/test', async (req, res) => {
    try {
      const result = await testHostSpec(req.body || {});
      res.json(result);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });

  // POST /api/hosts/:id/test → 测试连接：建隧道 → 探测 /api/version → 关隧道。
  app.post('/api/hosts/:id/test', async (req, res) => {
    const id = req.params.id;
    if (id === LOCAL_ID) {
      return res.json({ ok: true, bootId: null, status: 'connected' });
    }
    try {
      const host = await getHost(id);
      if (!host) return res.status(404).json({ error: `主机不存在: ${id}` });
      const rt = await openHost(id);
      const result = {
        ok: rt.status === 'connected',
        status: rt.status,
        bootId: rt.version?.bootId ?? null,
        error: rt.error?.message ?? null,
        errorCode: rt.error?.code ?? null,
        errorRetryable: rt.error?.retryable ?? null,
      };
      // 测试连接即关（不影响当前选中主机；切换时前端用 connect 保持隧道）。
      closeHost(id);
      res.json(result);
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // POST /api/hosts/:id/connect → 建立并保持隧道（供前端切换当前选中主机）。
  // 成功后此主机运行时保持 connected，proxy 后续请求可直接透传。
  app.post('/api/hosts/:id/connect', async (req, res) => {
    const id = req.params.id;
    if (id === LOCAL_ID) {
      return res.json({ ok: true, bootId: null, status: 'connected' });
    }
    try {
      const host = await getHost(id);
      if (!host) return res.status(404).json({ error: `主机不存在: ${id}` });
      const rt = await openHost(id);
      if (rt.status !== 'connected') {
        // 失败已留 error（{code,message,retryable}），返回 502，前端保持原主机。
        // retryable 的失败服务端会自动退避重连；非重试失败需用户处理（重新登录/删信任记录等）。
        return res.status(502).json({
          ok: false,
          status: rt.status,
          phase: rt.phase,
          error: rt.error?.message ?? null,
          errorCode: rt.error?.code ?? null,
          errorRetryable: rt.error?.retryable ?? null,
          nextRetryAt: rt.nextRetryAt ?? null,
        });
      }
      // 设计 R4-Q1：切换只留当前选中主机一条隧道（无后台常驻池）。
      // 连接成功后关闭其他所有活跃隧道；失败不关（前端停留原主机，其隧道保留）。
      closeAllExcept(id);
      // 记忆主机：前端切换当前主机成功后写盘，供薄服务下次 boot 恢复（design-android §7.7）。
      // 后台写盘：hosts.json 文件 IO 偶发阻塞（Windows 云同步/杀软）不得拖住连接响应。
      rememberLastHost(id);
      logWrite('connect', 'host', id);
      res.json({ ok: true, status: 'connected', bootId: rt.version?.bootId ?? null });
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // POST /api/hosts/:id/kick → 网络切换/回前台触发的即时探活与立即重连（A-4）。
  // 幂等：未运行的主机不建链，直接回当前状态（前端轮询会继续读服务端真实状态）。
  app.post('/api/hosts/:id/kick', async (req, res) => {
    const id = req.params.id;
    if (id === LOCAL_ID) return res.json({ id, phase: 'connected' });
    try {
      const rt = await kickHost(id);
      if (!rt) {
        // 未建立运行时（从未连接/已断开）：若无此主机则 404，否则回 disconnected。
        if (!(await getHost(id))) return res.status(404).json({ error: `主机不存在: ${id}` });
        return res.json({ id, phase: 'disconnected', status: 'disconnected' });
      }
      res.json({
        id,
        phase: rt.phase,
        status: rt.status,
        attempt: rt.attempt ?? 0,
        nextRetryAt: rt.nextRetryAt ?? null,
        errorCode: rt.error?.code ?? null,
        errorRetryable: rt.error?.retryable ?? null,
      });
    } catch (error) {
      logAndFail(res, error);
    }
  });

  // DELETE /api/hosts/:id/trust → 「忘记此主机」：清除 dsh 对端身份钉扎（A-6）。
  // KEY_CHANGED 时用户须先清信任记录才能重连；二次确认由前端负责。
  app.delete('/api/hosts/:id/trust', async (req, res) => {
    const id = req.params.id;
    if (id === LOCAL_ID) return res.status(400).json({ error: '本机无信任记录' });
    try {
      const result = await forgetHostTrust(id);
      logWrite('forget-trust', 'host', id, [`device=${result.deviceId}`, `removed=${result.removed}`]);
      res.json(result);
    } catch (error) {
      const status = error.code === 'not-found' ? 404 : error.code === 'unsupported' ? 400 : 500;
      res.status(status).json({ error: error.message });
    }
  });

  // POST /api/hosts/:id/disconnect → 手动断开连接：关闭隧道 + 停心跳 + 清运行时。
  // local 恒 connected，不可断开。对未连接/不存在的主机幂等返回 disconnected（closeHost
  // 只动运行时，hosts.json 里有没有该 id 都允许断开）。
  app.post('/api/hosts/:id/disconnect', (req, res) => {
    const id = req.params.id;
    if (id === LOCAL_ID) return res.status(400).json({ error: '本机不可断开' });
    closeHost(id);
    logWrite('disconnect', 'host', id);
    res.json({ id, status: 'disconnected' });
  });
};
