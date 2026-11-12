'use strict';
// Windows 兼容设计 P3 —— 新增跨平台测试（类 3）。
//
// 这些测试不依赖具体平台，Linux / macOS / Windows 上都能跑：通过子进程
// Object.defineProperty(process, 'platform', …) 模拟 win32/posix 分支，验证
// P0–P1 的跨平台实现：
//   1. lib/config.js HOME 解析（os.homedir() 回退 + AGENTLRAY_HOME 覆盖）
//   2. lib/resume.js buildResumeCommand 的 win32(PowerShell) / posix(POSIX) 命令串
//   3. lib/llm.js findClaudeCli 的 .cmd 后缀探测（win32 仅 .cmd 存在时能探测到）
//   4. bin/sessions.js runChild 的 spawn shell: process.platform === 'win32'
// 约定与项目既有测试一致：node:test + assert/strict，临时 HOME 隔离，不改真实用户数据。

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const CONFIG_PATH = path.join(REPO_ROOT, 'lib', 'config');
const RESUME_PATH = path.join(REPO_ROOT, 'lib', 'resume');
const LLM_PATH = path.join(REPO_ROOT, 'lib', 'llm');

// 子进程里模拟指定 platform 并执行一段代码（config/resume/llm 在 require 期锁
// 定各自平台相关状态，故在子进程内重定义 process.platform 后 require 目标模块）。
function runInPlatform(platformName, code, extraEnv = {}) {
  const script = `
    Object.defineProperty(process, 'platform', { value: ${JSON.stringify(platformName)}, configurable: true });
    ${code}
  `;
  // setup-env.cjs 会全局注入空的 AGENTLRAY_PLATFORMS_DIR；若本用例以临时 HOME 落盘
  // 自定义适配器（makeCustomHome），须把用户平台目录覆盖为 HOME 派生路径。放在
  // extraEnv 之前展开以保证显式覆盖仍生效。
  const homeDerived = extraEnv.HOME
    ? {
        AGENTLRAY_PLATFORMS_DIR: path.join(extraEnv.HOME, '.agentlray', 'platforms'),
        AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(extraEnv.HOME, 'project-platforms'),
      }
    : {};
  const res = spawnSync(NODE, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, ...homeDerived, ...extraEnv },
  });
  assert.equal(res.status, 0, `子进程失败(${platformName}): ${res.stderr}\nstdout: ${res.stdout}`);
  return res.stdout.trim();
}

// ---- 类 3.1：config.js HOME 解析（os.homedir() 回退 + AGENTLRAY_HOME 覆盖） ----

test('config HOME 解析：无 AGENTLRAY_HOME 时回退 os.homedir()，有则覆盖', () => {
  // 无覆盖 → os.homedir()（父进程与子进程环境一致，os.homedir() 结果应相同）
  const probe = `const c = require(${JSON.stringify(CONFIG_PATH)}); console.log(c.HOME);`;
  const clean = { ...process.env };
  delete clean.AGENTLRAY_HOME;
  const r1 = spawnSync(NODE, ['-e', probe], { encoding: 'utf8', env: clean });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.stdout.trim(), os.homedir());

  // AGENTLRAY_HOME 覆盖（便携部署/测试隔离场景）
  const fakeHome = path.join(os.tmpdir(), `agentlray-home-${process.pid}-${Date.now()}`);
  const r2 = spawnSync(NODE, ['-e', probe], {
    encoding: 'utf8',
    env: { ...clean, AGENTLRAY_HOME: fakeHome },
  });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(r2.stdout.trim(), fakeHome);
});

// ---- 类 3.2：buildResumeCommand 命令串（win32 PowerShell vs posix POSIX，含有无 cwd） ----

// 构造一个声明了 resume 契约的自定义平台对象（子进程内自建，保留 args 函数）。
const RESUME_PLATFORM_CODE = `
  const platform = { id: 'mycli', resume: { bin: 'mycli', args: (id) => ['--resume', id] } };
`;

test('buildResumeCommand：win32 输出 PowerShell 语法，posix 输出 POSIX 语法（含 cwd）', async () => {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'resume-cmd-'));
  const runCmd = (platformName, id, opts) =>
    JSON.parse(
      runInPlatform(
        platformName,
        `
          const resume = require(${JSON.stringify(RESUME_PATH)});
          (async () => {
            ${RESUME_PLATFORM_CODE}
            const r = await resume.buildResumeCommand(platform, ${JSON.stringify(id)}, ${JSON.stringify(opts)});
            console.log(JSON.stringify(r.command));
          })().catch((e) => { console.error(e); process.exit(2); });
        `,
        { HOME: tmpHome }
      )
    );

  // posix：含 cwd → `cd 'cwd' && bin args`
  assert.equal(runCmd('linux', 'abc-123', { cwd: '/proj dir' }), `cd '/proj dir' && mycli --resume abc-123`);
  // posix：无 cwd → 省略 cd 前缀
  assert.equal(runCmd('linux', 'abc-123', {}), `mycli --resume abc-123`);

  // win32：含 cwd → `Set-Location 'cwd'; & bin args`
  assert.equal(
    runCmd('win32', 'abc-123', { cwd: 'C:\\proj dir' }),
    `Set-Location 'C:\\proj dir'; & mycli --resume abc-123`
  );
  // win32：无 cwd → 省略 Set-Location
  assert.equal(runCmd('win32', 'abc-123', {}), `& mycli --resume abc-123`);
});

test('buildResumeCommand：win32 下 bin 含空格（如 Program Files）时被单引号包裹（I1）', async () => {
  const tmpHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'resume-cmd-bin-'));
  const runCmd = (platformName, id, opts) =>
    JSON.parse(
      runInPlatform(
        platformName,
        `
          const resume = require(${JSON.stringify(RESUME_PATH)});
          (async () => {
            const platform = { id: 'mycli', resume: { bin: 'C:\\\\Program Files\\\\mycli.exe', args: (id) => ['--resume', id] } };
            const r = await resume.buildResumeCommand(platform, ${JSON.stringify(id)}, ${JSON.stringify(opts)});
            console.log(JSON.stringify(r.command));
          })().catch((e) => { console.error(e); process.exit(2); });
        `,
        { HOME: tmpHome }
      )
    );

  // 含空格/反斜杠的 bin 在 PowerShell 中裸拼会解析失败（C:\Program 被当命令），
  // 现应被 psShellQuote 单引号包裹（反斜杠原样保留、单引号双写转义）。
  assert.equal(
    runCmd('win32', 'abc-123', { cwd: 'C:\\proj dir' }),
    `Set-Location 'C:\\proj dir'; & 'C:\\Program Files\\mycli.exe' --resume abc-123`
  );
  // posix：bin 保持既有行为（裸拼，不额外引号；PATH 下含空格的自定义 bin 在本平台
  // 由 runChild 的 resolveExecutablePath 处理，命令串仅作展示）。
  assert.equal(
    runCmd('linux', 'abc-123', { cwd: '/proj dir' }),
    `cd '/proj dir' && C:\\Program Files\\mycli.exe --resume abc-123`
  );
});

// ---- 类 3.3：findClaudeCli 的 .cmd 后缀探测（win32 仅 .cmd 存在时能探测到） ----

test('findClaudeCli：win32 下仅 claude.cmd 存在时能探测到；posix 探测不到', async () => {
  const tmpBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-bin-'));
  // 只放一个 claude.cmd（.cmd 无执行位语义，Windows 上靠存在性 + 后缀扫描命中）
  await fsp.writeFile(path.join(tmpBin, 'claude.cmd'), '@echo off\r\n');
  const findCode = `
    const llm = require(${JSON.stringify(LLM_PATH)});
    console.log(JSON.stringify(llm.findClaudeCli()));
  `;

  // win32：补扫 .cmd 后缀 → 命中 claude.cmd
  const win = runInPlatform('win32', findCode, { PATH: tmpBin, AGENTLRAY_CLAUDE_BIN: 'claude' });
  assert.equal(JSON.parse(win), path.join(tmpBin, 'claude.cmd'));

  // posix：只认可执行位、不带 .cmd 后缀 → 探测不到（返回 null）
  const posix = runInPlatform('linux', findCode, { PATH: tmpBin, AGENTLRAY_CLAUDE_BIN: 'claude' });
  assert.equal(JSON.parse(posix), null);
});

// ---- 类 3.4：bin/sessions.js runChild 的 spawn shell: process.platform === 'win32' ----

// 在临时 HOME 写入自定义平台适配器 my-copilot（声明 resume 契约，供 resumeSession
// --run 走 runChild；与 session-cli.test.js 的 addCustomPlatform 同构）。
async function makeCustomHome() {
  const home = await fsp.mkdtemp(path.join(os.tmpdir(), 'win-spawn-'));
  const dir = path.join(home, '.agentlray', 'platforms');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(
    path.join(dir, 'my-copilot.js'),
    `module.exports = {
  id: 'my-copilot',
  label: 'My Copilot',
  defaultDir: () => '/fixtures/my-copilot',
  list: async () => [],
  parse: async () => null,
  getSession: async (_dir, sessionId) =>
    sessionId === 'mp-1234'
      ? { session: { id: sessionId, cwd: '/fixtures/project-mp' }, messages: [] }
      : null,
  resume: {
    bin: 'my-copilot-cli',
    args: (id) => ['--resume', id],
  },
};
`
  );
  return home;
}

// runChild 不对外导出，但 resumeSession（导出）的 --run 路径会调用它。这里在
// 子进程内重定义 process.platform 并打补丁 child_process.spawn，捕获 runChild 实际
// 传入的命令/参数/shell 选项——避免在 Linux 上真去 spawn cmd.exe（会 ENOENT），既
// 确定性又全平台可跑。K1 修复后两平台均 shell=false，win32 经 resolveExecutablePath
// 把裸命令名/相对路径 resolve 成 PATH 内可执行文件全路径（无 shell 也能跑 .cmd）。
function captureSpawnShell(platformName, home) {
  const out = runInPlatform(
    platformName,
    `
      const cp = require('node:child_process');
      const captured = [];
      const origSpawn = cp.spawn;
      cp.spawn = (cmd, args, opts) => {
        captured.push({ cmd, args, shell: Boolean(opts && opts.shell) });
        // 伪子进程：close 时以退出码 0 收口，让 runChild 的 Promise 正常 resolve。
        let closeCb;
        const child = {
          on: (ev, cb) => { if (ev === 'close') closeCb = cb; return child; },
          once: () => child,
          unref: () => {},
        };
        setImmediate(() => closeCb && closeCb(0));
        return child;
      };
      const { resumeSession } = require(${JSON.stringify(path.join(REPO_ROOT, 'bin', 'sessions'))});
      (async () => {
        await resumeSession({ platform: 'my-copilot', id: 'mp-1234', run: true, cwd: '/' }, true);
        console.log(JSON.stringify(captured));
      })().catch((e) => { console.error('RESUME_ERR', e && e.message); process.exit(2); });
    `,
    { HOME: home }
  );
  const captured = JSON.parse(out.split('\n').filter((l) => l.trim()).pop());
  assert.equal(captured.length, 1, 'runChild 应恰好 spawn 一次');
  return captured[0];
}

test('runChild spawn：posix 与 win32 均无 shell（数组参数不拼接、无注入面）；win32 resolve 全路径', async () => {
  const home = await makeCustomHome();

  // posix：shell=false，直接以可执行文件方式 spawn（PATH 解析交给 spawn 自身）
  const posix = captureSpawnShell('linux', home);
  assert.equal(posix.cmd, 'my-copilot-cli');
  assert.deepEqual(posix.args, ['--resume', 'mp-1234']);
  assert.equal(posix.shell, false);

  // win32：resolve 出可执行文件全路径后无 shell spawn（shell 恒 false）。
  // 自定义 resume.bin='my-copilot-cli' 不在 PATH，resolveExecutablePath miss 后回退
  // 原值，spawn 报 ENOENT——此处只验证「不走 shell、不拼接」的注入防护性质。
  const win = captureSpawnShell('win32', home);
  assert.equal(win.cmd, 'my-copilot-cli');
  assert.deepEqual(win.args, ['--resume', 'mp-1234']);
  assert.equal(win.shell, false, 'win32 不得走 shell（数组参数拼接有注入风险，K1）');
});

// ---- 类 3.4b：win32 下 resolveExecutablePath 将裸命令名 resolve 成 PATH 内 .cmd 全路径 ----

test('resolveExecutablePath：win32 下将裸命令名 resolve 成 PATH 内 .cmd 全路径；posix 原样返回', async () => {
  const tmpBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'resolv-bin-'));
  await fsp.writeFile(path.join(tmpBin, 'omp.cmd'), '@echo off\r\n');
  await fsp.writeFile(path.join(tmpBin, 'codex.cmd'), '@echo off\r\n');

  const resolveProbe = (platformName, bin, extraEnv = {}) => {
    const out = runInPlatform(
      platformName,
      `
        const { resolveExecutablePath } = require(${JSON.stringify(path.join(REPO_ROOT, 'bin', 'sessions'))});
        console.log(JSON.stringify(resolveExecutablePath(${JSON.stringify(bin)})));
      `,
      { PATH: tmpBin, ...extraEnv }
    );
    return JSON.parse(out);
  };

  // win32：omp → <tmpBin>/omp.cmd（补扫 .cmd 后缀，全路径、无 shell 可执行）
  assert.equal(resolveProbe('win32', 'omp'), path.join(tmpBin, 'omp.cmd'));

  // win32：绝对路径含 .cmd → 原样返回
  assert.equal(resolveProbe('win32', path.join(tmpBin, 'codex.cmd')), path.join(tmpBin, 'codex.cmd'));

  // posix：裸名原样返回（PATH 解析交给 spawn 自身）
  assert.equal(resolveProbe('linux', 'omp'), 'omp');
});

// ---- 类 3.5：omp 续跑治理的 Windows 降级（无法判断激活/无法关进程 → 直接续跑） ----

// omp 的 resumeHooks.prepare/terminateOmpHolder 依赖 /proc 与 SIGTERM/SIGKILL，
// 仅 Linux 可用。Windows 上应降级为「不抛错、直接放行续跑」（terminated=false、
// livePid=null），保证任务执行不被激活状态判断/进程关闭阻塞。
const OMP_RESUME_PATH = path.join(REPO_ROOT, 'lib', 'platforms', 'builtin', 'omp', 'resume');

test('omp resumeHooks：win32 下 prepare 无法判断激活状态时直接放行续跑（不抛错）', () => {
  const out = runInPlatform(
    'win32',
    `
      require(${JSON.stringify(path.join(REPO_ROOT, 'test', 'setup-env.cjs'))});
      const { createOmpResumeHooks, terminateOmpHolder } = require(${JSON.stringify(OMP_RESUME_PATH)});
      const hooks = createOmpResumeHooks();
      (async () => {
        const t = terminateOmpHolder(12345); // win32：恒 false（无信号语义）
        const prepared = await hooks.prepare({
          run: true,
          dir: ${JSON.stringify(path.join(__dirname, 'fixtures', 'home', '.omp', 'agent', 'sessions'))},
          id: '019a0000-0000-7000-8000-00000000aaaa',
          cwd: '/fixtures/project-gamma',
        });
        console.log(JSON.stringify({ terminateResult: t, prepared }));
      })().catch((e) => { console.error('RESUME_ERR', e && e.message); process.exit(2); });
    `,
    { AGENTLRAY_NO_PLUGINS: '1' }
  );
  const doc = JSON.parse(out.split('\n').filter((l) => l.trim()).pop());
  // 无法关闭进程：terminateOmpHolder 返回 false 而非抛错
  assert.equal(doc.terminateResult, false);
  // 无法判断激活状态：prepare 直接放行（livePid=null、terminated=false、不抛错）
  assert.equal(doc.prepared.livePid, null);
  assert.equal(doc.prepared.terminated, false);
  assert.ok(doc.prepared.state, '--run 仍应带回 state 供 after 派生兜底校验');
});

// Linux 下持有进程「无法被终止」时（kill 抛 EPERM 等），terminateOmpHolder 应
// 返回 false（降级：直接续跑、terminated=false）而非抛错——保证进程关闭失败
// 不阻塞任务执行。通过 mock /proc 与 process.kill 模拟「存活但无终止权限」。
test('omp resumeHooks：linux 下进程无法终止时 terminateOmpHolder 返回 false 不抛错（降级）', () => {
  const out = runInPlatform(
    'linux',
    `
      require(${JSON.stringify(path.join(REPO_ROOT, 'test', 'setup-env.cjs'))});
      const fs = require('node:fs');
      const realRead = fs.readFileSync;
      const realKill = process.kill;
      // mock：目标 pid 在 /proc 存在且非僵尸（alive → true），但 kill 一律 EPERM
      //（无权限终止，如跨用户进程）→ SIGTERM/SIGKILL 均失败 → 最终返回 false。
      fs.readFileSync = (p, ...rest) => {
        if (String(p).startsWith('/proc/424242/stat')) return '424242 (holder) S 1 1 1 0 -1 4194560 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
        return realRead(p, ...rest);
      };
      process.kill = (pid, sig) => {
        if (sig === 0) return; // 存活探测成功
        const err = new Error('operation not permitted');
        err.code = 'EPERM';
        throw err;
      };
      const { terminateOmpHolder } = require(${JSON.stringify(OMP_RESUME_PATH)});
      // 缩短等待窗口，避免测试长时间空转
      const result = terminateOmpHolder(424242, { termWaitMs: 100, killWaitMs: 100 });
      console.log(JSON.stringify({ result }));
      fs.readFileSync = realRead;
      process.kill = realKill;
    `,
    { AGENTLRAY_NO_PLUGINS: '1' }
  );
  const doc = JSON.parse(out.split('\n').filter((l) => l.trim()).pop());
  assert.equal(doc.result, false, '无法终止时应返回 false（降级续跑），而非抛错');
});
