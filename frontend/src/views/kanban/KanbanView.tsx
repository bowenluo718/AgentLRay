// 任务看板视图：按会话四态（待用户输入/工作中/等待中/已停止）分列展示。
// - 数据复用 useSessionsList()（与侧栏列表同缓存、5s 轮询 + SSE 合并）；
//   平台多选/项目筛选完全共享侧栏 store，看板不提供平台/项目控件；
// - 看板局部控件仅「筛选任务...」文本搜索 + 每列展开/收起（全局手风琴：同一时刻
//   至多一列展开），均为组件内 state；
// - 响应式：宽度 <768（matchMedia，与 App.tsx 同一断点约定）纵向堆叠四列，每列默认
//   只展示 1 张卡（collapsedLimit=1）、组头整块可点展开/收起、页面级滚动（复用外层
//   TabsContent 的 overflow-auto）；≥768 维持横向四列 + 独立「展开」按钮 + 列内滚动。
// - 每列最多条数从 GET /api/settings/kanban（maxPerStatus，加载中/失败回退默认 20）；
//   桌面折叠条数 = maxPerStatus，移动端折叠恒 1（见 design-kanban-mobile.zh-CN.md）。
// - 状态标签/配色**只**取自 statusMetaFor（statusMeta.ts），无第三处硬编码。

import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { getKanbanConfig } from '@/api/client';
import type { SessionSummary } from '@/api/types';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { platformLabel, useAppStore } from '@/store';
import { UNKNOWN_PROJECT, filterSessionList, formatDate, resolveProjectValues } from '@/views/sessions/lib';
import { useSessionsList } from '@/views/sessions/queries';
import { statusMetaFor, useServerStatusLabels } from '@/views/sessions/statusMeta';
import { buildKanbanColumns } from './kanbanLib';

/** 看板每列默认最多展示条数（配置加载中/失败回退值）。 */
const DEFAULT_MAX_PER_STATUS = 20;

function KanbanCard({ session, project, platformLabelText, onClick }: {
  session: SessionSummary;
  project: string;
  platformLabelText: string;
  onClick: (s: SessionSummary) => void;
}) {
  const preview = session.firstUserMessage || '（无消息）';
  return (
    <div
      role="button"
      tabIndex={0}
      data-session-id={session.id}
      onClick={() => onClick(session)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(session);
        }
      }}
      className="cursor-pointer rounded-md border border-border bg-card/60 px-2.5 py-2 text-xs transition-colors hover:border-primary/40 hover:bg-card"
    >
      <div className="line-clamp-2 break-words font-medium text-foreground">{preview}</div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="min-w-0 truncate">{formatDate(session.lastActivity ?? session.timestamp)}</span>
        <span
          className="shrink-0 rounded border border-border/60 px-1 py-px text-[10px] text-primary/90"
          title={session.agent ? `来源平台 / ${session.agent}` : platformLabelText}
        >
          {platformLabelText}
        </span>
      </div>
      {project ? <div className="mt-0.5 truncate text-[10px] text-muted-foreground/70">📁 {project}</div> : null}
    </div>
  );
}

export function KanbanView() {
  const projectFilter = useAppStore((s) => s.projectFilter);
  const platforms = useAppStore((s) => s.platforms);
  const currentPlatform = useAppStore((s) => s.platform);
  const setDetailContext = useAppStore((s) => s.setDetailContext);
  const setSelectedSessionId = useAppStore((s) => s.setSelectedSessionId);
  const setView = useAppStore((s) => s.setView);
  const setSessionView = useAppStore((s) => s.setSessionView);

  // 看板局部控件（切走 TABS 重置；共享筛选仍在 store 持久化）。
  const [term, setTerm] = useState('');
  // 全局手风琴：任意时刻至多一列展开（null = 全收起）。桌面/移动共用同一 state，
  // 断点翻转自洽无需重置。
  const [expandedStatus, setExpandedStatus] = useState<string | null>(null);

  // 移动端断点订阅（与 App.tsx 同一 <768 约定，原生 matchMedia、不引依赖）。
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const { data, isLoading, error } = useSessionsList();
  const raw = data ?? [];
  useServerStatusLabels();

  // 每列最多条数：与服务端 kanban-config 同缓存键（SettingsDialog 保存后 invalidate 同步）。
  const kanbanCfg = useQuery({
    queryKey: ['kanban-config'] as const,
    queryFn: getKanbanConfig,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const maxPerStatus = kanbanCfg.data?.maxPerStatus?.value ?? DEFAULT_MAX_PER_STATUS;

  // 过滤管线（与侧栏同配方）：共享 projectFilter 客户端过滤 → 看板局部文本过滤。
  const projectValues = useMemo(() => resolveProjectValues(raw), [raw]);
  const filtered = useMemo(() => {
    const byProject = projectFilter.length
      ? raw.filter((s) => projectFilter.includes(projectValues.get(s) ?? UNKNOWN_PROJECT))
      : raw;
    return filterSessionList(byProject, term);
  }, [raw, projectValues, projectFilter, term]);

  const columns = useMemo(
    () => buildKanbanColumns(filtered, { collapsedLimit: isMobile ? 1 : maxPerStatus, expandedStatus }),
    [filtered, isMobile, maxPerStatus, expandedStatus]
  );

  const labelOf = useCallback((id: string) => platformLabel(platforms, id), [platforms]);

  // 点击卡片 → 会话详情（详情上下文独立于筛选）：与 ⌘K 跳转同路径。
  const openSession = useCallback(
    (s: SessionSummary) => {
      const current = useAppStore.getState();
      const platform = s.platform || current.platform;
      setDetailContext(platform, s.agent || '');
      setSelectedSessionId(s.id);
      setView('sessions');
      setSessionView('messages');
    },
    [setDetailContext, setSelectedSessionId, setView, setSessionView]
  );

  if (isLoading) {
    return <div className="p-2 text-xs text-muted-foreground">Loading sessions…</div>;
  }
  if (error) {
    return <div className="p-2 text-xs text-destructive">{(error as Error).message}</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 pb-3">
        <Input
          type="search"
          value={term}
          placeholder="筛选任务..."
          onChange={(e) => setTerm(e.target.value)}
          className="max-w-xs"
          aria-label="筛选任务"
        />
      </div>
      <div
        className={cn(
          "flex min-h-0 flex-1 gap-3 pb-2",
          // ≥768 横向四列 + 横向滚动（现状）；<768 纵向堆叠，页面级滚动交给外层 TabsContent
          isMobile ? "flex-col" : "flex-row overflow-x-auto"
        )}
      >
        {columns.map((col) => {
          const meta = statusMetaFor(col.status) || { label: col.status, badgeClass: 'text-muted-foreground' };
          const dotClass = meta.badgeClass.split(/\s+/)[0] || 'text-muted-foreground';
          const showExpand = col.total > maxPerStatus;
          const isOpen = expandedStatus === col.status;
          const expandable = col.total > 1;
          return (
            <div
              key={col.status}
              className={cn(
                "flex flex-col rounded-lg border border-border/60 bg-card/40",
                // ≥768 撑满等宽 + 列内滚动；<768 自适应高度、卡片随页面滚动
                isMobile ? "" : "h-full min-h-0 min-w-[200px] flex-1"
              )}
            >
              <div
                className={cn(
                  "flex shrink-0 items-center gap-1.5 border-b border-border/60 px-2.5 py-2",
                  // 移动端组头整块可点（展开/收起手风琴），桌面保留独立按钮
                  isMobile && expandable && "cursor-pointer select-none touch-manipulation",
                  // 移动端纵向堆叠 + 页面级滚动：组头吸顶遮住滚动上来的卡片
                  isMobile && "sticky top-0 z-10 bg-card/95 backdrop-blur-sm"
                )}
                onClick={isMobile && expandable ? () => setExpandedStatus(isOpen ? null : col.status) : undefined}
                role={isMobile && expandable ? 'button' : undefined}
                tabIndex={isMobile && expandable ? 0 : undefined}
                onKeyDown={
                  isMobile && expandable
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setExpandedStatus(isOpen ? null : col.status);
                        }
                      }
                    : undefined
                }
                aria-expanded={isMobile && expandable ? isOpen : undefined}
              >
                <span className={cn('shrink-0 text-xs leading-none', dotClass)}>●</span>
                <span className="truncate text-xs font-medium text-foreground">{meta.label}</span>
                <span className="ml-auto shrink-0 min-w-5 rounded-full bg-secondary px-1.5 py-px text-center text-[10px] text-muted-foreground">
                  {col.total}
                </span>
                {isMobile && expandable ? (
                  <span className="shrink-0 text-[10px] leading-none text-muted-foreground/70" aria-hidden>
                    {isOpen ? '▾' : '▸'}
                  </span>
                ) : null}
              </div>
              <div
                className={cn(
                  "space-y-1.5 px-1.5 py-1.5",
                  // ≥768 列内滚动；<768 页面级滚动（设计 B），列内不建滚动容器避免嵌套手势
                  isMobile ? "overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"
                )}
              >
                {col.list.length === 0 ? (
                  <div
                    className={cn(
                      "px-1 py-3 text-center text-[11px] text-muted-foreground",
                      // 移动端空列占位 = 空白灰卡（桌面保持原样，最小改动）
                      isMobile && "rounded-md border border-dashed border-border/60 bg-card/40 py-4"
                    )}
                  >
                    这个状态还没有任务
                  </div>
                ) : (
                  col.list.map((s) => (
                    <KanbanCard
                      key={s.id}
                      session={s}
                      project={projectValues.get(s) ?? ''}
                      platformLabelText={labelOf(s.platform || currentPlatform)}
                      onClick={openSession}
                    />
                  ))
                )}
              </div>
              {showExpand && !isMobile ? (
                <div className="shrink-0 border-t border-border/60 px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => setExpandedStatus(isOpen ? null : col.status)}
                    className="text-[11px] text-primary/80 hover:text-primary"
                  >
                    {isOpen ? '收起' : `还有 ${col.total - maxPerStatus} 条 · 展开全部`}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
