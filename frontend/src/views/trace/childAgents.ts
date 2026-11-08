// Child-agent (capabilities.children 平台，如 omp / claude-code 派生子 agent) 数据
// hooks，TraceView / ChildAgentsSection / 会话详情（useActiveSessionDetail）共用。
// Behavior ported from public/js/app.js (childrenEndpoint/childAgentLabel/getSessionChildren)。

import { useQuery } from '@tanstack/react-query';
import type { UseQueryResult } from '@tanstack/react-query';
import { getSessionChild, getSessionChildren, getSessionDetail } from '@/api/client';
import type { ChildAgentSummary, Platform, SessionDetail } from '@/api/types';
import { dirBySettingKey, platformInfoById, useAppStore } from '@/store';

/** 该平台是否可派生子 agent（能力位 capabilities.children）。 */
export function hasChildAgents(platform: Platform, platforms: Parameters<typeof platformInfoById>[0]): boolean {
  return platformInfoById(platforms, platform)?.capabilities.children === true;
}

/** Chip/span label：带描述/类型的子 agent 展示 meta，否则只展示名称。 */
export function childAgentLabel(c: ChildAgentSummary): string {
  return c.description || c.agentType || c.name;
}

/** Subagent list of the selected session. Legacy swallows fetch errors → empty list. */
export function useChildrenQuery(): UseQueryResult<ChildAgentSummary[]> {
  const platform = useAppStore((s) => s.detailPlatform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const settings = useAppStore((s) => s.settings);
  const platforms = useAppStore((s) => s.platforms);
  const dir = dirBySettingKey(settings, platformInfoById(platforms, platform)) || undefined;
  return useQuery({
    queryKey: ['session-children', platform, sessionId],
    enabled: hasChildAgents(platform, platforms) && !!sessionId,
    queryFn: () =>
      getSessionChildren(platform, sessionId, dir).catch(() => [] as ChildAgentSummary[]),
  });
}

/** The selected (parent) session detail — same key ViewSessions uses, cache is shared. */
export function useSessionDetailQuery(): UseQueryResult<SessionDetail> {
  const platform = useAppStore((s) => s.detailPlatform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const agent = useAppStore((s) => s.detailAgent);
  const settings = useAppStore((s) => s.settings);
  const platforms = useAppStore((s) => s.platforms);
  const needsAgent = platformInfoById(platforms, platform)?.capabilities.needsAgent === true;
  const dir = dirBySettingKey(settings, platformInfoById(platforms, platform)) || undefined;
  return useQuery({
    queryKey: ['session', platform, sessionId],
    enabled: !!sessionId && (!needsAgent || !!agent),
    queryFn: () => getSessionDetail(platform, sessionId, { agent: agent || undefined, dir }),
  });
}

/** Transcript of the child agent being viewed (viewingChildAgent). */
export function useChildSessionQuery(): UseQueryResult<SessionDetail> {
  const platform = useAppStore((s) => s.detailPlatform);
  const sessionId = useAppStore((s) => s.selectedSessionId);
  const child = useAppStore((s) => s.viewingChildAgent);
  const settings = useAppStore((s) => s.settings);
  const platforms = useAppStore((s) => s.platforms);
  const dir = dirBySettingKey(settings, platformInfoById(platforms, platform)) || undefined;
  return useQuery({
    queryKey: ['session-child', platform, sessionId, child],
    enabled: hasChildAgents(platform, platforms) && !!sessionId && !!child,
    queryFn: () => getSessionChild(platform, sessionId, child as string, dir),
  });
}

/**
 * SessionDetail powering the messages/trace area: the child transcript while a
 * child agent is being viewed, otherwise the parent session (legacy swapped
 * state.sessionData in viewChildAgent).
 */
export function useActiveSessionDetail(): UseQueryResult<SessionDetail> {
  const child = useAppStore((s) => s.viewingChildAgent);
  const parentQuery = useSessionDetailQuery();
  const childQuery = useChildSessionQuery();
  return child ? childQuery : parentQuery;
}
