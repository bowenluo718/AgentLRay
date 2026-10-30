// Sidebar session list: cards, >200-item virtualization, ↑↓ keyboard nav,
// auto-select-first — ported from legacy renderSessions/sessionCardHtml.
// 列表支持两级分组：外层按平台/按项目（组头可折叠），组内保留四态状态子组头
// （可折叠），组内按状态优先级 + 最后活动时间倒序排序。「不分组」= 当前扁平的
// 状态组头。聚合视图（多平台）跨平台归并，来源由卡片平台徽标标识。
// 项目 = cwd 推导显示值（末段；末段重复显完整 cwd 消歧；无 cwd → 未知项目）。

import { useVirtualizer } from '@tanstack/react-virtual';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import type { SessionSummary } from '@/api/types';
import { formatDurationCompact, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import { platformLabel, selectablePlatformIds, useAppStore } from '@/store';
import type { GroupBy } from '@/store';
import { UNKNOWN_PROJECT, filterSessionList, formatDate, resolveProjectValues } from './lib';
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

// 聚合视图跨平台归并时用到的状态展示顺序（与服务端 STATUS_ORDER 一致）。
const STATUS_ORDER = ['awaiting-input', 'working', 'waiting', 'stopped'];

/** 展示行：外层组头 / 状态子组头 / 会话卡片。name 带 kind 前缀作稳定 key（含折叠态）。 */
type SessionRow =
  | { kind: 'group'; name: string; label: string; count: number; collapsed: boolean; key: string }
  | { kind: 'header'; name: string; status: string; count: number; collapsed: boolean; key: string }
  | { kind: 'session'; session: SessionSummary; key: string };

/** lastActivity（缺省回退 timestamp）毫秒，无法解析返回 0（排最后）。 */
function lastActiveMs(s: SessionSummary): number {
  return parseTimestampMs(s.lastActivity) ?? parseTimestampMs(s.timestamp) ?? 0;
}

function statusPriority(status: string | null | undefined): number {
  const i = STATUS_ORDER.indexOf(status || 'stopped');
  return i === -1 ? STATUS_ORDER.length : i;
}

/** 把一个组的会话按状态子组头 + 卡片展开为行；状态头折叠时不展开卡片。
 *  key 带 groupKey 前缀保证跨组唯一（扁平/虚拟化都要求 key 唯一）；折叠名 name
 *  保持 `status:` 共享——折叠一个组的该状态即折叠全部组的该状态。 */
function appendStatusRows(
  rows: SessionRow[],
  list: SessionSummary[],
  collapsed: string[],
  groupKey?: string
): void {
  const buckets = new Map<string, SessionSummary[]>();
  for (const s of list) {
    const status = s.status || 'stopped';
    const bucket = buckets.get(status) ?? [];
    bucket.push(s);
    buckets.set(status, bucket);
  }
  const ordered = [...buckets.entries()].sort((a, b) => statusPriority(a[0]) - statusPriority(b[0]));
  for (const [status, bucket] of ordered) {
    bucket.sort((a, b) => lastActiveMs(b) - lastActiveMs(a));
    const name = `status:${status}`;
    const key = groupKey ? `${groupKey}:${name}` : name;
    const collapsedStatus = collapsed.includes(name);
    rows.push({ kind: 'header', name, status, count: bucket.length, collapsed: collapsedStatus, key });
    if (collapsedStatus) continue;
    for (const s of bucket) rows.push({ kind: 'session', session: s, key: s.id });
  }
}

/** 平台分组外层键顺序：运行时平台列表（服务端顺序）优先，未标注平台垫底。 */
function platformGroupOrder(buckets: Map<string, SessionSummary[]>, order: string[]): string[] {
  const known = order.filter((p) => buckets.has(p));
  const rest = [...buckets.keys()].filter((k) => !order.includes(k));
  return [...known, ...rest];
}

/** 项目分组外层键顺序：组内最优状态优先（待用户输入/工作中置顶），再按组内最新活动倒序。 */
function projectGroupOrder(buckets: Map<string, SessionSummary[]>): string[] {
  const score = (list: SessionSummary[]) => {
    let best = STATUS_ORDER.length;
    let newest = -1;
    for (const s of list) {
      const p = statusPriority(s.status);
      if (p < best) best = p;
      const m = lastActiveMs(s);
      if (m > newest) newest = m;
    }
    return { best, newest };
  };
  return [...buckets.keys()].sort((a, b) => {
    const sa = score(buckets.get(a) || []);
    const sb = score(buckets.get(b) || []);
    return sa.best - sb.best || sb.newest - sa.newest || a.localeCompare(b);
  });
}

/**
 * 将（已按平台/项目筛选、文本筛选后的）会话列表展开为展示行数组。
 * - 不分组：与旧行为一致（聚合视图跨平台按状态归并；单平台原序插状态头），仅新增状态头折叠。
 * - 按平台 / 按项目：外层组头（可折叠）+ 组内四态状态子组头（可折叠）+ 卡片。
 * 空组头不产生行（组头只出现在有可见子内容的组）。
 */
function buildRows(
  sessions: SessionSummary[],
  groupBy: GroupBy,
  collapsed: string[],
  projectValues: Map<SessionSummary, string>,
  /** 运行时平台顺序（服务端顺序）；labelOf 由 store 平台列表派生平台展示名。 */
  orderIds: string[],
  labelOf: (id: string) => string
): SessionRow[] {
  // 单选平台数据无 platform 标记：按平台分组退化为原生状态分组（含单选平台时的
  // groupBy='platform' 残留，避免渲染一个「未标注」空桶）。
  if (groupBy === 'none' || (groupBy === 'platform' && sessions.length > 0 && !sessions[0].platform)) {
    const rows: SessionRow[] = [];
    if (sessions.length > 0 && sessions[0].platform) {
      appendStatusRows(rows, sessions, collapsed);
      return rows;
    }
    // 单平台：保持服务端分组序，逐组插头（组头 only-if-有卡片）。
    const counts = new Map<string, number>();
    for (const s of sessions) {
      const status = s.status || 'stopped';
      counts.set(status, (counts.get(status) || 0) + 1);
    }
    const seen = new Set<string>();
    for (const s of sessions) {
      const status = s.status || 'stopped';
      if (!seen.has(status)) {
        seen.add(status);
        const name = `status:${status}`;
        rows.push({
          kind: 'header',
          name,
          status,
          count: counts.get(status) || 0,
          collapsed: collapsed.includes(name),
          key: name,
        });
      }
      rows.push({ kind: 'session', session: s, key: s.id });
    }
    return rows;
  }

  const buckets = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    const key =
      groupBy === 'platform' ? (s.platform || '未标注') : (projectValues.get(s) ?? UNKNOWN_PROJECT);
    const bucket = buckets.get(key) ?? [];
    bucket.push(s);
    buckets.set(key, bucket);
  }
  const order = groupBy === 'platform' ? platformGroupOrder(buckets, orderIds) : projectGroupOrder(buckets);
  const rows: SessionRow[] = [];
  for (const key of order) {
    const list = buckets.get(key) || [];
    const name = `group:${key}`;
    const collapsedGroup = collapsed.includes(name);
    const label = groupBy === 'platform' ? labelOf(key) : key;
    rows.push({ kind: 'group', name, label, count: list.length, collapsed: collapsedGroup, key: name });
    if (collapsedGroup) continue;
    appendStatusRows(rows, list, collapsed, name);
  }
  return rows;
}

/** 可折叠组头：▸/▾ + 标签 + 数量。用于外层组头与状态子组头；状态子组头缩进以示层级。 */
function CollapseHeader({
  label,
  count,
  collapsed,
  onToggle,
  className,
  dataAttr,
  labelClass,
  indent = false,
}: {
  label: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  className?: string;
  dataAttr?: string;
  labelClass?: string;
  indent?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      data-header-name={dataAttr}
      onClick={onToggle}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
      className={cn(
        'flex cursor-pointer select-none items-center gap-1.5 px-1 pb-1 pt-2.5 text-[10px] font-medium tracking-wide',
        indent && 'pl-4',
        className
      )}
    >
      <span className="inline-block w-2 shrink-0 text-muted-foreground/70">{collapsed ? '▸' : '▾'}</span>
      <span className={cn('truncate', labelClass)}>{label}</span>
      <span className="text-muted-foreground/60">{count}</span>
    </div>
  );
}

function SessionRowHeader({
  status,
  count,
  collapsed,
  onToggle,
  indent = false,
}: {
  status: string;
  count: number;
  collapsed: boolean;
  onToggle: () => void;
  indent?: boolean;
}) {
  const meta = statusMetaFor(status) || { label: status, badgeClass: 'text-muted-foreground' };
  return (
    <CollapseHeader
      label={meta.label}
      count={count}
      collapsed={collapsed}
      onToggle={onToggle}
      dataAttr={status}
      indent={indent}
      className={meta.badgeClass || 'text-muted-foreground'}
      labelClass={cn('rounded border px-1 py-px text-[10px]', meta.badgeClass || 'text-muted-foreground')}
    />
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

function SessionCard({
  session,
  active,
  project,
  onClick,
  labelOf,
}: {
  session: SessionSummary;
  active: boolean;
  project: string;
  onClick: () => void;
  labelOf: (id: string) => string;
}) {
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
        <span className="flex min-w-0 items-center gap-1.5">
          {session.platform ? (
            <span
              className="shrink-0 rounded border border-border/60 px-1 py-px text-[10px] text-primary/90"
              title={`来源平台${session.agent ? ` / ${session.agent}` : ''}`}
            >
              {labelOf(session.platform)}
              {session.agent ? ` / ${session.agent}` : ''}
            </span>
          ) : null}
          <span className="truncate">{formatDate(session.timestamp)}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
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
      {project ? <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">📁 {project}</div> : null}
      {preview ? <div className="mt-0.5 line-clamp-2 text-[11px] text-muted-foreground">{preview}</div> : null}
    </div>
  );
}

export function SessionList({ filterTerm, onNavigate }: { filterTerm: string; onNavigate?: () => void }) {
  const selectedSessionId = useAppStore((s) => s.selectedSessionId);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const groupBy = useAppStore((s) => s.groupBy);
  const projectFilter = useAppStore((s) => s.projectFilter);
  const collapsedGroups = useAppStore((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useAppStore((s) => s.toggleGroupCollapsed);
  const multiView = useAppStore((s) => s.selectedPlatforms.length > 0);
  const platforms = useAppStore((s) => s.platforms);
  // 平台分组顺序与展示名以运行时平台列表（服务端顺序）为准。
  const orderIds = useMemo(() => selectablePlatformIds(platforms), [platforms]);
  const labelOf = useCallback((id: string) => platformLabel(platforms, id), [platforms]);
  const { data, isLoading, error } = useSessionsList();
  const raw = data ?? [];
  const projectValues = useMemo(() => resolveProjectValues(raw), [raw]);
  // 单选平台时按平台分组无意义：退化为平铺状态分组（不依赖会话是否带 platform 标记）。
  const effectiveGroupBy = groupBy === 'platform' && !multiView ? 'none' : groupBy;
  const collapsed = collapsedGroups[effectiveGroupBy] ?? [];
  const filtered = useMemo(() => {
    const byProject = projectFilter.length
      ? raw.filter((s) => projectFilter.includes(projectValues.get(s) ?? UNKNOWN_PROJECT))
      : raw;
    return filterSessionList(byProject, filterTerm);
  }, [raw, projectValues, projectFilter, filterTerm]);
  const rows = useMemo(
    () => buildRows(filtered, effectiveGroupBy, collapsed, projectValues, orderIds, labelOf),
    [filtered, effectiveGroupBy, collapsed, projectValues, orderIds, labelOf]
  );
  const visibleSessions = useMemo(
    () => rows.filter((r): r is Extract<SessionRow, { kind: 'session' }> => r.kind === 'session').map((r) => r.session),
    [rows]
  );
  const virtualized = filtered.length > VIRT_THRESHOLD;
  useServerStatusLabels();

  const parentRef = useRef<HTMLDivElement>(null);
  // 聚合视图：点击会话只更新「详情上下文 + 选中会话」，不改动筛选（platform/
  // selectedPlatforms/分组/项目筛选原样保留）；详情按会话来源平台/agent 加载。
  // 单平台视图：仅选中（详情上下文与筛选一致）。
  const selectSession = useCallback(
    (session: SessionSummary) => {
      const store = useAppStore.getState();
      if (session.platform && store.selectedPlatforms.length > 0) {
        store.setDetailContext(session.platform, session.agent || '');
        store.setSelectedSessionId(session.id);
      } else {
        setSelectedSessionId(session.id);
      }
      onNavigate?.();
    },
    [onNavigate, setSelectedSessionId]
  );
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => VIRT_ESTIMATE,
    overscan: VIRT_OVERSCAN,
    enabled: virtualized,
    // Defers measurement flushes out of React's commit phase (flushSync warning)
    useAnimationFrameWithResizeObserver: true,
  });

  // Auto-select first session when nothing valid is selected (legacy loadSessions)。
  // 已有显式选中（含 URL 路由恢复、跨筛选的详情）绝不覆盖；聚合视图不自动选中：
  // 跳转需要用户明确点击某个平台的会话。
  useEffect(() => {
    if (!data || multiView) return;
    if (!useAppStore.getState().selectedSessionId) {
      setSelectedSessionId(visibleSessions[0]?.id || '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, multiView, setSelectedSessionId]);

  // ↑↓ keyboard navigation over the visible session rows (legacy document keydown) —
  // 折叠隐藏的行不参与导航；组头行天然不在 visibleSessions 内。
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches('input, textarea, select') || target.closest('[role="dialog"]')) return;
      if (!parentRef.current?.getClientRects().length) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const state = useAppStore.getState();
      if (state.view !== 'sessions' || !visibleSessions.length) return;
      const index = visibleSessions.findIndex((item) => item.id === state.selectedSessionId);
      const nextIndex =
        event.key === 'ArrowDown' ? Math.min(index + 1, visibleSessions.length - 1) : Math.max(index - 1, 0);
      const next = visibleSessions[nextIndex];
      if (!next || next.id === state.selectedSessionId) return;
      event.preventDefault();
      selectSession(next);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSessions, selectSession]);

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
  }, [selectedSessionId, virtualized, rows]);

  if (isLoading) {
    return <div className="p-2 text-xs text-muted-foreground">Loading sessions…</div>;
  }
  if (error) {
    return <div className="p-2 text-xs text-destructive">{(error as Error).message}</div>;
  }
  if (!filtered.length) {
    return <div className="p-2 text-xs text-muted-foreground">No sessions match this filter.</div>;
  }

  const toggleCollapsed = (name: string) => toggleGroupCollapsed(groupBy, name);

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-y-auto pr-1" data-testid="session-list">
      {virtualized ? (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const dataRow = rows[row.index];
            return (
              <div
                key={dataRow.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                className={cn('absolute left-0 top-0 w-full', dataRow.kind === 'session' && 'pb-2')}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {dataRow.kind === 'session' ? (
                  <SessionCard
                    session={dataRow.session}
                    active={dataRow.session.id === selectedSessionId}
                    project={projectValues.get(dataRow.session) ?? ''}
                    onClick={() => selectSession(dataRow.session)}
                    labelOf={labelOf}
                  />
                ) : dataRow.kind === 'group' ? (
                  <CollapseHeader
                    label={dataRow.label}
                    count={dataRow.count}
                    collapsed={dataRow.collapsed}
                    onToggle={() => toggleCollapsed(dataRow.name)}
                    className="text-foreground"
                    dataAttr={dataRow.label}
                  />
                ) : (
                  <SessionRowHeader
                    status={dataRow.status}
                    count={dataRow.count}
                    collapsed={dataRow.collapsed}
                    onToggle={() => toggleCollapsed(dataRow.name)}
                    indent
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="flex flex-col">
          {rows.map((row) =>
            row.kind === 'session' ? (
              <div key={row.key} className="pb-2">
                <SessionCard
                  session={row.session}
                  active={row.session.id === selectedSessionId}
                  project={projectValues.get(row.session) ?? ''}
                  onClick={() => selectSession(row.session)}
                  labelOf={labelOf}
                />
              </div>
            ) : row.kind === 'group' ? (
              // 外层分组折叠头吸顶：相对本列表滚动容器（overflow-y-auto）吸顶，不透明
              // 背景遮住滚动上来的卡片；-mr-1 抵消容器 pr-1 让吸顶背景横向占满。
              <div key={row.key} className="sticky top-0 z-10 -mr-1 bg-panel-alt/95 backdrop-blur-sm">
                <CollapseHeader
                  label={row.label}
                  count={row.count}
                  collapsed={row.collapsed}
                  onToggle={() => toggleCollapsed(row.name)}
                  className="text-foreground"
                  dataAttr={row.label}
                />
              </div>
            ) : (
              <SessionRowHeader
                key={row.key}
                status={row.status}
                count={row.count}
                collapsed={row.collapsed}
                onToggle={() => toggleCollapsed(row.name)}
                indent
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
