// Shared TanStack Query option builders for the sessions view. CmdkDialog
// reuses these with queryClient.fetchQuery so jump-to-session shares the cache.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchPlatforms, getSessionDetail, getSessions, getSessionsAll } from '@/api/client';
import type { Platform, SessionDetail, SessionSummary } from '@/api/types';
import { DEMO } from '@/demo/flag';
import { useHostGate } from '@/hooks/useHostGate';
import {
  FALLBACK_PLATFORM_INFOS,
  useAppStore,
} from '@/store';

/** 平台列表查询：拉取 GET /api/platforms 并写入 store（含 broken）。展示侧从
 *  store.platforms 读取派生；拉取失败时 store 保持内置降级表并记录错误信息。 */
export function usePlatforms() {
  const setPlatforms = useAppStore((s) => s.setPlatforms);
  const hostReady = useHostGate(); // 先连后加载：主机未就绪（连接中）不拉平台表
  const query = useQuery({
    queryKey: ['platforms'] as const,
    // 平台列表通常跨请求不变（增删需重启 server），页面内不重复拉取。
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    enabled: !DEMO && hostReady,
    queryFn: async () => {
      const data = await fetchPlatforms();
      setPlatforms(data);
      return data;
    },
  });
  // TanStack v5 已移除 useQuery 的 onError 回调，经 effect 把失败写入 store。
  useEffect(() => {
    if (query.isError) setPlatforms(FALLBACK_PLATFORM_INFOS, (query.error as Error).message);
  }, [query.isError, query.error, setPlatforms]);
  return query;
}

export interface ListScope {
  platform: Platform;
  agent: string;
}

export function sessionsListOptions(scope: ListScope) {
  const { platform, agent } = scope;
  return {
    // Prefix ['sessions', platform] per contract; agent affects the result set.
    // needsAgent 平台的 agent 空串 = 该平台全部 agents 的合并会话（后端通用路由处理）。
    queryKey: ['sessions', platform, agent] as const,
    queryFn: (): Promise<SessionSummary[]> =>
      getSessions(platform, {
        agent: agent || undefined,
      }),
    enabled: true,
  };
}

/** 聚合视图查询：GET /api/sessions 无 platform → 读服务端 ui.selectedPlatforms
 *  （空 → 全部），铺平为带来源标记的 SessionSummary[]。后端配置驱动。 */
export function sessionsAllListOptions() {
  return {
    // 后端配置驱动：GET /api/sessions 无 platform → 读配置 selectedPlatforms（空 → 全部）。
    queryKey: ['sessions', 'multi', 'config'] as const,
    queryFn: async (): Promise<SessionSummary[]> => {
      const result = await getSessionsAll();
      const flat: SessionSummary[] = [];
      for (const block of result.platforms) {
        for (const session of block.sessions) {
          flat.push({ ...session, platform: block.platform, agent: block.agent ?? undefined });
        }
      }
      return flat;
    },
  };
}

export function useSessionsList(): UseQueryResult<SessionSummary[]> {
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const platformsLoaded = useAppStore((s) => s.platformsLoaded);
  // 列表恒走聚合接口（后端配置驱动）；platform/selectedPlatforms 由侧栏 UI 与
  // 详情聚焦订阅（见 store），不再决定列表取数。
  const listOptions = sessionsAllListOptions();
  return useQuery<SessionSummary[]>({
    ...listOptions,
    // 平台列表未加载（store 仍是 FALLBACK 全挂载表）时禁用：避免在 setPlatforms
    // 收敛前误打已禁用平台的 sessions 接口。
    enabled: platformsLoaded,
    // Legacy restartRefreshLoop: poll the list every 5s while auto-refresh is on
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

export function sessionDetailOptions(scope: {
  platform: Platform;
  sessionId: string;
  agent: string;
}) {
  const { platform, sessionId, agent } = scope;
  return {
    queryKey: ['session', platform, sessionId] as const,
    queryFn: (): Promise<SessionDetail> =>
      getSessionDetail(platform, sessionId, {
        agent: agent || undefined,
      }),
    enabled: !!sessionId,
  };
}

/** Parent-session detail (summary always shows the parent, even while viewing a child).
 *  用详情上下文（detailPlatform/detailAgent）加载，不依赖筛选上下文。 */
export function useSessionDetail() {
  const detailPlatform = useAppStore((s) => s.detailPlatform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const detailAgent = useAppStore((s) => s.detailAgent);
  return useQuery(sessionDetailOptions({ platform: detailPlatform, sessionId, agent: detailAgent }));
}
