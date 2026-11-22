'use strict';
// 主机管理（multi-host，P0）：hosts.json CRUD + 运行时状态机 + 隧道生命周期。
// - 持久：~/.agentlray/hosts.json —— 连接目标列表（id/label/type/ssh 最小字段集）。
// - 运行时（不落盘）：每 host 的状态机 disconnected/connecting/connected/error，
//   ssh 隧道子进程、本地转发端口、最近一次 /api/version 探测结果。
// - `local` 内建恒在：直连本进程端口，状态恒 connected，不落盘、不建隧道。
// 隧道生命周期绑定当前选中主机：切换离开 → closeHost；删除 → closeHost + 移除；
// 进程退出 → 兜底 kill 所有活跃 ssh 子进程（防孤儿）。
const fs = require('fs');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const { HOSTS_FILE, readHostsFileJson, updateHostsFileJson } = require('./hosts-file');
const { encrypt: encryptSecret, decrypt: decryptSecret } = require('./secret');
const {
  spawnSsh,
  buildSshArgs,
  localBaseUrl,
  pickLocalPort,
  probeVersion,
  sshStderrText,
} = require('./transport');
// dsh 传输（ds-harness-remote 加密通道 + loopback 端口转发）：仅 type=dsh 的目标用到，
// 引入时不做任何副作用（借码层是懒加载的）。
const { openDshTunnel } = require('./dsh/client');
// dsh 设备身份信任库（A-6「忘记此主机」清除 client / probe 两处钉扎）。
const { identityStoreFor } = require('./dsh/identity');
const { linkError, normalizeLinkError } = require('./dsh/errors');
const log = require('./logging');

// ---- 链路健康探测与重连退避（A-2 / A-3）----
// 探测周期与上游 ssh_link keepAliveInterval 对齐（15s）；连续 2 次失败判链路已死。
// 重连指数退避 1→60s，上限后保持 60s 且**无限重试**（手机长时间后台不能因次数耗尽而
// 永久 failed）；每次等待加 ±20% 抖动，避免多主机同时打点。测试可用环境变量缩短周期。
function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function envMsList(raw, fallback) {
  if (!raw) return fallback;
  const list = String(raw)
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  return list.length > 0 ? list : fallback;
}

const HEALTH_PROBE_MS = positiveInt(process.env.AGENTLRAY_HOST_PROBE_MS, 15_000);
const HEALTH_PROBE_TIMEOUT_MS = positiveInt(process.env.AGENTLRAY_HOST_PROBE_TIMEOUT_MS, 3_000);
// 网络切换（A-4）触发的即时探活：与上游 kick() 的 5s ping 对齐。
const KICK_PROBE_TIMEOUT_MS = positiveInt(process.env.AGENTLRAY_HOST_KICK_TIMEOUT_MS, 5_000);
const HEALTH_FAIL_THRESHOLD = 2;
const RECONNECT_BACKOFF_MS = envMsList(process.env.AGENTLRAY_HOST_BACKOFF_MS, [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000,
]);
const BACKOFF_JITTER = 0.2;

// HOSTS_FILE 由 lib/hosts-file.js 提供（共享层，供 dsh/settings.js 同用）。

// 本机内建主机 id（恒在主机列表首位，状态恒 connected）。
const LOCAL_ID = 'local';

// 主机 id 契约（同平台 id 风格，宽松 slug）。
const HOST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

// ---- 运行时状态 ----
// hostId → runtime（不落盘）。
const runtime = new Map();

// 当前所有活跃 ssh 子进程（进程退出兜底 kill 用）。删除/关闭时也从这里移除。
const activeChildren = new Set();

// ---- 校验 ----

function normalizeHost(input) {
  if (!input || typeof input !== 'object') throw new Error('host 必须是对象');
  const id = String(input.id ?? '').trim();
  if (!HOST_ID_RE.test(id)) throw new Error('id 仅允许字母数字与连字符，且以字母/数字开头');
  if (id === LOCAL_ID) throw new Error(`id 保留给本机: ${LOCAL_ID}`);
  const label = String(input.label ?? '').trim();
  if (!label) throw new Error('label 必填');
  const type = input.type === 'dsh' ? 'dsh' : 'ssh';
  if (type === 'dsh') {
    // dsh 目标：中继服务器上的设备 id + 远端 AgentLRay 端口（默认 3800）。
    // 不填网络地址——dsh 走中继服务器转发，目标即设备身份。
    const dsh = input.dsh && typeof input.dsh === 'object' ? input.dsh : {};
    const deviceId = String(dsh.deviceId ?? '').trim();
    if (!deviceId) throw new Error('dsh.deviceId 必填');
    // 端口：缺省（未传/null/''）→ 3800；显式传值（含 0）按值校验。
    const portRaw = dsh.remoteAgentLrayPort == null || dsh.remoteAgentLrayPort === '' ? null : Number(dsh.remoteAgentLrayPort);
    const remoteAgentLrayPort = portRaw === null ? 3800 : portRaw;
    if (!Number.isInteger(remoteAgentLrayPort) || remoteAgentLrayPort < 1 || remoteAgentLrayPort > 65535) {
      throw new Error('dsh.remoteAgentLrayPort 需为 1–65535 的整数');
    }
    return {
      id,
      label,
      type,
      dsh: { deviceId, remoteAgentLrayPort },
    };
  }
  const ssh = input.ssh && typeof input.ssh === 'object' ? input.ssh : {};
  const host = String(ssh.host ?? '').trim();
  if (!host) throw new Error('ssh.host 必填');
  // 端口：显式 0/非法 → 当作提供但越界（拒绝）；空/null/'' → null（走 ssh 配置）。
  const portRaw = ssh.port == null || ssh.port === '' ? null : Number(ssh.port);
  const port = portRaw;
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('ssh.port 需为 1–65535 的整数');
  }
  const remoteAgentLrayPort = ssh.remoteAgentLrayPort ? Number(ssh.remoteAgentLrayPort) : 3800;
  if (!Number.isInteger(remoteAgentLrayPort) || remoteAgentLrayPort < 1 || remoteAgentLrayPort > 65535) {
    throw new Error('ssh.remoteAgentLrayPort 需为 1–65535 的整数');
  }
  return {
    id,
    label,
    type,
    ssh: {
      host,
      user: ssh.user ? String(ssh.user).trim() : '',
      port,
      remoteAgentLrayPort,
      identityFile: ssh.identityFile ? String(ssh.identityFile).trim() : '',
      // 私钥内容加密落盘（identityKeyEnc），不落明文（对齐 design-ssh-password / llm.apiKey）：
      // 连接时解密 → 写临时私钥文件供 ssh -i；GET 只回 hasIdentityKey 不回明文。
      identityKeyEnc: typeof ssh.identityKeyEnc === 'string' ? ssh.identityKeyEnc : '',
      useAgent: Boolean(ssh.useAgent),
    },
  };
}

// ---- hosts.json 读写（经 lib/hosts-file.js 共享层，原子写 0600）----
// 合并写保留顶层 dsh section：dsh 账号/角色配置与主机列表同文件（dsh/settings.js 也
// 写同一顶层 dsh），主机 CRUD 写盘时不得冲掉它。

async function readHostsFile() {
  const file = await readHostsFileJson();
  return Array.isArray(file?.hosts) ? file.hosts : [];
}

async function writeHostsFile(hosts) {
  // 读-合并-写在同一队列任务内完成：避免基于旧快照覆盖并发的 dsh section 写入。
  await updateHostsFileJson((file) => ({ ...file, hosts, updatedAt: new Date().toISOString() }));
  return hosts;
}

// ---- Android 薄服务能力门控（design-android-mobile-app §5.2）----
// 首版 Android 薄服务仅启用 dsh 传输（PRoot 内 child_process 可用，但 ssh 二进制不在
// rootfs）。AGENTLRAY_DISABLE_SSH=1 时在 hosts 层拒绝 ssh 主机（创建/修改/连接三重守卫），
// 返回 400。桌面 thin / full 未设置该变量则完全不受影响。

function sshDisabled() {
  return String(process.env.AGENTLRAY_DISABLE_SSH || '').trim() === '1';
}

/** DISABLE_SSH 时拒绝 ssh 类型（本地内建 local 始终放行）。 */
function assertTransportAllowed(type) {
  if (sshDisabled() && type === 'ssh') {
    const e = new Error('Android 薄服务仅支持 dsh 传输（SSH 隧道未启用）');
    e.code = 'transport-disabled';
    throw e;
  }
}

// ---- 记忆主机（lastHostId，design-android-mobile-app §7.7）----
// hosts.json 顶层 lastHostId 记录「上次选中的远程主机」。薄服务 boot 的
// resolveThinBootHost 优先它（次选 AGENTLRAY_THIN_HOST / hosts[0]），使 app 回前台
// 重启薄服务后能恢复上次主机。这是通用行为（桌面 thin / full 未禁用 ssh 时同样生效），
// 但 Android 端经 DISABLE_SSH 守卫只接受 dsh 类型。写盘走 updateHostsFileJson 保留顶层
// dsh section。

async function getLastHostId() {
  const file = await readHostsFileJson();
  const id = file?.lastHostId;
  return typeof id === 'string' && id ? id : null;
}

async function setLastHostId(id) {
  await updateHostsFileJson((file) => ({
    ...file,
    lastHostId: id || null,
    updatedAt: new Date().toISOString(),
  }));
  return id;
}

/**
 * 后台记忆「上次选中的主机」（连接成功后的便捷信息，供薄服务下次 boot 恢复）。
 * 不在 /connect 的响应路径上 await：现场（Windows）hosts.json 被云同步/杀软短暂占用时，
 * writeFile/rename 曾阻塞 90s+，表现为「连接卡住」（隧道其实早已建立）。慢写与失败只记 warn。
 */
function rememberLastHost(id, persist = setLastHostId) {
  const startedAt = Date.now();
  persist(id).then(
    () => {
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > 1000) log.app.warn('last host persist slow', { id, elapsedMs });
    },
    (error) => log.app.warn('last host persist failed', { id, error: (error && error.message) || String(error) })
  );
}

// ---- CRUD ----

async function listHosts() {
  const stored = await readHostsFile();
  // 脏文件/迁移容错：逐条规范化，非法项跳过（不抛，保证列表可用）。
  const hosts = [];
  for (const raw of stored) {
    try {
      hosts.push(normalizeHost(raw));
    } catch {
      /* skip corrupt entry */
    }
  }
  return hosts;
}

async function getHost(id) {
  const hosts = await listHosts();
  return hosts.find((h) => h.id === id) ?? null;
}

async function createHost(input) {
  const host = normalizeHost(input);
  assertTransportAllowed(host.type);
  const hosts = await listHosts();
  if (hosts.some((h) => h.id === host.id)) {
    const e = new Error(`主机 id 已存在: ${host.id}`);
    e.code = 'duplicate';
    throw e;
  }
  // 表单明文 identityKey → 加密落盘（identityKeyEnc）。dsh 目标没有 ssh 凭据。
  const key = typeof input?.ssh?.identityKey === 'string' ? input.ssh.identityKey : '';
  if (key && host.type === 'ssh') host.ssh.identityKeyEnc = await encryptSecret(key);
  hosts.push(host);
  await writeHostsFile(hosts);
  return host;
}

async function updateHost(id, input) {
  const next = normalizeHost({ ...input, id });
  assertTransportAllowed(next.type);
  if (next.id !== id) throw new Error('id 不可修改');
  const hosts = await listHosts();
  const idx = hosts.findIndex((h) => h.id === id);
  if (idx === -1) {
    const e = new Error(`主机不存在: ${id}`);
    e.code = 'not-found';
    throw e;
  }
  // 编辑：若当前已连接，先关隧道（配置可能变化），返回 disconnected 由前端重连。
  closeHost(id);
  // 私钥内容语义：明文 identityKey 非空 → 加密替换；空/未传 → 保留既有密文
  // （前端表单不回传 identityKeyEnc，直接覆盖会把原密钥清零）。如需清除，前端
  // 传 identityKey: '' 的显式标记，路由层据此删除密文。dsh 目标无 ssh 凭据，跳过。
  const key = typeof input?.ssh?.identityKey === 'string' ? input.ssh.identityKey : undefined;
  if (next.type === 'ssh') {
    if (key !== undefined) {
      if (key) next.ssh.identityKeyEnc = await encryptSecret(key);
      else next.ssh.identityKeyEnc = '';
    } else {
      // 未传 identityKey（仅改其他字段）：保留已存密文。
      next.ssh.identityKeyEnc = hosts[idx].ssh?.identityKeyEnc ?? '';
    }
  }
  hosts[idx] = next;
  await writeHostsFile(hosts);
  return next;
}

async function deleteHost(id) {
  const hosts = await listHosts();
  const idx = hosts.findIndex((h) => h.id === id);
  if (idx === -1) {
    const e = new Error(`主机不存在: ${id}`);
    e.code = 'not-found';
    throw e;
  }
  closeHost(id);
  hosts.splice(idx, 1);
  await writeHostsFile(hosts);
  return { id };
}

// ---- 隧道生命周期 ----

// 对外 phase 与内部 status 的映射：phase 是 A-1 的稳定语义；status 保留旧四态字符串，
// 既有网关（proxy 判定 connected）与前端旧代码继续可用。
const PHASE_STATUS = {
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  failed: 'failed',
  disconnected: 'disconnected',
};

function phaseStatus(phase) {
  return PHASE_STATUS[phase] || 'disconnected';
}

// prev 非空 = 自动重连路径：继承上一次的退避计数（attempt），否则每次新建 entry 都会把
// attempt 归零，退避永远停在第 1 档（等于固定 1s 重试，形成重试风暴）。
function createEntry(id, prev = null) {
  return {
    id,
    phase: 'disconnected',
    status: 'disconnected',
    // 失败详情：{ code, message, retryable }（A-1 稳定错误码）。
    error: null,
    // 重连成功次数（A-3）：进入 connected 归零；每次安排重连 +1。
    attempt: prev ? prev.attempt : 0,
    nextRetryAt: null,
    baseUrl: null,
    version: null,
    child: null,
    // 本地转发端口（A-5 稳定端口）：重连时继承上一次的端口作为「期望端口」，
    // 使断线重连前后 baseUrl 不变；被外部占用时由 pickLocalPort / loopback 回退随机。
    localPort: prev ? prev.localPort : null,
    tempKeyPath: null,
    dshTunnel: null,
    // 重连所需的已规范化主机规格（openHost 传入；probe 隧道不保存）。
    spec: null,
    // 是否允许自动重连（probe / 手动 closeHost 置 false）。
    reconnectable: false,
    healthTimer: null,
    healthFails: 0,
    healthProbing: false,
    reconnectTimer: null,
    // 测试注入：自定义重连实现（生产走 tunnelAndProbe）。
    reconnectFn: prev ? prev.reconnectFn : null,
  };
}

function setPhase(entry, phase, error = null) {
  entry.phase = phase;
  entry.status = phaseStatus(phase);
  entry.error = error;
  if (phase === 'connected') {
    entry.attempt = 0;
    entry.nextRetryAt = null;
  }
  return entry;
}

function getRuntime(id) {
  return runtime.get(id);
}

function localRuntime() {
  return {
    status: 'connected',
    phase: 'connected',
    error: null,
    baseUrl: localBaseUrl(process.env.PORT || 3800),
    version: null,
    attempt: 0,
    nextRetryAt: null,
  };
}

// 启动（或重连）一个主机：建隧道（ssh / dsh）或直连（local）→ 探测 /api/version。
// 成功 → connected + baseUrl + version；失败 → failed + 稳定错误码（宿主状态由调用方读）。
// 手动连接会取消进行中的退避等待并从第 0 次开始（A-3「用户手动重试跳过退避」）。
async function openHost(id) {
  if (id === LOCAL_ID) return localRuntime();

  const host = await getHost(id);
  if (!host) {
    const e = new Error(`主机不存在: ${id}`);
    e.code = 'not-found';
    throw e;
  }
  assertTransportAllowed(host.type);
  cancelReconnect(id);
  const prev = runtime.get(id);
  if (prev) {
    prev.attempt = 0;
    prev.nextRetryAt = null;
  }
  return tunnelAndProbe(id, host, { manual: true });
}

// 核心：按给定主机规格建隧道 → 探测 → 收尾。openHost 与 testHostSpec 共用，
// 避免表单「测试连接」（未保存配置）复制一份隧道逻辑。
// 传输按 type 分派：ssh → ssh 子进程隧道；dsh → 加密通道 + loopback 端口转发。
// options.probe=true 表示这是「测试连接」用的探测隧道（ssh 侧不向被连接方上报；
// dsh 侧用独立探测身份，避免顶替正在使用的出站隧道）。
// options.reconnect=true 表示这是 A-3 退避循环触发的自动重连：不重置 attempt/nextRetryAt。
async function tunnelAndProbe(id, host, options = {}) {
  const probe = Boolean(options.probe);
  // 自动重连：沿用上一次的退避计数（见 createEntry）。
  const prev = options.reconnect ? (options.prev ?? runtime.get(id) ?? null) : null;
  if (host.type === 'dsh') return dshTunnelAndProbe(id, host.dsh, options);
  const skipReporting = probe;
  const ssh = host.ssh;
  // 重新打开前清理旧隧道（幂等）。
  closeHost(id);

  // 私钥来源解析：identityKeyEnc（密文，解密为内容）优先 → 写临时私钥文件供 ssh -i 使用；
  // 否则沿用 identityFile（文件地址）。临时文件在隧道关闭时清理。
  let resolved;
  try {
    resolved = await resolveIdentityKey(ssh);
  } catch (e) {
    // prev 必须透传：否则每次重连都从 attempt=0 开始，退避形同 1s 固定重试。
    return finalizeFailure(id, 'ssh', e, { spec: probe ? null : host, prev });
  }
  const { ssh: effSsh, tempKeyPath } = resolved;

  const entry = createEntry(id, prev);
  entry.tempKeyPath = tempKeyPath;
  entry.spec = probe ? null : host;
  entry.reconnectable = !probe;
  setPhase(entry, 'connecting');
  runtime.set(id, entry);

  /**
   * 起一条 ssh 隧道并探测 /api/version。remoteSocketPath 非空时走 streamlocal（UNIX socket
   * 信任通道），否则走 TCP 回环。返回 { version, baseUrl } 或 { error }。
   */
  const launch = async (remoteSocketPath) => {
    // A-5：优先复用 entry 上一次的本地端口（重连路径由 createEntry 继承），保证 baseUrl 稳定。
    const localPort = await pickLocalPort(entry.localPort);
    const args = buildSshArgs(effSsh, localPort, remoteSocketPath);
    // spawnSsh 内部固定 pipe stderr 并累积到 child.sshStderr（transport 层职责），
    // 失败时透出真实报错，避免只见误导性的 ECONNREFUSED。
    const child = spawnSsh(args);
    entry.child = child;
    entry.localPort = localPort;
    entry.remoteSocketPath = remoteSocketPath || null;
    activeChildren.add(child);
    const isCurrent = () => runtime.get(id) === entry && entry.child === child;
    // 子进程意外退出 → 链路已死，进入重连（A-2 第 2 条：不再只是置 disconnected）。
    child.on('exit', () => {
      activeChildren.delete(child);
      if (!isCurrent()) return;
      entry.child = null;
      // 连接阶段内的退出由调用方竞速逻辑判定。
      if (entry.phase === 'connecting') return;
      const detail = sshStderrText(child);
      const error = normalizeLinkError(detail || 'ssh 隧道已断开', 'UNREACHABLE');
      log.app.warn('host link lost', { id, type: 'ssh', code: error.code });
      linkLost(id, error);
    });
    child.on('error', (err) => {
      activeChildren.delete(child);
      if (!isCurrent()) return;
      entry.child = null;
      const error = normalizeLinkError(sshStderrText(child) || `ssh 启动失败: ${err.message}`);
      if (entry.phase === 'connecting') return;
      linkLost(id, error);
    });

    const baseUrl = localBaseUrl(localPort);
    // 竞速：ssh 子进程 spawn 失败（error 事件）与连通探测成功，谁先确定结果。
    const outcome = await new Promise((resolve) => {
      child.once('error', (err) =>
        resolve({ error: err instanceof Error ? err : new Error(String(err)) })
      );
      probeVersion(baseUrl, { timeoutMs: 5000, attempts: 3 })
        .then((version) => resolve({ version, baseUrl }))
        .catch((e) => resolve({ error: e }));
    });
    if (outcome.error) {
      // 优先透出 ssh 真实 stderr（如 Connection timed out / Permission denied），
      // 而非探测阶段的误导性 ECONNREFUSED 127.0.0.1:<port>。
      outcome.detail = sshStderrText(child) || outcome.error.message;
      closeTunnelResources(entry);
      return outcome;
    }
    return outcome;
  };

  try {
    // 第一阶段：TCP 回环隧道。`/api/version` 是公开端点，因此即便被连接方开着本机令牌也能
    // 读到它通告的入站 socket 路径（`version.inboundSocket`）。
    let outcome = await launch(null);
    if (!outcome.error && !probe && isSocketPath(outcome.version?.inboundSocket)) {
      // 第二阶段：改走 streamlocal（内核按 socket 文件权限认证来源），被连接方无需关鉴权。
      // keepTempKey：两次 launch 共用同一个 `-i` 临时私钥，这里不能删。
      closeTunnelResources(entry, { keepTempKey: true });
      const viaSocket = await launch(outcome.version.inboundSocket);
      if (viaSocket.error) {
        // socket 不可用（旧 sshd 不支持 streamlocal / 路径被删）→ 退回 TCP 一次。
        log.app.warn('ssh inbound socket tunnel failed; falling back to loopback', { id });
        outcome = await launch(null);
      } else {
        outcome = viaSocket;
      }
    }
    if (outcome.error) {
      return finalizeFailure(id, 'ssh', outcome.detail || outcome.error.message, {
        spec: probe ? null : host,
        prev,
      });
    }

    entry.baseUrl = outcome.baseUrl;
    entry.version = outcome.version;
    markConnected(id, 'ssh');
    // 连接成功后立即向被连接方上报本机身份并启动心跳（inbound peers）。
    // 测试连接（skipReporting）不持续连接，跳过上报。
    if (!skipReporting) startReporting(id);
    return entry;
  } catch (e) {
    return finalizeFailure(id, 'ssh', e, { spec: probe ? null : host, prev });
  }
}

// 是否为可用的入站 socket 路径（被连接方 /api/version 通告；防注入非法值）。
function isSocketPath(p) {
  return typeof p === 'string' && p.startsWith('/') && p.endsWith('.sock') && !p.includes('/../');
}

// dsh 传输：建加密通道 + 本机 loopback 端点 → 探测远端 /api/version。
// 契约与 ssh 分支一致（{ phase, status, baseUrl, version, error }），网关层无需区分传输方式。
async function dshTunnelAndProbe(id, dsh, options = {}) {
  const probe = Boolean(options.probe);
  const prev = options.reconnect ? (options.prev ?? runtime.get(id) ?? null) : null;
  // 重新打开前清理旧隧道（幂等）。
  closeHost(id);
  const entry = createEntry(id, prev);
  entry.spec = probe ? null : { type: 'dsh', dsh };
  entry.reconnectable = !probe;
  setPhase(entry, 'connecting');
  runtime.set(id, entry);
  try {
    const tunnel = await openDshTunnel({
      deviceId: dsh.deviceId,
      remoteAgentLrayPort: dsh.remoteAgentLrayPort,
      // 探测隧道用独立身份，避免顶替正在使用的出站隧道（中继服务器同设备只留一条连接）。
      scope: probe ? 'probe' : 'client',
      // A-5：复用上一次的 loopback 本地端口（重连路径由 createEntry 继承）。
      localPort: entry.localPort,
    });
    // 连接期间被手动关闭/重连：新隧道不再使用，立即释放。
    if (runtime.get(id) !== entry) {
      try {
        await tunnel.close();
      } catch {
        /* ignore */
      }
      return entry;
    }
    entry.dshTunnel = tunnel;
    entry.baseUrl = tunnel.baseUrl;
    if (tunnel.localPort) entry.localPort = tunnel.localPort;
    let probedVersion = null;
    try {
      probedVersion = await probeVersion(tunnel.baseUrl, { timeoutMs: 5000, attempts: 3 });
    } catch (e) {
      return finalizeFailure(id, 'dsh', `dsh 隧道已建立，但远端 /api/version 探测失败：${e.message}`, {
        spec: probe ? null : { type: 'dsh', dsh },
      });
    }
    entry.version = probedVersion;
    markConnected(id, 'dsh');
    return entry;
  } catch (e) {
    return finalizeFailure(id, 'dsh', e, { spec: probe ? null : { type: 'dsh', dsh } });
  }
}

// 连接失败收尾：关隧道 → failed + 稳定错误码；retryable 且允许重连 → 安排退避重连。
// spec 非空表示可自动重连（probe 隧道传 null）。
function finalizeFailure(id, type, error, { spec = null, prev = null } = {}) {
  const cur = runtime.get(id);
  const norm = normalizeLinkError(error);
  const entry = cur || createEntry(id, prev);
  closeTunnelResources(entry);
  if (spec) entry.spec = spec;
  entry.reconnectable = Boolean(spec);
  setPhase(entry, 'failed', norm);
  runtime.set(id, entry);
  log.app.warn('host connect failed', { id, type, code: norm.code, retryable: norm.retryable, error: norm.message });
  if (norm.retryable && entry.reconnectable) scheduleReconnect(id, entry);
  return entry;
}

// 连接成功收尾：connected + 启动健康探测（A-2）。
function markConnected(id, type) {
  const entry = runtime.get(id);
  if (!entry) return;
  setPhase(entry, 'connected');
  entry.healthFails = 0;
  startHealthProbe(id, entry);
  log.app.info('host connected', { id, type, attempt: entry.attempt });
}

// 已连接链路被判定死亡（探测连续失败 / 子进程退出）→ reconnecting → 退避重连。
// 先摘除旧隧道资源（kill 子进程、关 dsh 通道、停探测），避免与下一次连接并存。
function linkLost(id, error) {
  const entry = runtime.get(id);
  if (!entry) return;
  if (entry.phase !== 'connected' && entry.phase !== 'reconnecting') return;
  stopHealthProbe(entry);
  stopReporting(id);
  closeTunnelResources(entry);
  setPhase(entry, 'reconnecting', normalizeLinkError(error));
  log.app.warn('host link lost', { id, code: entry.error.code });
  scheduleReconnect(id, entry);
}

// ---- 健康探测（A-2）----

function startHealthProbe(id, entry) {
  stopHealthProbe(entry);
  const timer = setInterval(() => {
    void healthTick(id, entry);
  }, HEALTH_PROBE_MS);
  if (timer.unref) timer.unref();
  entry.healthTimer = timer;
}

function stopHealthProbe(entry) {
  if (entry.healthTimer) {
    clearInterval(entry.healthTimer);
    entry.healthTimer = null;
  }
}

// 单次健康探测：GET <baseUrl>/api/version（复用 probeVersion，单次 + 短超时）。
// 连续 HEALTH_FAIL_THRESHOLD 次失败 → 链路判死。成功一次即清零失败计数。
async function healthTick(id, entry) {
  if (entry.healthProbing || entry.phase !== 'connected' || !entry.baseUrl) return;
  if (runtime.get(id) !== entry) return;
  entry.healthProbing = true;
  try {
    const version = await probeVersion(entry.baseUrl, {
      timeoutMs: HEALTH_PROBE_TIMEOUT_MS,
      attempts: 1,
    });
    entry.healthFails = 0;
    if (version && typeof version === 'object') entry.version = version;
    return;
  } catch (e) {
    entry.healthFails += 1;
    if (entry.healthFails >= HEALTH_FAIL_THRESHOLD) {
      linkLost(id, normalizeLinkError(e, 'UNREACHABLE'));
    }
    return;
  } finally {
    entry.healthProbing = false;
  }
}

// ---- 重连退避（A-3）----

function backoffDelay(attempt) {
  const idx = Math.min(Math.max(attempt - 1, 0), RECONNECT_BACKOFF_MS.length - 1);
  const base = RECONNECT_BACKOFF_MS[idx];
  const jitter = base * BACKOFF_JITTER * (Math.random() * 2 - 1);
  return Math.max(1, Math.round(base + jitter));
}

function scheduleReconnect(id, entry) {
  if (!entry.reconnectable) return;
  if (entry.reconnectTimer) return;
  entry.attempt += 1;
  const delay = backoffDelay(entry.attempt);
  // epoch ms（与前端 api/types.ts 的 `number` 一致；对外 JSON 直接是数字）。
  entry.nextRetryAt = Date.now() + delay;
  log.app.info('host reconnect scheduled', { id, attempt: entry.attempt, delayMs: delay });
  const timer = setTimeout(() => {
    entry.reconnectTimer = null;
    if (runtime.get(id) !== entry || !entry.reconnectable) return;
    void reconnectNow(id, entry);
  }, delay);
  if (timer.unref) timer.unref();
  entry.reconnectTimer = timer;
}

async function reconnectNow(id, entry) {
  const spec = entry.spec;
  if (!spec) return;
  setPhase(entry, 'reconnecting');
  entry.nextRetryAt = null;
  let next;
  try {
    next =
      typeof entry.reconnectFn === 'function'
        ? await entry.reconnectFn()
        : await tunnelAndProbe(id, spec, { reconnect: true, prev: entry });
  } catch (e) {
    next = finalizeFailure(id, spec.type, e, { spec, prev: entry });
  }
  // 重连过程中主机被关闭/替换：以最新的运行时为准（退避计数已在 createEntry 接续）。
  const cur = runtime.get(id);
  if (cur && next && cur !== next && cur !== entry) return;
}

// ---- 网络切换即时重连（A-4）----
// Android 原生在系统网络回调（onAvailable / onLost / onLinkPropertiesChanged）与 App 回前台
// 时调用 POST /api/hosts/:id/kick：PRoot 与宿主共享网络栈，Wi-Fi↔蜂窝切换后旧 socket 已死，
// 只能等下一次探活周期（≤30s）。kick 立即探活并按状态分流（对齐上游 ssh_link kick()）：
//   - connected      → 立即 ping（5s 超时）；失败即判链路已死（跳过「连续 2 次」阈值）；
//   - reconnecting / failed（可重试）→ 跳过当前退避等待，立即重连；
//   - failed（不可重试）/ connecting / 未运行 → 不动（用户须处理或正在建立）。
// 幂等：重复调用只会在链路仍不可用时再次触发立即重连。

async function kickHost(id) {
  if (id === LOCAL_ID) return localRuntime();
  const entry = runtime.get(id);
  if (!entry) return null;
  if (entry.phase === 'connected') {
    if (!entry.baseUrl) return entry;
    try {
      await probeVersion(entry.baseUrl, { timeoutMs: KICK_PROBE_TIMEOUT_MS, attempts: 1 });
      entry.healthFails = 0;
      return entry;
    } catch (e) {
      // 只对仍处于 connected 的同一 entry 判死（探活期间可能已被关闭/替换）。
      if (runtime.get(id) !== entry || entry.phase !== 'connected') return runtime.get(id) ?? null;
      log.app.info('host kick: link dead', { id });
      // 判死后立刻重连：kick 由网络事件触发，此刻等待退避毫无意义。
      linkLost(id, normalizeLinkError(e, 'UNREACHABLE'));
      return kickReconnectNow(id);
    }
  }
  return kickReconnectNow(id);
}

/**
 * kick 是否允许「跳过退避立即重连」：reconnecting（链路已建立过，必定已排退避）或
 * failed 且错误可重试。
 * **retryable=false 必须留在 failed 等用户处理**（KEY_CHANGED / DSH_AUTH_REQUIRED /
 * VERSION_INCOMPATIBLE / INVALID_TARGET / AUTH_REQUIRED）：否则每次系统网络事件都会重试
 * 一次已被 fail-closed 拒绝的连接，既与 A-1 的「不进重试循环」矛盾，也把 A-6 的
 * 「须用户显式忘记此主机」变成自动重试。failed 分支要求 `retryable === true`（而非 `!== false`），
 * 错误缺失时不擅自重连。
 */
function kickableForReconnect(entry) {
  if (!entry || !entry.reconnectable || !entry.spec) return false;
  if (entry.phase === 'reconnecting') return true;
  return entry.phase === 'failed' && entry.error?.retryable === true;
}

// 跳过当前退避等待，立即重连（kick 的公共后半段）。链路仍可重试才执行，否则原样返回。
async function kickReconnectNow(id) {
  const entry = runtime.get(id);
  if (!kickableForReconnect(entry)) return entry ?? null;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  entry.nextRetryAt = null;
  log.app.info('host kick: reconnect now', { id, attempt: entry.attempt });
  await reconnectNow(id, entry);
  return runtime.get(id) ?? null;
}

/** 对所有运行中的主机执行 kick（系统网络变化回调一次触发全部）。 */
async function kickAllHosts() {
  const ids = [...runtime.keys()].filter((id) => id !== LOCAL_ID);
  return Promise.all(ids.map((id) => kickHost(id).catch(() => runtime.get(id) ?? null)));
}

// ---- 身份 pin 的显式清除（A-6）----
// 对端设备公钥变化（KEY_CHANGED）时 fail-closed，用户须「忘记此主机」后重连。
// 出站隧道（client）与连接测试（probe）各有一份信任库（IDENTITY_SCOPES 里 peersFile 不同），
// 两处都要清，否则测试连接仍被拒。host scope 记录的是连入的对端，与出站目标无关，不清。
async function forgetHostTrust(id) {
  const host = await getHost(id);
  if (!host) {
    const e = new Error(`主机不存在: ${id}`);
    e.code = 'not-found';
    throw e;
  }
  if (host.type !== 'dsh' || !host.dsh?.deviceId) {
    const e = new Error('仅 dsh 主机使用设备身份钉扎，ssh 主机无需清除信任记录');
    e.code = 'unsupported';
    throw e;
  }
  const deviceId = host.dsh.deviceId;
  let removed = 0;
  for (const scope of ['client', 'probe']) {
    const store = identityStoreFor(scope);
    await store.loadPeers();
    if (await store.revokePeer(deviceId)) removed += 1;
  }
  log.app.info('host trust forgotten', { id, deviceId, removed });
  return { id, deviceId, removed };
}

// 取消进行中的退避等待（手动连接/关闭/删除时调用）。
function cancelReconnect(id) {
  const entry = runtime.get(id);
  if (!entry) return;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  entry.nextRetryAt = null;
}

// 只释放隧道资源（子进程 / dsh 通道 / 临时私钥 / 探测与心跳定时器），保留 entry 本身。
// options.keepTempKey：只杀子进程与定时器，保留 `identityKeyEnc` 解出的临时私钥——两阶段
// ssh 切换（TCP → streamlocal）在同一个 tunnelAndProbe 里连续启动两条隧道，私钥属于整次
// 连接的生命周期，提前删掉会让第二次 spawn 的 `-i` 指向不存在的文件（Permission denied）。
function closeTunnelResources(entry, options = {}) {
  stopHealthProbe(entry);
  if (entry.child) {
    activeChildren.delete(entry.child);
    try {
      entry.child.kill();
    } catch {
      /* ignore */
    }
    entry.child = null;
  }
  // dsh 传输：关闭加密通道与本机 loopback 端点。
  if (entry.dshTunnel) {
    try {
      const closing = entry.dshTunnel.close();
      if (closing && typeof closing.catch === 'function') closing.catch(() => undefined);
    } catch {
      /* ignore */
    }
    entry.dshTunnel = null;
  }
  // 清理 identityKey 写入的临时私钥目录（文件 + 其父 mkdtemp 目录，若存在）。
  if (entry.tempKeyPath && !options.keepTempKey) {
    try {
      fs.rmSync(path.dirname(entry.tempKeyPath), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    entry.tempKeyPath = null;
  }
}

// 关闭主机的隧道：取消重连 + kill 子进程 + 停探测/心跳 + 清运行时。local 无操作。
// 手动关闭后不自动重连（重新连接由用户/前端触发 openHost）。
function closeHost(id) {
  const entry = runtime.get(id);
  if (!entry) return;
  log.app.info('host closed', { id });
  entry.reconnectable = false;
  if (entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }
  stopReporting(id);
  closeTunnelResources(entry);
  runtime.delete(id);
}

// 私钥内容规范化：OpenSSH/PEM 私钥要求「首尾无空白 + 以换行结尾」（base64 行 + 结尾 \n）。
// 用户经表单粘贴/文件导入时，浏览器复制常丢失末尾换行或夹带首尾空白 → 临时文件被
// ssh 判 'Load key ...: invalid format'。写临时文件前统一 trim 首尾空白并补结尾 \n。
function normalizePemKey(content) {
  return `${String(content).trim()}\n`;
}

// 私钥来源解析：identityKeyEnc（密文）非空则优先——解密为内容 → 写临时私钥文件（0600）
// 供 ssh -i 用，返回 { ssh: 生效 ssh（identityFile 指向临时文件，identityKey 置解密后的内容
// 供 buildSshArgs 判断走内容）, tempKeyPath: 临时文件路径（无则 null）}；否则沿用原
// identityFile，不产生临时文件。解密失败（secret 文件变化/损坏）→ 抛错，由调用方走 error。
async function resolveIdentityKey(ssh) {
  if (!ssh.identityKeyEnc) return { ssh, tempKeyPath: null };
  const key = normalizePemKey(await decryptSecret(ssh.identityKeyEnc));
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentlray-key-'));
  const tempKeyPath = path.join(dir, 'id');
  await fsp.writeFile(tempKeyPath, key, { encoding: 'utf8', mode: 0o600 });
  return {
    ssh: { ...ssh, identityFile: tempKeyPath, identityKey: key },
    tempKeyPath,
  };
}

// 薄服务启动自动连接目标解析（design-thin-service Q23 + design-android §7.7）：
// 解析优先级：
//   1. 记忆主机 lastHostId（前端运行时切换会写盘；Android/DISABLE_SSH 时仅接受 dsh）；
//   2. AGENTLRAY_THIN_HOST=<id> 环境变量（原生侧显式指定）；
//   3. hosts.json 第一台（兼容旧行为）。
// 都没有 → null（前端空态引导）。DISABLE_SSH 时过滤掉 ssh 主机（它们无法被连接）。
async function resolveThinBootHost() {
  const hosts = await listHosts();
  // DISABLE_SSH（Android）时 ssh 主机不可连，从候选中排除；local 内建也不在 hosts 列表。
  const connectable = sshDisabled() ? hosts.filter((h) => h.type === 'dsh') : hosts;

  const remembered = await getLastHostId();
  if (remembered) {
    const hit = connectable.find((h) => h.id === remembered);
    if (hit) return hit;
  }

  const override = String(process.env.AGENTLRAY_THIN_HOST || '').trim();
  if (override) {
    const hit = connectable.find((h) => h.id === override);
    if (hit) return hit;
  }
  return connectable[0] ?? null;
}

// 薄服务 boot 自动连接（Q19/Q23）：解析目标并 openHost。连接失败返回 { ok:false, runtime }
//（状态已记入运行时，不阻塞启动）；host 解析/探测中的意外异常可能向上抛，由调用方
//（bin/thin-server.js 的 .then/.catch）兜底。前端首帧 GET /api/hosts 读到连接结果直落该主机。
// 返回 { ok, hostId, runtime }。
async function autoConnectThinHost() {
  const host = await resolveThinBootHost();
  if (!host) return { ok: false, hostId: null, runtime: null };
  const runtimeEntry = await openHost(host.id);
  return { ok: runtimeEntry.status === 'connected', hostId: host.id, runtime: runtimeEntry };
}

// 测试未保存的主机配置（表单「测试连接」）：按给定规格建隧道 → 探测 → 关，
// 不持久化、不影响当前选中主机运行时（用合成 id 隔离；skipReporting 不打扰被连接方）。
// 返回 { ok, status, bootId, error, errorCode, errorRetryable }（与 /api/hosts/:id/test 同构）。
async function testHostSpec(input) {
  const host = normalizeHost(input);
  // 表单明文 identityKey → 临时加密（不落盘），供 resolveIdentityKey 解密写临时文件。
  const plain = typeof input?.ssh?.identityKey === 'string' ? input.ssh.identityKey : '';
  if (plain && host.type === 'ssh') host.ssh.identityKeyEnc = await encryptSecret(plain);
  const id = `__probe__${host.id}`;
  const rt = await tunnelAndProbe(id, host, { probe: true });
  closeHost(id);
  return {
    ok: rt.status === 'connected',
    status: rt.status,
    bootId: rt.version?.bootId ?? null,
    error: rt.error?.message ?? null,
    errorCode: rt.error?.code ?? null,
    errorRetryable: rt.error?.retryable ?? null,
  };
}

// 关闭除 keepId 外所有主机的隧道（design R4-Q1：无后台常驻隧道池，
// 切换主机只留当前选中主机一条隧道）。local 无操作（不在 runtime）。
function closeAllExcept(keepId) {
  for (const id of Array.from(runtime.keys())) {
    if (id !== keepId) closeHost(id);
  }
}

// 关闭所有 dsh 隧道（dsh 退出登录时调用）：ssh 主机不依赖 dsh 凭据，保持不动。
// 必须同步关闭——隧道存活时其令牌刷新会把刚删除的凭据目录重新写回，退出后仍能转发。
function closeDshHosts() {
  for (const [id, entry] of Array.from(runtime.entries())) {
    if (entry && entry.dshTunnel) closeHost(id);
  }
}

// 进程退出兜底：kill 所有活跃 ssh 子进程 + 清理临时私钥目录 + 主机运行时（防孤儿隧道）。
// 同时清掉所有重连/探测定时器（unref 的定时器不会阻塞退出，但测试与优雅退出需无残留）。
function shutdownHosts() {
  for (const entry of runtime.values()) {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    stopHealthProbe(entry);
  }
  for (const id of Array.from(reportTimers.keys())) stopReporting(id);
  for (const child of activeChildren) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  for (const id of Array.from(runtime.keys())) closeHost(id);
}

// 测试专用：直接注入某 host 的 connected 运行时（baseUrl 指向测试用 mock server）。
// 仅测试用，避免真实 ssh spawn 依赖。生产路径不会调用。
// options.healthProbe=true 时启动真实健康探测（A-2 用例：杀 mock 链路后判死）。
function setRuntimeForTest(id, baseUrl, version = null, options = {}) {
  closeHost(id);
  const entry = createEntry(id);
  entry.baseUrl = baseUrl;
  entry.version = version;
  setPhase(entry, 'connected');
  runtime.set(id, entry);
  if (options.healthProbe) startHealthProbe(id, entry);
  return entry;
}

// 测试专用：注入「可重连」的失败运行时（A-3 用例：退避循环 + 自定义 reconnectFn）。
// reconnectFn 返回一个 entry 或调用 finalizeFailure；不传则走真实 tunnelAndProbe。
function setReconnectForTest(id, spec, reconnectFn) {
  closeHost(id);
  const entry = createEntry(id);
  entry.spec = spec;
  entry.reconnectable = true;
  entry.reconnectFn = reconnectFn;
  setPhase(entry, 'failed', linkError('UNREACHABLE', 'test: link down'));
  runtime.set(id, entry);
  scheduleReconnect(id, entry);
  return entry;
}

// ---- 入站 peer 上报（inbound）----
// 本机作为「连接方」主动向被连接方上报自身身份 + 心跳，使被连接方能展示「被谁连接」
// （design-inbound-peers）。被连接方无法从 TCP/HTTP 层识别来源，只能靠连接方上报。
// 自报身份：**本机机器名短名**（os.hostname 去域后缀）作为 peerId/label，使被连接方能
// 区分是哪台机器在连（design R-Q1：上报 os.hostname()）。version/bootId 由 server.js
// boot 注入（setSelfIdentity），即本机 GET /api/version 的字段。
const HEARTBEAT_MS = 20_000;

// hostname 短名：去域后缀（首个 `.` 之前）。空/异常兜底 'local'。
function shortHostname() {
  const hn = (os.hostname() || '').split('.')[0].trim();
  return hn || 'local';
}

let SELF = { peerId: shortHostname(), label: shortHostname(), version: null, bootId: null };
// hostId → 心跳 interval（本机作为连接方，为每台已连接远端各续一条心跳）。
const reportTimers = new Map();

/** 注入本机身份（连接方视角的 self）。server.js boot 时以 pkg.version + bootId 调用。
 *  peerId/label 缺省已由 SELF 默认为本机 hostname 短名，此处仅补充 version/bootId。 */
function setSelfIdentity(info) {
  SELF = { ...SELF, ...(info || {}) };
}

/** 读取本机自报身份（peerId/label/version/bootId）。供前端展示「本机上报的主机名」。 */
function getSelfIdentity() {
  return { ...SELF };
}

// 向被连接方 POST /api/inbound/hello 上报身份。失败静默（不阻塞连接，下次心跳重试）。
// 用 node:http（对齐 lib/transport probeVersion），不带 Origin/Referer → 对端 csrfGuard 放行。
function reportPeer(baseUrl, self) {
  const http = require('http');
  const body = JSON.stringify({
    peerId: self.peerId,
    label: self.label,
    version: self.version ?? null,
    bootId: self.bootId ?? null,
  });
  return new Promise((resolve) => {
    const req = http.request(
      `${baseUrl}/api/inbound/hello`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 5000,
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(true));
      }
    );
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.end(body);
  });
}

// 某远端连接成功后：立即上报一次 + 启动心跳续期（每台 connected 主机一条）。
function startReporting(id) {
  const entry = runtime.get(id);
  if (!entry || entry.status !== 'connected' || !entry.baseUrl) return;
  stopReporting(id);
  const self = { ...SELF };
  reportPeer(entry.baseUrl, self);
  const timer = setInterval(() => reportPeer(entry.baseUrl, self), HEARTBEAT_MS);
  if (timer.unref) timer.unref();
  reportTimers.set(id, timer);
}

// 关闭某远端（closeHost/closeAllExcept/shutdownHosts）时停心跳。
function stopReporting(id) {
  const timer = reportTimers.get(id);
  if (timer) {
    clearInterval(timer);
    reportTimers.delete(id);
  }
}

module.exports = {
  HOSTS_FILE,
  LOCAL_ID,
  HOST_ID_RE,
  HEARTBEAT_MS,
  normalizeHost,
  listHosts,
  getHost,
  createHost,
  updateHost,
  deleteHost,
  getRuntime,
  localRuntime,
  HEALTH_PROBE_MS,
  RECONNECT_BACKOFF_MS,
  backoffDelay,
  openHost,
  closeHost,
  kickHost,
  kickAllHosts,
  forgetHostTrust,
  closeAllExcept,
  closeDshHosts,
  testHostSpec,
  resolveThinBootHost,
  autoConnectThinHost,
  resolveIdentityKey,
  shutdownHosts,
  setRuntimeForTest,
  setReconnectForTest,
  setSelfIdentity,
  getSelfIdentity,
  reportPeer,
  shortHostname,
  sshDisabled,
  assertTransportAllowed,
  getLastHostId,
  setLastHostId,
  rememberLastHost,
};
