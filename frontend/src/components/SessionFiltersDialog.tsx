// 会话筛选配置弹框：平台多选、分组模式、项目筛选、OpenClaw agent、归档/自动
// 刷新等开关。侧栏默认只显示文本过滤与会话列表，全部筛选/分组配置收进此弹框。

import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { getAgents } from '@/api/client';
import type { Platform } from '@/api/types';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { brokenPlatforms, dirBySettingKey, platformInfoById, selectablePlatforms, useAppStore } from '@/store';
import type { GroupBy } from '@/store';
import { buildProjectOptions, resolveProjectValues } from '@/views/sessions/lib';
import { useSessionsList } from '@/views/sessions/queries';

const chipBase =
  'shrink-0 rounded border px-1.5 py-0.5 text-[10px] transition-colors disabled:cursor-not-allowed disabled:opacity-40';
const chipActive = 'border-primary/60 bg-primary/15 text-foreground';
const chipIdle = 'border-border bg-transparent text-muted-foreground hover:border-primary/40 hover:text-foreground';

const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: 'platform', label: '按平台' },
  { value: 'project', label: '按项目' },
  { value: 'none', label: '不分组' },
];

// 项目选项默认显示条数，超出折叠成「+N」。
const PROJECT_VISIBLE = 8;

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <label className="text-[11px] font-medium text-muted-foreground">{children}</label>;
}

function ToggleRow({
  label,
  title,
  checked,
  onChange,
}: {
  label: string;
  title: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[12px] text-muted-foreground" title={title}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange(v === true)} className="h-4 w-4" />
      {label}
    </label>
  );
}

/** 平台筛选：全部 + 多选。空白态默认全部平台。运行时列表（服务端顺序），
 *  broken 平台不进入可选项，单独以徽标 + 错误列出（不可交互启停）。 */
function PlatformNav() {
  const platform = useAppStore((s) => s.platform);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
  const setPlatform = useAppStore((s) => s.setPlatform);
  const togglePlatform = useAppStore((s) => s.togglePlatform);
  const selectAllPlatforms = useAppStore((s) => s.selectAllPlatforms);
  const platforms = useAppStore((s) => s.platforms);
  const selectable = selectablePlatforms(platforms);
  const broken = brokenPlatforms(platforms);
  const multi = selectedPlatforms.length > 0;
  const allSelected = multi && selectedPlatforms.length === selectable.length;
  const active = (p: Platform) => (multi ? selectedPlatforms.includes(p) : p === platform);
  return (
    <div className="space-y-1.5">
      <SectionLabel>平台</SectionLabel>
      <div className="flex flex-wrap items-center gap-1">
        <button
          type="button"
          aria-pressed={allSelected}
          onClick={() => (allSelected ? setPlatform(platform) : selectAllPlatforms())}
          title="同时选中全部平台的会话列表（全部 / 取消多选退回单平台）"
          className={cn(chipBase, allSelected ? chipActive : chipIdle)}
        >
          全部
        </button>
        {selectable.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-pressed={active(p.id)}
            onClick={() => togglePlatform(p.id)}
            title={p.dirSettingHint ?? `${p.label ?? p.id} 会话`}
            className={cn(chipBase, active(p.id) ? chipActive : chipIdle)}
          >
            {p.label ?? p.id}
          </button>
        ))}
      </div>
      {broken.length > 0 ? (
        <div className="space-y-1 rounded border border-dashed border-amber-500/40 bg-amber-500/5 px-2 py-1.5" data-testid="broken-platforms">
          <SectionLabel>异常平台（加载失败，不可查询）</SectionLabel>
          {broken.map((b) => (
            <div
              key={b.id ?? 'unknown'}
              className="flex items-start gap-1.5 text-[11px]"
              title={b.error ?? '适配器加载失败'}
            >
              <span
                className="shrink-0 rounded border border-amber-500/50 bg-amber-500/10 px-1 py-px text-[10px] font-medium text-amber-500"
                data-testid="broken-platform-badge"
              >
                ⚠ {b.id ?? '未知'}
              </span>
              <span className="break-all text-muted-foreground">{b.error ?? '加载失败'}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 分组模式：按平台 / 按项目 / 不分组。单选平台时按平台分组无意义，禁用。 */
function GroupByNav() {
  const groupBy = useAppStore((s) => s.groupBy);
  const setGroupBy = useAppStore((s) => s.setGroupBy);
  const multi = useAppStore((s) => s.selectedPlatforms.length > 0);
  return (
    <div className="space-y-1.5">
      <SectionLabel>分组</SectionLabel>
      <div className="flex flex-wrap items-center gap-1">
        {GROUP_OPTIONS.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={groupBy === o.value && !(o.value === 'platform' && !multi)}
            disabled={o.value === 'platform' && !multi}
            title={o.value === 'platform' && !multi ? '单选平台视图下按平台分组无意义，已禁用' : undefined}
            onClick={() => setGroupBy(o.value)}
            className={cn(chipBase, groupBy === o.value && !(o.value === 'platform' && !multi) ? chipActive : chipIdle)}
          >
            {o.label}
          </button>
        ))}
      </div>
      <p className="text-[10px] leading-4 text-muted-foreground/70">
        组内按状态 + 最后更新时间排序；状态头与分组头均可点击折叠，状态头以缩进区分层级。
      </p>
    </div>
  );
}

/** 项目筛选：多选 + 「全部项目」重置；选项从当前平台已加载数据动态收集。 */
function ProjectFilterNav() {
  const projectFilter = useAppStore((s) => s.projectFilter);
  const toggleProjectFilter = useAppStore((s) => s.toggleProjectFilter);
  const clearProjectFilter = useAppStore((s) => s.clearProjectFilter);
  const { data } = useSessionsList();
  const raw = data ?? [];
  const projectValues = useMemo(() => resolveProjectValues(raw), [raw]);
  const options = useMemo(() => buildProjectOptions(projectValues, raw), [projectValues, raw]);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? options : options.slice(0, PROJECT_VISIBLE);
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>项目</SectionLabel>
        {projectFilter.length > 0 ? (
          <button
            type="button"
            onClick={clearProjectFilter}
            className="text-[10px] text-muted-foreground hover:text-foreground"
            title="清空项目筛选，显示全部项目"
          >
            全部项目
          </button>
        ) : null}
      </div>
      {options.length === 0 ? (
        <div className="text-[10px] text-muted-foreground/70">当前平台无 cwd 数据</div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {visible.map((o) => {
            const selected = projectFilter.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={selected}
                onClick={() => toggleProjectFilter(o.value)}
                title={o.value}
                className={cn(chipBase, 'flex items-center gap-1', selected ? chipActive : chipIdle)}
              >
                <span className="max-w-[10rem] truncate">{o.value}</span>
                <span className="text-[9px] opacity-60">{o.count}</span>
              </button>
            );
          })}
          {!expanded && options.length > PROJECT_VISIBLE ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className={cn(chipBase, chipIdle)}
              title="展开全部项目"
            >
              +{options.length - PROJECT_VISIBLE}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

// needsAgent 平台详情按 agent 存放（openclaw：~/.openclaw/agents/<name>/sessions）。
function AgentNav() {
  const platform = useAppStore((s) => s.platform);
  const platforms = useAppStore((s) => s.platforms);
  const settings = useAppStore((s) => s.settings);
  const selectedAgent = useAppStore((s) => s.selectedAgent);
  const setSelectedAgent = useAppStore((s) => s.setSelectedAgent);
  const info = platformInfoById(platforms, platform);
  const { data: agents } = useQuery({
    queryKey: ['agents', platform, dirBySettingKey(settings, info)],
    queryFn: () => getAgents(platform, dirBySettingKey(settings, info) || undefined),
  });

  // 空 selectedAgent = 全部 agent 的合并会话（默认）。Radix SelectItem 不接受空串，
  // 用哨兵值承载"全部 agent"选项。
  const ALL = '__all__';
  const selected = selectedAgent || ALL;

  if (!agents?.length) {
    return (
      <div className="text-[11px] text-muted-foreground">
        未检测到 {info?.label ?? platform} agent（会话目录下无 agent 或目录不存在）
      </div>
    );
  }
  return (
    <Select value={selected} onValueChange={(v) => setSelectedAgent(v === ALL ? '' : v)}>
      <SelectTrigger className="h-8 text-xs" title={`选择要浏览哪个 agent 的会话（默认全部 agent）`}>
        <SelectValue placeholder="选择 agent" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL} className="text-xs">
          全部 agent
        </SelectItem>
        {agents.map((agent) => (
          <SelectItem key={agent} value={agent} className="text-xs">
            {agent}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function SessionFiltersDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const platform = useAppStore((s) => s.platform);
  const platformList = useAppStore((s) => s.platforms);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
  const autoRefresh = useAppStore((s) => s.autoRefresh);
  const setAutoRefresh = useAppStore((s) => s.setAutoRefresh);
  const autoScroll = useAppStore((s) => s.autoScroll);
  const setAutoScroll = useAppStore((s) => s.setAutoScroll);
  // 单选 needsAgent 平台时展示 agent 下拉。
  const showAgent = platformInfoById(platformList, platform)?.capabilities.needsAgent === true && selectedPlatforms.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-y-auto md:max-h-[min(85vh,700px)] sm:max-w-lg max-md:max-w-none max-md:w-[calc(100vw-2rem)] max-md:max-h-[calc(100dvh-2rem)] max-md:rounded-2xl max-md:p-4 max-md:gap-3 max-md:grid-cols-[minmax(0,1fr)]">
        <DialogHeader>
          <DialogTitle>会话筛选与分组</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <PlatformNav />
          <div className="border-t border-border pt-3">
            <GroupByNav />
          </div>
          <div className="border-t border-border pt-3">
            <ProjectFilterNav />
          </div>
          {showAgent ? (
            <div className="space-y-1.5 border-t border-border pt-3">
              <SectionLabel>OpenClaw agent</SectionLabel>
              <AgentNav />
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-border pt-3">
            <ToggleRow
              label="Auto-refresh"
              title="每 5 秒刷新列表；当前会话通过 SSE 实时追加"
              checked={autoRefresh}
              onChange={setAutoRefresh}
            />
            <ToggleRow
              label="Auto-scroll"
              title="新消息到达时自动滚到最新"
              checked={autoScroll}
              onChange={setAutoScroll}
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
