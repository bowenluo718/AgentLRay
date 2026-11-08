// OpenClaw adapter tests.
//
// 回归目标：
// 1. openclaw 会话里 user 消息的 content 是**字符串**（非数组）——真实用户输入
//    直接以纯文本字符串落盘（assistant 消息才是数组块）。元数据解析与
//    normalizeMessage 必须兼容字符串 content，否则 firstUserMessage/lastMessage
//    全部丢失 → 会话标题与首消息显示"无消息"。
// 2. openclaw 会在用户消息外包一层元信息前缀（定时任务 [cron:...]、心跳
//    [OpenClaw heartbeat poll]、时戳 [Fri 2026-10-30 00:52 GMT+8]），这些是
//    平台注入而非用户输入，标题/首消息应剥离前缀后取真实内容。

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const oc = require(path.join(__dirname, '..', 'lib', 'platforms', 'builtin', 'openclaw', 'parse'));
const { stripOpenClawNoise } = oc;

function writeSession(recs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlray-openclaw-test-'));
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

test('parseSessionMetadata 从字符串 content 的 user 消息提取 firstUserMessage', async (t) => {
  const recs = [
    SESSION_REC,
    { type: 'message', id: 'm1', timestamp: '2026-01-18T10:00:01.000Z', message: { role: 'user', content: '帮我查一下天气' } },
    {
      type: 'message',
      id: 'm2',
      timestamp: '2026-01-18T10:00:05.000Z',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: '好的，正在查询' }, { type: 'toolCall', id: 'c1', name: 'web_search', arguments: { q: '天气' } }],
      },
    },
  ];
  const { dir, file } = writeSession(recs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = await oc.parseSessionMetadata(file, path.basename(file));
  assert.equal(meta.firstUserMessage, '帮我查一下天气');
  // 最后一条是 assistant 消息 → lastMessage 指向它（字符串 content 也被正确提取）
  assert.equal(meta.lastMessage.role, 'assistant');
  assert.equal(meta.lastMessage.text, '好的，正在查询');
  assert.equal(meta.userCount, 1);
  assert.equal(meta.assistantCount, 1);
});

test('normalizeMessage 兼容字符串 content 的 user 消息', () => {
  const normalized = oc.normalizeMessage({
    type: 'message',
    id: 'm1',
    timestamp: '2026-01-18T10:00:01.000Z',
    message: { role: 'user', content: '纯文本输入' },
  });
  assert.equal(normalized.role, 'user');
  assert.deepEqual(normalized.content, [{ type: 'text', text: '纯文本输入' }]);
});

test('parseSessionFile 详情页同样兼容字符串 content', async (t) => {
  const recs = [
    SESSION_REC,
    { type: 'message', id: 'm1', timestamp: '2026-01-18T10:00:01.000Z', message: { role: 'user', content: '帮我查一下天气' } },
  ];
  const { dir, file } = writeSession(recs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { session, messages } = await oc.parseSessionFile(file);
  assert.equal(session.id, 'aaaaaaaa-1111-2222-3333-444455556666');
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].content, [{ type: 'text', text: '帮我查一下天气' }]);
});

// --- stripOpenClawNoise：剥离平台注入的元信息前缀 ---

test('stripOpenClawNoise 剥离时戳前缀保留真实用户输入', () => {
  assert.equal(stripOpenClawNoise('[Fri 2026-10-30 00:52 GMT+8] 你是谁'), '你是谁');
});

test('stripOpenClawNoise 剥离 cron 定时任务前缀保留实际指令', () => {
  assert.equal(
    stripOpenClawNoise('[cron:9d7186b9-14f9-43e5-b2da-96388e36d809 PLAN_AUTO_EVERY1M_1793286386230933] 【ST022】该喝水啦'),
    '【ST022】该喝水啦'
  );
});

test('stripOpenClawNoise 剥离 heartbeat 前缀', () => {
  assert.equal(stripOpenClawNoise('[OpenClaw heartbeat poll]'), '');
});

test('parseSessionMetadata 对带前缀的字符串 user 消息提取剥离后的 firstUserMessage', async (t) => {
  const recs = [
    SESSION_REC,
    {
      type: 'message',
      id: 'm1',
      timestamp: '2026-01-18T10:00:01.000Z',
      message: { role: 'user', content: '[Fri 2026-10-30 00:52 GMT+8] 你是谁' },
    },
  ];
  const { dir, file } = writeSession(recs);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const meta = await oc.parseSessionMetadata(file, path.basename(file));
  assert.equal(meta.firstUserMessage, '你是谁');
  assert.equal(meta.title, '你是谁');
});

test('stripOpenClawNoise 剥离 cron 消息里的 Current time/Reference UTC 注入行', () => {
  const input =
    '[cron:074a3829-c17a-4606-a359-171a9ced2070 RPM7_RP_1793289662] 每天输出一次工作进展总结\nCurrent time: Friday, October 30th, 2026 - 14:06 (Asia/Shanghai)\nReference UTC: 2026-10-30 06:06 UTC';
  assert.equal(stripOpenClawNoise(input), '每天输出一次工作进展总结');
});
