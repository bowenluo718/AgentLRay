// 远端版本不兼容提示（design-android-mobile-app §10「版本漂移」/ §P3）。
//
// /api/hosts 的每台主机带 `compatible`（lib/version-compat.js 单一真源判定）：
//   - false → 远端版本低于客户端最低要求，部分数据面接口可能缺失，提示升级；
//   - null  → 远端未上报版本，无法判定，不提示（避免误报）。
// 仅对「已连接且当前选中」的远端生效；可针对 hostId@版本 一次性忽略（localStorage）。
import { useState } from 'react';
import { hostLabel } from '@/lib/host-status';
import { useAppStore } from '@/store';

const DISMISS_KEY = 'agentlray.compat.dismissed';

export function HostCompatBanner() {
  const hosts = useAppStore((s) => s.hosts);
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const hostReady = useAppStore((s) => s.hostReady);
  const [dismissed, setDismissed] = useState<string | null>(() => {
    try {
      return localStorage.getItem(DISMISS_KEY);
    } catch {
      return null;
    }
  });

  if (!hostReady || selectedHostId === 'local') return null;
  const host = hosts.find((h) => h.id === selectedHostId);
  if (!host || host.status !== 'connected' || host.compatible !== false) return null;

  // 以「主机 + 版本」为忽略键：远端升级后（版本变化）重新提示。
  const key = `${host.id}@${host.remoteVersion ?? ''}`;
  if (dismissed === key) return null;

  const dismiss = () => {
    setDismissed(key);
    try {
      localStorage.setItem(DISMISS_KEY, key);
    } catch {
      /* 隐私模式等 localStorage 不可用：仅本次会话生效 */
    }
  };

  return (
    <div
      role="status"
      className="flex shrink-0 items-center gap-2 border-b border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300"
    >
      <span className="min-w-0 flex-1">
        {hostLabel(hosts, host.id)} 运行的 AgentLRay 为 {host.remoteVersion ?? '未知版本'}，低于客户端最低要求，部分功能可能不可用。请升级远端 AgentLRay。
      </span>
      <button
        type="button"
        onClick={dismiss}
        className="shrink-0 rounded border border-amber-500/50 px-2 py-0.5 font-medium hover:bg-amber-500/20"
      >
        知道了
      </button>
    </div>
  );
}
