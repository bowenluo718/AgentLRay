// Shared TanStack Query option builders for the sessions view. CmdkDialog
// reuses these with queryClient.fetchQuery so jump-to-session shares the cache.

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { getSessionDetail, getSessions, getSessionsAll } from '@/api/client';
import type { DirSettings } from '@/api/client';
import { PLATFORMS } from '@/api/types';
import type { Platform, SessionDetail, SessionSummary } from '@/api/types';
import { dirForPlatform, useAppStore } from '@/store';

export interface ListScope {
  platform: Platform;
  agent: string;
  settings: DirSettings;
}

export function sessionsListOptions(scope: ListScope) {
  const { platform, agent, settings } = scope;
  return {
    // Prefix ['sessions', platform] per contract; agent affects the result set.
    // openclaw 的 agent 空串 = 该平台全部 agents 的合并会话（后端 /api/openclaw/sessions）。
    queryKey: ['sessions', platform, agent] as const,
    queryFn: (): Promise<SessionSummary[]> =>
      getSessions(platform, {
        agent: agent || undefined,
        dir: dirForPlatform(settings, platform) || undefined,
      }),
    enabled: true,
  };
}

/** 聚合视图查询：GET /api/sessions?platform=<子集，全选时 all>，铺平为带来源标记的 SessionSummary[]。 */
export function sessionsAllListOptions(scope: { platformIds: Platform[]; settings: DirSettings }) {
  const { platformIds, settings } = scope;
  const all = platformIds.length === PLATFORMS.length;
  return {
    queryKey: ['sessions', 'multi', all ? 'all' : [...platformIds].sort().join(':')] as const,
    queryFn: async (): Promise<SessionSummary[]> => {
      const result = await getSessionsAll({ platforms: platformIds, dirs: settings });
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
  const listOptions =
    selectedPlatforms.length > 0
      ? sessionsAllListOptions({ platformIds: selectedPlatforms, settings })
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
  return {
    queryKey: ['session', platform, sessionId] as const,
    queryFn: (): Promise<SessionDetail> =>
      getSessionDetail(platform, sessionId, {
        agent: agent || undefined,
        dir: dirForPlatform(settings, platform) || undefined,
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
