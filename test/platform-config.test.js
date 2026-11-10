'use strict';
// lib/platform-config.js 单测：平台启停/替代控制面
//  - readPlatformStateSync：缺失/损坏/非法 id → { disabled:[], replaced:[] }；正常读取
//  - normalizeIdList：过滤非法/去重/保序
//  - loadPlatformSection / savePlatformSection 的读写往返
//  - setPlatformMounted：unknown → code unknown-platform；last queryable → code last-platform；
//    正常挂载/卸载写盘并返回 restart
//  - setPlatformReplaced：unknown → code unknown-platform；正常写盘
//
// SETTINGS_FILE 在 require lib/settings 时按 process.env.HOME（经 lib/config）
// 固定解析，故先设临时 HOME 再 require。
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-pcfg-'));
process.env.HOME = tmpHome;

const {
  normalizeIdList,
  readPlatformStateSync,
  loadPlatformSection,
  savePlatformSection,
  isQueryable,
  setPlatformMounted,
  setPlatformReplaced,
  applyPlatformSection,
  catalogGet,
  catalogHas,
  catalogValues,
} = require('../lib/platform-config');

const SETTINGS_FILE = path.join(tmpHome, '.agentlray', 'settings.json');

// 每个用例前重置 settings.json 中的 platforms section，避免跨用例共享写盘状态。
beforeEach(async () => {
  await savePlatformSection({ disabled: [], replaced: [] });
});

function mklistable(id) {
  return { id, list: async () => [], getSession: async () => null, defaultDir: () => `/tmp/${id}` };
}
function mkFileOnly(id) {
  // 无 list hook → 不可查询（用于 last-queryable 守卫测试）
  return { id, getSession: async () => null, defaultDir: () => `/tmp/${id}` };
}
function makeCatalog(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.id, e);
  return m;
}

test('normalizeIdList：过滤非法/去重/保序', () => {
  assert.deepEqual(normalizeIdList(['a', 'b', 'a', 1, '', 'c-d', 'Caps', 'a b', null]), ['a', 'b', 'c-d']);
  assert.deepEqual(normalizeIdList(undefined), []);
  assert.deepEqual(normalizeIdList('nope'), []);
});

test('readPlatformStateSync：缺失文件 → 空态', async () => {
  await fsp.rm(path.dirname(SETTINGS_FILE), { recursive: true, force: true });
  assert.deepEqual(readPlatformStateSync(), { disabled: [], replaced: [] });
});

test('readPlatformStateSync：损坏 JSON / 顶层非对象 / 非法 id 容错', async () => {
  await fsp.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
  await fsp.writeFile(SETTINGS_FILE, '{ not json', 'utf8');
  assert.deepEqual(readPlatformStateSync(), { disabled: [], replaced: [] });

  await fsp.writeFile(SETTINGS_FILE, '42', 'utf8');
  assert.deepEqual(readPlatformStateSync(), { disabled: [], replaced: [] });

  await fsp.writeFile(
    SETTINGS_FILE,
    JSON.stringify({ platforms: { disabled: ['ok', 5, 'bad id'], replaced: 'x' } }),
    'utf8'
  );
  assert.deepEqual(readPlatformStateSync(), { disabled: ['ok'], replaced: [] });
});

test('savePlatformSection / loadPlatformSection 往返', async () => {
  const saved = await savePlatformSection({ disabled: ['codex'], replaced: ['codex'] });
  assert.deepEqual(saved, { disabled: ['codex'], replaced: ['codex'] });
  assert.deepEqual(await loadPlatformSection(), { disabled: ['codex'], replaced: ['codex'] });
  // save 不重复去重/保现有字段
  const reloaded = JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
  assert.deepEqual(reloaded.platforms, { disabled: ['codex'], replaced: ['codex'] });
});

test('isQueryable：list/listForAgent/listAllAgents 任一函数即可查询', () => {
  assert.equal(isQueryable({ list: () => {} }), true);
  assert.equal(isQueryable({ listForAgent: () => {} }), true);
  assert.equal(isQueryable({ listAllAgents: () => {} }), true);
  assert.equal(isQueryable({ list: null, getSession: () => {} }), false);
  assert.equal(isQueryable(null), false);
});

test('catalog 访问辅助：兼容 Map 与 plain object', () => {
  const m = makeCatalog([mklistable('a')]);
  assert.equal(catalogHas(m, 'a'), true);
  assert.equal(catalogGet(m, 'a').id, 'a');
  assert.equal(catalogValues(m).length, 1);
  const o = { a: { id: 'a' } };
  assert.equal(catalogHas(o, 'a'), true);
  assert.equal(catalogGet(o, 'b'), undefined);
  assert.deepEqual(catalogValues(null), []);
});

test('setPlatformMounted：unknown id → code unknown-platform', async () => {
  await assert.rejects(setPlatformMounted('nope', false, new Map()), (e) => e.code === 'unknown-platform');
});

test('setPlatformMounted：卸载非最后可查询平台 → 写盘 restart true', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp')]);
  const r = await setPlatformMounted('codex', false, catalog);
  assert.deepEqual(r, { id: 'codex', mounted: false, restart: true });
  assert.deepEqual(await loadPlatformSection(), { disabled: ['codex'], replaced: [] });
});

test('setPlatformMounted：再挂载（mounted=true）→ 清除 disabled', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp')]);
  await setPlatformMounted('codex', false, catalog);
  const r = await setPlatformMounted('codex', true, catalog);
  assert.equal(r.mounted, true);
  assert.deepEqual(await loadPlatformSection(), { disabled: [], replaced: [] });
});

test('setPlatformMounted：卸载最后一个可查询平台 → code last-platform 且不写盘', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp')]);
  // 先禁用 codex（omp 仍是唯一可查询平台）→ OK
  await setPlatformMounted('codex', false, catalog);
  // 再尝试卸载 omp → 触发守卫，剩余可查询平台为 0，且 omp 不写盘
  await assert.rejects(setPlatformMounted('omp', false, catalog), (e) => e.code === 'last-platform');
  // 磁盘状态保持 codex 已禁用（omp 未写）
  assert.deepEqual(await loadPlatformSection(), { disabled: ['codex'], replaced: [] });
});

test('setPlatformMounted：catalog 空 / 全不可查询 → last-platform', async () => {
  await assert.rejects(setPlatformMounted('x', false, new Map([['x', mkFileOnly('x')]])), (e) => {
    assert.equal(e.code, 'last-platform');
    return true;
  });
});

test('setPlatformReplaced：unknown id → code unknown-platform', async () => {
  await assert.rejects(setPlatformReplaced('nope', true, new Map()), (e) => e.code === 'unknown-platform');
});

test('setPlatformReplaced：写 replaced，disabled 保留', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp')]);
  await savePlatformSection({ disabled: ['omp'], replaced: [] });
  const r = await setPlatformReplaced('codex', true, catalog);
  assert.deepEqual(r, { id: 'codex', replaced: true, restart: true });
  assert.deepEqual(await loadPlatformSection(), { disabled: ['omp'], replaced: ['codex'] });
  // unreplace
  const r2 = await setPlatformReplaced('codex', false, catalog);
  assert.equal(r2.replaced, false);
  assert.deepEqual(await loadPlatformSection(), { disabled: ['omp'], replaced: [] });
});

test('applyPlatformSection：一次批量应用 disabled/replaced，单次写盘', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp'), mklistable('hermes')]);
  const r = await applyPlatformSection({ disabled: ['codex', 'hermes'], replaced: ['omp'] }, catalog);
  assert.equal(r.restart, true);
  assert.deepEqual(await loadPlatformSection(), { disabled: ['codex', 'hermes'], replaced: ['omp'] });
});

test('applyPlatformSection：null 列表保持不变，只应用非 null 一侧', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp')]);
  await savePlatformSection({ disabled: ['omp'], replaced: [] });
  const r = await applyPlatformSection({ disabled: null, replaced: ['codex'] }, catalog);
  assert.deepEqual(await loadPlatformSection(), { disabled: ['omp'], replaced: ['codex'] });
  assert.deepEqual(r.disabled, ['omp']);
});

test('applyPlatformSection：unknown id → code unknown-platform 且零写盘', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp')]);
  await assert.rejects(applyPlatformSection({ disabled: ['nope'] }, catalog), (e) => {
    assert.equal(e.code, 'unknown-platform');
    return true;
  });
  assert.deepEqual(await loadPlatformSection(), { disabled: [], replaced: [] });
});

test('applyPlatformSection：批量停用全部可查询平台 → last-platform 且零写盘（原子）', async () => {
  const catalog = makeCatalog([mklistable('codex'), mklistable('omp'), mklistable('hermes')]);
  // 先已有 codex 被禁用 → 再批量停用 omp+hermes 会把全部可查询平台停光 → 整体拒绝
  await savePlatformSection({ disabled: ['codex'], replaced: [] });
  await assert.rejects(applyPlatformSection({ disabled: ['codex', 'omp', 'hermes'] }, catalog), (e) => {
    assert.equal(e.code, 'last-platform');
    return true;
  });
  // 零写盘：磁盘保持 codex 已禁用，omp/hermes 未被半写
  assert.deepEqual(await loadPlatformSection(), { disabled: ['codex'], replaced: [] });
});
