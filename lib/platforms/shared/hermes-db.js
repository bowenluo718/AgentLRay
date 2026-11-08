'use strict';
// hermes 会话数据库读取机制（openclaw/内置 与 hermes 平台共享）。
//
// openclaw 与会话来源 hermes 都需要读取 hermes 的 SQLite 会话库（state.db）。
// 平台之间不允许相互依赖（Q9/Q10 落地），这些与平台无关的数据库机制函数聚合到
// shared，两个平台通过相对路径（或 @agentlray/shared/hermes-db 裸名）统一引用。
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
const { HERMES_DIR } = require('../../config');

function getHermesDbPath(dir) {
  const base = dir || HERMES_DIR;
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
