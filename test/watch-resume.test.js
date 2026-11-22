// SSE 断线补拉（B-1）：/api/watch 事件带 `id: <字节偏移>`；重连时带 `?after=` 或
// `Last-Event-ID` 头从该偏移续读——断线期间写入的消息在重连后补发且不重复。
// 偏移失效（文件轮转/截断）时回落全量基线，不报错、不卡死。

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer } = require('./helpers.js');

const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
const OMP1_FILE = path.join(
  '.omp',
  'agent',
  'sessions',
  '-fixtures-project-gamma',
  '2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl'
);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 最小 SSE 客户端：收集 {event, data, id}，跳过 ping。
async function connectSse(url, headers = {}) {
  const controller = new AbortController();
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { accept: 'text/event-stream', ...headers },
  });
  if (!res.ok) throw new Error(`SSE connect failed: ${res.status}`);
  const events = [];
  let buffer = '';
  const decoder = new TextDecoder();
  (async () => {
    try {
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx = buffer.indexOf('\n\n');
        while (idx !== -1) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          let event = 'message';
          let data = '';
          let id = null;
          for (const line of raw.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7);
            else if (line.startsWith('data: ')) data += line.slice(6);
            else if (line.startsWith('id: ')) id = line.slice(4);
          }
          if (data) events.push({ event, data: JSON.parse(data), id });
          idx = buffer.indexOf('\n\n');
        }
      }
    } catch {
      /* aborted on close */
    }
  })();
  return {
    events,
    close: () => controller.abort(),
    async waitFor(name, timeoutMs = 5000, from = 0) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = events.slice(from).find((e) => e.event === name);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for SSE event ${name}`);
        await sleep(25);
      }
    },
  };
}

function ompUserLine(id, text) {
  return JSON.stringify({
    type: 'message',
    id,
    parentId: null,
    timestamp: '2026-01-20T09:00:00.000Z',
    message: { role: 'user', content: [{ type: 'text', text }], attribution: 'user' },
  });
}

const textsOf = (ev) => ev.data.messages.map((m) => m.content[0].text);

describe('watch SSE 断线补拉（B-1）', () => {
  let srv;
  let filePath;
  before(async () => {
    srv = await startServer();
    filePath = path.join(srv.home, OMP1_FILE);
  });
  after(async () => {
    await srv.stop();
  });

  it('connected 事件携带字节偏移 id；newMessages 的 id 单调递增到文件末尾', async () => {
    const sse = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
    try {
      const connected = await sse.waitFor('connected');
      assert.match(connected.id, /^\d+$/);
      const offset = Number(connected.id);
      assert.ok(offset > 0);
      const stat = await fsp.stat(filePath);
      assert.equal(offset, stat.size, '全量模式下 connected id 应为文件当前大小');
    } finally {
      sse.close();
    }
  });

  it('断线期间写入 3 条，带 ?after= 重连只补发这 3 条（不重复、不丢）', async () => {
    // 1) 建立连接并记下偏移，然后断开。
    const first = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
    const connected = await first.waitFor('connected');
    const after = Number(connected.id);
    first.close();
    await sleep(100);

    // 2) 「断线」期间写入 3 条。
    await fsp.appendFile(filePath, `${ompUserLine('om-r1', 'resume: one')}\n`);
    await fsp.appendFile(filePath, `${ompUserLine('om-r2', 'resume: two')}\n`);
    await fsp.appendFile(filePath, `${ompUserLine('om-r3', 'resume: three')}\n`);

    // 3) 带 after 重连：连接后立即补发断线期间的批次。
    const second = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}&after=${after}`);
    try {
      const reconnected = await second.waitFor('connected');
      assert.ok(Number(reconnected.id) > after, '续读后偏移应推进');
      const backlog = await second.waitFor('newMessages');
      assert.deepEqual(textsOf(backlog), ['resume: one', 'resume: two', 'resume: three']);
      assert.equal(Number(backlog.id), (await fsp.stat(filePath)).size);

      // 4) 续读之后的新写入只推增量（证明续读不会重复推历史）。
      await fsp.appendFile(filePath, `${ompUserLine('om-r4', 'resume: four')}\n`);
      const next = await second.waitFor('newMessages', 5000, second.events.indexOf(backlog) + 1);
      assert.deepEqual(textsOf(next), ['resume: four']);
      const all = second.events
        .filter((e) => e.event === 'newMessages')
        .flatMap((e) => e.data.messages.map((m) => m.id));
      assert.equal(new Set(all).size, all.length, '补发与增量之间不得重复消息');
    } finally {
      second.close();
    }
  });

  it('浏览器自动重连语义：Last-Event-ID 头等价于 after', async () => {
    const first = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
    const connected = await first.waitFor('connected');
    const after = Number(connected.id);
    first.close();
    await sleep(100);
    await fsp.appendFile(filePath, `${ompUserLine('om-h1', 'header: one')}\n`);

    const second = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`, {
      'Last-Event-ID': String(after),
    });
    try {
      await second.waitFor('connected');
      const backlog = await second.waitFor('newMessages');
      assert.deepEqual(textsOf(backlog), ['header: one']);
    } finally {
      second.close();
    }
  });

  it('偏移失效（文件被截断到更小尺寸）回落全量基线，不报错', async () => {
    const first = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}`);
    const connected = await first.waitFor('connected');
    const staleOffset = Number(connected.id) + 10_000; // 远超当前文件大小
    first.close();

    const second = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}&after=${staleOffset}`);
    try {
      const reconnected = await second.waitFor('connected');
      assert.equal(Number(reconnected.id), (await fsp.stat(filePath)).size);
      assert.equal(second.events.filter((e) => e.event === 'error').length, 0);
    } finally {
      second.close();
    }
  });

  it('after=0 等价于全量基线（不把整个文件当增量补发）', async () => {
    const size = (await fsp.stat(filePath)).size;
    const sse = await connectSse(`${srv.base}/api/watch?platform=omp&sessionId=${OMP1}&after=0`);
    try {
      const connected = await sse.waitFor('connected');
      assert.equal(Number(connected.id), size, 'after=0 时基线仍推进到文件末尾');
      // 旧实现会把 [0, size) 的全部行当增量补发（connected 后立刻出现全量 newMessages）。
      await sleep(200);
      assert.equal(sse.events.filter((e) => e.event === 'newMessages').length, 0);
    } finally {
      sse.close();
    }
  });
});
