import { useEffect } from 'react';
import { useAppStore } from '@/store';

/**
 * 主题应用（亮/暗两态）。
 *
 * 职责：theme 变化 → 增删 <html> 的 `.dark` 类（配合 index.css 的 :root 亮 / .dark 暗）。
 * 初始主题（含首启跟随系统）由 store.loadPersisted 决定，并与 index.html 的
 * 防闪烁内联脚本保持一致；此处只管把 store 值同步到 DOM。
 */
export function useTheme() {
  const theme = useAppStore((s) => s.theme);
  const setTheme = useAppStore((s) => s.setTheme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  return { theme, setTheme };
}
