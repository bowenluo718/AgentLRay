// Unit tests for the shared analysis traversal seam (lib/analyze.js, C4).
// search / insights / prompts / tool-audit 骑在其上：逐文件容错（单个坏文件不拖垮
// 整批）、collectFiles 缺失/异常降级 []、预算提前终止。容错与预算在同一处测一次。

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectFiles, iterateFiles, mapFiles } = require('../lib/analyze');

const files = [{ path: '/a', sessionId: 's1' }, { path: '/b', sessionId: 's2' }, { path: '/c', sessionId: 's3' }];

test('iterateFiles：逐文件容错，单个坏文件不拖垮整批', async () => {
  const seen = [];
  await iterateFiles(
    files,
    (f) => {
      if (f.path === '/b') throw new Error('bad file');
      return { ok: f.path };
    },
    (f, result) => {
      if (result) seen.push(f.path); // /b 失败置 null，被 accumulate 跳过
    }
  );
  assert.deepEqual(seen, ['/a', '/c']);
});

test('iterateFiles：onResult 返回 false 预算耗尽立即终止', async () => {
  const seen = [];
  await iterateFiles(files, (f) => ({ ok: f.path }), (f, result) => {
    seen.push(f.path);
    return seen.length < 2; // 处理两个文件后终止
  });
  assert.deepEqual(seen, ['/a', '/b']);
});

test('iterateFiles：scan 返回 null 结果同样跳过，不终止（无限处理）', async () => {
  const seen = [];
  await iterateFiles(files, () => null, (f, result) => {
    assert.equal(result, null);
    seen.push(f.path);
  });
  assert.deepEqual(seen, ['/a', '/b', '/c']);
});

test('mapFiles：并行逐文件，单个失败置 null，其余照常', async () => {
  const results = await mapFiles(files, async (f) => {
    if (f.path === '/b') throw new Error('bad');
    return f.sessionId;
  });
  assert.deepEqual(results, ['s1', null, 's3']);
});

test('collectFiles：collectFiles 缺失/异常 → []', async () => {
  assert.deepEqual(await collectFiles({}, '/dir'), []);
  assert.deepEqual(
    await collectFiles({ collectFiles: async () => { throw new Error('boom'); } }, '/dir'),
    []
  );
  assert.deepEqual(
    await collectFiles({ collectFiles: async () => [{ path: '/x' }] }, '/dir', { agent: 'a' }),
    [{ path: '/x' }]
  );
});
