'use strict';
// 进程级异常策略（Android 现场：调试桥/控制台管道断开 → EPIPE → uncaughtException →
// process.exit(1) → 重启风暴 + EADDRINUSE）。规则：
// - 控制台管道断开不是程序错误：记日志后继续运行；
// - 其它未捕获异常保持 Node 默认语义（退出码 1）。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { isBrokenPipeError, createProcessErrorHandler } = require('../lib/process-errors');

function pipeError(code) {
  const error = new Error(`${code}: write EPIPE`);
  error.code = code;
  return error;
}

function fakeLogger() {
  const calls = { error: [], close: 0 };
  return {
    calls,
    app: {
      error: (message, fields) => calls.error.push({ message, fields }),
    },
    close: () => {
      calls.close += 1;
    },
  };
}

test('isBrokenPipeError：识别 EPIPE 与已销毁/已结束的流', () => {
  assert.equal(isBrokenPipeError(pipeError('EPIPE')), true);
  assert.equal(isBrokenPipeError(pipeError('ERR_STREAM_DESTROYED')), true);
  assert.equal(isBrokenPipeError(pipeError('ERR_STREAM_WRITE_AFTER_END')), true);
  assert.equal(isBrokenPipeError(pipeError('ECONNRESET')), false);
  assert.equal(isBrokenPipeError(new Error('boom')), false);
  assert.equal(isBrokenPipeError(null), false);
});

test('createProcessErrorHandler：EPIPE 只记日志，不关闭日志、不退出进程', () => {
  const logger = fakeLogger();
  let exits = 0;
  const handle = createProcessErrorHandler({ logger, exit: () => (exits += 1) });

  const outcome = handle('uncaught exception', pipeError('EPIPE'));

  assert.equal(outcome, 'ignored');
  assert.equal(exits, 0);
  assert.equal(logger.calls.close, 0);
  assert.equal(logger.calls.error.length, 1);
  assert.match(logger.calls.error[0].message, /uncaught exception/);
});

test('createProcessErrorHandler：unhandledRejection 的 EPIPE 同样不退出', () => {
  const logger = fakeLogger();
  let exits = 0;
  const handle = createProcessErrorHandler({ logger, exit: () => (exits += 1) });

  assert.equal(handle('unhandled rejection', pipeError('EPIPE')), 'ignored');
  assert.equal(exits, 0);
  assert.equal(logger.calls.error[0].fields.error.includes('EPIPE'), true);
});

test('createProcessErrorHandler：其它未捕获异常按原语义退出码 1', () => {
  const logger = fakeLogger();
  const exits = [];
  const handle = createProcessErrorHandler({ logger, exit: (code) => exits.push(code) });

  assert.equal(handle('uncaught exception', new Error('boom')), 'fatal');
  assert.deepEqual(exits, [1]);
  assert.equal(logger.calls.close, 1);
  assert.equal(logger.calls.error.length, 1);
});

test('子进程：stdout 管道被读端关闭后仍继续运行（真实 EPIPE 路径）', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-epipe-proc-'));
  const projectRoot = path.join(__dirname, '..');
  const script = `
    process.env.AGENTLRAY_LOG_DIR = ${JSON.stringify(logDir)};
    process.env.AGENTLRAY_LOG_CONSOLE = '1';
    const log = require(${JSON.stringify(path.join(projectRoot, 'lib', 'logging'))});
    const { installProcessErrorHandlers } = require(${JSON.stringify(path.join(projectRoot, 'lib', 'process-errors'))});
    installProcessErrorHandlers();
    let n = 0;
    const timer = setInterval(() => log.app.info('tick ' + (++n)), 20);
    setTimeout(() => {
      clearInterval(timer);
      log.app.info('still alive');
      process.exit(0);
    }, 700);
  `;
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise((resolve) => child.on('exit', resolve));
  // 让子进程先写几条，再断开 stdout 读端，后续写入必然 EPIPE。
  await new Promise((resolve) => setTimeout(resolve, 200));
  child.stdout.destroy();
  const code = await exited;
  try {
    assert.equal(code, 0, `进程不应因 EPIPE 退出（stderr: ${stderr}）`);
    const file = fs.readdirSync(logDir).find((name) => /^app-\d{4}-\d{2}-\d{2}\.log$/.test(name));
    assert.ok(file, '子进程应写出 app 日志');
    assert.match(fs.readFileSync(path.join(logDir, file), 'utf8'), /still alive/);
  } finally {
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
