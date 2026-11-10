'use strict';
// 统一设置文件 ~/.agentlray/settings.json：section 原子合并写。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// settings.js 的 SETTINGS_FILE 在 require 时基于 HOME 求值 → 先设临时 HOME。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
process.env.HOME = tmpHome;
const { SETTINGS_FILE, saveSections } = require('../lib/settings');

async function readSettingsFile() {
  return JSON.parse(await fsp.readFile(SETTINGS_FILE, 'utf8'));
}

test('saveSections 只改写传入 section，未涉及 section 保留', async () => {
  await saveSections({ ui: { platform: 'omp', selectedPlatforms: ['omp'] } });
  await saveSections({ kanban: { maxPerStatus: 50 } });
  const onDisk = await readSettingsFile();
  assert.deepEqual(onDisk.ui, { platform: 'omp', selectedPlatforms: ['omp'] });
  assert.deepEqual(onDisk.kanban, { maxPerStatus: 50 });
  assert.equal(typeof onDisk.updatedAt, 'string');
});

test('saveUiSettings 浅合并 ui section：平台选择变化不覆盖其他 ui 键', async () => {
  const { saveUiSettings } = require('../lib/ui-settings');
  await saveSections({ ui: { platform: 'omp', selectedPlatforms: ['omp'], openclawDir: '/data/openclaw' } });
  await saveUiSettings({ platform: 'codex', selectedPlatforms: ['codex', 'omp'] });
  const onDisk = await readSettingsFile();
  assert.deepEqual(onDisk.ui, {
    openclawDir: '/data/openclaw',
    platform: 'codex',
    selectedPlatforms: ['codex', 'omp'],
  });
});

test('saveUiSettings 部分更新：只写 platform 不改 selectedPlatforms，反之亦然', async () => {
  const { saveUiSettings } = require('../lib/ui-settings');
  await saveSections({ ui: { platform: 'omp', selectedPlatforms: ['omp', 'codex'] } });
  // 设置面板「默认平台」只写 platform → 多选不受影响。
  await saveUiSettings({ platform: 'claude-code' });
  let onDisk = await readSettingsFile();
  assert.equal(onDisk.ui.platform, 'claude-code');
  assert.deepEqual(onDisk.ui.selectedPlatforms, ['omp', 'codex']);
  // 侧栏 persistState 只写 selectedPlatforms → 默认平台不受影响。
  await saveUiSettings({ selectedPlatforms: ['codex'] });
  onDisk = await readSettingsFile();
  assert.equal(onDisk.ui.platform, 'claude-code');
  assert.deepEqual(onDisk.ui.selectedPlatforms, ['codex']);
  // 空 patch 不改任何键。
  await saveUiSettings({});
  onDisk = await readSettingsFile();
  assert.equal(onDisk.ui.platform, 'claude-code');
  assert.deepEqual(onDisk.ui.selectedPlatforms, ['codex']);
});
