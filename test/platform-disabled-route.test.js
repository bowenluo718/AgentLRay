'use strict';
// 停用平台的会话端点：catalog 有、PLATFORMS 无（settings.platforms.disabled）时应给出
// 结构化 404（platformIssue.code=disabled + 待生效项数），而不是让前端只看到「无会话」。
// PLATFORMS 的挂载态在 require 期确定，故整体在子进程内构造加载结果再断言端点形状。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const FIXTURE = path.join(__dirname, 'platform-disabled-route.fixture.cjs');

function run(enableCodex) {
  const env = { ...process.env };
  // 夹具默认强制 gemini 未挂载；对照组（enableCodex）不施加该构造。
  if (!enableCodex) env.AGENTLRAY_FORCE_DISABLED_GEMINI = '1';
  delete env.AGENTLRAY_NO_PLUGINS;
  const out = spawnSync(process.execPath, ['--require', './test/setup-env.cjs', FIXTURE], {
    env,
    encoding: 'utf8',
  });
  assert.equal(out.status, 0, out.stderr);
  return JSON.parse(out.stdout.trim().split('\n').pop());
}

test('停用平台（catalog 有、未挂载）→ 会话端点结构化 404', () => {
  const res = run(false);
  // 未挂载平台的任一 /api/<id> 路径：结构化 404，提示「已在平台管理中停用」。
  assert.equal(res.geminiSessions.status, 404);
  assert.equal(res.geminiSessions.body.platformIssue.code, 'disabled');
  assert.equal(typeof res.geminiSessions.body.platformIssue.restartRequired, 'boolean');
  assert.equal(res.geminiSession.status, 404);
  assert.equal(res.geminiSession.body.platformIssue.code, 'disabled');
  // 不在 catalog 的平台不新增 404（保持原有行为）。
  assert.notEqual(res.unknownSessions.status, 404);
});

test('停用平台中间件不影响已挂载平台', () => {
  const res = run(true);
  // 对照组（不施加停用构造）：gemini 的查询照常落到通用会话路由，不被中间件拦截。
  assert.equal(res.geminiSessions.status, 200);
});
