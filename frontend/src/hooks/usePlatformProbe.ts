// Probe every platform's session count once per page load (legacy
// probePlatformSessionCounts): 0 or unreachable = known empty. Consumed by
// PlatformBar (collapse + first-launch auto-pick, #13) and SessionsView
// (all-empty guided state).

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getAgents, getSessions } from '@/api/client';
import type { Platform } from '@/api/types';
import { dirForPlatform, selectablePlatformIds, useAppStore } from '@/store';

export function usePlatformProbe() {
  const settings = useAppStore((s) => s.settings);
  // 只探测可查询平台（非 broken），自定义平台同样进首启自动挑选候选。
  // 注意：派生数组在组件内 useMemo（依赖 store 的平台列表引用），避免 zustand
  // selector 每渲染返回新引用导致无限重渲染。
  const platforms = useAppStore((s) => s.platforms);
  const platformIds = useMemo(() => selectablePlatformIds(platforms), [platforms]);
  return useQuery({
    queryKey: ['platform-probe', platformIds, settings],
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const entries = await Promise.all(
        platformIds.map(async (p) => {
          try {
            const list =
              p === 'openclaw'
                ? await getAgents(settings.openclawDir || undefined)
                : await getSessions(p, { dir: dirForPlatform(settings, p) || undefined });
            return [p, Array.isArray(list) ? list.length : 0] as const;
          } catch {
            return [p, 0] as const; // unreachable = treat as empty
          }
        })
      );
      return Object.fromEntries(entries) as Record<Platform, number>;
    },
  });
}
