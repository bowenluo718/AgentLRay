'use strict';
// 静态凭据加密存取（lib/secret.js + llm.apiKey 加密落盘）：密文 token 落盘、
// 明文只在内存；旧明文 apiKey 首次读取自动迁移加密。所有写盘隔离在临时 HOME。

const os = require('os');
const path = require('path');
const fsp = require('fs/promises');
const { test } = require('node:test');
const assert = require('node:assert/strict');

// 必须在 require lib 模块前隔离 HOME（config.js 加载时读 AGENTLRAY_HOME）。
process.env.AGENTLRAY_HOME = path.join(os.tmpdir(), `agentlray-secret-${process.pid}-${Date.now()}`);

const { encrypt, decrypt, SECRET_FILE } = require('../lib/secret');
const { loadLlmConfig, saveLlmConfig } = require('../lib/llm');
const { readSettings, saveSections } = require('../lib/settings');

test('secret 加密往返：密文不含明文、token 带 v1 前缀、密钥文件 0600', async () => {
  const plain = 'sk-super-secret-123';
  const token = await encrypt(plain);
  assert.ok(token.startsWith('v1:'));
  assert.ok(!token.includes(plain), 'token 不得含明文');
  assert.equal(await decrypt(token), plain);

  const st = await fsp.stat(SECRET_FILE);
  assert.equal(st.mode & 0o777, 0o600);
});

test('损坏 token 解密抛错（不静默回退）', async () => {
  await assert.rejects(() =>
    decrypt('v1:000000000000000000000000:0000000000000000:00000000000000000000000000000000')
  );
});

test('saveLlmConfig 加密落盘 apiKeyEnc、不落明文；load 解密回明文', async () => {
  await saveLlmConfig({ baseUrl: 'http://x/v1', apiKey: 'sk-secret', model: 'm' });
  const disk = await readSettings();
  assert.ok(!('apiKey' in disk.llm), '磁盘不得落明文 apiKey');
  assert.ok(typeof disk.llm.apiKeyEnc === 'string' && disk.llm.apiKeyEnc.startsWith('v1:'));
  assert.equal((await loadLlmConfig()).apiKey, 'sk-secret');
});

test('旧明文 apiKey 首次 load 迁移为密文并清除明文', async () => {
  await saveSections({ llm: { baseUrl: 'http://y/v1', apiKey: 'sk-legacy', model: 'm2' } });
  assert.equal((await loadLlmConfig()).apiKey, 'sk-legacy');
  const disk = await readSettings();
  assert.ok(!('apiKey' in disk.llm), '迁移后磁盘无明文');
  assert.ok(typeof disk.llm.apiKeyEnc === 'string');
});

test('apiKey 清空时删除 apiKeyEnc', async () => {
  await saveLlmConfig({ apiKey: '' });
  const disk = await readSettings();
  assert.ok(!('apiKeyEnc' in disk.llm) && !('apiKey' in disk.llm));
  assert.equal((await loadLlmConfig()).apiKey, '');
});

test('解密失败（secret 文件损坏）→ apiKey 降级空、apiKeyDecryptFailed=true、hasApiKey 仍 true、磁盘密文保留', async () => {
  // 先写一个正常密文。
  await saveLlmConfig({ apiKey: 'sk-real' });
  let c = await loadLlmConfig();
  assert.equal(c.apiKey, 'sk-real');
  assert.equal(c.apiKeyDecryptFailed, false);
  assert.equal(c.hasApiKey, true);

  // 损坏 secret 密钥文件 → 原密文解不开。
  await fsp.writeFile(SECRET_FILE, 'x'.repeat(32));
  c = await loadLlmConfig();
  assert.equal(c.apiKey, '', '解密失败降级为空，绝不回退明文');
  assert.equal(c.apiKeyDecryptFailed, true, '标记解密失败');
  assert.equal(c.hasApiKey, true, '磁盘仍认为已配置（避免 UI 误判未配置）');
  // 磁盘密文原样保留（不因解密失败被清除）。
  const disk = await readSettings();
  assert.ok(typeof disk.llm.apiKeyEnc === 'string');

  // 恢复密钥文件后重新可解。
  const real = await encrypt('sk-real');
  // 用原 secret 无法恢复——直接删掉坏文件重生成（loadKey 会重建）。
  await fsp.rm(SECRET_FILE, { force: true });
  const restored = await loadLlmConfig();
  assert.equal(restored.apiKeyDecryptFailed, true, '密钥文件变了，旧密文解不开属预期');
});

test('saveLlmConfig 未传 apiKey 时保留既有 apiKeyEnc（仅改 baseUrl/model 不清 key）', async () => {
  await saveLlmConfig({ baseUrl: 'http://a/v1', apiKey: 'sk-keep', model: 'm' });
  await saveLlmConfig({ baseUrl: 'http://b/v2', model: 'm2' });
  const disk = await readSettings();
  assert.ok(typeof disk.llm.apiKeyEnc === 'string', '未传 apiKey 不删密文');
  assert.equal(await decrypt(disk.llm.apiKeyEnc), 'sk-keep');
  assert.equal((await loadLlmConfig()).apiKey, 'sk-keep');
});
