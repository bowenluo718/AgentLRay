// 四态中文标签与配色（会话列表 / 任务看板共享）。
// 标签单源在服务端 /api/status-labels（lib/status.js STATUS_LABELS）；这里保留同键
// 配色与启动闪屏回退，启动后 fetch 一次并入服务器标签，避免各端硬编码漂移。
// 看板与列表的列头/徽标颜色**只**从这里取（statusMetaFor），不再出现第三处硬编码。

import { useEffect, useReducer } from 'react';

const STATUS_FALLBACK_META: Record<string, { label: string; badgeClass: string }> = {
  'awaiting-input': { label: '待用户输入', badgeClass: 'text-amber-300 border-amber-500/40' },
  working: { label: '工作中', badgeClass: 'text-emerald-300 border-emerald-500/40' },
  waiting: { label: '等待中', badgeClass: 'text-sky-300 border-sky-500/40' },
  stopped: { label: '已停止', badgeClass: 'text-muted-foreground border-border' },
};

const statusMetaCache = new Map<string, { label: string; badgeClass: string }>();

export function statusMetaFor(status: string | null | undefined) {
  if (!status) return null;
  return statusMetaCache.get(status) ?? STATUS_FALLBACK_META[status] ?? null;
}

/** 启动时并入服务端四态定义（新状态自动出现；失败静默回退本地副本）。 */
export function useServerStatusLabels(): void {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    let alive = true;
    fetch('/api/status-labels')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((payload: { labels?: Record<string, string> }) => {
        if (!alive || !payload?.labels) return;
        statusMetaCache.clear();
        for (const [status, label] of Object.entries(payload.labels)) {
          statusMetaCache.set(status, {
            label,
            badgeClass: STATUS_FALLBACK_META[status]?.badgeClass || 'text-muted-foreground border-border',
          });
        }
        forceRender();
      })
      .catch(() => {
        /* keep fallback */
      });
    return () => {
      alive = false;
    };
  }, []);
}
