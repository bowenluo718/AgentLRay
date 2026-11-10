import { useEffect } from 'react';
import { getSettings, saveSettings } from '@/api/client';
import { DEMO } from '@/demo/flag';
import { clearLegacyDirsFromLocalStorage, readLegacyDirsFromLocalStorage } from '@/store';

/**
 * Q13 一次性迁移：把旧版 localStorage 里的数据目录（openclawDir/codexDir/…）上传到
 * 服务端 settings.json 的 dirs section（目录真源迁移到服务端，见 design 文档 §4）。
 *
 * 触发点 = App 挂载（不依赖用户打开设置面板，保证用户在旧版配过的目录在服务端
 * 真源化后仍生效）。幂等：服务端已配置的键不覆盖（对比 GET /api/settings 的 dirs
 * section 的 configured），迁移成功后清除 localStorage 残留目录键。
 */
export function useDirsMigration(): void {
  useEffect(() => {
    if (DEMO) return;
    let cancelled = false;
    (async () => {
      const legacy = readLegacyDirsFromLocalStorage();
      const keys = Object.keys(legacy);
      if (keys.length === 0) return;
      let settings;
      try {
        settings = await getSettings();
      } catch {
        return; // 读不到服务端设置：静默，下次挂载再试（幂等）
      }
      // 只上传服务端尚未显式配置的键（dirs section key = dirSettingKey，与 legacy 键同形）。
      // dirs 是以平台 id 为键的 Record，元素含 undefined → 显式遍历 entries 收窄。
      const configuredKey: Record<string, true> = {};
      for (const entry of Object.values(settings.dirs ?? {})) {
        if (entry && entry.key && entry.configured) configuredKey[entry.key] = true;
      }
      const toUpload: Record<string, string> = {};
      for (const key of keys) {
        if (!configuredKey[key]) toUpload[key] = legacy[key];
      }
      if (cancelled) return;
      if (Object.keys(toUpload).length > 0) {
        try {
          await saveSettings({ dirs: toUpload });
        } catch {
          return; // 上传失败：保留 localStorage，下次重试
        }
      }
      if (!cancelled) clearLegacyDirsFromLocalStorage();
    })();
    return () => {
      cancelled = true;
    };
  }, []);
}
