// Prompts 提取器回归测试：字符串与数组 content 的兼容性。
//
// 背景：openclaw 平台的 user 消息 content 是**字符串**（纯文本落盘），而
// claude-code/codex 兼容字符串与数组块。各平台专属提取器（openclaw/omp）与
// 服务自定义平台的通用提取器（extractGenericJsonlPrompts）必须同时兼容两种
// 形状，否则字符串 content 会因 `Array.isArray` 为 false 被丢光 → Prompts
// 视图为空。
//
// 覆盖：
// - extractOpenClawPrompts   字符串 + 数组 content、带时戳前缀剥离（见 openclaw.test.js）
// - extractGenericJsonlPrompts  message 分支（openclaw-like）字符串 content

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const { extractGenericJsonlPrompts } = require(path.join(__dirname, '..', 'lib', 'prompts'));

function writeSession(recs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-prompts-extract-'));
  const file = path.join(dir, 'aaaaaaaa-1111-2222-3333-444455556666.jsonl');
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { dir, file };
}

const SESSION_REC = {
  type: 'session',
  version: '1',
  id: 'aaaaaaaa-1111-2222-3333-444455556666',
  timestamp: '2026-01-18T10:00:00.000Z',
  cwd: '/fixtures/project-omega',
};

test('extractGenericJsonlPrompts message 分支兼容字符串 content（openclaw-like）', async (t) => {
  const recs = [
    SESSION_REC,
    { type: 'message', id: 'm1', timestamp: '2026-01-18T10:00:01.000Z', message: { role: 'user', content: '字符串提示词' } },
    {
      type: 'message',
      id: 'm2',
      timestamp: '2026-01-18T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: '收到' }] },
    },
  ];
  const { dir, file } = writeSession(recs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { prompts } = await extractGenericJsonlPrompts(file);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, '字符串提示词');
  assert.equal(prompts[0].timestamp, '2026-01-18T10:00:01.000Z');
});

test('extractGenericJsonlPrompts message 分支兼容数组块 content（openclaw-like）', async (t) => {
  const recs = [
    SESSION_REC,
    {
      type: 'message',
      id: 'm1',
      timestamp: '2026-01-18T10:00:01.000Z',
      message: { role: 'user', content: [{ type: 'text', text: '数组块提示词' }] },
    },
  ];
  const { dir, file } = writeSession(recs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { prompts } = await extractGenericJsonlPrompts(file);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, '数组块提示词');
});

test('extractGenericJsonlPrompts message 分支剥离时戳前缀后提取字符串 content', async (t) => {
  const recs = [
    SESSION_REC,
    {
      type: 'message',
      id: 'm1',
      timestamp: '2026-01-18T10:00:01.000Z',
      message: { role: 'user', content: '[Fri 2026-10-30 00:52 GMT+8] 拉取镜像到目录' },
    },
  ];
  const { dir, file } = writeSession(recs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { prompts } = await extractGenericJsonlPrompts(file);
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, '拉取镜像到目录');
});
