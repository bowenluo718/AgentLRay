// Registry contract: every platform entry must expose the interface the
// generic routes (sessions/search/watch/insights/export/otlp) rely on.
// Guards against a new adapter being registered with a missing capability.

// 本测试只守护内置平台契约。v2（平台来源统一）后 lib/platforms 在 require 期同步
// 读 settings 的 platforms section（disabled/replaced）并并入 ~/.agentlray/platforms/
// 自定义适配器，因此须在 require 之前：① 禁用自定义平台；② 把 HOME 指到临时目录，
// 使 readPlatformStateSync 读到空的 settings（无 disabled/replaced），保证「空配置
// 基线 → 7 个内置平台」的确定性，不受用户本机配置（如禁用了 gemini）影响。
process.env.AGENTLRAY_NO_PLUGINS = '1';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-registry-'));
// setup-env.cjs 全局注入的空来源目录不基于本测试的临时 HOME，重置为空目录，
// 确保 lib/platforms 不并入任何自定义适配器。
process.env.AGENTLRAY_PLATFORMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-registry-user-'));
process.env.AGENTLRAY_PROJECT_PLATFORMS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-registry-project-'));

const test = require('node:test');
const assert = require('node:assert/strict');

const { PLATFORMS, collectSessionFiles } = require(path.join(__dirname, '..', 'lib', 'platforms'));
const { makeMessage } = require(path.join(__dirname, '..', 'lib', 'platforms', 'shared'));
const { EXPORT_PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'export'));
const { OTLP_PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'otlp'));
const { TOOL_AUDIT_PLATFORMS } = require(path.join(__dirname, '..', 'lib', 'tool-audit'));

const FILE_PLATFORMS = ['openclaw', 'codex', 'claude-code', 'omp', 'dsh', 'gemini'];

test('registry contains every platform with id, label and defaultDir', () => {
  assert.deepEqual(Object.keys(PLATFORMS).sort(), [...FILE_PLATFORMS, 'hermes'].sort());
  for (const [key, p] of Object.entries(PLATFORMS)) {
    assert.equal(p.id, key);
    assert.equal(typeof p.label, 'string');
    assert.equal(typeof p.defaultDir(), 'string');
    assert.equal(typeof p.getSession, 'function', `${key} missing getSession`);
  }
});

test('file-based platforms expose find/parse/collectFiles/watchParse', () => {
  for (const key of FILE_PLATFORMS) {
    const p = PLATFORMS[key];
    assert.equal(typeof p.find, 'function', `${key} missing find`);
    assert.equal(typeof p.parse, 'function', `${key} missing parse`);
    assert.equal(typeof p.collectFiles, 'function', `${key} missing collectFiles`);
    assert.equal(typeof p.watchParse, 'function', `${key} missing watchParse`);
  }
  // hermes is SQLite-backed: no session files to find/collect/tail
  assert.equal(PLATFORMS.hermes.find, null);
  assert.equal(PLATFORMS.hermes.collectFiles, null);
});

test('derived registries stay in sync with PLATFORMS', () => {
  // Export covers every platform; OTLP every file platform except openclaw
  assert.deepEqual(Object.keys(EXPORT_PLATFORMS).sort(), Object.keys(PLATFORMS).sort());
  assert.deepEqual(Object.keys(OTLP_PLATFORMS).sort(), FILE_PLATFORMS.filter((k) => !PLATFORMS[k].needsAgent).sort());
  assert.deepEqual([...TOOL_AUDIT_PLATFORMS].sort(), FILE_PLATFORMS.sort());
});

test('makeMessage carries the full normalized shape and applies overrides', () => {
  const base = makeMessage({});
  assert.deepEqual(Object.keys(base).sort(), [
    'content',
    'details',
    'id',
    'isError',
    'model',
    'provider',
    'role',
    'timestamp',
    'toolCallId',
    'toolName',
    'usage',
  ]);
  const m = makeMessage({ role: 'toolCall', toolCallId: 'c1', toolName: 'bash' });
  assert.equal(m.role, 'toolCall');
  assert.equal(m.toolCallId, 'c1');
  assert.equal(m.toolName, 'bash');
  assert.deepEqual(m.content, []);
  assert.equal(m.isError, false);
});

test('collectSessionFiles returns [] for unknown or file-less platforms', async () => {
  assert.deepEqual(await collectSessionFiles('nope', '', ''), []);
  assert.deepEqual(await collectSessionFiles('hermes', '', ''), []);
});
