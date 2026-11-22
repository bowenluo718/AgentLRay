'use strict';
// 控制台镜像的 EPIPE 防护：app 日志同时镜像 console。Android 调试桥/控制台管道断开后，
// 镜像写入会抛 EPIPE —— 绝不能让它反过来打断业务（此前会经 uncaughtException 退出进程）。
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const log = require('../lib/logging');

let tmpRoot;
let logDir;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-log-epipe-'));
  logDir = path.join(tmpRoot, 'logs');
  process.env.AGENTLRAY_LOG_DIR = logDir;
  process.env.AGENTLRAY_LOG_CONSOLE = '1';
  process.env.AGENTLRAY_LOG_LEVEL = 'trace';
  log.close();
});

afterEach(() => {
  log.close();
  delete process.env.AGENTLRAY_LOG_CONSOLE;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('控制台镜像抛 EPIPE 时仍写入文件，且不向调用方抛出', () => {
  const realLog = console.log;
  const error = new Error('EPIPE: broken pipe');
  error.code = 'EPIPE';
  console.log = () => {
    throw error;
  };
  try {
    assert.doesNotThrow(() => log.app.info('mirror epipe', { probe: 1 }));
  } finally {
    console.log = realLog;
  }
  const file = path.join(logDir, `app-${log.localDate()}.log`);
  assert.match(fs.readFileSync(file, 'utf8'), /mirror epipe/);
});

test('控制台镜像开启时给 stdout/stderr 装且只装一次管道错误监听', () => {
  log.app.info('first mirror write');
  const after = {
    out: process.stdout.listenerCount('error'),
    err: process.stderr.listenerCount('error'),
  };
  assert.ok(after.out >= 1, 'stdout 应装管道错误监听');
  assert.ok(after.err >= 1, 'stderr 应装管道错误监听');
  log.app.info('second mirror write');
  assert.equal(process.stdout.listenerCount('error'), after.out, '重复写入不得重复安装监听');
  assert.equal(process.stderr.listenerCount('error'), after.err, '重复写入不得重复安装监听');
});

test('stdout 的管道错误监听吞掉 EPIPE、不改变其它错误', () => {
  log.app.info('install guards');
  const epipe = new Error('EPIPE: broken pipe');
  epipe.code = 'EPIPE';
  assert.doesNotThrow(() => process.stdout.emit('error', epipe));
});
