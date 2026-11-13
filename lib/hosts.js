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
const fsp = require('fs/promises');
const { HOME } = require('./config');
const {
  spawnSsh,
  buildSshArgs,
  localBaseUrl,
  findFreePort,
  probeVersion,
  sshStderrText,
} = require('./transport');

const HOSTS_FILE = path.join(HOME, '.agentlray', 'hosts.json');

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
  if (type === 'dsh') throw new Error('dsh 传输尚未支持（type 预留）');
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
      useAgent: Boolean(ssh.useAgent),
    },
  };
}

// ---- hosts.json 读写（复用 lib/settings 原子写模式）----

async function readHostsFile() {
  try {
    const parsed = JSON.parse(await fsp.readFile(HOSTS_FILE, 'utf8'));
    if (Array.isArray(parsed?.hosts)) return parsed.hosts;
    return [];
  } catch {
    return [];
  }
}

async function writeHostsFile(hosts) {
  await fsp.mkdir(path.dirname(HOSTS_FILE), { recursive: true });
  const tmpPath = `${HOSTS_FILE}.tmp`;
  await fsp.writeFile(
    tmpPath,
    `${JSON.stringify({ hosts, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  );
  await fsp.rename(tmpPath, HOSTS_FILE);
  return hosts;
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
  const hosts = await listHosts();
  if (hosts.some((h) => h.id === host.id)) {
    const e = new Error(`主机 id 已存在: ${host.id}`);
    e.code = 'duplicate';
    throw e;
  }
  hosts.push(host);
  await writeHostsFile(hosts);
  return host;
}

async function updateHost(id, input) {
  const next = normalizeHost({ ...input, id });
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

function getRuntime(id) {
  return runtime.get(id);
}

function localRuntime() {
  return { status: 'connected', error: null, baseUrl: localBaseUrl(process.env.PORT || 3800), version: null };
}

// 启动（或重连）一个主机：建隧道（ssh）或直连（local）→ 探测 /api/version。
// 成功 → connected + baseUrl + version；失败 → error + error 文案（宿主状态由调用方读）。
// 返回 runtime（含最终 status）。
async function openHost(id) {
  if (id === LOCAL_ID) return localRuntime();

  const host = await getHost(id);
  if (!host) {
    const e = new Error(`主机不存在: ${id}`);
    e.code = 'not-found';
    throw e;
  }

  // 重新打开前清理旧隧道（幂等）。
  closeHost(id);

  const entry = {
    id,
    status: 'connecting',
    error: null,
    baseUrl: null,
    version: null,
    child: null,
    localPort: null,
  };
  runtime.set(id, entry);

  try {
    const localPort = await findFreePort();
    const args = buildSshArgs(host.ssh, localPort);
    // spawnSsh 内部固定 pipe stderr 并累积到 child.sshStderr（transport 层职责），
    // 失败时透出真实报错，避免只见误导性的 ECONNREFUSED。
    const child = spawnSsh(args);
    entry.child = child;
    entry.localPort = localPort;
    activeChildren.add(child);
    // 子进程意外退出 → 状态回 disconnected（隧道断）。stderr 已在探测失败路径透出。
    child.on('exit', () => {
      activeChildren.delete(child);
      const cur = runtime.get(id);
      if (cur && cur.child === child) {
        cur.status = 'disconnected';
        cur.error = 'ssh 隧道已断开';
        cur.child = null;
      }
    });
    child.on('error', (err) => {
      activeChildren.delete(child);
      const cur = runtime.get(id);
      if (cur && cur.child === child) {
        cur.status = 'error';
        cur.error = sshStderrText(child) || `ssh 启动失败: ${err.message}`;
        cur.child = null;
      }
    });

    const baseUrl = localBaseUrl(localPort);

    // 竞速：ssh 子进程 spawn 失败（error 事件）与连通探测成功，谁先确定结果。
    // 探测成功 → 存 version；spawn error 或探测失败 → 视为启动失败。
    let probedVersion = null;
    const launchOutcome = await new Promise((resolve) => {
      child.once('error', (err) =>
        resolve({ error: err instanceof Error ? err : new Error(String(err)) })
      );
      probeVersion(baseUrl, { timeoutMs: 5000, attempts: 3 })
        .then((version) => {
          probedVersion = version;
          resolve({ version });
        })
        .catch((e) => resolve({ error: e }));
    });

    if (launchOutcome.error) {
      closeHost(id);
      entry.status = 'error';
      // 优先透出 ssh 真实 stderr（如 Connection timed out / Permission denied），
      // 而非探测阶段的误导性 ECONNREFUSED 127.0.0.1:<port>。
      entry.error = sshStderrText(child) || launchOutcome.error.message;
      return entry;
    }

    entry.baseUrl = baseUrl;
    entry.version = probedVersion;
    entry.status = 'connected';
    entry.error = null;
    // 连接成功后立即向被连接方上报本机身份并启动心跳（inbound peers）。
    startReporting(id);
    return entry;
  } catch (e) {
    closeHost(id);
    entry.status = 'error';
    entry.error = e.message;
    return entry;
  }
}

// 关闭主机的隧道：kill 子进程 + 清运行时。local 无操作。
function closeHost(id) {
  const entry = runtime.get(id);
  if (!entry) return;
  stopReporting(id);
  if (entry.child) {
    activeChildren.delete(entry.child);
    try {
      entry.child.kill();
    } catch {
      /* ignore */
    }
  }
  runtime.delete(id);
}

// 关闭除 keepId 外所有主机的隧道（design R4-Q1：无后台常驻隧道池，
// 切换主机只留当前选中主机一条隧道）。local 无操作（不在 runtime）。
function closeAllExcept(keepId) {
  for (const id of Array.from(runtime.keys())) {
    if (id !== keepId) closeHost(id);
  }
}

// 进程退出兜底：kill 所有活跃 ssh 子进程 + 主机运行时（防孤儿隧道）。
function shutdownHosts() {
  for (const id of Array.from(reportTimers.keys())) stopReporting(id);
  for (const child of activeChildren) {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  }
  activeChildren.clear();
  runtime.clear();
}

// 测试专用：直接注入某 host 的 connected 运行时（baseUrl 指向测试用 mock server）。
// 仅测试用，避免真实 ssh spawn 依赖。生产路径不会调用。
function setRuntimeForTest(id, baseUrl, version = null) {
  runtime.set(id, { id, status: 'connected', error: null, baseUrl, version, child: null, localPort: null });
}

// ---- 入站 peer 上报（inbound）----
// 本机作为「连接方」主动向被连接方上报自身身份 + 心跳，使被连接方能展示「被谁连接」
// （design-inbound-peers）。被连接方无法从 TCP/HTTP 层识别来源，只能靠连接方上报。
// 自报身份：**本机机器名短名**（os.hostname 去域后缀）作为 peerId/label，使被连接方能
// 区分是哪台机器在连（design R-Q1：上报 os.hostname()）。version/bootId 由 server.js
// boot 注入（setSelfIdentity），即本机 GET /api/version 的字段。
const os = require('os');
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
  openHost,
  closeHost,
  closeAllExcept,
  shutdownHosts,
  setRuntimeForTest,
  setSelfIdentity,
  reportPeer,
  shortHostname,
};
