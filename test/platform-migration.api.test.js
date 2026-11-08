'use strict';
// 平台迁移（export → 重启/重新加载 → API 生效）端到端测试：
//  - 用 CLI `platform export codex` 把包内置导出到用户平台目录 + 默认 replace
//  - 重启 server 后 GET /api/platforms → codex origin=user 且 overrides=package
//  - /api/codex/sessions 可用（迁移后仍可查询会话）
//  - 删除导出文件并撤销 replace（重置）后，回落包内置 replacementPending/origin=package
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { startServer, getJson } = require('./helpers');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'agentlray.js');

function runExport(home, userPlatformsDir) {
  return spawnSync(process.execPath, [BIN, 'platform', 'export', 'codex'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      AGENTLRAY_HOME: home,
      AGENTLRAY_PLATFORMS_DIR: userPlatformsDir,
      AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, '.empty-project'),
    },
  });
}

test('export 后重启：/api/platforms origin=user overrides=package，/api/codex/sessions 可用', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-migrate-'));
  const userPlatformsDir = path.join(home, '.agentlray', 'platforms');
  fs.mkdirSync(userPlatformsDir, { recursive: true });

  const r = runExport(home, userPlatformsDir);
  assert.equal(r.status, 0, r.stderr);

  const srv = await startServer({
    HOME: home,
    AGENTLRAY_PLATFORMS_DIR: userPlatformsDir,
    AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, '.empty-project'),
  });
  try {
    const list = await getJson(srv.base, '/api/platforms');
    const codex = list.find((p) => p.id === 'codex');
    assert.ok(codex, 'codex 应存在于平台列表');
    assert.equal(codex.origin, 'user');
    assert.equal(codex.overrides, 'package');
    assert.equal(codex.broken, false);
    assert.equal(codex.builtin, false);

    // 导出后仍可查询会话
    const sessions = await getJson(srv.base, '/api/codex/sessions');
    assert.ok(Array.isArray(sessions));
  } finally {
    await srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('删除导出文件并撤销 replace → 回落包内置（origin=package, replacementPending）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-reset-'));
  const userPlatformsDir = path.join(home, '.agentlray', 'platforms');
  fs.mkdirSync(userPlatformsDir, { recursive: true });

  const r = runExport(home, userPlatformsDir);
  assert.equal(r.status, 0, r.stderr);

  // 删除导出文件（但 replaced 声明仍在）→ 下次加载回落包内置并标记 replacementPending
  fs.rmSync(path.join(userPlatformsDir, 'codex.js'));

  const srv = await startServer({
    HOME: home,
    AGENTLRAY_PLATFORMS_DIR: userPlatformsDir,
    AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, '.empty-project'),
  });
  try {
    const list = await getJson(srv.base, '/api/platforms');
    const codex = list.find((p) => p.id === 'codex');
    assert.ok(codex);
    assert.equal(codex.origin, 'package'); // 回落包内置
    // replaced 声明仍在但文件已删 → replacementPending
    assert.equal(codex.replacementPending, true);
    assert.equal(codex.broken, false);
  } finally {
    await srv.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
});
