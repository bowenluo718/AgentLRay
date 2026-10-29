'use strict';
// 任务看板配置：~/.agentlray/settings.json 的 kanban section 持久化
// （maxPerStatus 正整数白名单，默认 20）。路由级 value/configured/default 响应
// 由 test/api.test.js 的 /api/settings 用例覆盖。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

// settings.json 在 require 时基于 HOME 求值 → 先设临时 HOME。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-config-test-'));
process.env.HOME = tmpHome;

const { KANBAN_DEFAULTS, loadKanbanConfig, saveKanbanConfig } = require('../lib/kanban-config');

test('默认配置 = maxPerStatus 20', () => {
  assert.deepEqual(KANBAN_DEFAULTS, { maxPerStatus: 20 });
});

test('未配置时 loadKanbanConfig 返回空对象（全部回退默认）', async () => {
  assert.deepEqual(await loadKanbanConfig(), {});
});

test('saveKanbanConfig 落盘 settings.json 的 kanban section；白名单过滤', async () => {
  const saved = await saveKanbanConfig({ maxPerStatus: 50 });
  assert.deepEqual(saved, { maxPerStatus: 50 });

  const onDisk = JSON.parse(await fsp.readFile(path.join(tmpHome, '.agentlray', 'settings.json'), 'utf8'));
  assert.deepEqual(onDisk.kanban, { maxPerStatus: 50 });

  // 重新 load 读回
  assert.deepEqual(await loadKanbanConfig(), { maxPerStatus: 50 });
});

test('非法值（0 / 负数 / 浮点 / 缺失 / 非白名单）清除回退默认', async () => {
  for (const body of [
    { maxPerStatus: 0 },
    { maxPerStatus: -1 },
    { maxPerStatus: 1.5 },
    { maxPerStatus: '20' },
    { maxPerStatus: null },
    {},
    { bogus: 999 },
  ]) {
    const saved = await saveKanbanConfig(body);
    assert.deepEqual(saved, {}, `非法值应被清除：${JSON.stringify(body)}`);
    assert.deepEqual(await loadKanbanConfig(), {});
  }
});
