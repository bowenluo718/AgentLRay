// Real-time tail: EventSource on /api/watch appending into the shared
// ['session', platform, id] query cache (legacy startSse/closeSse).

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getHostReady, watchUrl } from '@/api/client';
import type { SessionDetail, SessionMessage, SessionMeta, SessionSummary } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { useAppStore } from '@/store';

export type SseStatus = 'off' | 'connecting' | 'live' | 'error';

/**
 * Watches the selected parent session while auto-refresh is on (suppressed when
 * a child transcript is being viewed). New messages are appended to the query
 * cache; `onNewMessages(count)` lets the caller expand pagination / auto-scroll.
 */
export function useSessionSse(onNewMessages: (count: number) => void): SseStatus {
  const platform = useAppStore((s) => s.detailPlatform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const agent = useAppStore((s) => s.detailAgent);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SseStatus>('off');
  const onNewRef = useRef(onNewMessages);
  onNewRef.current = onNewMessages;

  // Demo mode has no backend to stream from — the toggle stays visibly off.
  // 先连后加载：主机未就绪（连接中）不建 SSE（EventSource 不能带自定义头，走 ?host=）。
  const enabled = !DEMO && getHostReady() && autoRefresh && !!sessionId && !viewingChildAgent;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    const es = new EventSource(
      watchUrl({ platform, sessionId, agent: agent || undefined })
    );
    es.addEventListener('connected', () => setStatus('live'));
    es.addEventListener('newMessages', (e) => {
      const payload = JSON.parse((e as MessageEvent).data || '{}') as {
        messages?: SessionMessage[];
        session?: Partial<SessionMeta>;
      };
      const newMsgs = payload.messages;
      const hasMsgs = Array.isArray(newMsgs) && newMsgs.length > 0;
      // 即时刷新侧栏会话状态：把推送过来的 status 合进所有活动列表缓存变体。
      // 结束/闲置标记可能不附带新消息，因此先于空消息守卫处理（避免等下个 5s 轮询）。
      const pushedStatus = typeof payload.session?.status === 'string' ? payload.session.status : null;
      if (pushedStatus) {
        queryClient.setQueriesData<SessionSummary[]>({ queryKey: ['sessions', platform], type: 'active' }, (old) => {
          if (!old) return old;
          return old.map((s) => (s.id === sessionId ? { ...s, status: pushedStatus } : s));
        });
        // 列表恒走聚合接口（['sessions','multi',...]），即时同步其状态，避免等下个 5s 轮询。
        queryClient.setQueriesData<SessionSummary[]>({ queryKey: ['sessions', 'multi'], type: 'active' }, (old) => {
          if (!old) return old;
          return old.map((s) => (s.id === sessionId ? { ...s, status: pushedStatus } : s));
        });
      }
      if (!hasMsgs) {
        if (payload.session) {
          queryClient.setQueryData<SessionDetail>(['session', platform, sessionId], (old) =>
            old ? { ...old, session: { ...old.session, ...payload.session } } : old
          );
        }
        return;
      }
      queryClient.setQueryData<SessionDetail>(['session', platform, sessionId], (old) =>
        old
          ? { session: { ...old.session, ...(payload.session || {}) }, messages: [...old.messages, ...newMsgs] }
          : old
      );
      onNewRef.current(newMsgs.length);
      // Refresh sidebar counters (legacy loadSessions(true) on newMessages)
      queryClient.invalidateQueries({ queryKey: ['sessions', platform] });
      // 聚合列表（恒走 GET /api/sessions）同样失效重拉，即时反映新消息（不依赖 5s 轮询）。
      queryClient.invalidateQueries({ queryKey: ['sessions', 'multi'] });
    });
    // EventSource auto-reconnects on error — just reflect the state (🔴 Live)
    es.addEventListener('error', () => setStatus('error'));
    return () => {
      es.close();
      setStatus('off');
    };
  }, [enabled, platform, sessionId, agent, queryClient]);

  return status;
}
