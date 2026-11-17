'use strict';
// dsh 配置（settings.json 的 dsh section，design-dsh-host-connection「数据模型」）：
//   { role, serverUrl, email, passwordEnc, deviceName, allowedPorts }
// - role：本机角色（host=只被连 / client=只去连 / both=两者皆可，默认 both）。
// - serverUrl：中继服务器地址（默认官方 https://dsh.r2049.cn，可改自托管）。
// - email/passwordEnc：中继服务器账号；密码经 lib/secret.js AES-256-GCM 加密落盘，
//   GET /api/settings 只回 hasPassword，绝不回明文（对齐 llm.apiKey / ssh.identityKeyEnc）。
// - deviceName：本机在中继服务器上的设备名（默认本机 hostname 短名）。
// - allowedPorts：被连接方放行的本机端口（默认 [3800] = AgentLRay 默认端口）。
const os = require('os');
const { readSettings, saveSections } = require('../settings');
const { encrypt, decrypt } = require('../secret');

const DEFAULT_SERVER_URL = 'https://dsh.r2049.cn';
const DEFAULT_ALLOWED_PORTS = [3800];
const ROLES = ['host', 'client', 'both'];

/** 本机 hostname 短名（去域后缀）——dsh 设备名默认值。 */
function defaultDeviceName() {
  const name = (os.hostname() || '').split('.')[0].trim();
  return name || 'agentlray';
}

function normalizePorts(value) {
  if (value === undefined || value === null) return [...DEFAULT_ALLOWED_PORTS];
  if (!Array.isArray(value)) throw new Error('dsh.allowedPorts 必须是数组');
  const ports = [];
  for (const item of value) {
    const port = Number(item);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('dsh.allowedPorts 需为 1–65535 的整数');
    }
    if (!ports.includes(port)) ports.push(port);
  }
  return ports;
}

function normalizeServerUrl(value) {
  const url = String(value || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) throw new Error('dsh.serverUrl 需以 http:// 或 https:// 开头');
  return url.replace(/\/+$/, '');
}

/**
 * 读取 dsh 配置（存储值 + 默认值）。
 * 返回体含 passwordEnc（内部使用）与 hasPassword（对外展示用，不含明文）。
 */
async function loadDshSettings() {
  const stored = (await readSettings()).dsh || {};
  const role = ROLES.includes(stored.role) ? stored.role : 'both';
  return {
    role,
    serverUrl: stored.serverUrl ? String(stored.serverUrl) : DEFAULT_SERVER_URL,
    email: typeof stored.email === 'string' ? stored.email : '',
    passwordEnc: typeof stored.passwordEnc === 'string' ? stored.passwordEnc : '',
    deviceName: typeof stored.deviceName === 'string' && stored.deviceName.trim() ? stored.deviceName.trim() : defaultDeviceName(),
    allowedPorts: normalizePorts(stored.allowedPorts),
    hasPassword: Boolean(stored.passwordEnc),
  };
}

/**
 * 保存 dsh 配置（部分更新）。
 * password 语义与 llm.apiKey 一致：未传 = 保留；'' = 清除；非空 = 替换（加密落盘）。
 */
async function saveDshSettings(patch) {
  const current = await loadDshSettings();
  const next = { ...current };
  if (patch.role !== undefined) {
    if (!ROLES.includes(patch.role)) throw new Error(`dsh.role 需为 ${ROLES.join(' / ')}`);
    next.role = patch.role;
  }
  if (patch.serverUrl !== undefined) {
    const url = normalizeServerUrl(patch.serverUrl);
    if (!url) throw new Error('dsh.serverUrl 不能为空');
    next.serverUrl = url;
  }
  if (patch.email !== undefined) next.email = String(patch.email || '').trim();
  if (patch.deviceName !== undefined) {
    const name = String(patch.deviceName || '').trim();
    if (!name) throw new Error('dsh.deviceName 不能为空');
    next.deviceName = name;
  }
  if (patch.allowedPorts !== undefined) next.allowedPorts = normalizePorts(patch.allowedPorts);
  if (patch.password !== undefined) {
    const plain = String(patch.password || '');
    next.passwordEnc = plain ? await encrypt(plain) : '';
  }
  await saveSections({
    dsh: {
      role: next.role,
      serverUrl: next.serverUrl,
      email: next.email,
      passwordEnc: next.passwordEnc,
      deviceName: next.deviceName,
      allowedPorts: next.allowedPorts,
    },
  });
  return { ...next, hasPassword: Boolean(next.passwordEnc) };
}

/** 取中继服务器账号密码（解密）。未配置 → 返回 null（调用方给出可读提示）。 */
async function loadDshCredentials() {
  const cfg = await loadDshSettings();
  if (!cfg.email || !cfg.passwordEnc) return null;
  let password;
  try {
    password = await decrypt(cfg.passwordEnc);
  } catch {
    return null;
  }
  return { email: cfg.email, password };
}

module.exports = {
  DEFAULT_SERVER_URL,
  DEFAULT_ALLOWED_PORTS,
  ROLES,
  defaultDeviceName,
  loadDshSettings,
  saveDshSettings,
  loadDshCredentials,
};
