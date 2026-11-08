'use strict';
// 平台控制端点 API 测试（GET /api/platforms + PUT/DELETE mount + PUT/DELETE replace）
//  - GET 列出 7 个内置 + 挂载态/配置态/restartRequired 字段
//  - PUT mount 停用 → 写盘，重启后生效（返回 restart:true，同进程 list 仍 mounted）
//  - DELETE mount 逐一停用 → 最后一个可查询平台 → 422
//  - 未知平台 → 404
//  - PUT/DELETE replace 写盘往返
//  - 停用后 GET configured:true 反映配置态（configuredMounted=false, restartRequired=true）
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, getJson, sendJson } = require('./helpers');

test('platform 控制端点：GET 列表含 7 内置 + 形状', async () => {
  const srv = await startServer();
  try {
    const list = await getJson(srv.base, '/api/platforms');
    const ids = list.filter((p) => !p.broken).map((p) => p.id);
    assert.deepEqual(ids, ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini', 'hermes']);
    for (const p of list.filter((x) => !x.broken)) {
      assert.equal(p.builtin, true);
      assert.equal(p.mounted, true);
      assert.equal(p.configuredMounted, true);
      assert.equal(p.restartRequired, false);
      assert.equal(typeof p.capabilities.list, 'boolean');
      assert.equal(typeof p.color, 'string');
    }
    // openclaw 无 resume/create/bin；codex 有
    const openclaw = list.find((p) => p.id === 'openclaw');
    assert.equal(openclaw.resume, false);
    assert.equal(openclaw.create, false);
    assert.equal(openclaw.bin, null);
    const codex = list.find((p) => p.id === 'codex');
    assert.equal(codex.resume, true);
    assert.equal(codex.create, true);
    assert.equal(codex.bin, 'codex');
  } finally {
    await srv.stop();
  }
});

test('platform 控制端点：PUT mount 停用 → 重启后生效', async () => {
  const srv = await startServer();
  try {
    const r = await sendJson(srv.base, 'PUT', '/api/platforms/codex/mount', { mounted: false });
    assert.equal(r.id, 'codex');
    assert.equal(r.mounted, false);
    assert.equal(r.restart, true);
    // GET configured:true → codex 配置态未挂载 + restartRequired
    const list = await getJson(srv.base, '/api/platforms');
    const codex = list.find((p) => p.id === 'codex');
    assert.equal(codex.configuredMounted, false);
    assert.equal(codex.restartRequired, true);
    // 其它平台不受影响
    assert.equal(list.find((p) => p.id === 'omp').configuredMounted, true);
  } finally {
    await srv.stop();
  }
});

test('platform 控制端点：DELETE mount 再挂载恢复', async () => {
  const srv = await startServer();
  try {
    await sendJson(srv.base, 'DELETE', '/api/platforms/codex/mount');
    const r = await sendJson(srv.base, 'PUT', '/api/platforms/codex/mount', { mounted: true });
    assert.equal(r.mounted, true);
    const list = await getJson(srv.base, '/api/platforms');
    assert.equal(list.find((p) => p.id === 'codex').configuredMounted, true);
  } finally {
    await srv.stop();
  }
});

test('platform 控制端点：停用最后一个可查询平台 → 422', async () => {
  const srv = await startServer();
  try {
    // P2 会话核心面泛化后 openclaw 适配器新增 listForAgent/listAllAgents hook，
    // openclaw 变为可查询平台（isQueryable 判定 list||listForAgent||listAllAgents）。
    // 因此全部 7 个平台均可查询：逐一停用前 6 个 OK，停用第 7 个（openclaw）时
    // 剩余可查询平台为 0 → 422（守卫「不可禁用最后一个可查询平台」）。
    const disableOk = ['codex', 'claude-code', 'omp', 'dsh', 'gemini', 'hermes'];
    for (const id of disableOk) {
      await sendJson(srv.base, 'DELETE', `/api/platforms/${id}/mount`);
    }
    await sendJson(srv.base, 'DELETE', '/api/platforms/openclaw/mount', undefined, 422);
  } finally {
    await srv.stop();
  }
});

test('platform 控制端点：未知平台 → 404', async () => {
  const srv = await startServer();
  try {
    await sendJson(srv.base, 'PUT', '/api/platforms/nope/mount', { mounted: false }, 404);
    await sendJson(srv.base, 'DELETE', '/api/platforms/nope/mount', undefined, 404);
    await sendJson(srv.base, 'PUT', '/api/platforms/nope/replace', {}, 404);
  } finally {
    await srv.stop();
  }
});

test('platform 控制端点：PUT/DELETE replace 往返写盘', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const srv = await startServer();
  try {
    const readSettings = () => {
      try {
        return JSON.parse(fs.readFileSync(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8'));
      } catch {
        return {};
      }
    };
    // PUT replace → 写盘 replaced：[codex]
    const r = await sendJson(srv.base, 'PUT', '/api/platforms/codex/replace', { replaced: true });
    assert.equal(r.id, 'codex');
    assert.equal(r.replaced, true);
    assert.equal(r.restart, true);
    assert.deepEqual(readSettings().platforms, { disabled: [], replaced: ['codex'] });
    // 撤销 → 清空 replaced
    const r2 = await sendJson(srv.base, 'DELETE', '/api/platforms/codex/replace');
    assert.equal(r2.replaced, false);
    assert.deepEqual(readSettings().platforms, { disabled: [], replaced: [] });
  } finally {
    await srv.stop();
  }
});
