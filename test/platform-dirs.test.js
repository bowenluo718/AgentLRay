'use strict';
// resolveDirs（平台目录声明解析）单测：env 覆盖 / 非法 env 回退 / altEnv 家目录
// 语义 / root home 与 agentlray 基座 / segments。防止 DSH_HOME 等 altEnv 分支回归。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');

const { resolveDirs } = require('../lib/platforms/shared/config');

function withEnv(env, fn) {
  const saved = {};
  for (const k of Object.keys(env)) saved[k] = process.env[k];
  try {
    for (const k of Object.keys(env)) {
      if (env[k] == null) delete process.env[k];
      else process.env[k] = env[k];
    }
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('resolveDirs：默认段基于 HOME（agentlray 基座，加载时锁定为 os.homedir()）', () => {
  assert.equal(resolveDirs({ segments: ['.omp', 'agent', 'sessions'] }), path.join(os.homedir(), '.omp', 'agent', 'sessions'));
});

test('resolveDirs：root home 锚定 os.homedir()（CLI 自身文件，不受 AGENTLRAY_HOME 影响）', () => {
  withEnv({ AGENTLRAY_HOME: '/base' }, () => {
    assert.equal(resolveDirs({ root: 'home', segments: ['.claude', 'history.jsonl'] }), path.join(os.homedir(), '.claude', 'history.jsonl'));
  });
});

test('resolveDirs：env 覆盖优先，非法（非绝对/含 ..）回退默认段', () => {
  withEnv({ CODEX_DIR: '/custom/codex' }, () => {
    assert.equal(resolveDirs({ env: 'CODEX_DIR', segments: ['.codex', 'sessions'] }), '/custom/codex');
  });
  withEnv({ CODEX_DIR: 'relative' }, () => {
    assert.equal(resolveDirs({ env: 'CODEX_DIR', segments: ['.codex', 'sessions'] }), path.join(os.homedir(), '.codex', 'sessions'));
  });
  withEnv({ CODEX_DIR: '/bad/../escape' }, () => {
    assert.equal(resolveDirs({ env: 'CODEX_DIR', segments: ['.codex', 'sessions'] }), path.join(os.homedir(), '.codex', 'sessions'));
  });
});

test('resolveDirs：altEnv 用家目录语义拼 altSegments（DSH_HOME 回归）', () => {
  // dsh 声明：DSH_DIR → DSH_HOME 时 dsh 根 + /sessions（不能多拼 .dsh 段）。
  const decl = { env: 'DSH_DIR', altEnv: 'DSH_HOME', segments: ['.dsh', 'sessions'], altSegments: ['sessions'] };
  withEnv({ DSH_HOME: '/home/u/dsh' }, () => {
    assert.equal(resolveDirs(decl), '/home/u/dsh/sessions');
  });
  withEnv({ DSH_DIR: null, DSH_HOME: null }, () => {
    assert.equal(resolveDirs(decl), path.join(os.homedir(), '.dsh', 'sessions'));
  });
  // altSegments 缺省回退 segments。
  withEnv({ DSH_HOME: '/home/u/dsh' }, () => {
    assert.equal(resolveDirs({ env: 'X', altEnv: 'HOME' }), path.join(os.homedir()));
  });
});

test('resolveDirs：altEnv 在 env 非空时被跳过（DSH_DIR 优先）', () => {
  const decl = { env: 'DSH_DIR', altEnv: 'DSH_HOME', segments: ['.dsh', 'sessions'], altSegments: ['sessions'] };
  withEnv({ DSH_DIR: '/x/y', DSH_HOME: '/home/u/dsh' }, () => {
    assert.equal(resolveDirs(decl), '/x/y');
  });
});
