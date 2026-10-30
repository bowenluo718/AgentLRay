// Left sidebar（精简）：标题 + 会话文本过滤 + 会话列表。筛选/分组/agent/开关等
// 配置全部收进「会话筛选与分组」弹框（SessionFiltersDialog）与设置弹框。

import { ChevronsLeft, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import type { PointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { SessionFiltersDialog } from '@/components/SessionFiltersDialog';
import { SettingsDialog } from '@/components/SettingsDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTheme } from '@/hooks/useTheme';
import { platformLabel, useAppStore, SIDEBAR_MIN_WIDTH } from '@/store';
import { CmdkDialog } from '@/views/sessions/CmdkDialog';
import { SessionList } from '@/views/sessions/SessionList';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const platform = useAppStore((s) => s.platform);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
  const platforms = useAppStore((s) => s.platforms);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const { theme, setTheme } = useTheme();
  // 拖拽起点：记录边栏初始宽度与指针起始 x，横向位移换算宽度增量。
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterTerm, setFilterTerm] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkSeed, setCmdkSeed] = useState('');
  const multi = selectedPlatforms.length > 0;

  // Global ⌘K / Ctrl+K toggle (legacy document keydown)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCmdkSeed('');
        setCmdkOpen((open) => !open);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // 拖拽右缘调宽：pointer capture 保证移出时候仍能跟手；宽度下限由 store clamp
  //（SIDEBAR_MIN_WIDTH），超小宽度视为折叠（回到主内容）。
  const startDrag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragStart.current = { x: e.clientX, width: useAppStore.getState().sidebarWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const duringDrag = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const width = dragStart.current.width + dx;
    if (width <= SIDEBAR_MIN_WIDTH) {
      setSidebarCollapsed(true);
    } else {
      setSidebarWidth(width);
    }
  };
  const endDrag = (e: PointerEvent<HTMLDivElement>) => {
    dragStart.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  return (
    <aside
      aria-label="会话导航"
      className="relative flex min-h-0 flex-1 flex-col gap-3 overflow-hidden border-r border-border bg-panel-alt/95 p-4 pb-3"
    >
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-wide">AgentLRay</h1>
          <div className="text-xs text-muted-foreground">
            {multi ? `全部平台（${selectedPlatforms.length}）` : platformLabel(platforms, platform)} sessions
          </div>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            title="会话筛选与分组"
            aria-label="会话筛选与分组"
            onClick={() => setFiltersOpen(true)}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" title="Settings" aria-label="Settings" onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            title={theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
            aria-label={theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            className="hidden md:inline-flex"
          >
            {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </Button>
          <Button
            variant="outline"
            size="icon"
            title="折叠侧栏（或拖拽右缘调宽）"
            aria-label="折叠侧栏"
            onClick={() => setSidebarCollapsed(true)}
            className="hidden md:inline-flex"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="relative">
        <Input
          type="search"
          value={filterTerm}
          onChange={(e) => setFilterTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const q = filterTerm.trim();
              if (!q) return;
              setCmdkSeed(q);
              setCmdkOpen(true);
            }
          }}
          placeholder="输入过滤列表 · 回车全文搜索（空格分隔多关键词，全部命中才返回）"
          title="直接输入：按 ID/文件名/首条消息过滤左侧列表；按回车：打开全平台全文搜索 — 空格分隔多关键词，全部命中才返回"
          className="pr-10 text-xs"
        />
        <button
          type="button"
          onClick={() => {
            setCmdkSeed('');
            setCmdkOpen(true);
          }}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded border border-border px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
          title="全平台全局搜索（⌘K / Ctrl+K）"
        >
          ⌘K
        </button>
      </div>
      <SessionList filterTerm={filterTerm} onNavigate={onNavigate} />
      <SessionFiltersDialog open={filtersOpen} onOpenChange={setFiltersOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <CmdkDialog open={cmdkOpen} onOpenChange={setCmdkOpen} seedQuery={cmdkSeed} onNavigate={onNavigate} />
      {/* 右缘拖拽手柄：横向拖拽调宽，拖到最小宽度以下折叠。 */}
      <div
        aria-hidden
        onPointerDown={startDrag}
        onPointerMove={duringDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className="absolute inset-y-0 right-0 z-10 hidden w-1.5 cursor-col-resize touch-none select-none md:block hover:bg-primary/20"
        style={{ touchAction: 'none' }}
      />
    </aside>
  );
}
