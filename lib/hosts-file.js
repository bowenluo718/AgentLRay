'use strict';
// hosts.json 整文件读写共享层（无上游依赖，供 lib/hosts.js 与 lib/dsh/settings.js 共用）。
// - 职责：整文件对象的原子读写，不关心 hosts 数组或 dsh 字段语义。
// - 权限：0600——hosts.json 含私钥密文（identityKeyEnc）与 dsh 密码密文（passwordEnc）。
// - 结构：{ hosts: [], dsh?: {}, updatedAt }。dsh 为顶层 section（本机 dsh 账号/角色配置）。
const path = require('path');
const fsp = require('fs/promises');
const { HOME } = require('./config');

const HOSTS_FILE = path.join(HOME, '.agentlray', 'hosts.json');

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

/** 原子写整文件（tmp + rename，0600）。崩溃绝不截断。 */
async function writeHostsFileJson(data) {
  await fsp.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
  const tmpPath = `${HOSTS_FILE}.tmp`;
  await fsp.writeFile(
    tmpPath,
    `${JSON.stringify(data, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 }
  );
  await fsp.rename(tmpPath, HOSTS_FILE);
  return data;
}

module.exports = { HOSTS_FILE, readHostsFileJson, writeHostsFileJson };
