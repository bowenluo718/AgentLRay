// Sidebar session list: cards, >200-item virtualization, ↑↓ keyboard nav,
// auto-select-first — ported from legacy renderSessions/sessionCardHtml.
// 服务端已按状态分组排序；此处把四态作为可见分组头（header 行）渲染，
// 组内顺序即服务端"组内默认排序"。

import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useReducer, useRef } from 'react';
import type { SessionSummary } from '@/api/types';
import { formatDurationCompact, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store';
import { filterSessionList, formatDate } from './lib';
import { useSessionsList } from './queries';

const VIRT_THRESHOLD = 200; // below this many sessions, render everything
const VIRT_OVERSCAN = 10; // extra cards above/below the visible range
const VIRT_ESTIMATE = 96; // estimated card height incl. gap

// 四态中文标签与配色。标签单源在服务端 /api/status-labels（lib/status.js STATUS_LABELS）；
// 这里保留同键配色与启动闪屏回退，启动后 fetch 一次并入服务器标签，避免各端硬编码漂移。
const STATUS_FALLBACK_META: Record<string, { label: string; badgeClass: string }> = {
  'awaiting-input': { label: '待用户输入', badgeClass: 'text-amber-300 border-amber-500/40' },
  working: { label: '工作中', badgeClass: 'text-emerald-300 border-emerald-500/40' },
  waiting: { label: '等待中', badgeClass: 'text-sky-300 border-sky-500/40' },
  stopped: { label: '已停止', badgeClass: 'text-muted-foreground border-border' },
};

const statusMetaCache = new Map<string, { label: string; badgeClass: string }>();

function statusMetaFor(status: string | null | undefined) {
  if (!status) return null;
  return statusMetaCache.get(status) ?? STATUS_FALLBACK_META[status] ?? null;
}

/** 启动时并入服务端四态定义（新状态自动出现；失败静默回退本地副本）。 */
function useServerStatusLabels(): void {
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

/** 展示行：组头（header）或会话卡片（session）。 */
type SessionRow = { kind: 'header'; status: string; count: number } | { kind: 'session'; session: SessionSummary };

/** 将（已按状态分组的）会话列表展开为"组头 + 卡片"行数组；同一状态只产生一个组头（首个会话前插入），组头带计数。 */
function groupRows(sessions: SessionSummary[]): SessionRow[] {
  const counts = new Map<string, number>();
  for (const s of sessions) {
    const status = s.status || 'stopped';
    counts.set(status, (counts.get(status) || 0) + 1);
  }
  const seen = new Set<string>();
  const rows: SessionRow[] = [];
  for (const s of sessions) {
    const status = s.status || 'stopped';
    if (!seen.has(status)) {
      seen.add(status);
      rows.push({ kind: 'header', status, count: counts.get(status) || 0 });
    }
    rows.push({ kind: 'session', session: s });
  }
  return rows;
}

function SessionRowHeader({ status, count }: { status: string; count: number }) {
  const meta = statusMetaFor(status) || { label: status, badgeClass: 'text-muted-foreground' };
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-1 pb-1 pt-2.5 text-[10px] font-medium tracking-wide',
        meta.badgeClass || 'text-muted-foreground'
      )}
      data-status-header={status}
    >
      <span>{meta.label}</span>
      <span className="text-muted-foreground/60">{count}</span>
    </div>
  );
}

const SOURCE_ICONS: Record<string, string> = {
  cli: '⌨️',
  telegram: '✈️',
  discord: '🎮',
  weixin: '💬',
  wechat: '💬',
  slack: '💼',
  web: '🌐',
  feishu: '🐦',
  whatsapp: '📱',
};

function chipTexts(session: SessionSummary): string[] {
  const chips: string[] = [];
  if (session.userCount) chips.push(`👤 ${session.userCount}`);
  if (session.assistantCount) chips.push(`🤖 ${session.assistantCount}`);
  if (session.toolCallCount) chips.push(`🔧 ${session.toolCallCount}`);
  if (session.spawnCount) chips.push(`🌳 ${session.spawnCount} spawn`);
  if (session.model) chips.push(`🧠 ${session.model.split('/').pop()}`);
  if (session.source) chips.push(`${SOURCE_ICONS[session.source.toLowerCase()] || '📡'} ${session.source}`);
  const startMs = parseTimestampMs(session.timestamp);
  const endMs = parseTimestampMs(session.lastActivity);
  if (startMs && endMs && endMs - startMs >= 5000) chips.push(`⏱ ${formatDurationCompact(endMs - startMs)}`);
  return chips;
}

function SessionCard({ session, active, onClick }: { session: SessionSummary; active: boolean; onClick: () => void }) {
  const preview = session.firstUserMessage
    ? session.firstUserMessage.length > 80
      ? session.firstUserMessage.slice(0, 80) + '…'
      : session.firstUserMessage
    : '';
  const statusMeta = statusMetaFor(session.status);
  return (
    <div
      role="button"
      aria-pressed={active}
      tabIndex={0}
      data-session-id={session.id}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      className={cn(
        'cursor-pointer rounded-md border px-2.5 py-2 text-xs transition-colors',
        active
          ? 'border-primary/70 bg-primary/10'
          : 'border-border bg-card/60 hover:border-primary/40 hover:bg-card'
      )}
    >
      <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{formatDate(session.timestamp)}</span>
        <span className="flex items-center gap-1">
          {session.archived ? (
            <span className="rounded border border-dashed border-border px-1 py-px text-[10px]" title="归档会话">
              📦
            </span>
          ) : null}
          {statusMeta ? (
            <span className={cn('rounded border px-1 py-px text-[10px]', statusMeta.badgeClass)}>
              {statusMeta.label}
            </span>
          ) : null}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {chipTexts(session).map((chip) => (
          <span key={chip} className="rounded bg-secondary px-1 py-px text-[10px] text-muted-foreground">
            {chip}
          </span>
        ))}
      </div>
      <div className="mt-1 truncate font-medium text-foreground">{session.title || session.id}</div>
      {preview ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{preview}</div> : null}
    </div>
  );
}

export function SessionList({ filterTerm, onNavigate }: { filterTerm: string; onNavigate?: () => void }) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const { data, isLoading, error } = useSessionsList();
  const sessions = data ?? [];
  const filtered = filterSessionList(sessions, filterTerm);
  const rows = groupRows(filtered);
  const virtualized = filtered.length > VIRT_THRESHOLD;
  useServerStatusLabels();

  const parentRef = useRef<HTMLDivElement>(null);
  const selectSession = (id: string) => {
    setSelectedSessionId(id);
    onNavigate?.();
  };
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => VIRT_ESTIMATE,
    overscan: VIRT_OVERSCAN,
    enabled: virtualized,
    // Defers measurement flushes out of React's commit phase (flushSync warning)
    useAnimationFrameWithResizeObserver: true,
  });

  // Auto-select first session when nothing valid is selected (legacy loadSessions)
  useEffect(() => {
    if (!data) return;
    if (!data.some((s) => s.id === useAppStore.getState().selectedSessionId)) {
      setSelectedSessionId(data[0]?.id || '');
    }
  }, [data, setSelectedSessionId]);

  // ↑↓ keyboard navigation over the filtered session list (legacy document keydown)。
  // 组头行不参与导航：索引基于 filtered（纯会话数组），天然跳过 header。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select') || target.closest('[role="dialog"]')) return;
      if (!parentRef.current?.getClientRects().length) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const state = useAppStore.getState();
      if (state.view !== 'sessions' || !filtered.length) return;
      const index = filtered.findIndex((item) => item.id === state.selectedSessionId);
      const nextIndex =
        event.key === 'ArrowDown' ? Math.min(index + 1, filtered.length - 1) : Math.max(index - 1, 0);
      const next = filtered[nextIndex];
      if (!next || next.id === state.selectedSessionId) return;
      event.preventDefault();
      setSelectedSessionId(next.id);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [filtered, setSelectedSessionId]);

  // Keep the selected card visible (legacy scrollSessionIntoView) — also covers
  // ⌘K jumps landing on a card far outside the rendered window. 基于展示行下标定位。
  useEffect(() => {
    if (!selectedSessionId) return;
    const rowIdx = rows.findIndex((r) => r.kind === 'session' && r.session.id === selectedSessionId);
    if (rowIdx === -1) return;
    if (virtualized) {
      // rAF: scrollToIndex flushes synchronously — illegal inside the commit phase
      const raf = requestAnimationFrame(() => virtualizer.scrollToIndex(rowIdx, { align: 'auto' }));
      return () => cancelAnimationFrame(raf);
    } else {
      parentRef.current
        ?.querySelector(`[data-session-id="${CSS.escape(selectedSessionId)}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSessionId, virtualized]);

  if (isLoading) {
    return <div className="p-2 text-xs text-muted-foreground">Loading sessions…</div>;
  }
  if (error) {
    return <div className="p-2 text-xs text-destructive">{(error as Error).message}</div>;
  }
  if (!filtered.length) {
    return <div className="p-2 text-xs text-muted-foreground">No sessions match this filter.</div>;
  }

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="session-list">
      {virtualized ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const dataRow = rows[row.index];
            return (
              <div
                key={dataRow.kind === 'session' ? dataRow.session.id : `hdr-${dataRow.status}`}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className={cn('absolute left-0 top-0 w-full', dataRow.kind === 'session' && 'pb-2')}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {dataRow.kind === 'header' ? (
                  <SessionRowHeader status={dataRow.status} count={dataRow.count} />
                ) : (
                  <SessionCard
                    session={dataRow.session}
                    active={dataRow.session.id === selectedSessionId}
                    onClick={() => selectSession(dataRow.session.id)}
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) =>
            row.kind === 'header' ? (
              <SessionRowHeader key={`hdr-${row.status}`} status={row.status} count={row.count} />
            ) : (
              <div key={row.session.id} className="pb-2">
                <SessionCard
                  session={row.session}
                  active={row.session.id === selectedSessionId}
                  onClick={() => selectSession(row.session.id)}
                />
              </div>
            )
          )}
        </div>
      )}
    </div>
  );
}
