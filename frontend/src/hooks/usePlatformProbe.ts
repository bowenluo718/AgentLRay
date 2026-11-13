// Probe 当前视图选中平台的会话计数（legacy probePlatformSessionCounts）：
// 0 或不可达 = 已知空。被 SessionsView（all-empty 引导态）消费。
// 列表已恒走聚合接口（useSessionsList，后端配置驱动），此处从共享聚合缓存派生
// 各平台计数，不再逐平台调用 /api/:platform/sessions（消除多余单平台列表请求）。

import { useMemo } from 'react';
import { useSessionsList } from '@/views/sessions/queries';
import type { Platform } from '@/api/types';

export function usePlatformProbe() {
  // 复用聚合列表共享缓存：useSessionsList 铺平每条会话并带 platform 来源，
  // 由后端 selectedPlatforms 配置驱动（空 → 全部），零额外网络请求。
  const sessionsQuery = useSessionsList();
  const counts = useMemo<Record<Platform, number> | undefined>(() => {
    const data = sessionsQuery.data;
    if (!data) return undefined;
    const map: Record<Platform, number> = {};
    for (const s of data) {
      if (!s.platform) continue;
      map[s.platform] = (map[s.platform] ?? 0) + 1;
    }
    return map;
  }, [sessionsQuery.data]);
  // 保留 UseQueryResult 的形状（isLoading/isError 等），仅把 data 替换为计数表。
  return { ...sessionsQuery, data: counts };
}
