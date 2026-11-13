import { ArrowLeft, Copy, Moon, PanelLeft, Sun } from 'lucide-react';
import type { CSSProperties } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { Sidebar } from '@/components/Sidebar';
import { HostSelector } from '@/components/HostSelector';
import { HostConnectingView } from '@/components/HostConnectingView';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useTheme } from '@/hooks/useTheme';
import { useVersionPoller } from '@/hooks/useVersionPoller';
import { useInboundPoller } from '@/hooks/useInboundPoller';
import { DEMO } from '@/demo/flag';
import { getHosts, getSelectedPlatforms } from '@/api/client';
import { useAppStore } from '@/store';
import type { MainView } from '@/store';
import { usePlatforms } from '@/views/sessions/queries';
import { InsightsView } from '@/views/insights/InsightsView';
import { PromptsView } from '@/views/prompts/PromptsView';
import { SessionsView } from '@/views/sessions/SessionsView';
import { KanbanView } from '@/views/kanban/KanbanView';
import { cn } from '@/lib/utils';

const TABS: { view: MainView; label: string; title: string }[] = [
  { view: 'sessions', label: '会话', title: '浏览与回放会话：消息、工具调用、耗时与 token' },
  { view: 'insights', label: '分析', title: '聚合统计：工具调用、错误聚类、token 消耗、按日趋势' },
  { view: 'prompts', label: 'Prompts', title: '自动提取历史里所有真人 prompt：搜索、收藏、聚类分析与改写' },
  { view: 'kanban', label: '任务看板', title: '会话状态看板：按待用户输入/工作中/等待中/已停止 四列查看' },
];

export default function App() {
  usePlatforms(); // 服务端平台列表驱动（结果写入 store）
  useVersionPoller();
  useInboundPoller();
  const { theme, setTheme } = useTheme();
  const view = useAppStore((s) => s.view);
  const setView = useAppStore((s) => s.setView);
  const platform = useAppStore((state) => state.platform);
  const selectedSession = useAppStore((state) => state.selectedSessionId);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const sidebarWidth = useAppStore((s) => s.sidebarWidth);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setHosts = useAppStore((s) => s.setHosts);
  const hosts = useAppStore((s) => s.hosts);
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const rememberedHostId = useAppStore((s) => s.rememberedHostId);
  const hostReady = useAppStore((s) => s.hostReady);
  const platformsLoaded = useAppStore((s) => s.platformsLoaded);
  const applyRemoteSelection = useAppStore((s) => s.applyRemoteSelection);
  const queryClient = useQueryClient();
  const [navigationOpen, setNavigationOpen] = useState(false);
  // 刷新后重连记忆的远端主机（问题 1/2）。只跑一次：hosts 首帧拉取到位后，
  // 若记忆的是远端，重新 connectHost 以 X-Host-Id 访问其数据。不 reload（防循环）。
  const didRestoreHost = useRef(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  const navigationPanel = useRef<HTMLDivElement>(null);

  // 首帧拉取主机列表（[local, ...hosts]），写入 store；切换主机时 store 内部已负责刷新。
  useEffect(() => {
    if (DEMO) return;
    getHosts()
      .then((hosts) => setHosts(hosts))
      .catch(() => {});
  }, [setHosts]);

  // 刷新后重连记忆的远端主机（先连后加载）。hosts 首帧到位且记忆的是远端时，
  // setSelectedHostId 内部进入连接中（hostReady=false，占位不渲染数据面）、connectHost、
  // 成功后提交 + 置 hostReady=true；失败/超时回落本机。只恢复一次；不 reload（防循环）。
  useEffect(() => {
    if (DEMO || didRestoreHost.current) return;
    if (hosts.length === 0) return; // 等首帧主机列表落位
    const remembered = useAppStore.getState().rememberedHostId;
    if (remembered === 'local') return;
    didRestoreHost.current = true;
    // 记忆的主机可能已被删除 → 回落本机（hostReady 置 true，避免整页空白）。
    if (!hosts.some((h) => h.id === remembered)) {
      useAppStore.getState().setSelectedHostId('local');
      return;
    }
    const store = useAppStore.getState();
    // 进入连接中（数据面暂不可发）。
    store.setHostConnecting();
    // 前端超时兜底：20s > 后端 openHost 探测上限（5s×3）→ 不误杀「快连上」。
    // Promise.race 无法取消服务端隧道，用 settled 标志忽略迟到 resolve（隧道可能仍成）。
    const TIMEOUT_MS = 20_000;
    let settled = false;
    const settle = (hostReadyError: string | null) => {
      if (settled) return;
      settled = true;
      useAppStore.getState().setHostReadyResult(hostReadyError);
    };
    const timer = setTimeout(() => {
      store.setHostRuntime(remembered, 'disconnected', null); // 回落本机：勿标 error
      settle('连接远端超时，已回落本机');
      toast.error('连接远端超时，已回落本机');
    }, TIMEOUT_MS);
    store.setSelectedHostId(remembered).then((ok) => {
      clearTimeout(timer);
      if (!ok) {
        // 连不上远端则停留本机（选中的本地路由保持可用）。store 失败路径已置 hostReady=true。
        settle(null);
        return;
      }
      settle(null);
      // 重连成功后使平台 list 缓存失效：usePlatforms 以当前（远端）host 头重拉远端平台。
      queryClient.invalidateQueries({ queryKey: ['platforms'] });
    });
  }, [hosts, queryClient]);

  // 远端下筛选（平台/项目）数据与选中值来自远端 server ui（只读）。远端恢复/切换
  // 后、平台列表就绪时读取一次 GET /api/ui-selection（跟随远端 host 头透传 → 远端
  // ui），应用其选中值。不落本机持久化（applyRemoteSelection 只写前端状态）。
  useEffect(() => {
    if (DEMO || selectedHostId === 'local') return;
    if (!platformsLoaded) return;
    let cancelled = false;
    getSelectedPlatforms()
      .then((sel) => {
        if (cancelled) return;
        applyRemoteSelection({
          platform: 'openclaw', // 与远端 server ui 缺省对齐；applyRemoteSelection 收敛到有效平台
          selectedPlatforms: sel?.selectedPlatforms ?? [],
        });
      })
      .catch(() => {
        /* 远端 ui 读取失败：保持当前选择，不阻断 */
      });
    return () => {
      cancelled = true;
    };
  }, [selectedHostId, platformsLoaded, applyRemoteSelection]);
  const returnToContent = useCallback(() => {
    setNavigationOpen(false);
    if (window.matchMedia('(max-width: 767px)').matches) {
      requestAnimationFrame(() => navigationToggle.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (navigationOpen && window.matchMedia('(max-width: 767px)').matches) {
      navigationPanel.current?.querySelector<HTMLInputElement>('input[type="search"]')?.focus();
    }
  }, [navigationOpen]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 768px)');
    const onResize = () => {
      setNavigationOpen(false);
      if (!media.matches && navigationPanel.current?.contains(document.activeElement)) {
        requestAnimationFrame(() => navigationToggle.current?.focus());
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !media.matches && navigationOpen &&
        !(event.target as HTMLElement).closest('[role="dialog"]')) {
        event.preventDefault();
        returnToContent();
      }
    };
    media.addEventListener('change', onResize);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      media.removeEventListener('change', onResize);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [navigationOpen, returnToContent]);

  // 先连后加载：记忆的是远端且尚未就绪（连接中/刚回落前）→ 渲染连接占位，
  // 不渲染任何数据面（组件树不挂载，天然不发数据面请求）。本机（hostReady 初始 true）
  // 或 DEMO 不命中。失败回落本机后 hostReady=true，占位自动消失。
  if (!hostReady && rememberedHostId !== 'local') {
    return (
      <TooltipProvider delayDuration={300}>
        <div className="flex h-full flex-col overflow-hidden">
          <HostConnectingView hostId={rememberedHostId} />
        </div>
      </TooltipProvider>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col overflow-hidden">
        {DEMO ? (
          <div className="flex max-h-[24dvh] shrink-0 flex-wrap items-center justify-center gap-2 overflow-y-auto border-b border-[#e3b341]/40 bg-[#e3b341]/15 px-3 py-1.5 text-center text-xs text-[#e3b341] md:max-h-none [@media(max-height:500px)]:max-h-10">
            <span>🧪 Demo — synthetic data, not real sessions.</span>
            <button type="button"
              className="min-h-9 rounded border border-[#e3b341]/60 bg-foreground/10 px-2 py-1 font-medium hover:bg-foreground/20"
              onClick={() => {
                const store = useAppStore.getState();
                store.setPlatform('omp');
                store.setSelectedSessionId('0199demo-diagnostics');
                store.setSessionView('messages');
                store.setView('sessions');
                returnToContent();
              }}>
              体验自动体检 / Try diagnostics
            </button>
            <button
              type="button"
              title="Copy install command"
              onClick={() => {
                navigator.clipboard?.writeText('npx @bowenluo718/agent-lray').then(
                  () => toast.success('Copied: npx @bowenluo718/agent-lray'),
                  () => toast.error('Copy failed')
                );
              }}
              className="inline-flex items-center gap-1 rounded border border-[#e3b341]/50 bg-foreground/10 px-1.5 py-0.5 font-mono text-[11px] hover:border-[#e3b341] hover:text-foreground"
            >
              npx @bowenluo718/agent-lray
              <Copy className="h-3 w-3" />
            </button>
            <a
              href="https://github.com/bowenluo718/AgentLRay"
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              GitHub
            </a>
            {platform === 'omp' && selectedSession === '0199demo-diagnostics' && view === 'sessions' ? (
              <details className="w-full max-w-3xl text-left leading-5" data-testid="diagnostics-demo-guide">
                <summary className="cursor-pointer text-center">演示步骤 / Guide: 7 failure records → 2 events</summary>
                <p>自动整理重复失败、后续候选和调用结果缺口，无需人工标注。6 次同参 edit 失败 + 1 次搜索失败；早先测试通过只恢复那次测试，不验证后续修改。</p>
                <p>Inspect the automatic facts and original evidence. Human notes are optional and never change the automatic result. This static sample does not append live results.</p>
                <a href="https://github.com/bowenluo718/AgentLRay/blob/master/docs/diagnostics.md" target="_blank" rel="noreferrer"
                  className="underline underline-offset-2">本机使用与判定边界 / Local walkthrough and limits</a>
              </details>
            ) : null}
          </div>
        ) : null}
        <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-1 md:hidden">
          <span className="text-sm font-semibold">AgentLRay</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              title={theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
              aria-label={theme === 'dark' ? '切换到白天主题' : '切换到黑夜主题'}
              className="inline-flex min-h-11 items-center justify-center rounded px-2 text-muted-foreground hover:text-foreground focus-visible:outline"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <button ref={navigationToggle} type="button" aria-expanded={navigationOpen} aria-controls="session-navigation"
              className="inline-flex min-h-11 items-center gap-2 rounded px-2 text-sm text-primary focus-visible:outline"
              onClick={() => navigationOpen ? returnToContent() : setNavigationOpen(true)}>
              {navigationOpen ? <ArrowLeft className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
              {navigationOpen ? '返回内容' : '会话列表'}
            </button>
          </div>
        </div>
        <div
          className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)] md:grid-cols-[var(--sidebar-cols)]"
          style={{ '--sidebar-cols': sidebarCollapsed ? 'minmax(0,1fr)' : `${sidebarWidth}px minmax(0,1fr)` } as CSSProperties}
        >
          <div id="session-navigation" ref={navigationPanel}
            className={cn(
              'min-h-0 min-w-0 flex-col md:flex',
              navigationOpen ? 'flex' : 'hidden',
              sidebarCollapsed && 'md:hidden'
            )}>
            <Sidebar onNavigate={returnToContent} />
          </div>
          <main className={cn('min-h-0 min-w-0 flex-col overflow-hidden md:flex', navigationOpen ? 'hidden' : 'flex')}>
            <Tabs
              value={view}
              onValueChange={(v) => setView(v as MainView)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="flex shrink-0 items-center border-b border-border px-2 pt-1 md:px-4 md:pt-3">
                {sidebarCollapsed ? (
                  <button
                    type="button"
                    onClick={() => setSidebarCollapsed(false)}
                    title="展开侧栏"
                    aria-label="展开侧栏"
                    className="mr-1 hidden h-8 shrink-0 items-center rounded border border-border px-1.5 text-muted-foreground hover:text-foreground md:inline-flex"
                  >
                    <PanelLeft className="h-4 w-4" />
                  </button>
                ) : null}
                <TabsList className="h-11 overflow-x-auto bg-transparent p-0 md:h-9">
                  {TABS.map((tab) => (
                    <TabsTrigger
                      key={tab.view}
                      value={tab.view}
                      title={tab.title}
                      className="min-h-11 rounded-b-none border-b-2 border-transparent px-3 data-[state=active]:border-primary data-[state=active]:bg-transparent md:min-h-0 md:px-4"
                    >
                      {tab.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <div className="ml-auto pr-1">
                  <HostSelector />
                </div>
              </div>
              <TabsContent value="sessions" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <SessionsView />
              </TabsContent>
              <TabsContent value="insights" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <InsightsView />
              </TabsContent>
              <TabsContent value="prompts" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <PromptsView />
              </TabsContent>
              <TabsContent value="kanban" className="mt-0 min-h-0 flex-1 overflow-auto p-2 md:p-4">
                <KanbanView />
              </TabsContent>
            </Tabs>
          </main>
        </div>
      </div>
    </TooltipProvider>
  );
}
