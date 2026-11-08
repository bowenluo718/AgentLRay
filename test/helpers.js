// Test harness: boots an isolated AgentLRay server against a throwaway copy of
// test/fixtures/home. Every data dir (and HOME itself, for the ~/.agentlray and
// ~/.claude.json reads) points into the copy, so tests never touch real user
// data and mutating tests never dirty the checked-in fixtures.

const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_HOME = path.join(__dirname, 'fixtures', 'home');

function randomPort() {
  return 20000 + Math.floor(Math.random() * 10000);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function makeTmpHome() {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'agentlray-test-'));
  await fsp.cp(FIXTURE_HOME, tmpHome, { recursive: true });
  return tmpHome;
}

function serverEnv(home, port) {
  return {
    ...process.env,
    HOME: home,
    PORT: String(port),
    HOST: '127.0.0.1',
    OPENCLAW_DIR: path.join(home, '.openclaw', 'agents'),
    CODEX_DIR: path.join(home, '.codex', 'sessions'),
    CLAUDE_CODE_DIR: path.join(home, '.claude', 'projects'),
    OMP_DIR: path.join(home, '.omp', 'agent', 'sessions'),
    HERMES_DIR: path.join(home, '.hermes'),
    DSH_DIR: path.join(home, '.dsh', 'sessions'),
    GEMINI_DIR: path.join(home, '.gemini', 'tmp'),
    AGENTLRAY_LIBRARY_DIR: path.join(home, '.agentlray', 'library'),
    AGENTLRAY_ARCHIVE_DIR: path.join(home, '.agentlray', 'archive'),
    // 平台来源目录（P0）：指向隔离家目录下的（必然为空）子目录，确保 server
    // 子进程不并入用户本机自定义适配器/禁用配置，保持空配置基线。
    AGENTLRAY_PLATFORMS_DIR: path.join(home, '.agentlray', 'platforms'),
    AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, 'platforms'),
    // 宿主进程若导出 AGENTLRAY_NO_PLUGINS=1（例如排查问题时残留），会跳过 project/user
    // 来源，使自定义平台相关用例静默失效；测试基线显式清空，只由用例自身设置。
    AGENTLRAY_NO_PLUGINS: '',
  };
}

// Spawn `node server.js` on one candidate port; resolve with the child once
// /api/version answers, reject if the child dies first (e.g. EADDRINUSE).
async function spawnOnce(home, port, extraEnv) {
  const child = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    env: { ...serverEnv(home, port), ...extraEnv },
    cwd: REPO_ROOT,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });

  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before ready (port ${port}): ${stderr.trim()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/version`);
      if (res.ok) {
        await res.json();
        return child;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(60);
  }
  child.kill('SIGKILL');
  throw new Error(`server never became ready on port ${port}: ${stderr.trim()}`);
}

// Starts a hermetic server instance. Returns { base, home, stop }.
// 每个 server 实例一个全新隔离 HOME（夹具副本 + 随机派生目录），因此「重启后生效」
// 类用例应各自 startServer() 后重放配置，不要跨实例复用 HOME。
async function startServer(extraEnv) {
  const home = await makeTmpHome();
  let child = null;
  let lastError = null;
  let port = 0;
  for (let attempt = 0; attempt < 3 && !child; attempt++) {
    port = randomPort();
    try {
      child = await spawnOnce(home, port, extraEnv);
    } catch (error) {
      lastError = error;
    }
  }
  if (!child) {
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    throw lastError || new Error('failed to start server');
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(3000).then(() => child.kill('SIGKILL'))]);
    }
    // Give any fire-and-forget git commit in the library repo a beat to settle
    await sleep(100);
    await fsp.rm(home, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }

  return { base: `http://127.0.0.1:${port}`, home, stop };
}

// fetch + JSON with status assertion baked in
async function getJson(base, pathname, expectedStatus = 200) {
  const res = await fetch(base + pathname);
  if (res.status !== expectedStatus) {
    throw new Error(`GET ${pathname} -> ${res.status} (expected ${expectedStatus}): ${await res.text()}`);
  }
  return res.json();
}

async function sendJson(base, method, pathname, body, expectedStatus = 200) {
  const res = await fetch(base + pathname, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status !== expectedStatus) {
    throw new Error(`${method} ${pathname} -> ${res.status} (expected ${expectedStatus}): ${await res.text()}`);
  }
  return res.json();
}

module.exports = { startServer, getJson, sendJson, makeTmpHome, FIXTURE_HOME };
