'use strict';
// 统一设置文件 ~/.agentlray/settings.json：section 原子合并写 + 旧独立文件的一次性
// 幂等迁移（Q3/Q-B 结论：server 与 CLI 入口各调一次 migrateLegacySettings）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// settings.js 的 SETTINGS_FILE 在 require 时基于 HOME 求值 → 先设临时 HOME。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
process.env.HOME = tmpHome;
const { SETTINGS_FILE, saveSections, migrateLegacySettings } = require('../lib/settings');

function writeLegacy(name, data) {
  fs.writeFileSync(path.join(tmpHome, '.agentlray', name), JSON.stringify(data));
}

async function readSettingsFile() {
  return JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
}

async function legacyExists(name) {
  return fsp.access(path.join(tmpHome, '.agentlray', name)).then(() => true, () => false);
}

test('saveSections 只改写传入 section，未涉及 section 保留', async () => {
  await saveSections({ ui: { platform: 'omp', selectedPlatforms: ['omp'] } });
  await saveSections({ kanban: { maxPerStatus: 50 } });
  const onDisk = await readSettingsFile();
  assert.deepEqual(onDisk.ui, { platform: 'omp', selectedPlatforms: ['omp'] });
  assert.deepEqual(onDisk.kanban, { maxPerStatus: 50 });
  assert.equal(typeof onDisk.updatedAt, 'string');
});

test('migrateLegacySettings 幂等聚合 5 个旧文件并删除原文件', async () => {
  const dir = path.join(tmpHome, '.agentlray');
  await fsp.mkdir(dir, { recursive: true });
  // 清掉上一用例残留，构造旧版独立文件全部在场。
  await fsp.rm(SETTINGS_FILE, { force: true });
  for (const name of ['ui-settings.json', 'cli-bins.json', 'status-config.json', 'kanban-config.json', 'llm.json']) {
    await fsp.rm(path.join(dir, name), { force: true });
  }
  writeLegacy('ui-settings.json', { platform: 'codex', selectedPlatforms: ['codex', 'omp'] });
  writeLegacy('cli-bins.json', { codex: '/bin/codex' });
  writeLegacy('status-config.json', { recentActivityMs: 5 * 60 * 1000 });
  writeLegacy('kanban-config.json', { maxPerStatus: 30 });
  writeLegacy('llm.json', { baseUrl: 'http://llm/v1', apiKey: 'sk-x', model: 'm1' });

  await migrateLegacySettings();

  const onDisk = await readSettingsFile();
  assert.deepEqual(onDisk.ui, { platform: 'codex', selectedPlatforms: ['codex', 'omp'] });
  assert.deepEqual(onDisk.cliBins, { codex: '/bin/codex' });
  assert.deepEqual(onDisk.status, { recentActivityMs: 5 * 60 * 1000 });
  assert.deepEqual(onDisk.kanban, { maxPerStatus: 30 });
  assert.deepEqual(onDisk.llm, { baseUrl: 'http://llm/v1', apiKey: 'sk-x', model: 'm1' });

  for (const name of ['ui-settings.json', 'cli-bins.json', 'status-config.json', 'kanban-config.json', 'llm.json']) {
    assert.equal(await legacyExists(name), false, `${name} 应在迁移成功后删除`);
  }

  // 幂等：settings.json 已存在 → 第二次调用不动作，内容不变。
  const before = await readSettingsFile();
  await migrateLegacySettings();
  assert.deepEqual(await readSettingsFile(), before);
});

test('migrateLegacySettings 无任何旧文件则不建 settings.json', async () => {
  const dir = path.join(tmpHome, '.agentlray');
  await fsp.rm(SETTINGS_FILE, { force: true });
  for (const name of ['ui-settings.json', 'cli-bins.json', 'status-config.json', 'kanban-config.json', 'llm.json']) {
    await fsp.rm(path.join(dir, name), { force: true });
  }
  await migrateLegacySettings();
  assert.equal(await fsp.access(SETTINGS_FILE).then(() => true, () => false), false, '无旧配置时不应创建空文件');
});
