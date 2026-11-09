// Messages area: unit grouping, turn-group folds, retry annotations, and
// newest-first pagination (>200 msgs → first 60 + load more) — legacy renderMessages.

import { useMemo, useState } from 'react';
import type { Platform, SessionMessage } from '@/api/types';
import { formatDurationCompact, getTextContent, parseTimestampMs } from '@/lib/pure';
import { cn } from '@/lib/utils';
import type { MsgFilter, TimingAnalysis } from './lib';
import { applyMsgFilter, messageAnchorId } from './lib';
import { GraphLane, MessageBubble } from './MessageItem';
import type { MessageUnit, RetryInfo, TurnUnit } from './messageUnits';
import { buildMessageUnits, buildRetryChains, buildUserBlocks } from './messageUnits';

export const MSG_BATCH_SIZE = 60; // units added per "load more" click

function RetryAnnotation({ info }: { info: RetryInfo }) {
  const { status, attempt, totalAttempts } = info;
  if (status === 'error-retried') {
    return (
      <div className="retry-annotation retry-error mb-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
        ❌ Attempt {attempt}/{totalAttempts} failed — agent will retry
      </div>
    );
  }
  if (status === 'error-final') {
    return (
      <div className="retry-annotation retry-error-final mb-1 rounded border border-destructive/40 bg-destructive/10 px-2 py-0.5 text-[11px] text-destructive">
        ❌ All {totalAttempts} attempt{totalAttempts > 1 ? 's' : ''} failed
      </div>
    );
  }
  if (status === 'success-recovered') {
    return (
      <div className="retry-annotation retry-recovered mb-1 rounded border border-[hsl(var(--assistant))]/40 bg-[hsl(var(--assistant))]/10 px-2 py-0.5 text-[11px] text-[hsl(var(--assistant))]">
        ✅ Attempt {attempt}/{totalAttempts} — recovered after {attempt - 1} error{attempt - 1 > 1 ? 's' : ''}
      </div>
    );
  }
  return null;
}

function Chip({ className, title, children }: { className?: string; title?: string; children: React.ReactNode }) {
  return (
    <span title={title} className={cn('rounded bg-secondary px-1.5 py-px text-[10px] text-muted-foreground', className)}>
      {children}
    </span>
  );
}

function TurnGroup({ unit, timing, isCodex }: { unit: TurnUnit; timing: TimingAnalysis; isCodex: boolean }) {
  const toolCount = unit.tools.length;
  const stepCount = unit.steps.length;
  const errCount = unit.steps.filter((s) => s.role === 'toolResult' && s.isError).length;
  const { retryCount, retryMap } = buildRetryChains(unit);

  // Unique tool names for chips
  const toolNameCounts: Record<string, number> = {};
  for (const t of unit.tools) {
    const n = (t as { name?: string | null; toolName?: string | null }).name ??
      (t as SessionMessage).toolName ?? '?';
    toolNameCounts[n || '?'] = (toolNameCounts[n || '?'] || 0) + 1;
  }
  const chips = Object.entries(toolNameCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  // Tool batch duration: first toolCall start → last toolResult finish
  let firstCallTs: number | null = null;
  if (isCodex) {
    for (const t of unit.tools) {
      const ts = parseTimestampMs((t as SessionMessage).timestamp);
      if (ts !== null && (firstCallTs === null || ts < firstCallTs)) firstCallTs = ts;
    }
  } else {
    firstCallTs = parseTimestampMs(unit.assistant.timestamp);
  }
  let lastResultTs: number | null = null;
  for (const step of unit.steps) {
    if (step.role === 'toolResult') {
      const ts = parseTimestampMs(step.timestamp);
      if (ts !== null && (lastResultTs === null || ts > lastResultTs)) lastResultTs = ts;
    }
  }
  const batchDur = firstCallTs !== null && lastResultTs !== null && lastResultTs > firstCallTs ? lastResultTs - firstCallTs : null;

  const assistantText = getTextContent(unit.assistant.content);

  return (
    <div className="flex gap-2" id={`row-${messageAnchorId(unit.assistant) || ''}`}>
      <GraphLane message={unit.assistant} />
      <div className="min-w-0 flex-1">
        {assistantText ? <MessageBubble message={unit.assistant} timing={timing.timingByMessage.get(unit.assistant)} /> : null}
        <details className="turn-group group mt-1 rounded-md border border-border bg-card/40">
          <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-2 py-1.5 text-xs [&::-webkit-details-marker]:hidden">
            <span className="text-[10px] text-muted-foreground transition-transform group-open:rotate-90">▶</span>
            <strong>
              🔧 {toolCount} tool call{toolCount > 1 ? 's' : ''}
            </strong>
            <span className="text-muted-foreground">
              · {stepCount} result{stepCount > 1 ? 's' : ''}
            </span>
            <span className="flex flex-wrap items-center gap-1">
              {batchDur !== null ? (
                <Chip
                  title="Total tool execution time for this turn"
                  className={cn(
                    batchDur >= 60000 ? 'text-destructive' : batchDur >= 10000 ? 'text-yellow-500' : undefined
                  )}
                >
                  ⏱ {formatDurationCompact(batchDur)}
                </Chip>
              ) : null}
              {chips.map(([name, count]) => (
                <Chip key={name}>
                  {name}
                  {count > 1 ? ` ×${count}` : ''}
                </Chip>
              ))}
              {retryCount > 0 ? (
                <Chip
                  title={`${retryCount} tool${retryCount > 1 ? 's were' : ' was'} retried after errors`}
                  className="text-[#a5d6ff]"
                >
                  🔄 {retryCount} retr{retryCount > 1 ? 'ies' : 'y'}
                </Chip>
              ) : null}
              {errCount ? (
                <Chip className="text-destructive">
                  ❌ {errCount} error{errCount > 1 ? 's' : ''}
                </Chip>
              ) : null}
            </span>
          </summary>
          <div className="space-y-2 border-t border-border/60 p-2">
            {unit.steps.map((step, i) => {
              const retryInfo = retryMap.get(step);
              return (
                <div key={step.id || step.toolCallId || i} className="flex gap-2" id={`row-${messageAnchorId(step) || ''}`}>
                  <GraphLane message={step} />
                  <div className="min-w-0 flex-1">
                    {retryInfo && retryInfo.totalAttempts > 1 ? <RetryAnnotation info={retryInfo} /> : null}
                    <MessageBubble message={step} timing={timing.timingByMessage.get(step)} />
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      </div>
    </div>
  );
}

export function MessageList({
  messages,
  platform,
  msgFilter,
  timing,
  sortOrder,
  visibleUnitCount,
  onLoadMore,
}: {
  messages: SessionMessage[];
  platform: Platform;
  msgFilter: MsgFilter;
  timing: TimingAnalysis;
  sortOrder: 'asc' | 'desc';
  visibleUnitCount: number;
  onLoadMore: () => void;
}) {
  const isCodex = platform === 'codex' || platform === 'omp' || platform === 'dsh' || platform === 'gemini';

  // units 保持时间正序；正序/倒序通过渲染方向控制
  const units = useMemo<MessageUnit[]>(() => {
    const filtered = applyMsgFilter(timing.visibleMessages, msgFilter);
    return buildMessageUnits(filtered, isCodex);
  }, [timing, msgFilter, isCodex]);

  // 折叠的 user 块（默认展开：collapsed 为空集合）
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  if (!messages.length) {
    return <div className="py-8 text-center text-sm text-muted-foreground">Session messages will appear here.</div>;
  }

  // 分页：单侧可见单元数（从时间两端相对计数），渲染方向由 sortOrder 决定
  const n = Math.min(visibleUnitCount, units.length);
  const remaining = units.length - n;
  const displayUnits = sortOrder === 'asc' ? units.slice(0, n) : units.slice(units.length - n);
  // 分组后再决定块级方向：块内保持「user → 回复」，块之间按时间排序
  const blocks = buildUserBlocks(displayUnits);
  const orderedBlocks = sortOrder === 'asc' ? blocks : blocks.slice().reverse();

  return (
    <div className="space-y-2" data-testid="message-list">
      {orderedBlocks.map((block) => {
        if (block.user === null) {
          return block.items.map((unit, i) => renderUnit(unit, i, timing, isCodex));
        }
        const key = messageAnchorId(block.user) || block.user.id || '';
        const isCollapsed = collapsed.has(key);
        const collapseToggle = (
          <button
            type="button"
            onClick={() =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(key)) next.delete(key);
                else next.add(key);
                return next;
              })
            }
            title={isCollapsed ? '展开该用户回合' : '折叠该用户回合'}
            aria-label={isCollapsed ? '展开该用户回合' : '折叠该用户回合'}
            className="text-muted-foreground transition-transform hover:text-foreground"
            style={{ transform: isCollapsed ? 'rotate(-90deg)' : 'none' }}
          >
            ▼
          </button>
        );
        return (
          <div key={key} className="flex gap-2" id={`row-${messageAnchorId(block.user) || ''}`}>
            <GraphLane message={block.user} />
            <div className="min-w-0 flex-1">
              <MessageBubble
                message={block.user}
                timing={timing.timingByMessage.get(block.user)}
                collapseToggle={collapseToggle}
              />
              {isCollapsed ? null : (
                <div className="mt-2 space-y-2">
                  {block.items.map((unit, i) => renderUnit(unit, i, timing, isCodex))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {remaining > 0 ? (
        <div className="flex justify-center py-2" id="loadMoreBar">
          <button
            type="button"
            onClick={onLoadMore}
            className="rounded-md border border-border px-3 py-1.5 text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground"
          >
            {sortOrder === 'asc'
              ? `▼ Load ${Math.min(remaining, MSG_BATCH_SIZE)} later messages (${remaining} hidden)`
              : `▼ Load ${Math.min(remaining, MSG_BATCH_SIZE)} earlier messages (${remaining} hidden)`}
          </button>
        </div>
      ) : null}
    </div>
  );
}

// 渲染单个消息单元（single 或 turn）
function renderUnit(unit: MessageUnit, i: number, timing: TimingAnalysis, isCodex: boolean) {
  if (unit.type === 'single') {
    return (
      <div key={unit.msg.id || i} className="flex gap-2" id={`row-${messageAnchorId(unit.msg) || ''}`}>
        <GraphLane message={unit.msg} />
        <div className="min-w-0 flex-1">
          <MessageBubble message={unit.msg} timing={timing.timingByMessage.get(unit.msg)} />
        </div>
      </div>
    );
  }
  return <TurnGroup key={unit.assistant.id || i} unit={unit} timing={timing} isCodex={isCodex} />;
}
