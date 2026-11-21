'use strict';
// 日志能力（design-logging / ADR-0009）验证：
// - require 期零副作用 / 首次调用懒初始化；
// - 三类文件 boot/app/access 按天生成 + first-run 标记 + 统一行格式；
// - 级别过滤、跨天切换、保留清理、脱敏（字段黑名单 + query 强制脱敏）；
// - AGENTLRAY_LOG_DIR 优先于 AGENTLRAY_HOME；目录 0700 / 文件 0600；
// - 访问中间件端到端只记本机入口且 query 脱敏；写操作白名单只记字段名。
const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const express = require('express');

const log = require('../lib/logging');
const { logWrite } = require('../lib/routes/log-helper');

let tmpRoot;
let logDir;

// 每个用例独立隔离目录并重置 logger 懒初始化状态（close 后下次调用按新 env 重读）。
beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-log-'));
  logDir = path.join(tmpRoot, 'logs');
  process.env.AGENTLRAY_LOG_DIR = logDir;
  delete process.env.AGENTLRAY_HOME;
  delete process.env.AGENTLRAY_LOG_KEEP_DAYS;
  process.env.AGENTLRAY_LOG_LEVEL = 'trace';
  process.env.AGENTLRAY_LOG_CONSOLE = '0';
  log.close();
});

afterEach(() => {
  log.close();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function readLog(category, date = log.localDate()) {
  return fs.readFileSync(path.join(logDir, `${category}-${date}.log`), 'utf8');
}

/** 在假「当前时间」下同步执行 fn（覆盖 global.Date；子进程外仅本用例进程生效）。 */
function withFakeNow(iso, fn) {
  const RealDate = global.Date;
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(iso);
      else super(...args);
    }
    static now() {
      return new RealDate(iso).getTime();
    }
  }
  global.Date = FakeDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

test('require 期零副作用：require 不建目录/不开流，首次 log.* 才懒初始化', () => {
  const reqDir = path.join(tmpRoot, 'req-test-logs');
  const loggingPath = require.resolve('../lib/logging');
  const script = `
    const fs = require('fs');
    const log = require(${JSON.stringify(loggingPath)});
    const dir = process.env.AGENTLRAY_LOG_DIR;
    if (fs.existsSync(dir)) { console.error('目录在 require 期就被创建'); process.exit(2); }
    log.app.info('init');
    log.close();
    if (!fs.existsSync(dir)) { console.error('首次 log 调用未初始化目录'); process.exit(3); }
    process.exit(0);
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    env: { ...process.env, AGENTLRAY_LOG_DIR: reqDir, AGENTLRAY_LOG_CONSOLE: '0' },
  });
  assert.equal(res.status, 0, res.stderr?.toString());
});

test('first-run 标记 + 三类文件按天生成 + 统一行格式', () => {
  log.init({ version: '1.2.3', platforms: ['codex', 'claude-code'] });
  log.boot.info('boot', { port: 3800 });
  log.app.info('event', { k: 'v' });
  log.access.info('http request', { method: 'GET', path: '/api/x', status: 200, ms: 5, host: 'local' });
  log.close();

  const today = log.localDate();
  for (const category of ['boot', 'app', 'access']) {
    assert.ok(fs.existsSync(path.join(logDir, `${category}-${today}.log`)), `缺少 ${category} 文件`);
  }
  // first-run 标记含版本/平台目录/时间。
  const boot = readLog('boot');
  assert.match(boot, /\[info\] \[boot\] first-run \{"version":"1\.2\.3","platforms":\["codex","claude-code"\],"firstRunAt":/);
  assert.match(boot, /\[info\] \[boot\] boot \{"port":3800\}/);
  // 统一行格式：[ISO时间] [级别] [类别] 消息 {字段}。
  assert.match(boot, /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] \[info\] \[boot\] /m);
  assert.match(readLog('app'), /\[info\] \[app\] event \{"k":"v"\}/);
  assert.match(readLog('access'), /\[info\] \[access\] http request \{"method":"GET","path":"\/api\/x","status":200,"ms":5,"host":"local"\}/);
});

test('非首次初始化不再重复写 first-run 标记', () => {
  fs.mkdirSync(logDir, { recursive: true });
  log.init({ version: '1.0.0', platforms: [] });
  log.boot.info('boot');
  log.close();
  const boot = readLog('boot');
  assert.match(boot, /\[info\] \[boot\] boot/);
  assert.doesNotMatch(boot, /first-run/);
});

test('级别过滤：AGENTLRAY_LOG_LEVEL=warn 仅保留 warn/error', () => {
  process.env.AGENTLRAY_LOG_LEVEL = 'warn';
  log.app.debug('msg-debug');
  log.app.info('msg-info');
  log.app.warn('msg-warn');
  log.app.error('msg-error');
  log.close();
  const app = readLog('app');
  assert.doesNotMatch(app, /msg-debug/);
  assert.doesNotMatch(app, /msg-info/);
  assert.match(app, /msg-warn/);
  assert.match(app, /msg-error/);
});

test('跨天切换：每次写入检查日期，跨天即换文件（无后台定时器）', () => {
  withFakeNow('2026-01-01T10:00:00', () => log.app.info('day1'));
  // 不 close，直接改写「当前时间」→ 下一次写入应切到新日期文件。
  withFakeNow('2026-01-02T10:00:00', () => log.app.info('day2'));
  log.close();
  const f1 = path.join(logDir, 'app-2026-01-01.log');
  const f2 = path.join(logDir, 'app-2026-01-02.log');
  assert.ok(fs.existsSync(f1));
  assert.ok(fs.existsSync(f2));
  assert.match(fs.readFileSync(f1, 'utf8'), /day1/);
  assert.match(fs.readFileSync(f2, 'utf8'), /day2/);
});

test('保留清理：启动时删除超过 KEEP_DAYS 的三类文件，保留其它文件', () => {
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, 'boot-2000-01-01.log'), 'old');
  fs.writeFileSync(path.join(logDir, 'app-2099-01-01.log'), 'future');
  fs.writeFileSync(path.join(logDir, 'notes.txt'), 'keep');
  process.env.AGENTLRAY_LOG_KEEP_DAYS = '30';
  withFakeNow('2026-01-01T00:00:00', () => log.app.info('trigger'));
  assert.ok(!fs.existsSync(path.join(logDir, 'boot-2000-01-01.log')), '过期文件应被清理');
  assert.ok(fs.existsSync(path.join(logDir, 'app-2099-01-01.log')), '未过期文件应保留');
  assert.ok(fs.existsSync(path.join(logDir, 'notes.txt')), '非三类前缀文件不得误删');
});

test('脱敏：敏感字段值替换为 ***，普通字段保留', () => {
  log.app.info('redact', {
    password: 'p@ss-word',
    token: 'tok-value',
    apiKey: 'sk-value',
    identityKey: 'IDKEY-value',
    safe: 'ok',
    nested: { secret: 'nested-secret' },
  });
  log.close();
  const app = readLog('app');
  for (const secret of ['p@ss-word', 'tok-value', 'sk-value', 'IDKEY-value', 'nested-secret']) {
    assert.ok(!app.includes(secret), `敏感值泄漏: ${secret}`);
  }
  assert.match(app, /"safe":"ok"/);
  assert.match(app, /"\*\*\*"/);
});

test('访问日志 query 脱敏：敏感参数值替换为 ***，其它参数保留', () => {
  assert.equal(log.redactQuery('/api/x?token=abc&foo=bar&password=p'), '/api/x?token=***&foo=bar&password=***');
  assert.equal(log.redactQuery('/api/x?code=xyz'), '/api/x?code=***');
  assert.equal(log.redactQuery('/api/x'), '/api/x');
});

test('写操作白名单：只记动作/target/id/字段名，不含任何字段值', () => {
  logWrite('update', 'host', 'h1', ['ssh', 'label']);
  log.close();
  const app = readLog('app');
  assert.match(app, /\[info\] \[app\] write /);
  assert.match(app, /"action":"update"/);
  assert.match(app, /"target":"host"/);
  assert.match(app, /"id":"h1"/);
  assert.match(app, /"fields":\["ssh","label"\]/);
});

test('AGENTLRAY_LOG_DIR 优先于 AGENTLRAY_HOME', () => {
  const homeDir = path.join(tmpRoot, 'home');
  process.env.AGENTLRAY_HOME = homeDir;
  log.app.info('x');
  log.close();
  assert.ok(fs.existsSync(path.join(logDir, `app-${log.localDate()}.log`)), '应写入 AGENTLRAY_LOG_DIR');
  assert.ok(!fs.existsSync(path.join(homeDir, '.agentlray', 'logs')), '不应写入 HOME 默认目录');
});

test('权限：目录 0700、文件 0600', { skip: process.platform === 'win32' }, () => {
  log.app.info('perm');
  log.close();
  assert.equal(fs.statSync(logDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(logDir, `app-${log.localDate()}.log`)).mode & 0o777, 0o600);
});

test('访问中间件端到端：只记本机入口，记录 method/path(query 脱敏)/status/ms/host', async () => {
  const app = express();
  app.use(log.createAccessMiddleware());
  app.get('/api/test', (_req, res) => res.json({ ok: true }));
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/test?token=SECRET-TOKEN&foo=bar`);
    assert.equal(res.status, 200);
    await res.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  log.close();
  const access = readLog('access');
  assert.match(access, /\[info\] \[access\] http request /);
  assert.match(access, /"path":"\/api\/test\?token=\*\*\*&foo=bar"/);
  assert.match(access, /"status":200/);
  assert.match(access, /"method":"GET"/);
  assert.match(access, /"host":"local"/);
  assert.match(access, /"ms":\d+/);
  assert.ok(!access.includes('SECRET-TOKEN'), '访问日志 query 中的敏感值不得明文落盘');
});
