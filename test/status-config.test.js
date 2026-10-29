'use strict';
// 状态时间配置：~/.agentlray/settings.json 的 status section 持久化 + setStatusConfig
// 注入对 deriveStatus 判定的影响（web 设置面板 / CLI 启动注入）。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  STATUS,
  DEFAULT_RECENT_ACTIVITY_MS,
  DEFAULT_ACTIVE_WORK_CEIL_MS,
  DEFAULT_HISTORY_CEIL_MS,
  deriveStatus,
  setStatusConfig,
  getStatusConfig,
  resetStatusConfig,
} = require('../lib/status');

// settings.json 在 require 时基于 HOME 求值 → 先设临时 HOME。
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'status-config-test-'));
process.env.HOME = tmpHome;
const {
  STATUS_DEFAULTS,
  loadStatusConfig,
  saveStatusConfig,
} = require('../lib/status-config');

const NOW = Date.parse('2026-10-23T04:00:00.000Z');
const minAgo = (min) => NOW - min * 60 * 1000;

test('默认配置 = 2min / 30min / 12h（毫秒）', () => {
  assert.deepEqual(STATUS_DEFAULTS, {
    recentActivityMs: 2 * 60 * 1000,
    activeWorkCeilMs: 30 * 60 * 1000,
    historyCeilMs: 12 * 60 * 60 * 1000,
  });
  assert.equal(DEFAULT_RECENT_ACTIVITY_MS, 2 * 60 * 1000);
  assert.equal(DEFAULT_ACTIVE_WORK_CEIL_MS, 30 * 60 * 1000);
  assert.equal(DEFAULT_HISTORY_CEIL_MS, 12 * 60 * 60 * 1000);
});

test('未配置时 loadStatusConfig 返回空对象，getStatusConfig 回退默认窗口', async () => {
  assert.deepEqual(await loadStatusConfig(), {});
  assert.deepEqual(getStatusConfig(), {
    recentActivityMs: DEFAULT_RECENT_ACTIVITY_MS,
    activeWorkCeilMs: DEFAULT_ACTIVE_WORK_CEIL_MS,
    historyCeilMs: DEFAULT_HISTORY_CEIL_MS,
  });
});

test('saveStatusConfig 落盘并白名单过滤；非法值清除回退默认', async () => {
  const saved = await saveStatusConfig({
    recentActivityMs: 5 * 60 * 1000,
    activeWorkCeilMs: 0, // 非正数 → 清除
    historyCeilMs: 'nope', // 非数字 → 忽略
    bogus: 999, // 非白名单 → 忽略
  });
  assert.deepEqual(saved, { recentActivityMs: 5 * 60 * 1000 });

  // 磁盘 settings.json 的 status section 只含白名单
  const onDisk = JSON.parse(await fsp.readFile(path.join(tmpHome, '.agentlray', 'settings.json'), 'utf8'));
  assert.deepEqual(Object.keys(onDisk.status).sort(), ['recentActivityMs']);
  assert.equal(onDisk.status.recentActivityMs, 5 * 60 * 1000);

  // 重新 load 读回
  assert.deepEqual(await loadStatusConfig(), { recentActivityMs: 5 * 60 * 1000 });
});

test('setStatusConfig 注入影响 deriveStatus 判定（working 上界扩展）', () => {
  // 会话最后一次活动 40 分钟前：默认 ACTIVE_WORK_CEIL=30min → 判定 waiting。
  const tail = { lastPromptAt: new Date(minAgo(40)).toISOString(), lastAssistantAt: new Date(minAgo(40)).toISOString() };
  const meta = { lastActivity: new Date(minAgo(40)).toISOString() };

  resetStatusConfig();
  assert.equal(deriveStatus(tail, meta, NOW), STATUS.WAITING);

  // 扩展 ACTIVE_WORK_CEIL 到 60min → 40min 前仍判 working。
  setStatusConfig({ activeWorkCeilMs: 60 * 60 * 1000 });
  assert.equal(deriveStatus(tail, meta, NOW), STATUS.WORKING);

  // 显式 opts 优先于注入值：opts 传 30min → 回到 waiting。
  assert.equal(
    deriveStatus(tail, meta, NOW, { activeWorkCeilMs: 30 * 60 * 1000 }),
    STATUS.WAITING
  );

  resetStatusConfig();
  assert.equal(deriveStatus(tail, meta, NOW), STATUS.WAITING);
});

test('setStatusConfig 非法值被忽略，不污染缓存', () => {
  setStatusConfig({ recentActivityMs: -5, activeWorkCeilMs: 'x', historyCeilMs: 0 });
  assert.deepEqual(getStatusConfig(), {
    recentActivityMs: DEFAULT_RECENT_ACTIVITY_MS,
    activeWorkCeilMs: DEFAULT_ACTIVE_WORK_CEIL_MS,
    historyCeilMs: DEFAULT_HISTORY_CEIL_MS,
  });
  resetStatusConfig();
});
