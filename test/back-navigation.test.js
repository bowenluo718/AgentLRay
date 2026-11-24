// 系统返回键 → 页面内后退（design-android-system-back）的前端层级历史。
//
// 被测：frontend/src/lib/backNavigation.ts（用 esbuild 把 TS 编成 ESM 后在 Node 里跑，
// 不需要浏览器）。依赖的 store 用一个最小 zustand 替身：只保留层级相关字段，
// setState(patch) 语义与真实 store 一致（合并补丁）。
//
// 假 history 按浏览器语义建模：go(-1) 与 back() 异步移动游标并派发 popstate。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

/** 把 backNavigation.ts 编成临时 ESM 文件（`@/store` 换成本测试的替身）。 */
async function compileBackNavigation() {
  const esbuild = require(path.join(FRONTEND_DIR, 'node_modules', 'esbuild'));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-backnav-'));
  await esbuild.build({
    entryPoints: [path.join(FRONTEND_DIR, 'src', 'lib', 'backNavigation.ts')],
    outfile: path.join(outDir, 'backNavigation.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    plugins: [
      {
        name: 'stub-store',
        setup(build) {
          build.onResolve({ filter: /^@\/store$/ }, () => ({ path: 'stub-store', namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            // 用取巧写法：每次读 store 都现查全局，测试之间可换替身。
            contents: `export const useAppStore = new Proxy({}, { get: (_, key) => globalThis.__agentlrayStore[key] });`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  return path.join(outDir, 'backNavigation.mjs');
}

/** 最小 zustand 替身：getState / setState / subscribe。 */
function makeStore(initial) {
  let state = { ...initial };
  const listeners = new Set();
  return {
    getState: () => state,
    setState: (patch) => {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /** 模拟用户操作：一次动作里改多个字段（订阅者只应看到一次合并结果）。 */
    act: (patch) => {
      state = { ...state, ...patch };
      for (const fn of listeners) fn(state);
    },
  };
}

function makeWindow() {
  const win = {
    location: { href: 'http://127.0.0.1:3801/?view=sessions', pathname: '/', search: '?view=sessions' },
    entries: [],
    index: 0,
    popstateListeners: new Set(),
    reported: [],
    goCalls: 0,
  };
  win.entries.push({ state: null, href: win.location.href });
  const sameHref = () => win.location.href;
  win.history = {
    get state() {
      return win.entries[win.index].state;
    },
    pushState(state, _title, url) {
      win.entries = win.entries.slice(0, win.index + 1);
      win.entries.push({ state, href: url || sameHref() });
      win.index = win.entries.length - 1;
    },
    replaceState(state, _title, url) {
      win.entries[win.index] = { state, href: url || sameHref() };
    },
    go(delta) {
      win.goCalls += 1;
      const target = win.index + delta;
      setImmediate(() => {
        if (target < 0 || target >= win.entries.length) return;
        win.index = target;
        win.location.href = win.entries[target].href;
        for (const fn of win.popstateListeners) fn({ state: win.entries[target].state });
      });
    },
    back() {
      win.history.go(-1);
    },
  };
  win.addEventListener = (type, fn) => {
    if (type === 'popstate') win.popstateListeners.add(fn);
  };
  win.removeEventListener = (type, fn) => {
    if (type === 'popstate') win.popstateListeners.delete(fn);
  };
  win.AgentLRayNative = {
    postBackState: (canBack, level) => win.reported.push({ canBack, level }),
  };
  // 手机竖屏（<768px）：退会话详情时应展开会话列表覆盖层。
  win.matchMedia = (query) => ({ matches: query === '(max-width: 767px)', media: query });
  return win;
}

let nav;
/** 本文件共享的 window：install 会幂等重装，假 history 直接重置即可。 */
let win;
let store;

function baseState(over = {}) {
  return {
    selectedHostId: 'local',
    view: 'sessions',
    selectedSessionId: '',
    detailPlatform: 'openclaw',
    detailAgent: '',
    selectedAgent: '',
    viewingChildAgent: null,
    sessionView: 'messages',
    navigationOpen: false,
    ...over,
  };
}

/** 等待所有微任务与 setImmediate 落地（schedule 的 queueMicrotask + 假 history 的 go）。 */
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(async () => {
  nav = nav || (await import(await compileBackNavigation()));
  win = makeWindow();
  globalThis.window = win;
  globalThis.history = win.history;
  store = makeStore(baseState());
  globalThis.__agentlrayStore = store;
  nav.installBackNavigation();
});

const lastReport = () => win.reported[win.reported.length - 1];

test('根层级：没有可后退的页面，上报 canBack=false（原生按原语义退出）', () => {
  assert.deepEqual(lastReport(), { canBack: false, level: 'root' });
  assert.equal(win.__agentlrayBack(), false);
  assert.equal(win.goCalls, 0);
});

test('选中会话：上报可后退，返回键退出会话并回到当初那一页', async () => {
  store.act({ selectedSessionId: 's1' });
  await settle();
  assert.equal(win.entries.length, 2, '选中会话应压入一个历史条目');
  assert.deepEqual(lastReport(), { canBack: true, level: 'session' });

  assert.equal(win.__agentlrayBack(), true);
  await settle();
  const st = store.getState();
  assert.equal(st.selectedSessionId, '', '返回键退出会话详情');
  assert.equal(st.navigationOpen, false, '回到选中会话之前的那一页（列表未展开）');
  assert.deepEqual(lastReport(), { canBack: false, level: 'root' });
});

test('会话内子页签：返回键先回 messages，再退出会话（不一次退两级）', async () => {
  store.act({ selectedSessionId: 's1' });
  await settle();
  store.act({ sessionView: 'trace' });
  await settle();
  assert.deepEqual(lastReport(), { canBack: true, level: 'sessionView' });

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().sessionView, 'messages');
  assert.equal(store.getState().selectedSessionId, 's1', '子页签返回不应退出会话');

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().selectedSessionId, '');
});

test('会话列表覆盖层：返回键只收起列表，保持当前会话', async () => {
  store.act({ selectedSessionId: 's1' });
  await settle();
  store.act({ navigationOpen: true });
  await settle();
  assert.deepEqual(lastReport(), { canBack: true, level: 'navigation' });

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().navigationOpen, false);
  assert.equal(store.getState().selectedSessionId, 's1');
  assert.deepEqual(lastReport(), { canBack: true, level: 'session' });
});

test('页签：返回键回到打开页面时的页签', async () => {
  store.act({ view: 'insights' });
  await settle();
  assert.deepEqual(lastReport(), { canBack: true, level: 'tab' });

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().view, 'sessions');
  assert.deepEqual(lastReport(), { canBack: false, level: 'root' });
});

test('切会话是横切导航：返回键回到上一个会话而不是先退出详情', async () => {
  store.act({ selectedSessionId: 's1' });
  await settle();
  store.act({ selectedSessionId: 's2' });
  await settle();
  assert.equal(win.entries.length, 3, '切会话也应压入历史条目');

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().selectedSessionId, 's1');
});

test('页面内后退（点「返回内容」）消费历史条目，与系统返回键落在同一条历史线上', async () => {
  store.act({ selectedSessionId: 's1' });
  await settle();
  store.act({ navigationOpen: true });
  await settle();
  assert.equal(win.entries.length, 3);

  store.act({ navigationOpen: false }); // 相当于 returnToContent()
  await settle();
  assert.equal(win.goCalls, 1, '页面内后退应 go(-1) 而不是再压一条');
  assert.equal(win.entries.length, 3);
  assert.equal(store.getState().navigationOpen, false);
  assert.equal(store.getState().selectedSessionId, 's1', 'popstate 落回覆盖层之前，不应连带退出会话');

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().selectedSessionId, '');
});

test('同一次动作里改多个字段只算一步（展开列表 + 选中会话）', async () => {
  store.act({ navigationOpen: true, selectedSessionId: 's1' });
  await settle();
  assert.equal(win.entries.length, 2);

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().selectedSessionId, '');
  assert.equal(store.getState().navigationOpen, false);
});

test('冷启动（seq=0）绝不 history.back：退回会落到 Capacitor 占位页', async () => {
  // 模拟 URL 已带会话、页面加载后才安装：基线条目就是会话详情，之前只有占位页。
  store = makeStore(baseState({ selectedSessionId: 's1' }));
  globalThis.__agentlrayStore = store;
  nav.installBackNavigation();
  win.entries[0].state = null; // 覆盖占位页的基线快照，验证不依赖 history.state
  assert.deepEqual(lastReport(), { canBack: true, level: 'session' });

  assert.equal(win.__agentlrayBack(), true);
  await settle();
  assert.equal(win.goCalls, 0, '没有本模块条目时不能 history.back()');
  assert.equal(store.getState().selectedSessionId, '');
  assert.equal(store.getState().navigationOpen, true, '窄屏退出详情 → 展开会话列表');
  assert.deepEqual(lastReport(), { canBack: true, level: 'navigation' });

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().navigationOpen, false);
  assert.deepEqual(lastReport(), { canBack: false, level: 'root' });
});

test('上下文重置（切换主机）不下沉历史：返回键不会退进旧主机的会话', async () => {
  store.act({ selectedSessionId: 's1' });
  await settle();
  store.act({ selectedHostId: 'remote-1', selectedSessionId: '', detailAgent: '' });
  await settle();
  assert.deepEqual(lastReport(), { canBack: false, level: 'root' });

  win.__agentlrayBack();
  await settle();
  assert.equal(store.getState().selectedSessionId, '');
  assert.equal(store.getState().selectedHostId, 'remote-1');
});
