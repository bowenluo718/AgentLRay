'use strict';
// 静态凭据加密存取（对齐 design-ssh-password 的密钥设计）：把 llm.apiKey 等
// 敏感值加密落盘，磁盘上只存密文 token，不落明文。密钥文件 ~/.agentlray/secret
// 首启自动生成 32 字节随机密钥（0600）；拿到本机文件的攻击者仍可解（等同明文
// 安全性），但低于明文落盘，防磁盘泄露/备份扫描。无新增依赖（node:crypto）。
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const { HOME } = require('./config');

const SECRET_FILE = path.join(HOME, '.agentlray', 'secret');
const KEY_BYTES = 32; // aes-256-gcm

async function loadKey() {
  try {
    const key = await fsp.readFile(SECRET_FILE);
    if (key.length === KEY_BYTES) return key;
  } catch {
    /* 缺失/不可读 → 走生成 */
  }
  // 生成：O_EXCL（flag 'wx'）原子创建防首启并发竞态——两个并发请求若各自随机生成
  // 不同 key 再覆盖写，会导致先加密的 token 解不开。创建冲突（已被并发写入）则重读。
  await fsp.mkdir(path.dirname(SECRET_FILE), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const key = crypto.randomBytes(KEY_BYTES);
    try {
      await fsp.writeFile(SECRET_FILE, key, { mode: 0o600, flag: 'wx' });
      return key;
    } catch {
      /* 已存在（并发首启）或不可写 → 重读既有 */
    }
    const existing = await fsp.readFile(SECRET_FILE);
    if (existing.length === KEY_BYTES) return existing;
  }
  throw new Error(`无法初始化密钥文件: ${SECRET_FILE}`);
}

// 格式：v1:<iv hex>:<tag hex>:<ct hex>
async function encrypt(plain) {
  const key = await loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ct.toString('hex')}`;
}

// 解密失败（secret 文件变化/损坏/token 格式错）→ 抛错，调用方决定降级策略。
async function decrypt(token) {
  const key = await loadKey();
  const parts = String(token).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('secret token 格式错误');
  }
  const iv = Buffer.from(parts[1], 'hex');
  const tag = Buffer.from(parts[2], 'hex');
  const ct = Buffer.from(parts[3], 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = {
  SECRET_FILE,
  encrypt,
  decrypt,
};
