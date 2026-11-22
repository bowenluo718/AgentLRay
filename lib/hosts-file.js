'use strict';
// hosts.json 整文件读写共享层（无上游依赖，供 lib/hosts.js 与 lib/dsh/settings.js 共用）。
// - 职责：整文件对象的原子读写，不关心 hosts 数组或 dsh 字段语义。
// - 权限：0600——hosts.json 含私钥密文（identityKeyEnc）与 dsh 密码密文（passwordEnc）。
// - 结构：{ hosts: [], dsh?: {}, updatedAt }。dsh 为顶层 section（本机 dsh 账号/角色配置）。
//
// 并发：所有写入串行化（单进程内 promise 队列）。此前多个读-改-写并发（连接后记忆主机、
// 保存 dsh 设置、主机 CRUD）都用固定 `${HOSTS_FILE}.tmp`，会互相覆盖或 rename ENOENT。
// 需要「读最新 → 改 → 写」的调用方一律用 updateHostsFileJson，避免基于旧快照覆盖新写入。
const path = require('path');
const fsp = require('fs/promises');
const { HOME } = require('./config');

const HOSTS_FILE = path.join(HOME, '.agentlray', 'hosts.json');

// 写队列：保证同一时刻只有一个写入在跑（read-modify-write 也在队列内执行）。
let writeQueue = Promise.resolve();
// 临时文件名递增序号：即便出现队列外的并发写，也不会撞同一个 tmp 路径。
let tmpSeq = 0;

function enqueue(task) {
  const run = writeQueue.then(task, task);
  // 队列本身吞掉异常，避免一次失败阻断后续写入（异常仍返回给本次调用方）。
  writeQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** 读整文件对象（缺失/损坏 → {}）。 */
async function readHostsFileJson() {
  try {
    const parsed = JSON.parse(await fsp.readFile(HOSTS_FILE, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** 原子写整文件（tmp + rename，0600）。崩溃绝不截断。须在写队列内调用。 */
async function writeNow(data) {
  await fsp.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
  tmpSeq += 1;
  const tmpPath = `${HOSTS_FILE}.${process.pid}.${tmpSeq}.tmp`;
  try {
    await fsp.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tmpPath, HOSTS_FILE);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return data;
}

/** 原子写整文件（排队执行）。 */
function writeHostsFileJson(data) {
  return enqueue(() => writeNow(data));
}

/**
 * 读-改-写：在写队列内读取最新文件、交给 mutate 生成新对象后原子写回。
 * mutate 返回 undefined/null 表示不写（无变更）。
 * @param {(file: object) => object | null | undefined | Promise<object | null | undefined>} mutate
 */
function updateHostsFileJson(mutate) {
  return enqueue(async () => {
    const file = await readHostsFileJson();
    const next = await mutate(file);
    if (next === undefined || next === null) return file;
    return writeNow(next);
  });
}

module.exports = { HOSTS_FILE, readHostsFileJson, writeHostsFileJson, updateHostsFileJson };
