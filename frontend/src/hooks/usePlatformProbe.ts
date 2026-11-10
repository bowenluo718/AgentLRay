// Probe 当前视图选中平台的会话计数（legacy probePlatformSessionCounts）：
// 0 或不可达 = 已知空。被 SessionsView（all-empty 引导态）消费。
// 只探测「当前筛选/单选选中的已挂载平台」——未选中或服务端禁用的平台绝不发请求。

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { getSessions } from '@/api/client';
import type { Platform } from '@/api/types';
import { selectablePlatformIds, useAppStore } from '@/store';

export function usePlatformProbe() {
  const platforms = useAppStore((s) => s.platforms);
  const platform = useAppStore((s) => s.platform);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
  const platformsLoaded = useAppStore((s) => s.platformsLoaded);
  // 探测范围 = 当前选中平台（多选=选中集合，单选=[platform]），且仅限已挂载。
  // 平台列表未加载（store 仍是 FALLBACK 全挂载表）时返回空 → 查询不启用，
  // 避免在 setPlatforms 收敛前误探服务端已禁用（disabled）的平台。
  const platformIds = useMemo(() => {
    if (!platformsLoaded) return [] as string[];
    const mountedIds = new Set(selectablePlatformIds(platforms));
    const scope = selectedPlatforms.length > 0 ? selectedPlatforms : [platform];
    return scope.filter((p) => mountedIds.has(p));
  }, [platforms, platformsLoaded, selectedPlatforms, platform]);
  return useQuery({
    queryKey: ['platform-probe', platformIds],
    staleTime: Number.POSITIVE_INFINITY,
    enabled: platformIds.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        platformIds.map(async (p) => {
          try {
            // 统一走通用列表路由；needsAgent 平台缺省 agent = 全部 agent 合并会话，
            // 探测只关心是否有会话，无需枚举 agent。
            const list = await getSessions(p);
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
