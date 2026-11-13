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
  getRuntime,
} = require('../hosts');

function publicHost(host) {
  const rt = getRuntime(host.id);
  return {
    id: host.id,
    label: host.label,
    type: host.type,
    ssh: host.ssh,
    status: rt?.status ?? (host.id === LOCAL_ID ? 'connected' : 'disconnected'),
    error: rt?.error ?? null,
    version: rt?.version ?? null,
  };
}

module.exports = function mountHostsRoutes(app) {
  // GET /api/hosts → [local, ...hosts]（每项含运行时 status/version）。
  app.get('/api/hosts', async (_req, res) => {
    try {
      const hosts = await listHosts();
      res.json([publicHost({ id: LOCAL_ID, label: '本机', type: 'ssh', ssh: null }), ...hosts.map((h) => publicHost(h))]);
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // POST /api/hosts → 新建（body: { id, label, type, ssh }）。
  app.post('/api/hosts', async (req, res) => {
    try {
      const host = await createHost(req.body || {});
      res.json(publicHost(host));
    } catch (error) {
      res.status(error.code === 'duplicate' ? 409 : 400).json({ error: error.message });
    }
  });

  // PUT /api/hosts/:id → 编辑（全量替换字段；id 不可改；已连接先关隧道待重连）。
  app.put('/api/hosts/:id', async (req, res) => {
    try {
      const host = await updateHost(req.params.id, req.body || {});
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
      res.json({ id });
    } catch (error) {
      res.status(500).json({ error: error.message });
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
        error: rt.error ?? null,
      };
      // 测试连接即关（不影响当前选中主机；切换时前端用 connect 保持隧道）。
      closeHost(id);
      res.json(result);
    } catch (error) {
      res.status(500).json({ error: error.message });
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
        // 失败已留 error，返回 502，前端保持原主机。
        return res.status(502).json({ ok: false, status: rt.status, error: rt.error });
      }
      // 设计 R4-Q1：切换只留当前选中主机一条隧道（无后台常驻池）。
      // 连接成功后关闭其他所有活跃隧道；失败不关（前端停留原主机，其隧道保留）。
      closeAllExcept(id);
      res.json({ ok: true, status: 'connected', bootId: rt.version?.bootId ?? null });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};
