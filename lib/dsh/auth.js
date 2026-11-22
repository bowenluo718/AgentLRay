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
const fsp = require('fs/promises');
const { HOME } = require('../config');
const vendorMod = require('./vendor');
const { identityStoreFor } = require('./identity');
const { loadDshSettings, normalizeServerUrl } = require('./settings');
const { stopDshHostService } = require('./host');
const { closeDshHosts } = require('../hosts');
const log = require('../logging');

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

/**
 * 登录后顺带注册「连接测试」身份（probe）：连接测试用独立设备身份（防顶替出站隧道），
 * 而登录只覆盖 host/client → probe 永远无凭据、/api/dsh/test 必然报登录失效。
 * 只在能出站连接（client / both）时注册；probe 有自己的身份，不参与登录态判定。
 */
function scopesToProvision(role) {
  return role === 'host' ? [] : ['probe'];
}

/**
 * 构造某 scope 的认证会话：身份 + 凭据存储 + ServerApi（不要求账号密码）。
 * serverUrl 可选覆盖已保存地址（D28）——发现/扫码针对 draft 地址时传入。
 * createIdentity=false：只读会话，不生成设备身份（退出清理 / 登录态判定用）。
 * 读路径一旦生成身份，退出时删掉的 dsh 目录会被后续的「查登录态」立即重建，
 * 出现「已退出但仍残留设备身份文件」。
 */
async function openAuthSession(scope, serverUrl, options = {}) {
  const vendor = vendorMod.loadVendor();
  const config = await loadDshSettings();
  const identities = identityStoreFor(scope);
  const identity = await (options.createIdentity === false
    ? identities.loadExisting()
    : identities.loadOrCreate(config.deviceName));
  const credentialStore = new vendor.serverCredentials.ServerCredentialStore(credentialDir(scope));
  // 设备 role 由 API 类决定（上游 deviceDescriptor 用 this.role）：host scope 必须用
  // HostServerApi 注册，否则设备在中继服务器上被登记成 client 角色 —— 而 /api/v1/devices
  // 只返回 role=host 的设备，本机就永远不出现在其它 AgentLRay 的设备列表里（现场：
  // 远程以 host 登录后，本地 client 拉设备列表始终看不到它）。
  // client/probe scope 是出站连接方，保持 ClientServerApi。
  // 两类 API 的认证方法（oauthProviders/startOAuthQrLogin/pollOAuthQrLogin/
  // authorizeWithAccount）完全相同，构造参数也一致。
  const Api = scope === 'host' ? vendor.serverApi.HostServerApi : vendor.serverApi.ClientServerApi;
  const api = new Api(resolveTargetUrl(config, serverUrl), credentialStore);
  if (identity) api.bindIdentity(identity);
  return { vendor, config, identities, identity, api, credentialStore };
}

/**
 * 服务器明确 revoke 本设备后的身份恢复函数（传给上游 authorizeWithAccount / pollOAuthQrLogin）：
 * 丢弃被 revoke 的身份、生成全新身份并更新会话中的 api 绑定。
 * 被 revoke 的 deviceId 永久不可用——不换身份则此后每次登录都被拒（现场：重登后立刻又「登录已失效」）。
 */
function identityRecovery(session, scope) {
  return async () => {
    const next = await session.identities.recreate(session.config.deviceName);
    session.api.bindIdentity(next);
    log.app.warn('dsh identity recreated', {
      scope,
      reason: 'DEVICE_REVOKED',
      deviceId: next.deviceId,
      fingerprint: next.fingerprint,
    });
    return next;
  };
}

/** 某 scope 是否已有有效设备 token（refresh 未过期）。 */
async function scopeHasToken(credentialStore, api, identity) {
  // 无设备身份 → 必然无该身份的 token（只读路径不生成身份）。
  if (!identity) return false;
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
      const { api, identity, credentialStore } = await openAuthSession(scope, undefined, { createIdentity: false });
      if (await scopeHasToken(credentialStore, api, identity)) roles.push(scope);
    } catch {
      // 身份/组件异常不阻断整体判定——该 scope 视为无 token。
    }
  }
  return { loggedIn: roles.length > 0, roles };
}

/** cause 链最多展开层数（防环 / 防异常深链）。 */
const MAX_CAUSE_DEPTH = 6;

/**
 * 沿 error.cause 链逐层展开（最多 MAX_CAUSE_DEPTH 层）。
 * 错误链形如：ServerApiError('Server request failed.') → TypeError('fetch failed') → 底层
 * （ENOTFOUND / ECONNREFUSED / ENETUNREACH / ETIMEDOUT / 证书 / bad port）。
 * @returns {Array<{name: string, code?: string, message: string}>}
 */
function causeChain(error) {
  const chain = [];
  for (let cause = error && error.cause; cause && chain.length < MAX_CAUSE_DEPTH; cause = cause.cause) {
    chain.push({ name: cause.name, code: cause.code, message: String(cause.message || '').replace(/\s+/g, ' ').trim() });
  }
  return chain;
}

/**
 * 把 dsh 网络类错误的底层原因拼成可诊断的文案（参照 lib/llm.js 的既有做法）。
 * 只读一层 cause 只能拿到无信息量的 'fetch failed'，因此用 causeChain 逐层展开。
 * 只拼底层原因，不改原始 message，保证既有断言与 UI 前缀稳定。
 * 例：Server request failed. (network_error; TypeError: fetch failed; ENETUNREACH: connect ENETUNREACH 2402:4e00::1:443)
 */
function describeNetworkError(error) {
  const parts = [];
  if (error && error.reason) parts.push(String(error.reason));
  for (const link of causeChain(error)) {
    const text = link.message ? `${link.code || link.name || 'cause'}: ${link.message}` : String(link.code || link.name || '');
    if (text && !parts.includes(text)) parts.push(text);
  }
  return parts.filter(Boolean).join('; ');
}

/** DNS 解析类错误码（glibc getaddrinfo）：无法解析中继服务器域名。 */
const DNS_ERROR_CODES = new Set(['EAI_AGAIN', 'EAI_NONAME', 'EAI_NODATA', 'ENOTFOUND', 'EAI_FAIL']);

/**
 * 把底层错误链归类成用户可理解的提示（不影响原始 message）。
 * 返回 { hint } 或 null；hint 面向 UI，用户可直接据此操作。
 */
function classifyNetworkError(error) {
  for (const link of causeChain(error)) {
    if (DNS_ERROR_CODES.has(String(link.code || ''))) {
      return { hint: '无法解析中继服务器域名，请检查手机网络或 DNS 设置' };
    }
  }
  return null;
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
    // both 禁扫码（D3）：不发起网络请求，直接回空。
    return { providers: [], devicePairing: false };
  }
  // host/client 角色才发现 provider。providers 是服务器级，用任一 scope 的 api 查询即可。
  // serverUrl 可选覆盖已保存地址（D28：针对 draft 地址发现，避免读到旧服务器）。
  // 读路径不生成身份：退出后前端渲染登录表单会调用本接口，不能在此重建设备身份文件。
  const { api } = await openAuthSession(effectiveRole === 'host' ? 'host' : 'client', serverUrl, {
    createIdentity: false,
  });
  try {
    const items = await api.oauthProviders();
    const providers = items
      .filter((item) => !item.devicePairing && item.qrStartUrl != null)
      .map((item) => ({ id: item.id, displayName: item.displayName, qrStartUrl: item.qrStartUrl }));
    log.app.info('dsh discover providers', {
      role: effectiveRole,
      serverUrl: api.baseUrl,
      providerCount: providers.length,
      providers: providers.map((p) => p.id),
      devicePairing: items.some((item) => item.devicePairing === true),
    });
    return { providers, devicePairing: items.some((item) => item.devicePairing === true) };
  } catch (error) {
    // 发现失败（自托管 404 / 网络错误）→ 只回退账号密码（providers 空，前端直显账号密码）。
    // 记底层原因：ServerApiError 的 reason + cause 链（DNS/连接/证书/超时）。
    // 只记底层 cause，不记请求头/token（敏感）。
    const detail = describeNetworkError(error);
    const chain = causeChain(error);
    log.app.warn('dsh discover providers failed', {
      role: effectiveRole,
      serverUrl: api.baseUrl,
      error: error.message,
      code: error && error.code,
      reason: error && error.reason,
      cause: chain.length === 1 ? chain[0] : chain.length > 1 ? chain : undefined,
    });
    // 透出给前端：把底层原因拼进 error，让「网络不通/超时」与「服务器拒绝」可区分。
    // 可归类时额外给出面向用户的中文 hint（如 DNS 解析失败），UI 优先展示它。
    const classified = classifyNetworkError(error);
    return {
      providers: [],
      devicePairing: false,
      error: detail ? `${error.message} (${detail})` : error.message,
      ...(classified ? { hint: classified.hint } : {}),
    };
  }
}

/** 发起扫码登录会话（D21）。返回官方形状 {qrId, scanUrl, expiresIn, provider}。
 *  serverUrl 可选覆盖已保存地址（D29），须与 pollQrLogin 传同一地址。 */
async function startQrLogin(role, provider, serverUrl) {
  if (role === 'both') throw new Error('both 角色不支持扫码登录（请使用账号密码）');
  const scope = role === 'host' ? 'host' : 'client';
  // 读路径不生成身份：发起扫码只是拿会话，身份在 pollQrLogin（登录）时才生成。
  const { api } = await openAuthSession(scope, serverUrl, { createIdentity: false });
  const session = await api.startOAuthQrLogin(provider || 'zhihu');
  // 只记请求参数（role/provider/serverUrl）与 expiresIn；不记 qrId/scanUrl（会话令牌，脱敏）。
  log.app.info('dsh qr start', {
    role,
    provider: provider || 'zhihu',
    serverUrl: api.baseUrl,
    expiresIn: session.expiresIn,
  });
  return { qrId: session.qrId, scanUrl: session.scanUrl, expiresIn: session.expiresIn, provider: provider || 'zhihu' };
}

/**
 * 轮询扫码登录结果（D21）。complete 时 token 由上游 pollOAuthQrLogin 内部 register()
 * 写入该 role scope 的 ServerCredentialStore。
 */
async function pollQrLogin(role, qrId, serverUrl) {
  const scope = role === 'host' ? 'host' : 'client';
  const session = await openAuthSession(scope, serverUrl);
  const { api, identity } = session;
  const result = await api.pollOAuthQrLogin(identity, qrId, identityRecovery(session, scope));
  // 扫码完成即已登录：顺带补注册 probe（连接测试身份），失败不影响扫码结果。
  if (result.status !== 'complete') return { status: result.status };
  // 复用本次扫码得到的账号令牌登记 probe（账号密码不落盘，不能再走账号密码登录）。
  const probe = toProbeResult(await provisionScopes(role, serverUrl, { accountToken: result.accountToken }));
  return { status: result.status, ...(probe ? { probe } : {}) };
}

/** provisionScopes 结果 → 对外形状：无 probe 需求返回 undefined；否则 { ok, code?, message? }。 */
function toProbeResult(provisioned) {
  if (provisioned.roles.length === 0 && !provisioned.error) return undefined;
  return provisioned.error ? { ok: false, ...provisioned.error } : { ok: true };
}

/**
 * 为角色顺带注册的 scope（目前只有 probe）注册设备凭据；已有有效 token 则跳过（幂等）。
 * 登记必须复用**本次登录得到的账号授权**（accountToken，仅内存传递），不能传账号密码：
 * 账号密码不落盘、也不再要求用户重输；上游 authorizeWithAccount 缺账号密码会直接抛错。
 * 没有账号授权（如 host 角色、或上游未返回令牌）→ 跳过并报明确原因，不影响主登录结果。
 * 返回 { roles: 成功的 scope, error: { code, message } | null }；失败只记日志，绝不回滚主登录结果。
 */
async function provisionScopes(role, serverUrl, authorization) {
  const roles = [];
  let failure = null;
  for (const scope of scopesToProvision(role)) {
    try {
      const { api, identity, credentialStore } = await openAuthSession(scope, serverUrl);
      if (await scopeHasToken(credentialStore, api, identity)) {
        roles.push(scope);
        continue;
      }
      if (!authorization || typeof authorization.accountToken !== 'string' || !authorization.accountToken) {
        throw Object.assign(new Error('缺少账号授权，无法登记连接测试身份'), { code: 'AUTHORIZATION_REQUIRED' });
      }
      await api.authorizeOwnedRoleWithAccount(
        identity,
        authorization.accountToken,
        authorization.account,
        identityRecovery({ api, identities: identityStoreFor(scope), config: await loadDshSettings() }, scope)
      );
      roles.push(scope);
    } catch (error) {
      failure = { code: (error && error.code) || null, message: (error && error.message) || String(error) };
      log.app.warn('dsh scope provision failed', { scope, role, code: failure.code, error: failure.message });
    }
  }
  return { roles, error: failure };
}

/** probe 是否还缺凭据（只读判定，不创建身份；host 角色无需 probe）。 */
async function probeNeedsProvisioning(serverUrl) {
  const probe = await openAuthSession('probe', serverUrl, { createIdentity: false });
  return !(await scopeHasToken(probe.credentialStore, probe.api, probe.identity));
}

/**
 * probe（连接测试）凭据自愈：probe 是派生身份（role=client），旧版本登录不会顺带登记它，
 * 现场表现为 ~/.agentlray/dsh/probe/ 凭据目录缺失 → /api/dsh/test 永远报「登录已失效」。
 *
 * 登记必须走**相反角色**的授权方：中继的 register-owned-role 明确要求
 * 「an owned-role registration must use the opposite device role」，用 client token 登记
 * client 设备会被拒（现场实测 INVALID_MESSAGE）。因此这里用本机 **host scope** 的 access
 * token 授权（owned_device，不落账号令牌、不需要账号密码）；probe 被 revoke 时重建身份重试一次。
 * 本机未以 host 登录（role=client）时无法离线登记——只能由用户重新登录一次（账号授权路径）。
 * 返回 { ok, created, error }，不抛错。
 */
async function provisionProbeFromOwner(serverUrl) {
  try {
    const owner = await openAuthSession('host', serverUrl, { createIdentity: false });
    if (!(await scopeHasToken(owner.credentialStore, owner.api, owner.identity))) {
      throw Object.assign(new Error('本机未以 host 身份登录，无法为连接测试登记独立身份'), {
        code: 'AUTHORIZATION_REQUIRED',
      });
    }
    const ownerTokens = await owner.api.authenticate(owner.identity);
    let probe = await openAuthSession('probe', serverUrl);
    if (await scopeHasToken(probe.credentialStore, probe.api, probe.identity)) {
      return { ok: true, created: false, error: null };
    }
    try {
      await probe.api.authorizeOwnedRole(probe.identity, ownerTokens.accessToken, ownerTokens.account);
    } catch (error) {
      // probe 身份被中继 revoke 时该 deviceId 永久不可用，换新身份重试一次。
      if (!error || error.code !== 'DEVICE_REVOKED') throw error;
      await probe.identities.recreate(probe.config.deviceName);
      probe = await openAuthSession('probe', serverUrl);
      await probe.api.authorizeOwnedRole(probe.identity, ownerTokens.accessToken, ownerTokens.account);
    }
    log.app.info('dsh probe credential provisioned', { reason: 'owner-token' });
    return { ok: true, created: true, error: null };
  } catch (error) {
    const failure = { code: (error && error.code) || null, message: (error && error.message) || String(error) };
    log.app.warn('dsh probe credential provision failed', failure);
    return { ok: false, created: false, error: failure };
  }
}

/**
 * 账号密码登录（D16/D18）：对角色对应 scope(s) 调 authorizeWithAccount 注册生成 token。
 * 返回 { roles: 已登录 scope 集合 }。
 */
async function loginWithAccount(role, email, password) {
  if (!email || !password) throw new Error('账号与密码必填');
  const scopes = scopesForRole(role);
  const ok = [];
  // 本次登录得到的账号授权（仅内存，用于登记 probe；不落盘、不记日志）。
  let accountToken;
  let account;
  for (const scope of scopes) {
    const session = await openAuthSession(scope);
    const { api, identity, credentialStore } = session;
    // 幂等：该 scope 已有有效 token 则跳过重复注册。
    if (await scopeHasToken(credentialStore, api, identity)) {
      ok.push(scope);
      continue;
    }
    const authorization = await api.authorizeWithAccount(
      identity,
      email,
      password,
      identityRecovery(session, scope)
    );
    // 账号授权只取本次登录返回值（PATCH：authorizeWithAccount 返回 accountToken）；不读落盘凭据。
    accountToken = authorization && authorization.accountToken;
    account = authorization && authorization.account;
    ok.push(scope);
  }
  // 旧版本升级现场：主 scope 已有有效 token → 上面的循环跳过 authorizeWithAccount，
  // 就拿不到账号授权，probe 无法登记（连接测试永远失败）。此时补做一次账号授权
  //（同一身份的重复注册幂等）；失败只记日志，不影响登录结果。
  // 仅在确实需要 probe（role !== host）且 probe 缺凭据时才补做，避免 host 登录多打一次
  // /auth/login（可能触发中继限流）。
  if (!accountToken && scopesToProvision(role).length > 0) {
    try {
      if (await probeNeedsProvisioning()) {
        const session = await openAuthSession(scopes[0]);
        const authorization = await session.api.authorizeWithAccount(
          session.identity,
          email,
          password,
          identityRecovery(session, scopes[0])
        );
        accountToken = authorization && authorization.accountToken;
        account = authorization && authorization.account;
      }
    } catch (error) {
      log.app.warn('dsh probe authorization failed', {
        role,
        code: (error && error.code) || null,
        error: (error && error.message) || String(error),
      });
    }
  }
  // 顺带注册 probe（连接测试身份）；失败不影响账号登录结果，也不改变 roles 语义（roles 只含登录 scope）。
  const probe = toProbeResult(await provisionScopes(role, undefined, { accountToken, account }));
  // 不记 email/password（敏感）。记 role、覆盖 scope 与结果 roles。
  log.app.info('dsh account login', { role, scopes, roles: ok, probeOk: probe ? probe.ok : null });
  return { roles: ok, ...(probe ? { probe } : {}) };
}

/**
 * 退出（D7/D25）：清空 `~/.agentlray/dsh/` 下所有认证连接文件（各 scope 凭据目录 +
 * 设备身份/密钥 + 对端信任库），回未登录态。无网络副作用（不发 revoke 请求）。
 * 不清旧 email/passwordEnc；dsh 配置（role/serverUrl/deviceName/allowedPorts）在 hosts.json，不受影响。
 * 下次登录按需重新生成设备身份。
 */
async function logout() {
  const dir = path.dirname(credentialDir('host')); // ~/.agentlray/dsh
  // 先停被连接方服务：常驻的 host 服务持有身份/凭据存储（会周期性刷新 token、重连），
  // 不停掉就会在删除目录后把文件重新写回去。停服不清理磁盘，不影响下面的删除。
  await stopDshHostService().catch((error) =>
    log.app.warn('dsh logout stop host failed', { error: (error && error.message) || String(error) })
  );
  // 同样先关出站/探测隧道（hosts.js 运行时持有 client/probe 会话）：隧道存活时其令牌刷新会
  // 把凭据重新写回已删除的目录，且退出后仍能转发到远端。
  closeDshHosts();
  let removed = false;
  try {
    await fsp.rm(dir, { recursive: true, force: true });
    removed = true;
  } catch (error) {
    log.app.warn('dsh logout cleanup failed', { dir, error: (error && error.message) || String(error) });
  }
  log.app.info('dsh logout', { dir, removed });
  return { ok: removed };
}

module.exports = {
  credentialDir,
  scopesForRole,
  scopesToProvision,
  openAuthSession,
  scopeHasToken,
  provisionProbeFromOwner,
  scopeLoginStatus,
  discoverProviders,
  startQrLogin,
  pollQrLogin,
  loginWithAccount,
  logout,
};
