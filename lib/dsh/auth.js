'use strict';
// dsh 认证（登录/登出）——design-dsh-login-methods：
// - 多登录方式：账号密码 + 网页 OAuth 扫码（zhihu/github/google，动态发现）。
// - 账号密码不落盘：只在本次登录操作临时使用 authorizeWithAccount 注册生成 token，
//   不写入 hosts.json 的 email/passwordEnc（旧密文保留但不用）。
// - 登录态唯一判据 = token：任一 scope 的 ServerCredentialStore 有有效 token 即已登录。
// - both 角色禁扫码（官方 device-pairing 协议配对设备只能是 host，见设计 D3），只账号密码。
//
// scope：host（被连接方）/ client（出站隧道）/ probe（连接测试）。认证按角色映射到
// scope(s)：host→['host']、client→['client']、both→['host','client']。
const path = require('path');
const { HOME } = require('../config');
const vendorMod = require('./vendor');
const { identityStoreFor } = require('./identity');
const { loadDshSettings, normalizeServerUrl } = require('./settings');

/**
 * 目标中继服务器地址（design-dsh-login-methods D28–D30）：
 * - 传了 serverUrl → 按 http(s) 校验后使用（覆盖已保存值，供发现/扫码针对 draft 地址）；
 * - 未传/空 → 回退已保存的 config.serverUrl（兼容既有调用）。
 * 非法（非 http(s)）由 normalizeServerUrl 抛错，路由层映射为 400。
 */
function resolveTargetUrl(config, serverUrl) {
  const raw = serverUrl == null ? '' : String(serverUrl).trim();
  if (!raw) return config.serverUrl;
  const url = normalizeServerUrl(raw);
  if (!url) throw new Error('dsh.serverUrl 不能为空');
  return url;
}

// 每个作用域一份凭据目录（与 client.js 的 credentialDir 对齐）。
function credentialDir(scope) {
  return path.join(HOME, '.agentlray', 'dsh', scope);
}

/** 角色 → 需要授权的 scope(s)。both 同时覆盖 host+client。 */
function scopesForRole(role) {
  if (role === 'host') return ['host'];
  if (role === 'client') return ['client'];
  return ['host', 'client']; // both
}

/** 构造某 scope 的认证会话：身份 + 凭据存储 + ServerApi（不要求账号密码）。
 *  serverUrl 可选覆盖已保存地址（D28）——发现/扫码针对 draft 地址时传入。 */
async function openAuthSession(scope, serverUrl) {
  const vendor = vendorMod.loadVendor();
  const config = await loadDshSettings();
  const identities = identityStoreFor(scope);
  const identity = await identities.loadOrCreate(config.deviceName);
  const credentialStore = new vendor.serverCredentials.ServerCredentialStore(credentialDir(scope));
  // ClientServerApi 的认证方法（oauthProviders/startOAuthQrLogin/pollOAuthQrLogin/
  // authorizeWithAccount）与 HostServerApi 相同，用前者构造即可。
  const api = new vendor.serverApi.ClientServerApi(resolveTargetUrl(config, serverUrl), credentialStore);
  api.bindIdentity(identity);
  return { vendor, config, identities, identity, api, credentialStore };
}

/** 某 scope 是否已有有效设备 token（refresh 未过期）。 */
async function scopeHasToken(credentialStore, api, identity) {
  const stored = await credentialStore.load(api.baseUrl, identity.deviceId);
  return Boolean(stored && stored.refreshTokenExpiresAt > Date.now() + 30_000);
}

/**
 * 登录态判定（D5/D24）：任一 scope 有有效 token 即已登录；
 * 返回 loggedIn 布尔 + 有 token 的 scope 集合。
 */
async function scopeLoginStatus() {
  const roles = [];
  for (const scope of ['host', 'client']) {
    try {
      const { api, identity, credentialStore } = await openAuthSession(scope);
      if (await scopeHasToken(credentialStore, api, identity)) roles.push(scope);
    } catch {
      // 身份/组件异常不阻断整体判定——该 scope 视为无 token。
    }
  }
  return { loggedIn: roles.length > 0, roles };
}

/**
 * 动态发现登录方式（D2/D3）。both 禁扫码 → 返回空 providers。
 * role 可选覆盖：未登录时前端 draft.role 可能尚未落盘（改 both→host/client 后直接扫码），
 * 按 draft.role 判断可扫码性，避免读到服务端旧 role 误判（评审 P1）。
 */
async function discoverProviders(role, serverUrl) {
  const config = await loadDshSettings();
  const effectiveRole = role === 'host' || role === 'client' || role === 'both' ? role : config.role;
  if (effectiveRole === 'both') {
    return { providers: [], devicePairing: false };
  }
  // host/client 角色才发现 provider。providers 是服务器级，用任一 scope 的 api 查询即可。
  // serverUrl 可选覆盖已保存地址（D28：针对 draft 地址发现，避免读到旧服务器）。
  const { api } = await openAuthSession(effectiveRole === 'host' ? 'host' : 'client', serverUrl);
  try {
    const items = await api.oauthProviders();
    const providers = items
      .filter((item) => !item.devicePairing && item.qrStartUrl != null)
      .map((item) => ({ id: item.id, displayName: item.displayName, qrStartUrl: item.qrStartUrl }));
    return { providers, devicePairing: items.some((item) => item.devicePairing === true) };
  } catch (error) {
    // 发现失败（自托管 404 / 网络错误）→ 只回退账号密码（providers 空，前端直显账号密码）。
    return { providers: [], devicePairing: false, error: error.message };
  }
}

/** 发起扫码登录会话（D21）。返回官方形状 {qrId, scanUrl, expiresIn, provider}。
 *  serverUrl 可选覆盖已保存地址（D29），须与 pollQrLogin 传同一地址。 */
async function startQrLogin(role, provider, serverUrl) {
  if (role === 'both') throw new Error('both 角色不支持扫码登录（请使用账号密码）');
  const scope = role === 'host' ? 'host' : 'client';
  const { api } = await openAuthSession(scope, serverUrl);
  const session = await api.startOAuthQrLogin(provider || 'zhihu');
  return { qrId: session.qrId, scanUrl: session.scanUrl, expiresIn: session.expiresIn, provider: provider || 'zhihu' };
}

/**
 * 轮询扫码登录结果（D21）。complete 时 token 由上游 pollOAuthQrLogin 内部 register()
 * 写入该 role scope 的 ServerCredentialStore。
 */
async function pollQrLogin(role, qrId, serverUrl) {
  const scope = role === 'host' ? 'host' : 'client';
  const { api, identity } = await openAuthSession(scope, serverUrl);
  const result = await api.pollOAuthQrLogin(identity, qrId);
  return { status: result.status };
}

/**
 * 账号密码登录（D16/D18）：对角色对应 scope(s) 调 authorizeWithAccount 注册生成 token。
 * 返回 { roles: 已登录 scope 集合 }。
 */
async function loginWithAccount(role, email, password) {
  if (!email || !password) throw new Error('账号与密码必填');
  const scopes = scopesForRole(role);
  const ok = [];
  for (const scope of scopes) {
    const { api, identity, credentialStore } = await openAuthSession(scope);
    // 幂等：该 scope 已有有效 token 则跳过重复注册。
    if (await scopeHasToken(credentialStore, api, identity)) {
      ok.push(scope);
      continue;
    }
    await api.authorizeWithAccount(identity, email, password);
    ok.push(scope);
  }
  return { roles: ok };
}

/** 退出（D7/D25）：清所有 scope 的 token，回未登录态。不清旧 email/passwordEnc。 */
async function logout() {
  // 逐 scope 用 store.clear() 清本机 token（无网络副作用，避免 revoke 请求）。
  for (const scope of ['host', 'client']) {
    try {
      const { credentialStore } = await openAuthSession(scope);
      await credentialStore.clear();
    } catch {
      // 某 scope 清理失败不阻断其它 scope。
    }
  }
  return { ok: true };
}

module.exports = {
  credentialDir,
  scopesForRole,
  openAuthSession,
  scopeHasToken,
  scopeLoginStatus,
  discoverProviders,
  startQrLogin,
  pollQrLogin,
  loginWithAccount,
  logout,
};
