// Shared TanStack Query option builders for the sessions view. CmdkDialog
// reuses these with queryClient.fetchQuery so jump-to-session shares the cache.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { useEffect } from 'react';
import { fetchPlatforms, getSessionDetail, getSessions, getSessionsAll } from '@/api/client';
import type { DirSettings } from '@/api/client';
import type { Platform, SessionDetail, SessionSummary } from '@/api/types';
import { DEMO } from '@/demo/flag';
import {
  FALLBACK_PLATFORM_INFOS,
  dirBySettingKey,
  dirsByParam,
  platformInfoById,
  selectablePlatformIds,
  useAppStore,
} from '@/store';

/** 平台列表查询：拉取 GET /api/platforms 并写入 store（含 broken）。展示侧从
 *  store.platforms 读取派生；拉取失败时 store 保持内置降级表并记录错误信息。 */
export function usePlatforms() {
  const setPlatforms = useAppStore((s) => s.setPlatforms);
  const query = useQuery({
    queryKey: ['platforms'] as const,
    // 平台列表通常跨请求不变（增删需重启 server），页面内不重复拉取。
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    enabled: !DEMO,
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
  settings: DirSettings;
}

export function sessionsListOptions(scope: ListScope) {
  const { platform, agent, settings } = scope;
  // 目录值 = 该平台 dirSettingKey 对应的设置（无 dirSettingKey 平台取适配器 defaultDir）。
  const dir = dirBySettingKey(settings, platformInfoById(useAppStore.getState().platforms, platform)) || undefined;
  return {
    // Prefix ['sessions', platform] per contract; agent affects the result set.
    // needsAgent 平台的 agent 空串 = 该平台全部 agents 的合并会话（后端通用路由处理）。
    queryKey: ['sessions', platform, agent] as const,
    queryFn: (): Promise<SessionSummary[]> =>
      getSessions(platform, {
        agent: agent || undefined,
        dir,
      }),
    enabled: true,
  };
}

/** 聚合视图查询：GET /api/sessions?platform=<子集，全选时 all>，铺平为带来源标记的 SessionSummary[]。 */
export function sessionsAllListOptions(scope: {
  platformIds: Platform[];
  settings: DirSettings;
  /** 运行时可查询平台数（store 派生），用于「全选 → platform=all」判定。 */
  selectableCount: number;
}) {
  const { platformIds, settings, selectableCount } = scope;
  // 「全部」判定：选择数与运行时可查询平台数一致 → 交给后端 platform=all
  // （含 needsAgent 平台 per-agent 展开）；否则按所选子集逗号拼接。
  const all = platformIds.length > 0 && platformIds.length >= selectableCount;
  return {
    queryKey: ['sessions', 'multi', all ? 'all' : [...platformIds].sort().join(':')] as const,
    queryFn: async (): Promise<SessionSummary[]> => {
      // 目录覆盖按各平台 dirParam 组装（store 平台列表为运行时真源）。
      const dirsByPlatform = dirsByParam(settings, useAppStore.getState().platforms);
      const result = await getSessionsAll({ platforms: all ? [] : platformIds, dirsByPlatform });
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
  const platform = useAppStore((s) => s.platform);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
  const agent = useAppStore((s) => s.selectedAgent);
  const settings = useAppStore((s) => s.settings);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const selectableCount = useAppStore((s) => selectablePlatformIds(s.platforms).length);
  const listOptions =
    selectedPlatforms.length > 0
      ? sessionsAllListOptions({ platformIds: selectedPlatforms, settings, selectableCount })
      : sessionsListOptions({ platform, agent, settings });
  return useQuery<SessionSummary[]>({
    ...listOptions,
    // Legacy restartRefreshLoop: poll the list every 5s while auto-refresh is on
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

export function sessionDetailOptions(scope: {
  platform: Platform;
  sessionId: string;
  agent: string;
  settings: DirSettings;
}) {
  const { platform, sessionId, agent, settings } = scope;
  const dir =
    dirBySettingKey(settings, platformInfoById(useAppStore.getState().platforms, platform)) || undefined;
  return {
    queryKey: ['session', platform, sessionId] as const,
    queryFn: (): Promise<SessionDetail> =>
      getSessionDetail(platform, sessionId, {
        agent: agent || undefined,
        dir,
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
  const settings = useAppStore((s) => s.settings);
  return useQuery(sessionDetailOptions({ platform: detailPlatform, sessionId, agent: detailAgent, settings }));
}
