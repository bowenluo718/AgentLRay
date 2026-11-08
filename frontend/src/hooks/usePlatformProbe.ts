// Probe every platform's session count once per page load (legacy
// probePlatformSessionCounts): 0 or unreachable = known empty. Consumed by
// PlatformBar (collapse + first-launch auto-pick, #13) and SessionsView
// (all-empty guided state).

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getSessions } from '@/api/client';
import type { Platform } from '@/api/types';
import { dirBySettingKey, platformInfoById, selectablePlatformIds, useAppStore } from '@/store';

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
            // 统一走通用列表路由；needsAgent 平台缺省 agent = 全部 agent 合并会话，
            // 探测只关心是否有会话，无需枚举 agent。
            const dir = dirBySettingKey(settings, platformInfoById(platforms, p)) || undefined;
            const list = await getSessions(p, { dir });
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
