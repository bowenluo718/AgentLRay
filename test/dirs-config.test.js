'use strict';
// 平台数据目录配置（~/.agentlray/settings.json 的 dirs section）单元测试：
//  - 白名单：仅接受已挂载且声明 dirSettingKey 的平台键，未知键忽略
//  - 校验：非绝对路径 / 含 '..' 的目录值清除回退默认
//  - 优先级（Q11-B）：env 生效 > settings dirs 配置 > 平台 defaultDir 默认段
//  - dirForPlatform 单一出口：env 生效时忽略配置目录
//
// env 优先级测试需要 CODEX_DIR 在 require 期前注入（平台 defaultDir() 在 require
// 期即把 env 合并进常量），故在文件顶部设 CODEX_DIR；omp 不设 env 用以覆盖
// 「配置目录生效」分支。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// settings.json / 平台 defaultDir 在 require 时基于 HOME 与 env 求值 → 先设隔离。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dirs-config-test-'));
process.env.HOME = tmpHome;
// codex 的 env 生效（用于验证 env 优先、配置忽略）；其余平台不设 env。
process.env.CODEX_DIR = path.join(tmpHome, 'env-codex');

const { dirSettingKeys, isValidDir, dirForPlatform, saveDirsConfig } = require('../lib/dirs-config');

test('白名单只含已挂载且声明 dirSettingKey 的平台键', () => {
  const keys = dirSettingKeys();
  const known = ['openclawDir', 'codexDir', 'claudeCodeDir', 'ompDir', 'dshDir'];
  for (const k of known) assert.equal(keys[k], true, `白名单应含 ${k}`);
  assert.equal(keys.bogusDir, undefined);
});

test('isValidDir：仅接受绝对路径且不含 ..', () => {
  assert.equal(isValidDir('/a/b'), true);
  assert.equal(isValidDir('relative/path'), false);
  assert.equal(isValidDir('/a/../b'), false);
  assert.equal(isValidDir(''), false);
});

test('codex env 生效 → dirForPlatform 返回 env 路径，配置目录被忽略（env > 配置）', async () => {
  const platform = require('../lib/platforms').PLATFORMS.codex;
  // 无配置时 = defaultDir()（含 env 合并）
  assert.equal(dirForPlatform(platform), platform.defaultDir());
  assert.ok(platform.defaultDir().startsWith(process.env.CODEX_DIR), 'defaultDir 应含 env 路径');

  // 即便写入配置，env 生效平台也忽略（dirForPlatform 走 defaultDir）
  await saveDirsConfig({ codexDir: '/configured/codex' });
  assert.equal(dirForPlatform(platform), platform.defaultDir());
  assert.notEqual(dirForPlatform(platform), '/configured/codex');
});

test('omp 无 env → 配置目录生效（设置目录覆盖默认段）', async () => {
  const { PLATFORMS } = require('../lib/platforms');
  const platform = PLATFORMS.omp;
  const dflt = platform.defaultDir();

  // 未配置 → 默认段
  assert.equal(dirForPlatform(platform), dflt);

  // 配置绝对路径 → 覆盖默认段
  await saveDirsConfig({ ompDir: '/data/omp-sessions' });
  assert.equal(dirForPlatform(platform), '/data/omp-sessions');

  // 空串清除 → 回退默认段
  await saveDirsConfig({ ompDir: '' });
  assert.equal(dirForPlatform(platform), dflt);
});

test('非法目录值（相对 / 含 .. / 非字符串）清除回退默认，未知键忽略', async () => {
  const { PLATFORMS } = require('../lib/platforms');
  const platform = PLATFORMS.omp;
  const dflt = platform.defaultDir();

  for (const bad of ['relative/path', '/a/../b', 123, null]) {
    await saveDirsConfig({ ompDir: bad });
    assert.equal(dirForPlatform(platform), dflt, `非法值应清除：${JSON.stringify(bad)}`);
  }
  // 未知键（非白名单）不产生任何写入副作用
  const saved = await saveDirsConfig({ bogusDir: '/whatever' });
  assert.equal(saved.ompDir, undefined);
});

test('saveDirsConfig 落盘 settings.json 的 dirs section 且只保留合法键', async () => {
  const fsp = require('node:fs/promises');
  await saveDirsConfig({ ompDir: '/data/omp' });
  const onDisk = JSON.parse(
    await fsp.readFile(path.join(tmpHome, '.agentlray', 'settings.json'), 'utf8')
  );
  assert.equal(onDisk.dirs.ompDir, '/data/omp');
  // env 生效平台（codex）的配置在 save 时被丢弃（不落盘）
  assert.equal(onDisk.dirs.codexDir, undefined);
});
