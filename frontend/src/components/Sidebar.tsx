// Left sidebar（精简）：标题 + 会话文本过滤 + 会话列表。筛选/分组/agent/开关等
// 配置全部收进「会话筛选与分组」弹框（SessionFiltersDialog）与设置弹框。

import { Settings, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PLATFORM_LABELS } from '@/api/types';
import { SessionFiltersDialog } from '@/components/SessionFiltersDialog';
import { SettingsDialog } from '@/components/SettingsDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useAppStore } from '@/store';
import { CmdkDialog } from '@/views/sessions/CmdkDialog';
import { SessionList } from '@/views/sessions/SessionList';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const platform = useAppStore((s) => s.platform);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
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

  return (
    <aside aria-label="会话导航" className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden border-r border-border bg-panel-alt/95 p-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-wide">AgentLRay</h1>
          <div className="text-xs text-muted-foreground">
            {multi ? `全部平台（${selectedPlatforms.length}）` : PLATFORM_LABELS[platform]} sessions
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
    </aside>
  );
}
