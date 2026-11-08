'use strict';
// agentlray platform export CLI（bin/platform.js export）测试：
//  - 导出包内置 → 生成薄适配器（§6.5 模板 + AGENTLRAY_PKG_ROOT 包根解析）
//  - 默认写入 settings.replaced（自动 replace）
//  - --no-replace 不写 replaced
//  - 若 id 在 settings.disabled 中 → 移出（迁移语义）
//  - 重复导出（无 --force）→ exit 1 + export-exists
//  - --force 覆盖
//  - user 来源（已是本地自定义）拒绝导出 → exit 1 + export-user-origin
//
// 用临时 AGENTLRAY_HOME / 临时平台目录，禁碰真实 ~/.agentlray。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');
const BIN = path.join(REPO_ROOT, 'bin', 'agentlray.js');

function makeEnv(home, extra = {}) {
  return {
    ...process.env,
    HOME: home,
    AGENTLRAY_HOME: home,
    AGENTLRAY_PLATFORMS_DIR: path.join(home, 'u'),
    AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, '.empty-project'),
    ...extra,
  };
}

function runExport(home, args) {
  return spawnSync(process.execPath, [BIN, 'platform', 'export', ...args], {
    encoding: 'utf8',
    env: makeEnv(home),
  });
}

function readSettings(home) {
  try {
    return JSON.parse(fs.readFileSync(path.join(home, '.agentlray', 'settings.json'), 'utf8'));
  } catch {
    return {};
  }
}

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-export-'));
}

test('export 生成薄适配器 + 自动 replace + AGENTLRAY_PKG_ROOT 包根解析', () => {
  const home = tmpHome();
  const outDir = path.join(home, 'u');
  const r = runExport(home, ['codex', '--out', outDir, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const data = JSON.parse(r.stdout);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, 'platform-export');
  assert.equal(data.id, 'codex');
  assert.equal(data.origin, 'package');
  assert.equal(data.replaced, true);
  assert.equal(data.restart, true);

  // 薄适配器内容：use strict + 注释 + path + AGENTLRAY_PKG_ROOT 判空 + require(path.join(root, 'lib/platforms/builtin/codex/index.js'))
  const file = path.join(outDir, 'codex.js');
  assert.ok(fs.existsSync(file));
  const src = fs.readFileSync(file, 'utf8');
  assert.match(src, /'use strict'/);
  assert.match(src, /process\.env\.AGENTLRAY_PKG_ROOT/);
  assert.match(src, /AGENTLRAY_PKG_ROOT is not set/);
  assert.match(src, /require\(path\.join\(root, ["']lib\/platforms\/builtin\/codex\/index\.js["']\)\)/);

  // 自动 replace 写入 settings.replaced
  const settings = readSettings(home);
  assert.deepEqual(settings.platforms.replaced, ['codex']);
});

test('export 的薄适配器在 AgentLRay 加载下解析到包内置实现（origin=user, overrides=package）', () => {
  const home = tmpHome();
  const outDir = path.join(home, 'u');
  fs.mkdirSync(outDir, { recursive: true });
  // 模拟 export 产物 + replaced 配置
  fs.writeFileSync(
    path.join(outDir, 'codex.js'),
    `'use strict';\nconst path = require('path');\nconst root = process.env.AGENTLRAY_PKG_ROOT;\nif (!root) throw new Error('AGENTLRAY_PKG_ROOT is not set; load this adapter through AgentLRay.');\nmodule.exports = require(path.join(root, "lib/platforms/builtin/codex/index.js"));\n`
  );
  fs.mkdirSync(path.join(home, '.agentlray'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agentlray', 'settings.json'),
    JSON.stringify({ platforms: { disabled: [], replaced: ['codex'] } })
  );
  const script = `
    const { listPlatformInfo, PLATFORMS } = require(${JSON.stringify(path.join(REPO_ROOT, 'lib', 'platforms'))});
    const info = listPlatformInfo().find((p) => p.id === 'codex');
    console.log(JSON.stringify({
      origin: info.origin, overrides: info.overrides, mounted: info.mounted, broken: info.broken,
      loadedId: PLATFORMS.codex && PLATFORMS.codex.id, loadedLabel: PLATFORMS.codex && PLATFORMS.codex.label,
    }));
  `;
  const r = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: makeEnv(home),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(out.origin, 'user');
  assert.equal(out.overrides, 'package');
  assert.equal(out.mounted, true);
  assert.equal(out.broken, false);
  assert.equal(out.loadedId, 'codex');
  assert.equal(out.loadedLabel, 'Codex');
});

test('export --no-replace 不写 settings.replaced', () => {
  const home = tmpHome();
  const r = runExport(home, ['codex', '--out', path.join(home, 'u'), '--no-replace']);
  assert.equal(r.status, 0, r.stderr);
  const settings = readSettings(home);
  assert.deepEqual(settings.platforms.replaced, []);
});

test('export 迁移语义：id 在 disabled 中 → 移出恢复挂载', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.agentlray'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agentlray', 'settings.json'),
    JSON.stringify({ platforms: { disabled: ['codex'], replaced: ['omp', 'codex'] } })
  );
  const r = runExport(home, ['codex', '--out', path.join(home, 'u')]);
  assert.equal(r.status, 0, r.stderr);
  const settings = readSettings(home);
  // 移出 disabled，且 replaced 去重保序
  assert.deepEqual(settings.platforms.disabled, []);
  assert.deepEqual(settings.platforms.replaced, ['omp', 'codex']);
});

test('export 重复导出（无 --force）→ exit 1 + export-exists', () => {
  const home = tmpHome();
  const outDir = path.join(home, 'u');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'codex.js'), '// dummy');
  const r = runExport(home, ['codex', '--out', outDir, '--json']);
  assert.equal(r.status, 1);
  const data = JSON.parse(r.stdout);
  assert.equal(data.kind, 'error');
  assert.equal(data.error.code, 'export-exists');
  assert.match(data.error.message, /已存在/);
});

test('export --force 覆盖已存在文件', () => {
  const home = tmpHome();
  const outDir = path.join(home, 'u');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'codex.js'), '// dummy');
  const r = runExport(home, ['codex', '--out', outDir, '--force']);
  assert.equal(r.status, 0, r.stderr);
  const src = fs.readFileSync(path.join(outDir, 'codex.js'), 'utf8');
  assert.match(src, /require\(path\.join\(root/);
});

test('export user 来源（本地自定义）拒绝导出 → exit 1 + export-user-origin', () => {
  const home = tmpHome();
  const outDir = path.join(home, 'u');
  fs.mkdirSync(outDir, { recursive: true });
  // 写一个有效码 user 适配器（id=codex），使加载后 codex origin=user。
  fs.writeFileSync(
    path.join(outDir, 'codex.js'),
    `'use strict';\nconst path = require('path');\nconst root = process.env.AGENTLRAY_PKG_ROOT;\nif (!root) throw new Error('no root');\nmodule.exports = require(path.join(root, "lib/platforms/builtin/codex/index.js"));\n`
  );
  fs.mkdirSync(path.join(home, '.agentlray'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.agentlray', 'settings.json'),
    JSON.stringify({ platforms: { disabled: [], replaced: ['codex'] } })
  );
  // 直接调 platform export 时，lib/platforms 加载后 codex origin=user → 拒绝
  const r = runExport(home, ['codex', '--out', path.join(home, 'other'), '--json']);
  assert.equal(r.status, 1);
  const data = JSON.parse(r.stdout);
  assert.equal(data.error.code, 'export-user-origin');
});

test('export 未知平台 → exit 1 + unknown-platform', () => {
  const home = tmpHome();
  const r = runExport(home, ['nope', '--out', path.join(home, 'u'), '--json']);
  assert.equal(r.status, 1);
  const data = JSON.parse(r.stdout);
  assert.equal(data.error.code, 'unknown-platform');
});
