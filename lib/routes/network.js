'use strict';
// 宿主网络状态上报（D-1）：薄服务记录原生壳观察到的网络事件与系统阻断状态，
// 供前端顶部横幅与诊断使用。纯内存（进程重启即清空），不落盘。
//
//   POST /api/network/status  —— 原生壳上报
//        { transport?: 'wifi'|'cellular'|'ethernet'|'none'|'other',
//          blocked?: boolean|null, dnsChanged?: boolean }
//   收到后：dnsChanged 或 transport 变化 → 对全部运行中的主机 kick（A-4 立即探活/重连）。
//   GET  /api/network/status  —— 读取最近一次上报（含 serverTime，前端据此判新鲜度）。
//
// /api/network 是本机资源（lib/auth.js LOCAL_ONLY_RE 与 proxy 同源），绝不透传远端。

const { kickAllHosts } = require('../hosts');
const log = require('../logging');

const TRANSPORTS = new Set(['wifi', 'cellular', 'ethernet', 'none', 'other']);

// 最近一次上报（不落盘）。null = 从未上报（桌面/未接原生壳）。
let last = null;

function snapshot() {
  return last ? { ...last } : null;
}

function normalizeTransport(raw) {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return TRANSPORTS.has(value) ? value : null;
}

module.exports = function mountNetworkRoutes(app) {
  app.post('/api/network/status', (req, res) => {
    const body = req.body || {};
    const transport = normalizeTransport(body.transport);
    const blocked = typeof body.blocked === 'boolean' ? body.blocked : null;
    const dnsChanged = body.dnsChanged === true;
    const prev = last;
    last = {
      transport,
      blocked,
      reportedAt: Date.now(),
      dnsChanged,
      serverTime: Date.now(),
    };
    const transportChanged = Boolean(prev) && prev.transport !== transport;
    log.app.info('network status', {
      transport,
      blocked,
      dnsChanged,
      transportChanged,
    });
    // 切网/DNS 变化 → 旧 socket 已死，立即探活并跳过退避重连（A-4）。
    // **不 await**：kickAllHosts 可能包含 dsh 隧道重建（秒级），而原生壳的上报连接
    // readTimeout=2s——同步等待会让每次切网都误报「上报失败」，而 kick 实际已生效。
    // 上报语义是「已接收」，前端/服务端通过轮询读取真实状态。
    if (dnsChanged || transportChanged) {
      void kickAllHosts().catch((error) => {
        log.app.warn('network status: kick failed', { error: error?.message || String(error) });
      });
    }
    res.json({ ok: true, ...snapshot() });
  });

  app.get('/api/network/status', (_req, res) => {
    res.json({ status: snapshot(), serverTime: Date.now() });
  });
};

module.exports.snapshot = snapshot;
module.exports._resetForTest = () => {
  last = null;
};
