// Real-time tail: EventSource on /api/watch appending into the shared
// ['session', platform, id] query cache (legacy startSse/closeSse).
//
// 数据不丢（B-1）：SSE 断线不依赖 EventSource 自带的「从头再来」语义。每次 newMessages
// 记下服务端附带的 `id:`（文件字节偏移）；连接重建时用 `?after=<offset>` 让服务端续读，
// 断线期间写入的消息在重连后补发，且不重复。偏移失效（文件轮转/截断）时服务端回落全量，
// 前端再以 invalidateQueries 对账一次。

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { getHostReady, watchUrl } from '@/api/client';
import { cachedUiToken } from '@/api/ui-token';
import type { SessionDetail, SessionMessage, SessionMeta, SessionSummary } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { useAppStore } from '@/store';

export type SseStatus = 'off' | 'connecting' | 'live' | 'error';

/** 断线补拉起读偏移：事件 id 是服务端消费到的文件字节偏移（数字字符串）。 */
function parseEventId(e: Event): number | null {
  const raw = (e as MessageEvent).lastEventId;
  if (!raw) return null;
  const n = Number(raw);
  // 0 视为无效：服务端把 after=0 当全量基线，续读无意义（避免每次重连都传 after=0）。
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Watches the selected parent session while auto-refresh is on (suppressed when
 * a child transcript is being viewed). New messages are appended to the query
 * cache; `onNewMessages(count)` lets the caller expand pagination / auto-scroll.
 */
export function useSessionSse(
  onNewMessages: (count: number) => void,
  onAuthLost?: () => void
): SseStatus {
  const platform = useAppStore((s) => s.detailPlatform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const agent = useAppStore((s) => s.detailAgent);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const viewingChildAgent = useAppStore((s) => s.viewingChildAgent);
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SseStatus>('off');
  const onNewRef = useRef(onNewMessages);
  onNewRef.current = onNewMessages;
  // 最近一次收到的字节偏移（断线重连时的 ?after=）。切换会话时重置。
  const lastOffsetRef = useRef<number | null>(null);
  // 鉴权失效（401）回调：由调用方决定提示（本 hook 只管停止重连，避免 401 风暴）。
  const onAuthLostRef = useRef<(() => void) | null>(null);
  onAuthLostRef.current = onAuthLost ?? null;

  // Demo mode has no backend to stream from — the toggle stays visibly off.
  // 先连后加载：主机未就绪（连接中）不建 SSE（EventSource 不能带自定义头，走 ?host=）。
  const enabled = !DEMO && getHostReady() && autoRefresh && !!sessionId && !viewingChildAgent;

  useEffect(() => {
    if (!enabled) {
      setStatus('off');
      return;
    }
    setStatus('connecting');
    lastOffsetRef.current = null;
    let disposed = false;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const appendMessages = (payload: {
      messages?: SessionMessage[];
      session?: Partial<SessionMeta>;
    }) => {
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
      // 去重：重连补发可能与已缓存消息重叠（例如补拉边界重叠），按 id 过滤已存在项。
      queryClient.setQueryData<SessionDetail>(['session', platform, sessionId], (old) => {
        if (!old) return old;
        const seen = new Set(old.messages.map((m) => m.id));
        const fresh = newMsgs.filter((m) => !seen.has(m.id));
        return {
          session: { ...old.session, ...(payload.session || {}) },
          messages: fresh.length > 0 ? [...old.messages, ...fresh] : old.messages,
        };
      });
      onNewRef.current(newMsgs.length);
      // Refresh sidebar counters (legacy loadSessions(true) on newMessages)
      queryClient.invalidateQueries({ queryKey: ['sessions', platform] });
      // 聚合列表（恒走 GET /api/sessions）同样失效重拉，即时反映新消息（不依赖 5s 轮询）。
      queryClient.invalidateQueries({ queryKey: ['sessions', 'multi'] });
    };

    // 本机鉴权（C-1）：EventSource 拿不到 HTTP 状态码，只能靠读流前的响应探测区分
    // 「断线可重连」与「401 令牌失效」（重试只会放大 401，且不会自愈）。
    // 注意 EventSource 也带不了自定义头，所以 401 只证明 **cookie** 缺失/失效；缓存令牌
    // （localStorage）可能仍然有效 → 返回 'cookie-missing' 让调用方先重新兑换 cookie。
    const probeAuth = async (): Promise<'ok' | 'cookie-missing' | 'invalid'> => {
      try {
        const res = await fetch(watchUrl({ platform, sessionId, agent: agent || undefined }), {
          method: 'GET',
          headers: { accept: 'text/event-stream' },
        });
        // 只读状态即中止（不消费流）：200 = 鉴权通过（可重连）。
        void res.body?.cancel();
        if (res.status !== 401) return 'ok';
        return cachedUiToken() ? 'cookie-missing' : 'invalid';
      } catch {
        return 'ok'; // 网络错误（服务未起）→ 按可重连处理
      }
    };

    const connect = () => {
      if (disposed) return;
      const after = lastOffsetRef.current;
      es = new EventSource(watchUrl({ platform, sessionId, agent: agent || undefined, after }));
      es.addEventListener('connected', (e) => {
        // 服务端已建立基线/续读：视为 live。若本次是重连（after 非空），补拉一次会话
        // 与列表，覆盖「偏移失效回落全量」等边界（服务端从全量基线起算时前端对账）。
        const id = parseEventId(e);
        if (id !== null) lastOffsetRef.current = id;
        setStatus('live');
        attempt = 0;
        if (after !== null) {
          queryClient.invalidateQueries({ queryKey: ['session', platform, sessionId] });
          queryClient.invalidateQueries({ queryKey: ['sessions', platform] });
          queryClient.invalidateQueries({ queryKey: ['sessions', 'multi'] });
        }
      });
      es.addEventListener('newMessages', (e) => {
        const id = parseEventId(e);
        if (id !== null) lastOffsetRef.current = id;
        appendMessages(JSON.parse((e as MessageEvent).data || '{}'));
      });
      es.addEventListener('error', () => {
        // EventSource 自带重连会丢掉断线期间的消息（无 after 语义）→ 主动重建：
        // 关闭旧连接，按指数退避（1s→15s 上限）重连，携带最后偏移续读。
        setStatus('error');
        if (es) {
          es.close();
          es = null;
        }
        if (disposed) return;
        const delay = Math.min(1000 * 2 ** attempt, 15000);
        attempt += 1;
        retryTimer = setTimeout(() => {
          void probeAuth().then((result) => {
            if (disposed) return;
            if (result === 'cookie-missing') {
              // cookie 丢了但缓存令牌还在：走一次公开兑换端点重设 cookie 后回到原页面
              // （不清缓存——它仍是唯一可用凭据，清了会把「SSE 断流」升级成整站 401）。
              const token = cachedUiToken();
              if (!token) return;
              window.location.assign(
                `/?token=${encodeURIComponent(token)}&next=${encodeURIComponent(location.pathname + location.search)}`
              );
              return;
            }
            if (result === 'invalid') {
              // 无任何可用凭据（cookie 与缓存都失效）→ 停止重连并提示重新打开页面。
              setStatus('error');
              onAuthLostRef.current?.();
              return;
            }
            connect();
          });
        }, delay);
      });
    };

    connect();
    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (es) es.close();
      setStatus('off');
    };
  }, [enabled, platform, sessionId, agent, queryClient]);

  return status;
}
