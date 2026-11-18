// Left sidebar（精简）：标题 + 会话文本过滤 + 会话列表。筛选/分组/agent/开关等
// 配置全部收进「会话筛选与分组」弹框（SessionFiltersDialog）与设置弹框。

import { ChevronsLeft, Moon, Settings, SlidersHorizontal, Sun } from 'lucide-react';
import type { PointerEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SessionFiltersDialog } from '@/components/SessionFiltersDialog';
import { HostsDialog } from '@/components/HostsDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useTheme } from '@/hooks/useTheme';
import { useAppStore, SIDEBAR_MIN_WIDTH } from '@/store';
import { CmdkDialog } from '@/views/sessions/CmdkDialog';
import { SessionList } from '@/views/sessions/SessionList';

export function Sidebar({ onNavigate, onOpenSettings }: { onNavigate?: () => void; onOpenSettings?: () => void }) {
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setSidebarWidth = useAppStore((s) => s.setSidebarWidth);
  const { theme, setTheme } = useTheme();
  // 拖拽起点：记录边栏初始宽度与指针起始 x，横向位移换算宽度增量。
  const dragStart = useRef<{ x: number; width: number } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hostsOpen, setHostsOpen] = useState(false);
  const [filterTerm, setFilterTerm] = useState('');
  const [cmdkOpen, setCmdkOpen] = useState(false);
  const [cmdkSeed, setCmdkSeed] = useState('');

  // 主机入口（侧栏底部固定）：当前使用本地时文本「远程连接」，否则显示当前连接主机名。
  const hosts = useAppStore((s) => s.hosts);
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const disconnectHost = useAppStore((s) => s.disconnectHost);
  const inbound = useAppStore((s) => s.inbound);
  const currentHost = hosts.find((h) => h.id === selectedHostId) ?? null;
  const currentHostLabel = selectedHostId === 'local' ? null : (currentHost?.label || selectedHostId);
  const onEntryDisconnect = () => {
    if (selectedHostId === 'local') return;
    disconnectHost(selectedHostId).then((ok) => {
      if (ok) toast.success('已断开连接');
      else toast.error('断开连接失败');
    });
  };

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
      {/* 顶部栏仅桌面端显示：设置/主题/折叠按钮；移动端设置按钮与主体切换按钮一起放在全页顶栏（App.tsx）。 */}
      <div className="hidden items-center justify-between md:flex">
        <div>
          <h1 className="text-lg font-semibold tracking-wide">AgentLRay</h1>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" title="设置" aria-label="设置" onClick={onOpenSettings}>
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
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="icon"
          title="会话筛选与分组"
          aria-label="会话筛选与分组"
          onClick={() => setFiltersOpen(true)}
          className="shrink-0"
        >
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
        <div className="relative min-w-0 flex-1">
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
      </div>
      <SessionList filterTerm={filterTerm} onNavigate={onNavigate} />
      {/* 主机入口（固定在侧栏底部）：mt-auto 使其无论 SessionList 是否挂载都贴底；
          本地时「远程连接」，否则显示当前主机名 + 断开。 */}
      <div className="mt-auto flex shrink-0 items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1.5">
        <button
          type="button"
          title="主机设置"
          aria-label="主机设置"
          onClick={() => setHostsOpen(true)}
          className="flex min-w-0 flex-1 items-center gap-2 rounded px-1 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="h-4 w-4 shrink-0"
          >
            <rect x="3" y="4" width="18" height="13" rx="2"></rect>
            <path d="M8 21h8M12 17v4"></path>
          </svg>
          <span className="truncate">{currentHostLabel ?? '远程连接'}</span>
        </button>
        {selectedHostId !== 'local' ? (
          <Button
            variant="ghost"
            size="icon"
            title="断开当前远端连接"
            aria-label="断开当前远端连接"
            className="h-6 w-6 shrink-0 text-muted-foreground hover:text-destructive"
            onClick={onEntryDisconnect}
          >
            <span className="text-base leading-none">×</span>
          </Button>
        ) : inbound && inbound.count > 0 ? (
          <span
            title={`${inbound.count} 台其他主机正在连接本机`}
            className="inline-flex h-5 shrink-0 items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 text-[11px] font-medium text-sky-600 dark:text-sky-400"
          >
            <span className="h-1.5 w-1.5 rounded-full bg-sky-500" />
            {inbound.count}
          </span>
        ) : null}
      </div>
      <SessionFiltersDialog open={filtersOpen} onOpenChange={setFiltersOpen} />
      <HostsDialog open={hostsOpen} onOpenChange={setHostsOpen} />
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
