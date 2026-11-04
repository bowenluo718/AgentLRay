// 看板「新建任务」弹窗：为可新建平台（create===true）触发一次会话新建。
// - 数据源：平台列表取 store.platforms（由 App.tsx 的全局 usePlatforms() 维护，
//   运行时 GET /api/platforms 单一真源，拉取失败回退内置表）；下拉可选项 = 设置文件
//   （ui-settings.json）中「已选择平台」即左侧会话筛选选中的平台（多选
//   selectedPlatforms / 单平台 platform，仅取运行时有效条目），与设置保持一致；
//   可新建的平台可选，不可新建的平台（如 openclaw/dsh）列出但禁用（不标注
//   「不支持新建」）。默认平台/路径由 KanbanView
//   传入（当前选中会话的平台 + 项目路径，或当前筛选平台）。
// - 命令串与 spawn 逻辑单一真源在后端 POST /api/:platform/sessions/new（lib/new.js），
//   前端不本地拼命令，只消费后端返回（command 供成功提示手动复制）。
// - 提交成功 → toast + 关弹窗 + 失效会话列表缓存（invalidate ['sessions']）；
//   失败 → 弹窗内错误文本、保持打开；pending 期间禁用提交按钮。
// - cwd：ProjectCombobox 可手动输入，也可下拉选择「已识别项目」（数据与左侧会话筛选
//   的项目一致，剔除「未知项目」占位）；平台 / cwd / 提示词三者必填，提交前做必填
//   校验并按字段展示错误。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronsUpDown, Folder } from 'lucide-react';
import { toast } from 'sonner';
import { createSession } from '@/api/client';
import type { Platform } from '@/api/types';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { createCapablePlatforms, selectablePlatforms, useAppStore } from '@/store';
import { UNKNOWN_PROJECT, buildProjectOptions, resolveProjectValues } from '@/views/sessions/lib';
import { useSessionsList } from '@/views/sessions/queries';

// cwd 下拉：可手动输入，也可从「已识别项目」下拉选择（数据与左侧会话筛选的项目一致，
// 即 resolveProjectValues + buildProjectOptions 的项目选项，剔除「未知项目」占位）。
// 下拉选项展示项目显示值（与左侧筛选一致，多为 cwd 末段），但选中后填入输入框的是
// 该项目的完整 cwd 路径（valueToCwd 映射），保证提交给后端的 cwd 是真实目录。
function ProjectCombobox({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Command 根 ref：滚轮滚动需要手动滚动其内部 [cmdk-list]（见 onWheel）。
  const commandRef = useRef<HTMLDivElement>(null);
  // 下拉面板根 ref / 触发按钮 ref：判断焦点是否落在下拉面板内（见下方焦点放行逻辑）。
  const panelRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { data } = useSessionsList();
  const raw = data ?? [];
  const projectValues = useMemo(() => resolveProjectValues(raw), [raw]);
  // 项目显示值 ↔ 完整 cwd 路径的双向映射：valueToCwd 用于下拉回填（显示值 → cwd），
  // cwdToValue 用于把输入框当前值反查为下拉中的项目项（cwd → 显示值）。
  // resolveProjectValues 保证同名末段项目的 cwd 一致（末段重复时已升级为完整路径
  // 显示消歧），故两个方向都是一一对应。
  const { valueToCwd, cwdToValue } = useMemo(() => {
    const toCwd = new Map<string, string>();
    const toValue = new Map<string, string>();
    for (const s of raw) {
      const v = projectValues.get(s);
      if (v && v !== UNKNOWN_PROJECT && s.cwd) {
        toCwd.set(v, s.cwd);
        toValue.set(s.cwd, v);
      }
    }
    return { valueToCwd: toCwd, cwdToValue: toValue };
  }, [raw, projectValues]);
  // 当前输入值对应的项目显示值；输入值不属于已识别项目时为 undefined（下拉全不选中）。
  const selectedValue = useMemo(() => cwdToValue.get(value.trim()), [cwdToValue, value]);
  const projects = useMemo(
    () => buildProjectOptions(projectValues, raw).map((o) => o.value).filter((v) => v !== UNKNOWN_PROJECT),
    [projectValues, raw]
  );
  const filtered = useMemo(
    () => (query ? projects.filter((p) => p.toLowerCase().includes(query.toLowerCase())) : projects),
    [projects, query]
  );
  // 下拉滚轮滚动：本弹窗是 Radix 模态 Dialog，其滚动锁定（react-remove-scroll）会把
  // portal 内可滚动元素的滚轮事件一律 preventDefault（Popover 内容渲染在 Dialog 子树
  // 外的 portal 里，滚轮不经过锁定容器的捕获处理器，被 document 冒泡阶段当作「背景
  // 事件」吞掉），导致只能拖滚动条、滚轮无效。这里在 Command 根上捕获滚轮，手动滚动
  // 内部列表并 preventDefault，绕开该拦截；列表未溢出时不拦截（不干扰其它滚动）。
  const handleWheel = (e: React.WheelEvent) => {
    const list = commandRef.current?.querySelector<HTMLElement>('[cmdk-list]');
    if (!list) return;
    const { scrollTop, scrollHeight, clientHeight } = list;
    if (scrollHeight <= clientHeight) return;
    const next = Math.min(Math.max(scrollTop + e.deltaY, 0), scrollHeight - clientHeight);
    if (next !== scrollTop) {
      e.preventDefault();
      list.scrollTop = next;
    }
  };
  // ── 焦点放行：Radix 焦点陷阱与 portal 下拉面板的冲突 ──────────────────────────
  // 本弹窗是 Radix 模态 Dialog，其焦点陷阱（FocusScope）监听 document 上的
  // focusin/focusout：焦点一旦离开弹窗的 DOM 子树，就把焦点抢回弹窗内最后一个聚焦的
  // 元素。而下拉面板（Popover 内容）经 Portal 渲染到 document.body，不在弹窗子树内，
  // 于是面板里的搜索框一点就失焦——无法聚焦、无法输入、无法搜索。
  // （同一弹窗里的平台 Select 正常：它与 Dialog 共用同一份 @radix-ui/react-focus-scope，
  //  焦点作用域栈能互相让位；Popover 依赖的是另一份版本，两个作用域栈彼此不可见。）
  // 下拉面板是弹窗的合法子层，焦点在「弹窗内 ↔ 下拉面板」之间移动时应当放行，故在两处
  // 边界拦截冒泡，使事件不再到达 document，焦点陷阱便不会把焦点抢回弹窗：
  //   - focusin：焦点进入面板，事件冒泡经面板根 → 在面板根拦截；
  //   - focusout：焦点离开弹窗内元素、移入面板，事件冒泡经弹窗根 → 在弹窗根拦截。
  // 面板之外的焦点移动不受影响，弹窗其余部分仍照常受焦点陷阱约束。
  const handlePanelFocus = (e: React.FocusEvent) => {
    e.stopPropagation();
  };

  useEffect(() => {
    if (!open) return;
    // 弹窗根：触发按钮向上找到 role=dialog 的祖先（即 Radix DialogContent）。下拉面板
    // 被 portal 出去，故「焦点是否移入面板」的判定只能落在弹窗根这一层。
    const dialogEl = triggerRef.current?.closest<HTMLElement>('[role="dialog"]');
    if (!dialogEl) return;
    const onFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null;
      // 焦点从弹窗内元素移入下拉面板：阻止 focusout 冒泡到 document（焦点陷阱据此会
      // 把焦点抢回弹窗内，搜索框刚获得焦点就再次失焦）。
      if (next && panelRef.current?.contains(next)) e.stopPropagation();
    };
    dialogEl.addEventListener('focusout', onFocusOut);
    return () => dialogEl.removeEventListener('focusout', onFocusOut);
  }, [open]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      {/* Anchor 指向整个输入容器：--radix-popover-trigger-width 以容器宽为基准，
          使下拉面板与输入框同宽（此前 Anchor 缺失，面板宽度按右下角小图标按钮算，
          宽度仅约 24px 导致几乎无法选择项目）。 */}
      <PopoverAnchor asChild>
        <div className="relative">
          <Input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="选择已识别项目或手动输入路径"
            aria-label="cwd"
            className="pr-8"
          />
          <PopoverTrigger asChild>
            <Button
              ref={triggerRef}
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 text-muted-foreground"
              aria-label="选择项目"
            >
              <ChevronsUpDown className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        ref={panelRef}
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        onFocus={handlePanelFocus}
      >
        <Command ref={commandRef} onWheel={handleWheel}>
          <CommandInput placeholder="搜索项目…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>无匹配项目</CommandEmpty>
            <CommandGroup>
              {filtered.map((p) => {
                const current = p === selectedValue;
                return (
                  <CommandItem
                    key={p}
                    value={p}
                    aria-current={current ? 'true' : undefined}
                    // 「已选中」（当前输入值对应的项目）与键盘导航 active 态
                    // （cmdk 的 data-selected=true → 中性灰底）区分开：选中态用
                    // primary 配色 + 勾选标记，二者可同时出现而不互相覆盖。
                    className={cn(current && 'bg-primary/10 font-medium text-primary')}
                    onSelect={(v) => {
                      onChange(valueToCwd.get(v) ?? v);
                      setOpen(false);
                      setQuery('');
                    }}
                  >
                    <Folder className="mr-2 h-3.5 w-3.5 text-muted-foreground" />
                    {p}
                    {current ? <Check className="ml-auto h-3.5 w-3.5 text-primary" /> : null}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function NewTaskDialog({
  open,
  onOpenChange,
  defaultPlatform,
  defaultCwd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPlatform: Platform;
  defaultCwd?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const platforms = useAppStore((s) => s.platforms);
  const selectedPlatforms = useAppStore((s) => s.selectedPlatforms);
  const singlePlatform = useAppStore((s) => s.platform);
  const creatable = useMemo(() => createCapablePlatforms(platforms), [platforms]);
  // 可新建平台 id 静态查找表（只读下标查询）。
  const creatableIds = useMemo(() => {
    const table: Record<string, true> = {};
    for (const p of creatable) table[p.id] = true;
    return table;
  }, [creatable]);

  // 左侧筛选条件中选中的有效平台：多选模式用 selectedPlatforms，单平台模式用 platform；
  // 只取运行时有效条目（非 broken、有 id），与可新建平台合并为下拉可选项（去重、可新建在前）。
  const filteredSelected = useMemo(() => {
    const ids = new Set(selectedPlatforms.length > 0 ? selectedPlatforms : [singlePlatform]);
    return selectablePlatforms(platforms).filter((p) => ids.has(p.id));
  }, [selectedPlatforms, singlePlatform, platforms]);

  // 下拉可选项：与设置文件（ui-settings.json）中「已选择平台」保持一致，即左侧会话
  // 筛选选中的平台（多选 selectedPlatforms / 单平台 platform），只取运行时有效条目。
  // 可新建的平台排在前、可选；不可新建（如 openclaw/dsh）排在后、禁用。不额外并入
  // 全部可新建平台——用户未在设置中选择的平台不出现在新建任务可选项中。
  const options = useMemo(() => {
    return [...filteredSelected].sort(
      (a, b) => Number(!!creatableIds[b.id]) - Number(!!creatableIds[a.id])
    );
  }, [filteredSelected, creatableIds]);

  const [platform, setPlatform] = useState<Platform>(defaultPlatform);
  const [cwd, setCwd] = useState(defaultCwd ?? '');
  const [message, setMessage] = useState('');
  // 必填校验错误（平台/cwd/提示词 均必填）。
  const [fieldErrors, setFieldErrors] = useState<{ platform?: string; cwd?: string; message?: string }>({});
  // 后端请求错误（如命令不存在 / cwd 目录不存在）。
  const [error, setError] = useState('');

  // 每次打开时刷新默认值（选中会话/筛选平台可能已变化）。
  const [lastOpen, setLastOpen] = useState(open);
  if (open && !lastOpen) {
    setLastOpen(true);
    setPlatform(defaultPlatform);
    setCwd(defaultCwd ?? '');
    setMessage('');
    setFieldErrors({});
    setError('');
  } else if (!open && lastOpen) {
    setLastOpen(false);
  }

  // 默认平台若不可新建（如当前筛选平台是 openclaw/dsh），回退第一个可新建平台。
  const effectivePlatform: Platform = creatable.some((p) => p.id === platform)
    ? platform
    : (creatable[0]?.id ?? platform);

  const submit = useMutation({
    mutationFn: () =>
      createSession(effectivePlatform, {
        message: message.trim(),
        cwd: cwd.trim(),
      }),
    onSuccess: (result) => {
      onOpenChange(false);
      toast.success(`已触发 ${result.platform} 新建会话`);
      if (result.command) toast.info(result.command);
      // 新建会话会被平台 CLI 写入 → 失效会话列表缓存，触发看板/侧栏刷新。
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    setError('');
    const errors: { platform?: string; cwd?: string; message?: string } = {};
    if (options.length === 0 || !creatableIds[effectivePlatform]) {
      errors.platform = '请选择平台';
    }
    if (!cwd.trim()) errors.cwd = '请填写工作目录（cwd）';
    if (!message.trim()) errors.message = '请填写提示词';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    submit.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onOpenChange(false)}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              平台<span className="text-destructive">*</span>
            </span>
            <Select value={effectivePlatform} onValueChange={(v) => setPlatform(v as Platform)}>
              <SelectTrigger className="h-9 text-sm" aria-label="选择平台">
                <SelectValue placeholder="选择平台" />
              </SelectTrigger>
              <SelectContent>
                {options.map((p) => {
                  const ok = !!creatableIds[p.id];
                  return (
                    <SelectItem key={p.id} value={p.id} className="text-sm" disabled={!ok}>
                      {p.label || p.id}
                      {!ok && <span className="ml-2 text-[0.7rem] text-muted-foreground">不支持新建</span>}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {fieldErrors.platform && <span className="text-xs text-destructive">{fieldErrors.platform}</span>}
            {creatable.length === 0 && (
              <span className="text-xs text-muted-foreground">当前没有可新建会话的平台</span>
            )}
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              cwd（工作目录）<span className="text-destructive">*</span>
            </span>
            <ProjectCombobox value={cwd} onChange={setCwd} />
            {fieldErrors.cwd && <span className="text-xs text-destructive">{fieldErrors.cwd}</span>}
          </label>
          <label className="block space-y-1">
            <span className="text-xs text-muted-foreground">
              提示词<span className="text-destructive">*</span>
            </span>
            <Textarea
              rows={5}
              value={message}
              placeholder="给新任务的提示词（必填）"
              onChange={(e) => setMessage(e.target.value)}
              className="font-mono text-xs"
            />
            {fieldErrors.message && <span className="text-xs text-destructive">{fieldErrors.message}</span>}
          </label>
          {error && <div className="text-sm text-destructive">{error}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button onClick={handleSubmit} disabled={submit.isPending || options.length === 0}>
              {submit.isPending ? '触发中…' : '新建'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
