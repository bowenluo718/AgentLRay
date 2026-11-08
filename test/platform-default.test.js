'use strict';
// lib/platforms/index.js defaultPlatformId() 测试：
//  - 空配置（无 settings platforms section）→ 返回第一个已挂载平台 = openclaw
//    （与既有「req.query.platform || 'openclaw'」零回归）
//  - 默认会话/洞察/提示词/尾随路由在未传 platform 时回落 defaultPlatformId()
//
// defaultPlatformId 在 require 期基于 settings platforms section 一次性求值
// （重启后生效）。为验证「不同配置 → 不同默认平台」且不污染其它测试的 HOME，
// 用子进程在隔离 HOME 下 require lib/platforms 分别断言空配置与「首个平台被禁用」
// 两种场景。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

function runInIsolated(settingsJson) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-default-'));
  if (settingsJson) {
    fs.mkdirSync(path.join(home, '.agentlray'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agentlray', 'settings.json'), JSON.stringify(settingsJson));
  }
  const script = `
    process.env.HOME = ${JSON.stringify(home)};
    process.env.AGENTLRAY_PLATFORMS_DIR = ${JSON.stringify(path.join(home, '.empty-user'))};
    process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = ${JSON.stringify(path.join(REPO_ROOT, 'platforms'))};
    const { defaultPlatformId, PLATFORMS, listPlatformInfo } = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'platforms'))});
    console.log(JSON.stringify({ default: defaultPlatformId(), platforms: Object.keys(PLATFORMS) }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('defaultPlatformId：空配置 → openclaw（首个已挂载平台）', () => {
  const out = runInIsolated(null);
  assert.equal(out.default, 'openclaw');
  assert.deepEqual(out.platforms, ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini', 'hermes']);
});

test('defaultPlatformId：首个平台被禁用（replaced）→ 回落到下一个已挂载平台', () => {
  // 替换 openclaw 不开箱即写 PLATFORMS（重启生效）；这里模拟「配置了 disabled 且
  // 重启后 require」的最终态：disabled openclaw → 默认平台为 codex
  const out = runInIsolated({ platforms: { disabled: ['openclaw'], replaced: [] } });
  assert.equal(out.default, 'codex');
  assert.deepEqual(out.platforms, ['codex', 'claude-code', 'omp', 'dsh', 'gemini', 'hermes']);
});

test('defaultPlatformId：listPlatformInfo 反映挂载/配置/重启差异于空配置一致', () => {
  // 空配置下无差异：mounted === configuredMounted === true，restartRequired false
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-default-info-'));
  const script = `
    process.env.HOME = ${JSON.stringify(home)};
    process.env.AGENTLRAY_PLATFORMS_DIR = ${JSON.stringify(path.join(home, '.empty-user'))};
    process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = ${JSON.stringify(path.join(REPO_ROOT, 'platforms'))};
    const { defaultPlatformId, listPlatformInfo } = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'platforms'))});
    const info = listPlatformInfo();
    console.log(JSON.stringify({
      default: defaultPlatformId(),
      mounted: info.filter((p) => !p.broken && p.mounted).length,
      configured: info.filter((p) => !p.broken && p.configuredMounted).length,
      restart: info.filter((p) => !p.broken && p.restartRequired).length,
      broken: info.filter((p) => p.broken).length,
    }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, `subprocess failed: ${r.stderr}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.default, 'openclaw');
  assert.equal(out.mounted, 7);
  assert.equal(out.configured, 7);
  assert.equal(out.restart, 0);
  assert.equal(out.broken, 0);
});
