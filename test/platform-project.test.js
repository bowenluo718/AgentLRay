'use strict';
// 项目平台来源（AGENTLRAY_PROJECT_PLATFORMS_DIR / <repo>/platforms）加载测试：
//  - 项目目录被当作独立来源加载，默认挂载，origin=project
//  - 可被 unmount（写 settings.disabled）停用
//  - manifest.json 的 replaces 声明并入生效替代集合（settings.replaced ∪ manifest.replaces）
//  - manifest 缺失/损坏 → 忽略不失败
//
// 用临时目录作为项目来源，禁碰真实 <repo>/platforms 与 ~/.agentlray。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'agentlray.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-project-'));
}

// 生成一个「继承包内置」的薄适配器（与 export 产物一致），以某个内置 id 作为项目平台。
function thinAdapterSource(id) {
  return `'use strict';\nconst path = require('path');\nconst root = process.env.AGENTLRAY_PKG_ROOT;\nif (!root) throw new Error('no root');\nmodule.exports = require(path.join(root, ${JSON.stringify(path.posix.join('lib', 'platforms', 'builtin', `${id}.js`))}));\n`;
}

function makeEnv(home, projectDir) {
  return {
    ...process.env,
    HOME: home,
    AGENTLRAY_HOME: home,
    AGENTLRAY_PLATFORMS_DIR: path.join(home, 'u'),
    AGENTLRAY_PROJECT_PLATFORMS_DIR: projectDir,
  };
}

function loadInfo(home, projectDir) {
  const script = `
    const { listPlatformInfo } = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'platforms'))});
    console.log(JSON.stringify(listPlatformInfo().map((p) => ({
      id: p.id, origin: p.origin, mounted: p.mounted, configuredMounted: p.configuredMounted,
      broken: p.broken, overrides: p.overrides, replacementPending: p.replacementPending,
      error: p.error,
    }))));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: makeEnv(home, projectDir),
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

test('项目平台默认挂载，origin=project，可加载（复用包内置薄适配器）', () => {
  const home = tmpHome();
  const projectDir = path.join(home, 'proj-platforms');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'codex.js'), thinAdapterSource('codex'));
  // 项目覆盖包内置需已声明替代——用 manifest 声明。
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({ replaces: ['codex'] }));
  const info = loadInfo(home, projectDir);
  const codex = info.find((p) => p.id === 'codex' && p.origin === 'project');
  assert.ok(codex, 'codex 应从项目来源存在');
  assert.equal(codex.origin, 'project');
  assert.equal(codex.mounted, true);
  assert.equal(codex.configuredMounted, true);
  assert.equal(codex.broken, false);
  assert.equal(codex.overrides, 'package'); // 项目覆盖包内置
  assert.equal(codex.replacementPending, false);
});

test('项目平台可通过 unmount 停用（写 settings.disabled），重启后生效', () => {
  const home = tmpHome();
  const projectDir = path.join(home, 'proj-platforms');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'codex.js'), thinAdapterSource('codex'));
  // 先配置 replaced（否则未声明替代的项目覆盖会被 broken），再 unmount。
  const r = spawnSync(process.execPath, [BIN, 'platform', 'unmount', 'codex', '--json'], {
    encoding: 'utf8',
    env: makeEnv(home, projectDir),
  });
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(
    fs.readFileSync(path.join(home, '.agentlray', 'settings.json'), 'utf8')
  );
  assert.ok(settings.platforms.disabled.includes('codex'));
  // disabled 后（模拟重启）项目平台 origin 仍在但不可查询（mounted=false）
  const info = loadInfo(home, projectDir);
  const codex = info.find((p) => p.id === 'codex' && p.origin === 'project');
  assert.ok(codex);
  assert.equal(codex.mounted, false);
  assert.equal(codex.configuredMounted, false);
});

test('manifest.replaces 声明替代项目内置 → 项目覆盖生效（origin=project）', () => {
  const home = tmpHome();
  const projectDir = path.join(home, 'proj-platforms');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'codex.js'), thinAdapterSource('codex'));
  // manifest 声明 replaces:['codex']，即使 settings.replaced 为空也视为已声明替代。
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({ replaces: ['codex'] }));
  const info = loadInfo(home, projectDir);
  const codex = info.find((p) => p.id === 'codex' && p.origin === 'project');
  assert.ok(codex);
  assert.equal(codex.origin, 'project');
  assert.equal(codex.broken, false);
});

test('未声明替代的项目平台同 id → broken（提示 export/replace）', () => {
  const home = tmpHome();
  const projectDir = path.join(home, 'proj-platforms');
  fs.mkdirSync(projectDir, { recursive: true });
  // settings 无 replaced，manifest 无 replaces —— 项目同 id 覆盖包内置缺替代声明
  fs.writeFileSync(path.join(projectDir, 'codex.js'), thinAdapterSource('codex'));
  const info = loadInfo(home, projectDir);
  // 同 id 会返回两条：packaged 正常 + project 损坏。取 project 来源那条。
  const codex = info.find((p) => p.id === 'codex' && p.origin === 'project');
  assert.ok(codex);
  assert.equal(codex.broken, true);
  assert.match(codex.error || '', /export|replace/);
});

test('manifest 缺失/损坏 → 忽略不失败，不影响已加载平台', () => {
  const home = tmpHome();
  const projectDir = path.join(home, 'proj-platforms');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'codex.js'), thinAdapterSource('codex'));
  // manifest 损坏（非 JSON 且非 replaces 数组）
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), 'not-json{{{');
  const info = loadInfo(home, projectDir);
  const codex = info.find((p) => p.id === 'codex' && p.origin === 'project');
  assert.ok(codex);
  assert.equal(codex.broken, true); // 无替代声明 → broken（与 manifest 缺失场景一致）
  assert.match(codex.error || '', /export|replace/);

  // 且不抛错：其余内置平台仍完整
  assert.ok(info.some((p) => p.id === 'openclaw' && p.origin === 'package'));
});

test('readProjectManifestReplaces：损坏 → 空数组；缺失 → 空数组', () => {
  const home = tmpHome();
  const projectDir = path.join(home, 'proj-platforms');
  fs.mkdirSync(projectDir, { recursive: true });
  const { readProjectManifestReplaces } = require(path.join(REPO_ROOT, 'lib', 'platforms', 'loader'));
  assert.deepEqual(readProjectManifestReplaces(projectDir), []); // 缺失
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), 'bad json');
  assert.deepEqual(readProjectManifestReplaces(projectDir), []); // 损坏
  fs.writeFileSync(path.join(projectDir, 'manifest.json'), JSON.stringify({ replaces: ['a', 1, 'b'] }));
  assert.deepEqual(readProjectManifestReplaces(projectDir), ['a', 'b']); // 过滤非字符串
});
