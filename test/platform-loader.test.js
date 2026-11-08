'use strict';
// lib/platforms/loader.js 三来源（package / project / user）单测：loadPlatformSources
//  - package 固定序（openclaw, codex, claude-code, omp, dsh, gemini, hermes）
//  - project + user 目录按文件名序追加；同 id 冲突规则（同源重复 broken /
//    project|user 覆盖 package 需 replaced / user 覆盖 project 允许）
//  - AGENTLRAY_NO_PLUGINS=1 → 只保留 package + 逃生 broken
//  - validateAdapter 独立校验（bad id / 缺必需函数 / label 非字符串 / 同 id 占用）
//
// loader 在 require 期按 HOME 定 PLATFORM_DIR、设 AGENTLRAY_PKG_ROOT；目录 env
// 在每次 loadPlatformSources 调用时读取 → 测试先设 HOME，并各自覆盖
// AGENTLRAY_PROJECT_PLATFORMS_DIR / AGENTLRAY_PLATFORMS_DIR 指向本测试临时目录。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-loader2-'));
process.env.HOME = tmpHome;

const { validateAdapter, loadPlatformSources, ID_RE } = require('../lib/platforms/loader');

const projectDir = path.join(tmpHome, 'proj', 'platforms');
const userDir = path.join(tmpHome, '.agentlray', 'platforms');

function writeAdapter(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  delete require.cache[file];
  fs.writeFileSync(file, `module.exports = ${body};\n`);
  return file;
}

const PACKAGE = [
  'openclaw',
  'codex',
  'claude-code',
  'omp',
  'dsh',
  'gemini',
  'hermes',
].map((id) => ({ id, defaultDir: () => `/tmp/${id}`, getSession: async () => null, label: id }));

function run(opts = {}) {
  process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = projectDir;
  process.env.AGENTLRAY_PLATFORMS_DIR = userDir;
  const prev = process.env.AGENTLRAY_NO_PLUGINS;
  if (opts.noPlugins) process.env.AGENTLRAY_NO_PLUGINS = '1';
  else delete process.env.AGENTLRAY_NO_PLUGINS;
  const r = loadPlatformSources({ packageAdapters: PACKAGE, disabled: opts.disabled, replaced: opts.replaced });
  if (prev === undefined) delete process.env.AGENTLRAY_NO_PLUGINS;
  else process.env.AGENTLRAY_NO_PLUGINS = prev;
  return r;
}

function clearSources() {
  fs.rmSync(projectDir, { recursive: true, force: true });
  fs.rmSync(userDir, { recursive: true, force: true });
}

test('空配置基线：仅 package，固定序，无 broken', () => {
  clearSources();
  const { catalog, broken } = run();
  assert.deepEqual([...catalog.keys()], ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini', 'hermes']);
  assert.equal(broken.length, 0);
  for (const [id, entry] of catalog) {
    assert.equal(entry.origin, 'package');
    assert.equal(entry.adapter.id, id);
    assert.equal(entry.replacementPending, false);
  }
});

test('user 自定义平台：追加到末尾，origin=user', () => {
  clearSources();
  writeAdapter(userDir, 'co-mind.js', `{ id: 'co-mind', defaultDir: () => '/tmp/co-mind', getSession: async () => null, label: 'CoMind' }`);
  const { catalog, broken } = run();
  assert.deepEqual([...catalog.keys()], [...PACKAGE.map((p) => p.id), 'co-mind']);
  assert.equal(catalog.get('co-mind').origin, 'user');
  assert.equal(broken.length, 0);
});

test('project + user 来源均加载，project 在前', () => {
  clearSources();
  writeAdapter(projectDir, 'a-p.js', `{ id: 'a-p', defaultDir: () => '/tmp/a-p', getSession: async () => null, label: 'Pi' }`);
  writeAdapter(userDir, 'b-u.js', `{ id: 'b-u', defaultDir: () => '/tmp/b-u', getSession: async () => null, label: 'Ui' }`);
  const { catalog } = run();
  assert.deepEqual([...catalog.keys()], [...PACKAGE.map((p) => p.id), 'a-p', 'b-u']);
  assert.equal(catalog.get('a-p').origin, 'project');
  assert.equal(catalog.get('b-u').origin, 'user');
});

test('同来源重复 id：后加载者 broken，先加载者保留', () => {
  clearSources();
  writeAdapter(userDir, 'a-u.js', `{ id: 'dup', defaultDir: () => '/tmp/a', getSession: async () => null, label: 'A' }`);
  writeAdapter(userDir, 'b-u.js', `{ id: 'dup', defaultDir: () => '/tmp/b', getSession: async () => null, label: 'B' }`);
  const { catalog, broken } = run();
  assert.equal(catalog.get('dup').adapter.label, 'A');
  assert.equal(broken.length, 1);
  assert.match(broken[0].error, /id 已被占用：dup/);
  assert.equal(broken[0].origin, 'user');
});

test('project/user 覆盖 package：未声明 replaced → broken（提示先 export/replace）', () => {
  clearSources();
  writeAdapter(userDir, 'codex.js', `{ id: 'codex', defaultDir: () => '/tmp/cx', getSession: async () => null, label: 'MyCodex' }`);
  const { catalog, broken } = run();
  // 包内置保留，user 版 broken
  assert.equal(catalog.get('codex').origin, 'package');
  assert.equal(broken.length, 1);
  assert.match(broken[0].error, /id 已被占用：codex。请先 agentlray platform export <id> 或 platform replace <id>/);
});

test('project/user 覆盖 package：声明了 replaced → 覆盖生效，overrides=package', () => {
  clearSources();
  writeAdapter(userDir, 'codex.js', `{ id: 'codex', defaultDir: () => '/tmp/cx', getSession: async () => null, label: 'MyCodex' }`);
  const { catalog, broken } = run({ replaced: ['codex'] });
  assert.equal(catalog.get('codex').origin, 'user');
  assert.equal(catalog.get('codex').overrides, 'package');
  assert.equal(catalog.get('codex').adapter.label, 'MyCodex');
  assert.equal(broken.length, 0);
});

test('user 覆盖 project：允许，overrides=project', () => {
  clearSources();
  writeAdapter(projectDir, 'p.js', `{ id: 'custom', defaultDir: () => '/tmp/p', getSession: async () => null, label: 'FromP' }`);
  writeAdapter(userDir, 'u.js', `{ id: 'custom', defaultDir: () => '/tmp/u', getSession: async () => null, label: 'FromU' }`);
  const { catalog, broken } = run();
  assert.equal(catalog.get('custom').origin, 'user');
  assert.equal(catalog.get('custom').overrides, 'project');
  assert.equal(catalog.get('custom').adapter.label, 'FromU');
  assert.equal(broken.length, 0);
});

test('replaced 声明但无覆盖文件 → 包内置保留，replacementPending=true', () => {
  clearSources();
  const { catalog, broken } = run({ replaced: ['hermes'] });
  assert.equal(catalog.get('hermes').origin, 'package');
  assert.equal(catalog.get('hermes').replacementPending, true);
  assert.equal(broken.length, 0);
});

test('加载抛错的文件 → broken（含 error），好文件不受影响', () => {
  clearSources();
  writeAdapter(userDir, 'boom.js', `(() => { throw new Error('boom-in-require'); })();`);
  writeAdapter(userDir, 'ok.js', `{ id: 'okp', defaultDir: () => '/tmp/ok', getSession: async () => null, label: 'Ok' }`);
  const { catalog, broken } = run();
  assert.equal(catalog.get('okp').origin, 'user');
  assert.equal(broken.length, 1);
  assert.equal(broken[0].file, 'boom.js');
  assert.match(broken[0].error, /boom-in-require/);
});

test('AGENTLRAY_NO_PLUGINS=1：只保留 package，含逃生 broken', () => {
  clearSources();
  writeAdapter(userDir, 'co-mind.js', `{ id: 'co-mind', defaultDir: () => '/tmp/co-mind', getSession: async () => null, label: 'CoMind' }`);
  const { catalog, broken } = run({ noPlugins: true });
  assert.deepEqual([...catalog.keys()], PACKAGE.map((p) => p.id));
  assert.equal(broken.length, 1);
  assert.match(broken[0].error, /AGENTLRAY_NO_PLUGINS=1/);
});

test('disabled 不影响 catalog 合并，仅由 index.js 决定是否挂载', () => {
  clearSources();
  const { catalog } = run({ disabled: ['codex'] });
  assert.deepEqual([...catalog.keys()], PACKAGE.map((p) => p.id));
});

test('validateAdapter：id 非法 / 缺必需函数 / label 非字符串', () => {
  const bad = validateAdapter({ id: 'Bad', defaultDir: () => '', getSession: async () => null, label: 'x' });
  assert.equal(bad.ok, undefined);
  assert.match(bad.error, /id 不合法/);
  const ok = validateAdapter({ id: 'ok', defaultDir: () => '', getSession: async () => null, label: 'x' });
  assert.equal(ok.ok, true);
  assert.match(validateAdapter({ id: 'x', label: 'y' }).error, /缺少必需函数 defaultDir/);
  assert.match(validateAdapter({ id: 'x', defaultDir: () => '', getSession: async () => null }).error, /label 必须是字符串/);
});

test('validateAdapter：同 id 占用（未声明 replaced）→ broken 提示', () => {
  const registry = new Map([['codex', { id: 'codex', origin: 'package', defaultDir: () => '', getSession: async () => null, label: 'codex' }]]);
  const r = validateAdapter({ id: 'codex', defaultDir: () => '', getSession: async () => null, label: 'dup' }, registry);
  assert.match(r.error, /id 已被占用/);
  // 声明 replaced → 允许
  const r2 = validateAdapter({ id: 'codex', defaultDir: () => '', getSession: async () => null, label: 'dup' }, registry, { replaced: new Set(['codex']) });
  assert.equal(r2.ok, true);
});

test('ID_RE 契约：小写字母/数字开头，仅小写/数字/连字符', () => {
  assert.match('co-mind', ID_RE);
  assert.match('a1', ID_RE);
  assert.doesNotMatch('Co-mind', ID_RE);
  assert.doesNotMatch('co_mind', ID_RE);
  assert.doesNotMatch('-mind', ID_RE);
  assert.doesNotMatch('co mind', ID_RE);
});

test('子目录平台 <id>/index.js 由 loader 加载，辅助文件（parse.js 等）不产生独立平台', () => {
  clearSources();
  const platDir = path.join(userDir, 'myplat');
  fs.mkdirSync(platDir, { recursive: true });
  fs.writeFileSync(path.join(platDir, 'parse.js'), '// 内聚辅助文件，不应被单独加载为平台\n');
  fs.writeFileSync(
    path.join(platDir, 'index.js'),
    `module.exports = { id: 'myplat', defaultDir: () => '/tmp/myplat', getSession: async () => null, label: 'MyPlat' };\n`
  );
  const { catalog, broken } = run();
  const entry = catalog.get('myplat');
  assert.ok(entry, '子目录平台应加载');
  assert.equal(entry.origin, 'user');
  assert.equal(entry.adapter.label, 'MyPlat');
  assert.equal(broken.length, 0, '辅助文件 parse.js 不应产生 broken');
  assert.ok(catalog.has('myplat'));
  // 只产出一个 myplat，parse.js 不作为独立 id
  assert.equal([...catalog.keys()].filter((k) => k === 'myplat').length, 1);
});

test('同名冲突：<id>.js 单文件与 <id>/index.js 子目录并存 → 子目录优先，无重复、无虚假 broken', () => {
  clearSources();
  // 在同一 user 目录放置 foo.js 与 foo/index.js（目录按字典序先于 foo.js 枚举，
  // 恰好命中「目录先枚举、单文件后枚举」的路径）。
  const platDir = userDir; // user 来源目录
  fs.mkdirSync(platDir, { recursive: true });
  fs.writeFileSync(path.join(platDir, 'foo.js'), "module.exports = { id: 'foo', defaultDir: () => '/file', getSession: async () => null, label: 'Foo File' };\n");
  fs.mkdirSync(path.join(platDir, 'foo'), { recursive: true });
  fs.writeFileSync(path.join(platDir, 'foo', 'index.js'), "module.exports = { id: 'foo', defaultDir: () => '/dir', getSession: async () => null, label: 'Foo Dir' };\n");
  const { catalog, broken } = run();
  const foo = catalog.get('foo');
  assert.ok(foo, 'foo 应加载');
  assert.equal(foo.adapter.label, 'Foo Dir', '子目录形态应优先');
  assert.equal([...catalog.keys()].filter((k) => k === 'foo').length, 1, '同 id 只产出一条');
  assert.equal(broken.length, 0, '不应产生单文件的虚假 broken 条目');
  // 反序：仅单文件组织形式（无同名目录）仍正常加载。
  clearSources();
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'bar.js'), "module.exports = { id: 'bar', defaultDir: () => '/bar', getSession: async () => null, label: 'Bar' };\n");
  const { catalog: c2, broken: b2 } = run();
  assert.ok(c2.get('bar'));
  assert.equal(b2.length, 0);
});

test('@agentlray/shared 裸名别名由 shared-alias 解析到外层共享目录', () => {
  const { installSharedAlias } = require('../lib/platforms/shared-alias');
  installSharedAlias();
  // 子模块（helpers）与目录入口（index）都应按别名解析到 lib/platforms/shared。
  const helpers = require('@agentlray/shared/helpers');
  const barrel = require('@agentlray/shared');
  assert.ok(helpers && typeof helpers === 'object');
  assert.ok(barrel && typeof barrel === 'object');
  // 与相对路径 require 得到同一模块实例（同引用），证明别名命中共享目录。
  const relHelpers = require('../lib/platforms/shared/helpers');
  assert.equal(helpers, relHelpers);
});
