// 系统返回键的页面内后退（design-android-system-back）。
//
// 背景：Android 壳只有一个 Activity，页面层级全在 SPA 状态里（zustand），系统返回若不拦截
// 就直接退出 App。原生侧（NativeBackHost）只认本模块上报的层级快照：页面还能后退时注入
// `window.__agentlrayBack()` 让这里退一步；已在根层级时原生按原语义退出（不吞返回键）。
//
// 层级（自底向顶，见 [levelsFor]）：
//   tab         页签（回到本次页面打开时的页签）
//   session     会话详情（后退一步 = 清空选中；窄屏同时展开会话列表覆盖层）
//   child       子 Agent 执行记录（viewingChildAgent）
//   sessionView 会话详情子页签（messages → trace / diagnostics）
//   navigation  移动端会话列表覆盖层（<768px）
//
// 历史：每个 history 条目（history.state）存**该页面自己的完整快照**。前进/横切导航
// （切页签、切会话、展开覆盖层、进子页签/子 Agent）pushState 一个新条目；页面内后退
// （点「返回内容」、切回 messages、点父 Agent、切回原页签）用 history.go(-n) 消费对应
// 条目。这样系统返回键、浏览器返回键与页面内的后退按钮落在同一条历史线上，且返回键
// 落到的总是「当初离开时的那一页」。上下文重置（切主机/平台会清空会话）不下沉历史，
// 而是把当前条目重标为新基线——否则返回会退进旧主机的会话。
//
// 冷启动陷阱：WebView history 里有 Capacitor 占位页。`seq === 0`（还没有本模块压入的
// 条目）时退回浏览器历史会落到启动屏，因此那种情况一律在页面内推导后退，绝不调
// history.back()。

import type { Platform } from '@/api/types';
import type { MainView, SessionView } from '@/store';
import { useAppStore } from '@/store';

export type BackLevel = 'tab' | 'session' | 'child' | 'sessionView' | 'navigation';

/** 上报给原生的快照（参数与 Android `NativeBackHost.BackSnapshot` 一致）。 */
export interface BackSnapshot {
  canBack: boolean;
  level: BackLevel | 'root';
}

/** 原生注入的全局桥与页面内后退钩子。薄服务页面是 Capacitor 本地源之外的源，
 *  取不到 `window.Capacitor`，故原生用无能力 JS 接口（BackBridge）收上报。 */
declare global {
  interface Window {
    AgentLRayNative?: { postBackState?: (canBack: boolean, level: string) => void };
    __agentlrayBack?: () => boolean;
  }
}

const DEFAULT_SESSION_VIEW: SessionView = 'messages';
const MOBILE_QUERY = '(max-width: 767px)';

/** 一个页面的完整层级快照：足够用 [patchFor] 还原到这一刻。 */
export interface NavSnapshot {
  /** 所属主机：切换主机后旧历史条目不可还原（会话不在新主机里）。 */
  host: string;
  view: MainView;
  sessionId: string;
  sessionPlatform: Platform;
  sessionAgent: string;
  /** openclaw 归属 agent（侧栏列表上下文）。 */
  agent: string;
  child: string | null;
  sessionView: SessionView;
  navigation: boolean;
}

interface NavEntry {
  __agentlray: true;
  /** 条目序号：0 = 页面加载时的基线条目，每前进一次 +1。 */
  seq: number;
  snapshot: NavSnapshot;
}

type StoreState = ReturnType<typeof useAppStore.getState>;

function snapshotOf(state: StoreState): NavSnapshot {
  return {
    host: state.selectedHostId,
    view: state.view,
    sessionId: state.selectedSessionId,
    sessionPlatform: state.detailPlatform,
    sessionAgent: state.detailAgent,
    agent: state.selectedAgent,
    child: state.viewingChildAgent,
    sessionView: state.sessionView,
    navigation: state.navigationOpen,
  };
}

function sameSnapshot(a: NavSnapshot, b: NavSnapshot): boolean {
  return (
    a.host === b.host &&
    a.view === b.view &&
    a.sessionId === b.sessionId &&
    a.sessionPlatform === b.sessionPlatform &&
    a.sessionAgent === b.sessionAgent &&
    a.agent === b.agent &&
    a.child === b.child &&
    a.sessionView === b.sessionView &&
    a.navigation === b.navigation
  );
}

/** 当前应存在的层级，自底向顶（空数组 = 根层级，返回键交回系统）。 */
export function levelsFor(snapshot: NavSnapshot, initialView: MainView): BackLevel[] {
  const levels: BackLevel[] = [];
  if (snapshot.view !== initialView) levels.push('tab');
  if (snapshot.sessionId) levels.push('session');
  if (snapshot.sessionId && snapshot.child) levels.push('child');
  if (snapshot.sessionId && snapshot.sessionView !== DEFAULT_SESSION_VIEW) levels.push('sessionView');
  if (snapshot.navigation) levels.push('navigation');
  return levels;
}

/** 快照还原成 store 补丁（只动层级字段，其余状态跟随实时值）。 */
export function patchFor(snapshot: NavSnapshot): Partial<StoreState> {
  return {
    view: snapshot.view,
    selectedSessionId: snapshot.sessionId,
    detailPlatform: snapshot.sessionPlatform,
    detailAgent: snapshot.sessionAgent,
    selectedAgent: snapshot.agent,
    viewingChildAgent: snapshot.child,
    sessionView: snapshot.sessionView,
    navigationOpen: snapshot.navigation,
  };
}

function isNarrowViewport(): boolean {
  try {
    return window.matchMedia?.(MOBILE_QUERY)?.matches === true;
  } catch {
    return false;
  }
}

/** 自栈顶退一级后的页面（用于没有历史条目可消费的场合）。 */
export function backOneLevel(snapshot: NavSnapshot, levels: BackLevel[], initialView: MainView): NavSnapshot {
  switch (levels[levels.length - 1]) {
    case 'navigation':
      return { ...snapshot, navigation: false };
    case 'sessionView':
      return { ...snapshot, sessionView: DEFAULT_SESSION_VIEW };
    case 'child':
      return { ...snapshot, child: null };
    case 'session':
      // 会话详情下面就是列表：窄屏展开覆盖层（用户看到的是会话列表），宽屏只清空选中。
      return {
        ...snapshot,
        sessionId: '',
        child: null,
        sessionView: DEFAULT_SESSION_VIEW,
        navigation: isNarrowViewport(),
      };
    case 'tab':
      return { ...snapshot, view: initialView };
    default:
      return snapshot;
  }
}

/**
 * 是否是「上下文重置」：切主机/平台/agent 会清空会话，这不是用户后退，而是换了数据源。
 * 这类变化不能下沉历史（否则返回会退出旧主机的会话），只把当前条目重标为新基线。
 */
function isContextReset(before: NavSnapshot, after: NavSnapshot, levels: BackLevel[], beforeLevels: BackLevel[]): boolean {
  if (before.host !== after.host) return true;
  const contextChanged =
    before.sessionPlatform !== after.sessionPlatform ||
    before.sessionAgent !== after.sessionAgent ||
    before.agent !== after.agent;
  return contextChanged && (!after.sessionId || levels.length < beforeLevels.length);
}

/** 已安装时的卸载函数：重复安装只换监听，不叠加（StrictMode 双跑 / 测试重装）。 */
let uninstallCurrent: (() => void) | null = null;

/**
 * 安装返回键支持（完整实例的桌面浏览器同样适用：浏览器返回键也走同一套层级历史）。
 * 返回卸载函数。必须在 store 已按 URL 恢复状态之后调用（main.tsx 的 render）。
 */
export function installBackNavigation(): () => void {
  uninstallCurrent?.();

  const initialView = useAppStore.getState().view;
  let lastSnapshot = snapshotOf(useAppStore.getState());
  let lastLevels = levelsFor(lastSnapshot, initialView);
  /** 当前所在条目的序号（0 = 页面加载时的基线条目）。 */
  let currentSeq = 0;
  let pending = false;
  /** 后退的 popstate 尚未落地：忽略连击，且不再为期间的 store 变化另起历史。 */
  let backPending = false;
  let backTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const entryOf = (seq: number, snapshot: NavSnapshot): NavEntry => ({ __agentlray: true, seq, snapshot });

  const report = (snapshot: NavSnapshot) => {
    const levels = levelsFor(snapshot, initialView);
    const top = levels[levels.length - 1];
    const payload: BackSnapshot = { canBack: !!top, level: top ?? 'root' };
    try {
      window.AgentLRayNative?.postBackState?.(payload.canBack, payload.level);
    } catch {
      /* 桥不可用（浏览器 / 旧壳）：返回键语义不变 */
    }
  };

  /** 只对齐内部位置（当前条目重标 + 上报），不动 store——popstate 落地时用。 */
  const mark = (snapshot: NavSnapshot, seq: number) => {
    currentSeq = seq;
    lastSnapshot = snapshot;
    lastLevels = levelsFor(snapshot, initialView);
    window.history.replaceState(entryOf(seq, snapshot), '', window.location.href);
    report(snapshot);
  };

  /** 应用页面快照：store + 当前条目重标（用于推导后退 / 无条目可还原）。 */
  const apply = (snapshot: NavSnapshot, seq: number) => {
    mark(snapshot, seq);
    useAppStore.setState(patchFor(snapshot));
  };

  /** 当前条目重标为新基线（上下文重置 / 历史条目不足时）。 */
  const rebaseline = (snapshot: NavSnapshot) => mark(snapshot, 0);

  const endBack = () => {
    backPending = false;
    if (backTimer) {
      clearTimeout(backTimer);
      backTimer = null;
    }
  };

  const onPopState = (event: PopStateEvent) => {
    if (disposed) return;
    endBack();
    const state = event.state as NavEntry | null;
    if (!state || state.__agentlray !== true) {
      // 不是本模块的条目（页面加载前的历史）：按层级推导退一步，并把当前条目重标为基线。
      const snapshot = snapshotOf(useAppStore.getState());
      const levels = levelsFor(snapshot, initialView);
      if (levels.length > 0) apply(backOneLevel(snapshot, levels, initialView), 0);
      else rebaseline(snapshot);
      return;
    }
    if (state.snapshot.host !== useAppStore.getState().selectedHostId) {
      // 跨主机残留条目（切主机前压入的历史）：不还原，就地重标为新基线。
      rebaseline(snapshotOf(useAppStore.getState()));
      return;
    }
    // 条目就是「这一页」的真源：还原它（页面内后退时 store 已是目标页，此处为幂等）。
    apply(state.snapshot, state.seq);
  };

  // 层级变化 → 微任务内合并处理一次（同一事件里的多字段变化只算一步）。
  const schedule = () => {
    if (pending || disposed) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (disposed) return;
      const snapshot = snapshotOf(useAppStore.getState());
      if (sameSnapshot(snapshot, lastSnapshot)) return;
      const levels = levelsFor(snapshot, initialView);

      if (isContextReset(lastSnapshot, snapshot, levels, lastLevels)) {
        rebaseline(snapshot);
        return;
      }
      if (backPending) {
        // 后退的 popstate 还没落地：store 已按预期变化（或正处中间态），不再另起历史。
        lastSnapshot = snapshot;
        lastLevels = levels;
        return;
      }

      const sessionSwitched = snapshot.sessionId !== lastSnapshot.sessionId && !!snapshot.sessionId;
      if (sessionSwitched || levels.length >= lastLevels.length) {
        // 前进 / 横切：先把当前条目固定为「离开前」的页面，再压入新页面。
        window.history.replaceState(entryOf(currentSeq, lastSnapshot), '', window.location.href);
        currentSeq += 1;
        lastSnapshot = snapshot;
        lastLevels = levels;
        window.history.pushState(entryOf(currentSeq, snapshot), '', window.location.href);
        report(snapshot);
        return;
      }

      // 页面内后退：消费对应历史条目（popstate 会把 store 对齐到落地的「上一页」）。
      const drops = lastLevels.length - levels.length;
      if (drops > currentSeq) {
        // 历史里没有足够的条目（基线之后又被重置过）：不下沉，就地重标。
        rebaseline(snapshot);
        return;
      }
      lastSnapshot = snapshot;
      lastLevels = levels;
      currentSeq -= drops;
      backPending = true;
      window.history.go(-drops);
      report(snapshot);
    });
  };

  // 页面内后退钩子（原生在页面可后退时注入调用）。
  window.__agentlrayBack = () => {
    const snapshot = snapshotOf(useAppStore.getState());
    const levels = levelsFor(snapshot, initialView);
    if (levels.length === 0) return false;
    if (backPending) return true;
    if (currentSeq > 0) {
      // 有本模块压入的条目：退回上一页，由 popstate 还原那一页的快照。
      backPending = true;
      backTimer = setTimeout(() => {
        // 兜底：popstate 迟迟不来也不能永久吞掉返回键。
        backPending = false;
        backTimer = null;
      }, 500);
      window.history.back();
    } else {
      // seq === 0：没有本模块压入的条目，退回浏览器历史会落到 Capacitor 占位页。
      apply(backOneLevel(snapshot, levels, initialView), 0);
    }
    return true;
  };

  // 基线：把页面加载时的条目标成当前页面，后续 popstate 才有快照可读。
  mark(lastSnapshot, 0);
  const unsubscribe = useAppStore.subscribe(schedule);
  window.addEventListener('popstate', onPopState);

  const uninstall = () => {
    if (disposed) return;
    disposed = true;
    if (uninstallCurrent === uninstall) uninstallCurrent = null;
    unsubscribe();
    window.removeEventListener('popstate', onPopState);
    if (backTimer) clearTimeout(backTimer);
    delete window.__agentlrayBack;
  };
  uninstallCurrent = uninstall;
  return uninstall;
}
