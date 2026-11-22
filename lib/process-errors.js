'use strict';
// 进程级异常策略（design-logging §5.5 的补充）：未捕获异常 / 未处理 rejection 统一写
// app 日志。**控制台管道断开（EPIPE）不是程序错误**——Android 薄服务在调试桥/控制台
// 断开后写日志会得到 EPIPE，若按默认语义 exit(1)，会陷入重启风暴（并撞 EADDRINUSE）。
// 因此 EPIPE 只记日志、进程继续运行；其它异常保持 Node 默认语义（退出码 1）。
//
// 与 lib/logging.js 的分工：logging 负责「写入侧」不因 EPIPE 抛出（镜像 + stdio 监听），
// 本模块负责「进程兜底」不因漏网的 EPIPE 退出。
const log = require('./logging');

/**
 * 处理一条进程级错误：记 app 日志；断开类错误不退出，其余退出码 1。
 * @param {'uncaught exception'|'unhandled rejection'} kind
 * @param {unknown} error
 * @param {{logger?: object, exit?: (code: number) => void}} [deps] 供测试注入
 * @returns {'ignored'|'fatal'}
 */
function createProcessErrorHandler({ logger = log, exit = (code) => process.exit(code) } = {}) {
  return function handleProcessError(kind, error) {
    const detail = error instanceof Error ? error.stack || error.message : String(error);
    logger.app.error(kind, { error: detail });
    if (log.isBrokenPipeError(error)) return 'ignored';
    logger.close();
    exit(1);
    return 'fatal';
  };
}

/** 注册进程级兜底（server.js / bin/thin-server.js 共用；幂等由调用方保证只调一次）。 */
function installProcessErrorHandlers() {
  const handle = createProcessErrorHandler();
  process.on('uncaughtException', (error) => handle('uncaught exception', error));
  process.on('unhandledRejection', (reason) => handle('unhandled rejection', reason));
}

module.exports = {
  createProcessErrorHandler,
  installProcessErrorHandlers,
  isBrokenPipeError: log.isBrokenPipeError,
};
