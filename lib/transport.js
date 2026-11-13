'use strict';
// transport 层：local 直连 / ssh -L 隧道建拆。
// - local：baseUrl = http://127.0.0.1:<PORT>，无子进程。
// - ssh：spawn 系统 ssh 子进程做本地端口转发，远端 AgentLRay 保持 127.0.0.1 绑定，
//   安全边界在系统 ssh 层（零存密，凭据/指纹全走 ~/.ssh/config、ssh-agent、known_hosts）。
// 本模块只负责「命令构造 + spawn + 连通性探测」，主机生命周期/状态机在 lib/hosts.js。
const { spawn } = require('child_process');
const net = require('net');

// 复用系统 ssh（Windows 下 spawn 加 shell 以命中 ssh.exe，参照 lib/resume.js 语义）。
// stderr 固定走 pipe 并累积到 child.sshStderr，供上层在隧道失败时透出真实报错
// （否则 stdio ignore 会吞掉 Connection timed out / Permission denied 等，
// 只暴露出探测阶段的误导性 ECONNREFUSED）。调用方不可覆盖 stdio。
function spawnSsh(args, opts = {}) {
  const child = spawn('ssh', args, {
    shell: process.platform === 'win32',
    ...opts,
    // stderr 固定 pipe（放在 spread 之后，调用方不可覆盖）：供上层累积真实报错。
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  child.sshStderr = '';
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // 截断防爆：只保留最近一段 stderr。
      child.sshStderr = (child.sshStderr + chunk).slice(-8192);
    });
  }
  return child;
}

// 构造 ssh -L 本地端口转发命令串参数（单一真源，方便单测断言）。
// 返回 { args, localPort }；localPort 由调用方以 listen(0) 探测的空闲端口传入，
// 或由 buildArgs 内部按需传入。
function buildSshArgs(ssh, localPort) {
  const args = [
    '-N',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${ssh.remoteAgentLrayPort}`,
    // ServerAliveInterval 保活防长空闲隧道被掐（design R4-Q2）。
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    // 非交互 spawn 下首次连接自动信任并记录 host key（写入 known_hosts），
    // 避免卡在 "Are you sure you want to continue connecting (yes/no)?"。
    // accept-new 仅信任「未知」key，已记录 key 变化仍拒绝（防中间人）。
    '-o',
    'StrictHostKeyChecking=accept-new',
  ];
  if (ssh.port) args.push('-p', String(ssh.port));
  if (ssh.identityFile) args.push('-i', ssh.identityFile);
  if (ssh.useAgent) args.push('-o', 'ForwardAgent=yes');
  const userHost = `${ssh.user ? `${ssh.user}@` : ''}${ssh.host}`;
  args.push(userHost);
  return args;
}

function localBaseUrl(port) {
  return `http://127.0.0.1:${port}`;
}

// 探测空闲本地端口（listen(0) 后关闭交回给 ssh）。异步。
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// 从 ssh 子进程累积的 stderr 中提炼一行最有价值的真实报错文案。
// 只取非空、非 debug 行（剔除 debug1: 等噪音），返回首条有效行；无则空串。
function sshStderrText(child) {
  const raw = (child?.sshStderr || '').trim();
  if (!raw) return '';
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^debug\d*:/i.test(l));
  return lines[0] || '';
}

// 连通性探测：GET <baseUrl>/api/version，带超时。返回 { bootId }；失败抛错。
// 借助 node:http 而非 fetch（避免依赖 undici，且能精确控制超时/错误语义）。
function probeVersion(baseUrl, { timeoutMs = 5000, attempts = 1 } = {}) {
  const http = require('http');
  const attempt = () =>
    new Promise((resolve, reject) => {
      const req = http.get(`${baseUrl}/api/version`, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`Invalid version payload: ${e.message}`));
          }
        });
      });
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error('version probe timeout'));
      });
      req.on('error', reject);
    });

  const run = async (left) => {
    if (left <= 0) throw new Error(`version probe failed after ${attempts} attempt(s)`);
    try {
      return await attempt();
    } catch (e) {
      if (left <= 1) throw e;
      await new Promise((r) => setTimeout(r, 300));
      return run(left - 1);
    }
  };
  return run(attempts);
}

module.exports = {
  spawnSsh,
  buildSshArgs,
  localBaseUrl,
  findFreePort,
  probeVersion,
  sshStderrText,
};
