'use strict';
// dsh 配置（hosts.json 顶层 dsh section，design-dsh-host-connection「数据模型」）：
//   { role, serverUrl, deviceName, allowedPorts }
// - role：本机角色（host=只被连 / client=只去连 / both=两者皆可，默认 both）。
// - serverUrl：中继服务器地址（默认官方 https://dsh.r2049.cn，可改自托管）。
// - deviceName：本机在中继服务器上的设备名（默认本机 hostname 短名）。
// - allowedPorts：被连接方放行的本机端口（默认 [3800] = AgentLRay 默认端口）。
//
// 账号密码不落盘（design-dsh-login-methods D4）：email/password 只在登录操作临时使用，
// 不再写入 hosts.json；登录态由 token（各 scope ServerCredentialStore）承载。
//
// 存储：hosts.json 顶层 dsh section（与主机列表同文件，0600 权限）。旧版本存于
// settings.json 的 dsh section——首次读取时经 migrateDshSectionOnce 状态驱动幂等迁移。
// hosts.json 读写经 lib/hosts-file.js 共享层，避免与 lib/hosts.js 形成循环依赖。
const os = require('os');
const { readSettings } = require('../settings');
const { readHostsFileJson, writeHostsFileJson } = require('../hosts-file');

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
 * 一次性迁移（状态驱动幂等）：旧版本 dsh 配置存于 settings.json 的 dsh section，
 * 首次读取时若 hosts.json 尚无 dsh 且 settings.json 有 dsh → 拷入 hosts.json。
 * hosts.json 已有 dsh 即为权威，之后不再读取/覆盖 settings.json（幂等靠状态，
 * 不用模块级 flag——测试多次重建文件不会被内存状态卡住）。
 */
async function migrateDshSectionOnce() {
  const file = await readHostsFileJson();
  if (file.dsh) return;
  const legacy = (await readSettings()).dsh;
  if (!legacy || typeof legacy !== 'object') return;
  // 只迁移配置字段：旧 email/passwordEnc 不搬（账号密码不落盘，design-dsh-login-methods D4）。
  const migrated = {
    ...(legacy.role !== undefined ? { role: legacy.role } : {}),
    ...(legacy.serverUrl !== undefined ? { serverUrl: legacy.serverUrl } : {}),
    ...(legacy.deviceName !== undefined ? { deviceName: legacy.deviceName } : {}),
    ...(legacy.allowedPorts !== undefined ? { allowedPorts: legacy.allowedPorts } : {}),
  };
  await writeHostsFileJson({ ...file, dsh: migrated, updatedAt: new Date().toISOString() });
}

/**
 * 读取 dsh 配置（存储值 + 默认值）。账号密码不落盘 → 不含 email/passwordEnc。
 */
async function loadDshSettings() {
  await migrateDshSectionOnce();
  const stored = (await readHostsFileJson()).dsh || {};
  const role = ROLES.includes(stored.role) ? stored.role : 'both';
  return {
    role,
    serverUrl: stored.serverUrl ? String(stored.serverUrl) : DEFAULT_SERVER_URL,
    deviceName: typeof stored.deviceName === 'string' && stored.deviceName.trim() ? stored.deviceName.trim() : defaultDeviceName(),
    allowedPorts: normalizePorts(stored.allowedPorts),
  };
}

/**
 * 保存 dsh 配置（部分更新）。email/password 参数一律忽略（账号密码不落盘，D4）。
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
  if (patch.deviceName !== undefined) {
    const name = String(patch.deviceName || '').trim();
    if (!name) throw new Error('dsh.deviceName 不能为空');
    next.deviceName = name;
  }
  if (patch.allowedPorts !== undefined) next.allowedPorts = normalizePorts(patch.allowedPorts);
  // 整文件读-合并-原子写：只改写 dsh section，保留 hosts 数组等其它顶层字段。
  // dsh section 只写配置字段——旧 email/passwordEnc 若有会在本次重写时被清除。
  const file = await readHostsFileJson();
  await writeHostsFileJson({
    ...file,
    dsh: {
      role: next.role,
      serverUrl: next.serverUrl,
      deviceName: next.deviceName,
      allowedPorts: next.allowedPorts,
    },
    updatedAt: new Date().toISOString(),
  });
  return next;
}

module.exports = {
  DEFAULT_SERVER_URL,
  DEFAULT_ALLOWED_PORTS,
  ROLES,
  defaultDeviceName,
  normalizeServerUrl,
  migrateDshSectionOnce,
  loadDshSettings,
  saveDshSettings,
};
