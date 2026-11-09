'use strict';
// hermes 会话数据库（state.db）读取机制，随 hermes 平台内聚。
// 缺省家目录取 ./dirs 的 session（HERMES_DIR 覆盖，缺省 ~/.hermes），显式传入
// dir 时以入参优先。
const fs = require('fs');
const path = require('path');
// node:sqlite 在 22.x 仍打印 ExperimentalWarning；它是服务端唯一吞掉的警告。
const originalEmitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const text = typeof warning === 'string' ? warning : warning?.message || '';
  if (text.includes('SQLite is an experimental feature')) return;
  return originalEmitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = require('node:sqlite');
const { session: HERMES_HOME } = require('./dirs');

function getHermesDbPath(dir) {
  const base = dir || HERMES_HOME;
  return path.join(base, 'state.db');
}

// node:sqlite (Node >= 22.13)：无原生编译步骤，`npm i` 不会因缺编译链失败。
// 只读打开在文件缺失时抛错，这正是调用方依赖的 fileMustExist 行为。Hermes 以
// WAL 模式写入；只读连接跟随写方日志模式，无需 pragma。
// 与 better-sqlite3 的差异调用方已容忍：`.get()` 无行返回 undefined（而非 null），
// 行是 null-prototype 对象。
function openHermesDb(dir) {
  const dbPath = getHermesDbPath(dir);
  if (!fs.existsSync(dbPath)) return null;
  try {
    return new DatabaseSync(dbPath, { readOnly: true });
  } catch {
    return null;
  }
}

// 为 SSE tail 端点打开 db：错误向上抛（watch 路由以 SSE error 事件上报）。
function openHermesDbForWatch(dbPath) {
  return new DatabaseSync(dbPath, { readOnly: true });
}

function unixToIso(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toISOString();
}

module.exports = { getHermesDbPath, openHermesDb, openHermesDbForWatch, unixToIso };
