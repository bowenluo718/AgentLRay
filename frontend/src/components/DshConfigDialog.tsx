// dsh 配置弹框（design-dsh-login-methods）：
// - 两态状态机：未登录（可编辑配置 + 登录方式）/ 已登录（只读摘要 + 角色 + 退出）。
// - 登录方式：账号密码 + 动态发现的 OAuth 扫码 provider（官方 zhihu/github/google）。
//   both 角色禁扫码（D3）；可用方式 >1 用页签，否则直显账号密码（D13/D58）。
// - provider 发现（D48/D49）：已登录不调；未登录 serverUrl 非空打开即发现、为空失焦后发现。
// - 账号密码「登录」= PUT /api/dsh/config 带 email/password（落配置字段 + 生成 token）。
// - 扫码成功 → 先以目标 serverUrl 完成扫码（token 落该地址），再保存配置字段 + 进入登录态（QrLoginPanel onComplete 回传目标地址）。
// - 退出 → 清 token + 若当前主机是 dsh 类型则切回本地（settleHostSwitch）。
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  DshAuthProvider,
  discoverDshAuthProviders,
  getDshConfig,
  getHosts,
  logoutDsh,
  saveDshConfig as apiSaveDshConfig,
} from '@/api/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useAppStore } from '@/store';
import { settleHostSwitch } from '@/components/HostsDialog';
import { QrLoginPanel } from '@/components/dsh/QrLoginPanel';
import { PasswordLoginPanel } from '@/components/dsh/PasswordLoginPanel';
import { DshLoggedInView } from '@/components/dsh/DshLoggedInView';

interface Draft {
  role: 'host' | 'client' | 'both';
  serverUrl: string;
  deviceName: string;
  /** 放行端口（逗号/空格分隔文本，保存时解析为数字数组）。 */
  allowedPorts: string;
}

function parsePorts(text: string): number[] {
  return text
    .split(/[\s,]+/)
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 65535);
}

/**
 * 是否为可发起 provider 发现的「完整」中继地址。
 * 移动端逐字符输入时，中途停顿会把半截地址（如 https://dsh.r2049.c）发给服务器；
 * 这类地址在内网可能被 DNS 搜索域静默补全到错误主机，导致扫码方式恒为空。
 * 这里在本地拦截：要求 http(s)、主机名合法；域名顶级段至少 2 个字符（排除 ".c" 这类半截），
 * IPv4 / IPv6 字面量 / localhost 放行。与后端 `normalizeServerUrl` 的主机名规则保持一致。
 */
function isDiscoverableServerUrl(value: string): boolean {
  const target = value.trim();
  if (!target) return false;
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname;
  if (!host) return false;
  // IPv4 / IPv6 字面量（IPv6 在 URL 中带方括号）。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  if (/^\[[0-9a-f:.]+\]$/i.test(host)) return true;
  // localhost 不受 DNS 搜索域影响（解析走 /etc/hosts），PC 自托管中继合法。
  if (host === 'localhost') return true;
  // 域名：至少含一个点，且最后一段（顶级段）长度 >= 2。
  if (!host.includes('.')) return false;
  const lastLabel = host.split('.').pop() ?? '';
  return lastLabel.length >= 2;
}

export function DshConfigDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft>({ role: 'both', serverUrl: '', deviceName: '', allowedPorts: '' });
  const seeded = useRef(false);
  const [providers, setProviders] = useState<DshAuthProvider[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  // 后端对网络类失败的归类提示（如 DNS 解析失败）。优先展示它，原始 error 仅作 title 诊断。
  const [providersHint, setProvidersHint] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState('password');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [serverDirty, setServerDirty] = useState(false);

  const cfg = useQuery({ queryKey: ['dsh-config'], queryFn: getDshConfig, enabled: open });
  const hosts = useQuery({ queryKey: ['hosts'], queryFn: getHosts, enabled: open });
  const selectedHostId = useAppStore((s) => s.selectedHostId);
  const setSelectedHostId = useAppStore((s) => s.setSelectedHostId);

  const loggedIn = Boolean(cfg.data?.authStatus.loggedIn);

  function seed() {
    setDraft({
      role: cfg.data?.role ?? 'both',
      serverUrl: cfg.data?.serverUrl ?? '',
      deviceName: cfg.data?.deviceName ?? '',
      allowedPorts: (cfg.data?.allowedPorts ?? [3800]).join(', '),
    });
  }

  // 请求代际守卫：只有「最新一次」发现的结果才允许落地，避免晚到的旧响应
  // （例如半截地址返回的空列表）覆盖新地址已拿到的 provider（移动端 RTT 抖动放大）。
  const discoverGen = useRef(0);

  // provider 发现：both 禁扫码；完整地址才调。参数显式传入避免闭包陈旧。
  const discover = async (url: string, role: Draft['role']) => {
    // 每次调用先递增代际：即使是「跳过请求」的早退，也要让在飞的旧请求失效。
    const gen = ++discoverGen.current;
    // 清空 provider 时要连同旧的发现错误一起清，避免切换角色/清空地址后残留上一次的失败提示。
    if (role === 'both') {
      setProviders([]);
      setProvidersError(null);
      setProvidersHint(null);
      return;
    }
    const target = url.trim();
    if (!target) {
      setProviders([]);
      setProvidersError(null);
      setProvidersHint(null);
      return;
    }
    // 半截地址不发起发现：本地判定「非完整地址」直接给出可区分的提示，不发请求。
    if (!isDiscoverableServerUrl(target)) {
      setProviders([]);
      setProvidersHint(null);
      setProvidersError('地址不完整，请填写完整域名（如 https://dsh.r2049.cn）');
      return;
    }
    try {
      // 传 draft.serverUrl（Q2）：发现针对用户当前编辑的地址，而非已保存值。
      const res = await discoverDshAuthProviders(role, target);
      if (gen !== discoverGen.current) return; // 已有更新的发现，丢弃本次结果。
      setProviders(res.providers);
      // 后端发现失败以 200 + 空 providers + error 返回：透出 error，让「失败」与「无扫码方式」可区分。
      setProvidersError(res.error ?? null);
      // 可归类失败（如 DNS 解析失败）优先展示后端给出的中文提示，原始 error 降为诊断信息。
      setProvidersHint(res.hint ?? null);
      // 用函数式更新读取「当前」页签，避免 render 闭包里的旧值。
      if (res.providers.length > 0) {
        setActiveTab((cur) => (cur !== 'password' && !res.providers.some((p) => p.id === cur) ? 'password' : cur));
      }
    } catch (e) {
      if (gen !== discoverGen.current) return; // 旧请求的失败同样不得覆盖新结果。
      setProviders([]);
      setProvidersHint(null);
      setProvidersError((e as Error).message);
    }
  };

  useEffect(() => {
    if (open && cfg.data && !seeded.current) {
      seeded.current = true;
      seed();
      // 已登录不发现 provider；未登录按 serverUrl 是否非空决定是否立即发现。
      if (!cfg.data.authStatus.loggedIn && cfg.data.serverUrl) {
        void discover(cfg.data.serverUrl, cfg.data.role);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cfg.data]);

  function handleOpenChange(next: boolean) {
    if (next) {
      seeded.current = false;
      setLoginError(null);
      setProvidersError(null);
      setProvidersHint(null);
      setActiveTab('password');
      setServerDirty(false);
    }
    onOpenChange(next);
  }

  // 当前 role 的实时引用：URL 变化触发的（防抖）重发现需要拿到「当前」角色，
  // 避免依赖 render 闭包里的旧值（尤其移动端，键盘/失焦时序不可靠）。
  const roleRef = useRef<Draft['role']>('both');
  useEffect(() => {
    roleRef.current = draft.role;
  }, [draft.role]);
  const serverUrlRef = useRef('');
  useEffect(() => {
    serverUrlRef.current = draft.serverUrl;
  }, [draft.serverUrl]);

  // 防抖：地址连续编辑时只在停顿后真正发一次发现请求（URL/角色读实时 ref）。
  const discoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleDiscover = () => {
    if (discoverTimer.current) clearTimeout(discoverTimer.current);
    discoverTimer.current = setTimeout(() => {
      void discover(serverUrlRef.current, roleRef.current);
    }, 400);
  };
  useEffect(() => {
    return () => {
      if (discoverTimer.current) clearTimeout(discoverTimer.current);
    };
  }, []);

  const serverUrlChanged = (url: string) => {
    setDraft((prev) => ({ ...prev, serverUrl: url }));
    setServerDirty(true);
    // 地址变化即重发现（移动端失焦不可靠）：确保针对当前编辑值访问服务器、拿到扫码方式。
    scheduleDiscover();
  };
  // serverUrl 失焦后立即重新发现（D49）：从空变非空、或非空改非空都触发（防抖的即时兜底）。
  const onServerBlur = () => {
    if (!loggedIn && serverDirty) {
      setServerDirty(false);
      if (discoverTimer.current) clearTimeout(discoverTimer.current);
      void discover(serverUrlRef.current, roleRef.current);
    }
  };

  // role 变化：both → 不发现（清 provider）；host/client 且 serverUrl 非空 → 发现。
  // serverUrl 读实时引用（serverUrlRef），避免与刚输入的地址不同步。
  const roleChanged = (role: Draft['role']) => {
    const currentUrl = serverUrlRef.current.trim();
    setDraft((prev) => ({ ...prev, role }));
    if (role === 'both') {
      setProviders([]);
      setProvidersError(null);
      setProvidersHint(null);
      setActiveTab('password');
    } else if (currentUrl) {
      void discover(currentUrl, role);
    }
  };

  // 配置字段校验（D17）：前端即时校验。
  const validateConfig = (): string | null => {
    if (!/^https?:\/\//i.test(draft.serverUrl.trim())) return '中继服务器地址需以 http:// 或 https:// 开头';
    if (!draft.deviceName.trim()) return '本机设备名不能为空';
    if (parsePorts(draft.allowedPorts).length === 0 && draft.allowedPorts.trim() !== '') {
      return '放行端口需为 1–65535 的整数（逗号分隔）';
    }
    return null;
  };

  // 账号密码登录（D16）：落配置字段 + authorizeWithAccount 生成 token。
  const loginMut = useMutation({
    mutationFn: (creds: { email: string; password: string }) =>
      apiSaveDshConfig({
        role: draft.role,
        serverUrl: draft.serverUrl.trim(),
        deviceName: draft.deviceName.trim(),
        allowedPorts: parsePorts(draft.allowedPorts),
        email: creds.email,
        password: creds.password,
      }),
    onSuccess: () => {
      setLoginError(null);
      queryClient.invalidateQueries({ queryKey: ['dsh-config'] });
      toast.success('dsh 登录成功');
    },
    onError: (e) => {
      // 登录失败：配置已落（D16），保持未登录，显示错误。
      setLoginError((e as Error).message);
      queryClient.invalidateQueries({ queryKey: ['dsh-config'] });
    },
  });

  // 扫码成功：刷新配置（token 已落 scope，进入登录态）。
  // targetServerUrl = 扫码实际使用的目标地址（Q3）：用它持久化，保证 token 与保存的 serverUrl 一致。
  const handleQrComplete = (targetServerUrl: string) => {
    queryClient.invalidateQueries({ queryKey: ['dsh-config'] });
    // 扫码成功后保存配置字段（不含账号密码）；serverUrl 用本次扫码的目标地址。
    void apiSaveDshConfig({
      role: draft.role,
      serverUrl: (targetServerUrl || draft.serverUrl).trim(),
      deviceName: draft.deviceName.trim(),
      allowedPorts: parsePorts(draft.allowedPorts),
    })
      .then(() => queryClient.invalidateQueries({ queryKey: ['dsh-config'] }))
      .catch((e) => toast.error(`配置保存失败：${(e as Error).message}`));
  };

  // 退出：清 token + 若当前主机是 dsh 类型则切回本地（D25）。
  // wasDsh 在 mutationFn 内按「退出前」的主机判定（不依赖 onSuccess 闭包旧值，评审 P5）。
  const logoutMut = useMutation({
    mutationFn: async (): Promise<{ wasDsh: boolean }> => {
      const wasDsh = hosts.data?.hosts?.find((h) => h.id === selectedHostId)?.type === 'dsh';
      await logoutDsh();
      if (wasDsh) await setSelectedHostId('local');
      return { wasDsh };
    },
    onSuccess: ({ wasDsh }) => {
      onOpenChange(false);
      queryClient.invalidateQueries({ queryKey: ['dsh-config'] });
      toast.success('已退出 dsh 登录');
      // 原先查看的是 dsh 主机且已切回 local → 收尾刷新。
      if (wasDsh) settleHostSwitch();
    },
    onError: (e) => toast.error(`退出失败：${(e as Error).message}`),
  });

  // 可用登录方式列表：账号密码恒有 + 发现的 provider。
  const methods = useMemo(() => {
    if (loggedIn || draft.role === 'both') return [{ id: 'password', label: '账号密码' }];
    const list = [{ id: 'password', label: '账号密码' }];
    for (const p of providers) list.push({ id: p.id, label: p.displayName });
    return list;
  }, [loggedIn, draft.role, providers]);

  const useTabs = methods.length > 1;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-lg overflow-y-auto top-[6%] translate-y-0 max-h-[85vh] max-sm:w-[calc(100%-1.5rem)] max-sm:max-w-[calc(100%-1.5rem)] max-sm:p-4">
        <DialogHeader>
          <DialogTitle>dsh 配置</DialogTitle>
        </DialogHeader>

        {loggedIn && cfg.data ? (
          <DshLoggedInView cfg={cfg.data} loggingOut={logoutMut.isPending} onLogout={() => logoutMut.mutate()} />
        ) : (
          <div className="space-y-3">
            {/* 配置字段（未登录可编辑） */}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="dshcfg-role">
                本机角色
              </label>
              <select
                id="dshcfg-role"
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                value={draft.role}
                onChange={(e) => roleChanged(e.target.value as Draft['role'])}
              >
                <option value="both">both（既被连也去连，默认）</option>
                <option value="host">host（只被别的 AgentLRay 连接）</option>
                <option value="client">client（只去连别的 AgentLRay）</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="dshcfg-server-url">
                中继服务器地址
              </label>
              <Input
                id="dshcfg-server-url"
                placeholder="https://dsh.r2049.cn"
                value={draft.serverUrl}
                onChange={(e) => serverUrlChanged(e.target.value)}
                onBlur={onServerBlur}
              />
              <p className="text-[11px] text-muted-foreground">
                默认官方公共服务器；内网强控场景可填自托管地址。AgentLRay 不内置中继服务器。
              </p>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="dshcfg-device-name">
                本机设备名
              </label>
              <Input
                id="dshcfg-device-name"
                placeholder="如：devbox"
                value={draft.deviceName}
                onChange={(e) => setDraft({ ...draft, deviceName: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">在中继服务器上的设备标识（默认本机 hostname 短名）</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground" htmlFor="dshcfg-allowed-ports">
                放行端口（被连接方允许访问本机哪些端口，逗号分隔）
              </label>
              <Input
                id="dshcfg-allowed-ports"
                placeholder="3800"
                value={draft.allowedPorts}
                onChange={(e) => setDraft({ ...draft, allowedPorts: e.target.value })}
              />
              <p className="text-[11px] text-muted-foreground">
                默认 3800（AgentLRay 默认端口）。远端 AgentLRay 跑其它端口时，在此放行并在对端主机里填同一端口。
              </p>
            </div>

            {/* both 禁扫码提示（D3） */}
            {draft.role === 'both' ? (
              <p className="text-[11px] text-muted-foreground">
                both 角色暂不支持扫码登录，请使用账号密码，或切换到 host/client 角色扫码授权。
              </p>
            ) : null}

            {/* 发现失败提示：与「服务器确实没有扫码方式」区分开。
                providersError 来自后端发现失败（200 + 空 providers + error），
                无 provider 时它为空，不展示该行。 */}
            {providersHint || providersError ? (
              // 可归类失败（如 DNS 解析失败）优先展示面向用户的中文提示；原始错误放进 title 供排查。
              <p
                className="text-[11px] text-destructive"
                role="alert"
                title={providersHint ? (providersError ?? undefined) : undefined}
              >
                {providersHint ?? `未发现扫码方式：${providersError}`}
              </p>
            ) : null}

            {/* 登录方式 */}
            {useTabs ? (
              <Tabs value={activeTab} onValueChange={setActiveTab}>
                <TabsList className="w-full">
                  {methods.map((m) => (
                    <TabsTrigger key={m.id} value={m.id} className="flex-1">
                      {m.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <TabsContent value="password" className="pt-2">
                  <PasswordLoginPanel
                    busy={loginMut.isPending}
                    error={loginError}
                    onLogin={(email, password) => {
                      const err = validateConfig();
                      if (err) {
                        setLoginError(err);
                        return;
                      }
                      loginMut.mutate({ email, password });
                    }}
                  />
                </TabsContent>
                {providers.map((p) => (
                  <TabsContent key={p.id} value={p.id} className="pt-2">
                    <QrLoginPanel
                      role={draft.role === 'host' ? 'host' : 'client'}
                      provider={p.id}
                      serverUrl={draft.serverUrl.trim()}
                      onComplete={handleQrComplete}
                    />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <div className="space-y-2">
                <PasswordLoginPanel
                  busy={loginMut.isPending}
                  error={loginError}
                  onLogin={(email, password) => {
                    const err = validateConfig();
                    if (err) {
                      setLoginError(err);
                      return;
                    }
                    loginMut.mutate({ email, password });
                  }}
                />
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
