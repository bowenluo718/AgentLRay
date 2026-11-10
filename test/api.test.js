// Integration tests: each describe block gets a hermetic server whose HOME is
// a temp copy of test/fixtures/home. The read-only groups share one server;
// groups that mutate global stores start their own so runs stay
// order-independent and repeatable.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer, getJson, sendJson, makeTmpHome } = require('./helpers.js');

const CODEX1 = '01900000-0000-7000-8000-000000000001';
const CODEX2 = '01900000-0000-7000-8000-000000000002';
const CLAUDE_A = 'aaaa1111-2222-4333-8444-555566667777';
const CLAUDE_B = 'bbbb1111-2222-4333-8444-555566667778';
const OMP1 = '019a0000-0000-7000-8000-00000000aaaa';
const OMP2 = '019a0000-0000-7000-8000-00000000bbbb';

async function exists(p) {
  return fsp.access(p).then(
    () => true,
    () => false
  );
}

// 在 home 下写一个可执行的假平台 CLI（记录被调用的 args + cwd），返回其所在目录，
// 以便把该目录注入服务器的 PATH 覆盖 spawn（fire-and-forget 真实 spawn 需要）。
async function makeFakeBin(home, bin, outFile) {
  const bindir = path.join(home, '.fakebin');
  await fsp.mkdir(bindir, { recursive: true });
  const script =
    `#!${process.execPath}\n` +
    `const fs = require('node:fs');\n` +
    `let out = '';\n` +
    `process.argv.slice(2).forEach((a) => { out += 'arg:' + a + '\\n'; });\n` +
    `out += 'cwd:' + process.cwd() + '\\n';\n` +
    `fs.writeFileSync(${JSON.stringify(outFile)}, out);\n` +
    `process.exit(0);\n`;
  await fsp.writeFile(path.join(bindir, bin), script, { mode: 0o755 });
  return bindir;
}

async function readFakeLog(file) {
  return (await fsp.readFile(file, 'utf8')).trim();
}

describe('AgentLRay API', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('GET /api/version returns a boot id', async () => {
    const body = await getJson(srv.base, '/api/version');
    assert.equal(typeof body.bootId, 'string');
    assert.ok(body.bootId.length > 0);
  });

  describe('sessions: codex', () => {
    it('lists sessions newest-first with metadata', async () => {
      const sessions = await getJson(srv.base, '/api/codex/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [CODEX2, CODEX1]
      );
      const s1 = sessions[1];
      assert.equal(s1.timestamp, '2026-01-15T10:00:00.000Z');
      assert.equal(s1.cwd, '/fixtures/project-alpha');
      assert.equal(s1.userCount, 2);
      assert.equal(s1.toolCallCount, 1);
      assert.equal(s1.toolResultCount, 1);
      assert.ok(s1.firstUserMessage.startsWith('fixture: search-needle-alpha'));
      // codex 无独立 title 记录，title 回退到首条用户消息（前端据此显示而非 UUID）
      assert.equal(s1.title, s1.firstUserMessage);
      assert.deepEqual(s1.topTools, [{ name: 'shell', count: 1 }]);
    });

    it('serves a session detail with normalized roles', async () => {
      const { session, messages } = await getJson(srv.base, `/api/codex/sessions/${CODEX1}`);
      assert.equal(session.id, CODEX1);
      assert.equal(session.cwd, '/fixtures/project-alpha');
      const roles = messages.map((m) => m.role);
      for (const role of ['user', 'assistant', 'toolCall', 'toolResult']) {
        assert.ok(roles.includes(role), `missing role ${role}`);
      }
      const call = messages.find((m) => m.role === 'toolCall');
      assert.equal(call.toolName, 'shell');
      assert.equal(call.toolCallId, 'call-fx-1');
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'call-fx-1');
      assert.equal(result.isError, false);
      assert.deepEqual(result.details, { status: 'ok', exitCode: 0, durationMs: 400 });
    });
  });

  describe('sessions: claude-code', () => {
    it('lists sessions without leaking subagent transcripts', async () => {
      const sessions = await getJson(srv.base, '/api/claude-code/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [CLAUDE_B, CLAUDE_A]
      );
      const a = sessions[1];
      assert.equal(a.toolCallCount, 1);
      assert.equal(a.toolResultCount, 1);
      assert.equal(a.cwd, '/fixtures/project-beta');
      assert.ok(a.firstUserMessage.startsWith('fixture: claude-prompt-one'));
    });

    it('serves a session detail with tool_use/tool_result normalized', async () => {
      const { session, messages } = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}`);
      assert.equal(session.id, CLAUDE_A);
      const roles = messages.map((m) => m.role);
      for (const role of ['user', 'assistant', 'toolResult']) {
        assert.ok(roles.includes(role), `missing role ${role}`);
      }
      const assistant = messages.find((m) => m.role === 'assistant');
      const toolCall = assistant.content.find((c) => c.type === 'toolCall');
      assert.equal(toolCall.name, 'Task');
      assert.equal(toolCall.id, 'toolu-fx-1');
      assert.equal(assistant.usage.input_tokens, 10);
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'toolu-fx-1');
      assert.equal(result.content[0].text, 'hello');
    });

    it('exposes subagents via the children endpoints', async () => {
      const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children`);
      assert.equal(children.length, 1);
      const child = children[0];
      assert.equal(child.name, 'agent-fx001');
      assert.equal(child.agentType, 'general-purpose');
      assert.equal(child.description, 'Scout the fixture');
      assert.equal(child.messageCount, 2);

      const detail = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/children/agent-fx001`);
      assert.deepEqual(
        detail.messages.map((m) => m.role),
        ['user', 'assistant']
      );
      assert.equal(detail.messages[1].content[0].text, 'hello');
    });

    it('a Task-free session has no children', async () => {
      const children = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_B}/children`);
      assert.deepEqual(children, []);
    });
  });

  describe('sessions: omp', () => {
    it('lists sessions with title, cost-bearing usage and tool counts', async () => {
      const sessions = await getJson(srv.base, '/api/omp/sessions');
      assert.equal(sessions.length, 2);
      assert.deepEqual(
        sessions.map((s) => s.id),
        [OMP2, OMP1]
      );
      const s1 = sessions[1];
      assert.equal(s1.title, 'Fixture OMP Session');
      assert.equal(s1.toolCallCount, 1);
      assert.equal(s1.toolResultCount, 1);
      assert.ok(s1.firstUserMessage.startsWith('fixture: omp-prompt-alpha'));
    });

    it('serves a detail with the toolCall→toolResult error pair and usage.cost', async () => {
      const { session, messages } = await getJson(srv.base, `/api/omp/sessions/${OMP1}`);
      assert.equal(session.id, OMP1);
      assert.equal(session.model, 'fixture/model-x');
      const call = messages.find((m) => m.role === 'toolCall');
      assert.equal(call.toolName, 'bash');
      assert.equal(call.toolCallId, 'tc-fx-1');
      const result = messages.find((m) => m.role === 'toolResult');
      assert.equal(result.toolCallId, 'tc-fx-1');
      assert.equal(result.isError, true);
      const assistant = messages.find((m) => m.role === 'assistant');
      assert.equal(assistant.usage.cost.total, 0.003);
      assert.equal(assistant.usage.input, 100);
    });

    it('exposes spawned children next to the session file', async () => {
      const children = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children`);
      assert.equal(children.length, 1);
      assert.equal(children[0].name, 'Scout');
      assert.equal(children[0].file, 'Scout.jsonl');
      assert.equal(children[0].messageCount, 2);

      const detail = await getJson(srv.base, `/api/omp/sessions/${OMP1}/children/Scout`);
      assert.equal(detail.messages.filter((m) => m.role === 'user').length, 1);
      assert.ok(detail.messages.some((m) => m.role === 'assistant'));
    });

    it('a child-free session reports no children', async () => {
      const children = await getJson(srv.base, `/api/omp/sessions/${OMP2}/children`);
      assert.deepEqual(children, []);
    });
  });

  describe('resume-command 端点（复制恢复命令，与 CLI resume 同源）', () => {
    it('内置六平台返回命令串（?cwd= 拼 cd 前缀）', async () => {
      const codex = await getJson(
        srv.base,
        `/api/codex/sessions/${CODEX1}/resume-command?cwd=${encodeURIComponent('/fixtures/project-alpha')}`
      );
      assert.equal(codex.supported, true);
      assert.equal(codex.bin, 'codex');
      assert.deepEqual(codex.args, ['resume', CODEX1, '--yolo']);
      assert.equal(codex.command, "cd '/fixtures/project-alpha' && codex resume 01900000-0000-7000-8000-000000000001 --yolo");

      const claude = await getJson(srv.base, `/api/claude-code/sessions/${CLAUDE_A}/resume-command`);
      assert.equal(claude.supported, true);
      assert.equal(claude.command, `claude --dangerously-skip-permissions --resume ${CLAUDE_A}`);

      const omp = await getJson(srv.base, `/api/omp/sessions/${OMP1}/resume-command`);
      assert.equal(omp.supported, true);
      assert.equal(omp.command, `omp --auto-approve --resume=${OMP1}`);

      const dshSid = 'session-9f8e7d6c-0101-1010-2323-abcde';
      const dsh = await getJson(srv.base, `/api/dsh/sessions/${dshSid}/resume-command`);
      assert.equal(dsh.supported, true);
      assert.equal(dsh.bin, 'dsh');
      assert.deepEqual(dsh.args, ['--profile', 'pi-tui', '--preset', 'standard', '--resume', dshSid]);
      assert.equal(dsh.command, `dsh --profile pi-tui --preset standard --resume ${dshSid}`);

      const gemini = await getJson(srv.base, '/api/gemini/sessions/gem-0123/resume-command');
      assert.equal(gemini.supported, true);
      assert.equal(gemini.command, 'gemini -r gem-0123 --approval-mode=yolo');

      const hermes = await getJson(srv.base, '/api/hermes/sessions/h-0001/resume-command');
      assert.equal(hermes.supported, true);
      assert.equal(hermes.command, 'hermes --resume h-0001 --yolo');
    });

    it('无原生续跑平台返回 supported:false，未知平台 404', async () => {
      const openclaw = await getJson(srv.base, '/api/openclaw/sessions/oc-1/resume-command');
      assert.equal(openclaw.supported, false);
      assert.match(openclaw.error, /no native resume command/);

      await getJson(srv.base, '/api/nope/sessions/x/resume-command', 404);
    });

    it('GET /api/platforms 透出 resume 契约标志', async () => {
      const platforms = await getJson(srv.base, '/api/platforms');
      const byId = Object.fromEntries(platforms.filter((p) => p.id).map((p) => [p.id, p]));
      assert.equal(byId.codex.resume, true);
      assert.equal(byId['claude-code'].resume, true);
      assert.equal(byId.omp.resume, true);
      assert.equal(byId.dsh.resume, true);
      assert.equal(byId.gemini.resume, true);
      assert.equal(byId.hermes.resume, true);
      assert.equal(byId.openclaw.resume, false);
    });
  });

  describe('POST /api/:platform/sessions/new（新建会话任务，与 CLI new 同源）', () => {
    // 新建会真实 fire-and-forget spawn 平台 CLI：happy-path 需要一个可执行的假
    // codex 注入 PATH，否则 ENOENT 命中 50ms 首发 error 窗口 → 500。因此本组起
    // 自己的服务器（独立 HOME + 假 bin 目录）。
    let csrv;
    let fakeLog;
    let fakeCwd;
    before(async () => {
      const home = await makeTmpHome();
      fakeLog = path.join(home, 'codex-new.log');
      const bindir = await makeFakeBin(home, 'codex', fakeLog);
      fakeCwd = path.join(home, 'work');
      await fsp.mkdir(fakeCwd, { recursive: true });
      csrv = await startServer({ PATH: `${bindir}${path.delimiter}${process.env.PATH || ''}` });
      csrv.home = home;
    });
    after(async () => {
      await csrv.stop();
    });

    it('codex + message → 200 triggered:true，命令含 exec --full-auto 且 message 末位，确实 fire-and-forget spawn', async () => {
      const body = await sendJson(csrv.base, 'POST', '/api/codex/sessions/new', {
        message: '修个 bug',
        cwd: fakeCwd,
      });
      assert.equal(body.triggered, true);
      assert.equal(body.platform, 'codex');
      assert.equal(body.bin, 'codex');
      assert.deepEqual(body.args, ['exec', '--full-auto', '修个 bug']);
      assert.equal(body.command, `cd '${fakeCwd}' && codex exec --full-auto '修个 bug'`);
      // fire-and-forget：子进程异步写日志，轮询等待落盘
      const deadline = Date.now() + 3000;
      let log = '';
      while (Date.now() < deadline) {
        try {
          log = await readFakeLog(fakeLog);
          if (log) break;
        } catch {
          /* not yet */
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.match(log, /arg:exec/);
      assert.match(log, /arg:--full-auto/);
      assert.match(log, /arg:修个 bug/);
      assert.ok(log.includes(`cwd:${fakeCwd}`), `cwd 应为执行目录: ${log}`);
    });

    it('无 cwd/message 也可触发（空提示词裸启）', async () => {
      const body = await sendJson(csrv.base, 'POST', '/api/codex/sessions/new', {});
      assert.equal(body.triggered, true);
      assert.deepEqual(body.args, ['exec', '--full-auto']);
    });

    it('dsh 无 create 契约 → 4xx（422）且 triggered:false', async () => {
      const res = await fetch(csrv.base + '/api/dsh/sessions/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 422);
      const body = await res.json();
      assert.equal(body.triggered, false);
      assert.match(body.error, /no native create command/);
    });

    it('cwd 不存在 → 400', async () => {
      const res = await fetch(csrv.base + '/api/codex/sessions/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/definitely/not/a/real/dir' }),
      });
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.match(body.error, /cwd/);
    });

    it('未知平台 → 404', async () => {
      const res = await fetch(csrv.base + '/api/nope/sessions/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 404);
    });

    it('GET /api/platforms 透出 create 契约标志（codex true / dsh false）', async () => {
      const platforms = await getJson(csrv.base, '/api/platforms');
      const byId = Object.fromEntries(platforms.filter((p) => p.id).map((p) => [p.id, p]));
      assert.equal(byId.codex.create, true);
      assert.equal(byId['claude-code'].create, true);
      assert.equal(byId.omp.create, true);
      assert.equal(byId.gemini.create, true);
      assert.equal(byId.hermes.create, true);
      assert.equal(byId.dsh.create, false);
      assert.equal(byId.openclaw.create, false);
    });
  });

  describe('sessions: multi-platform aggregate', () => {
    it('lists sessions across comma-separated platforms', async () => {
      const result = await getJson(srv.base, '/api/sessions?platform=omp,codex');
      assert.equal(result.all, false);
      assert.deepEqual(result.platformIds, ['omp', 'codex']);
      assert.equal(result.platforms.length, 2);
      const ompBlock = result.platforms.find((p) => p.platform === 'omp');
      assert.equal(ompBlock.agent, null);
      assert.equal(ompBlock.total, 2);
      assert.ok(ompBlock.sessions.some((s) => s.id === OMP1));
      const codexBlock = result.platforms.find((p) => p.platform === 'codex');
      assert.ok(codexBlock.total >= 1);
    });

    it('platform=all returns one block per platform with offset/limit applied per block', async () => {
      const result = await getJson(srv.base, '/api/sessions?platform=all&limit=2');
      assert.equal(result.all, true);
      assert.ok(result.platformIds.includes('openclaw'));
      assert.ok(result.platformIds.includes('hermes'));
      const codex = result.platforms.find((p) => p.platform === 'codex');
      assert.equal(codex.limit, 2);
      assert.ok(codex.sessions.length <= 2);
      // total 是过滤后、分页前；每块独立分页
      assert.ok(codex.total >= codex.sessions.length);
    });

    it('status/match filters apply per platform block', async () => {
      const grabbed = await getJson(srv.base, '/api/sessions?platform=omp,codex&status=working');
      // 夹具会话时间远早于墙钟 → 全部 stopped
      assert.ok(grabbed.platforms.every((p) => p.total === 0));
      const byMatch = await getJson(srv.base, '/api/sessions?platform=all&match=fixture');
      assert.ok(byMatch.total > 0);
    });

    it('rejects unknown platforms and the result of combining all with others', async () => {
      const bad = await getJson(srv.base, '/api/sessions?platform=omp,nope', 400);
      assert.match(bad.error, /Unknown platform/);
      const mixed = await getJson(srv.base, '/api/sessions?platform=all,omp', 400);
      assert.match(mixed.error, /cannot be combined/);
    });

    it('openclaw without agent lists every agent as its own block', async () => {
      // 夹具 home 无 openclaw agents 目录 → 空；但请求本身合法（不要求 --agent）
      const result = await getJson(srv.base, '/api/sessions?platform=openclaw');
      assert.equal(result.all, false);
      assert.equal(result.platforms.length, 0);
    });

    it('GET /api/openclaw/sessions 合并全部 agents，详情跨 agent 查找', async () => {
      const agentsRoot = path.join(srv.home, '.openclaw', 'agents');
      const mk = async (agent, id) => {
        const dir = path.join(agentsRoot, agent, 'sessions');
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(
          path.join(dir, `${id}.jsonl`),
          `${JSON.stringify({ type: 'session', id, timestamp: '2026-01-10T09:00:00.000Z', cwd: `/workspace/${id}` })}\n` +
            `${JSON.stringify({
              type: 'message',
              timestamp: '2026-01-10T09:00:02.000Z',
              message: { role: 'user', content: [{ type: 'text', text: `${id} task` }] },
            })}\n`
        );
      };
      try {
        await mk('alpha-ag', 'oc-a1');
        await mk('beta-ag', 'oc-b2');

        // 缺省：全部 agents 合并，每条带来源 agent 与 cwd
        const merged = await getJson(srv.base, '/api/openclaw/sessions');
        assert.equal(merged.length, 2);
        const byId = Object.fromEntries(merged.map((s) => [s.id, s.agent]));
        assert.equal(byId['oc-a1'], 'alpha-ag');
        assert.equal(byId['oc-b2'], 'beta-ag');
        assert.equal(merged.find((s) => s.id === 'oc-a1').cwd, '/workspace/oc-a1');

        // 详情：跨全部 agents 查找并标注归属
        const detail = await getJson(srv.base, '/api/openclaw/sessions/oc-b2');
        assert.equal(detail.session.id, 'oc-b2');
        assert.equal(detail.session.cwd, '/workspace/oc-b2');
        assert.equal(detail.agent, 'beta-ag');

        // 指定 agent 仍限定单 agent
        const single = await getJson(srv.base, '/api/openclaw/sessions?agent=alpha-ag');
        assert.equal(single.length, 1);
        assert.equal(single[0].id, 'oc-a1');

        // 未命中 → 404
        await getJson(srv.base, '/api/openclaw/sessions/oc-nope', 404);
      } finally {
        await fsp.rm(path.join(agentsRoot, 'alpha-ag'), { recursive: true, force: true });
        await fsp.rm(path.join(agentsRoot, 'beta-ag'), { recursive: true, force: true });
      }
    });
  });

  describe('search', () => {
    it('finds a keyword in one platform', async () => {
      const results = await getJson(srv.base, '/api/search?q=search-needle-alpha&platform=codex');
      assert.equal(results.length, 1);
      assert.equal(results[0].sessionId, CODEX1);
      assert.equal(results[0].platform, 'codex');
      assert.ok(results[0].matches.length >= 1);
      assert.equal(results[0].matches[0].role, 'user');
      assert.ok(results[0].matches[0].snippet.includes('search-needle-alpha'));
    });

    it('multi-keyword search is an AND across the session', async () => {
      const hit = await getJson(srv.base, '/api/search?q=search-needle-alpha+zebra-token&platform=codex');
      assert.equal(hit.length, 1);
      assert.equal(hit[0].sessionId, CODEX1);
      const miss = await getJson(srv.base, '/api/search?q=search-needle-alpha+no-such-token-anywhere&platform=codex');
      assert.deepEqual(miss, []);
    });

    it('platform=all merges hits across platforms', async () => {
      const results = await getJson(srv.base, '/api/search?q=fixture&platform=all&limit=100');
      const platforms = new Set(results.map((r) => r.platform));
      for (const p of ['codex', 'claude-code', 'omp', 'dsh', 'gemini']) {
        assert.ok(platforms.has(p), `missing platform ${p}`);
      }
    });

    it('falls back to claude prompt history for retired sessions', async () => {
      const results = await getJson(srv.base, '/api/search?q=history-needle-gamma&platform=claude-code');
      assert.equal(results.length, 1);
      const hit = results[0];
      assert.equal(hit.history, true);
      assert.equal(hit.sessionId, null);
      assert.equal(hit.file, 'history.jsonl');
      assert.equal(hit.project, '/fixtures/project-beta');
      assert.ok(hit.matches[0].snippet.includes('history-needle-gamma'));
    });

    it('rejects path traversal via the agent query parameter', async () => {
      // Plant a session file OUTSIDE the openclaw data dir, reachable only by
      // escaping it: <home>/.openclaw/agents/../../escape/sessions/evil.jsonl.
      const evilDir = path.join(srv.home, 'escape', 'sessions');
      await fsp.mkdir(evilDir, { recursive: true });
      await fsp.writeFile(
        path.join(evilDir, 'evil.jsonl'),
        `${JSON.stringify({
          type: 'message',
          timestamp: '2026-01-20T08:00:00.000Z',
          message: { role: 'user', content: [{ type: 'text', text: 'escape-needle-secret' }] },
        })}\n`
      );

      // Search must not follow ../ out of the agents dir
      const results = await getJson(
        srv.base,
        '/api/search?q=escape-needle-secret&platform=openclaw&agent=..%2F..%2Fescape'
      );
      assert.deepEqual(results, []);

      // Insights must not aggregate the escaped file either
      const insights = await getJson(srv.base, '/api/insights?platform=openclaw&agent=..%2F..%2Fescape');
      assert.equal(insights.totalSessions, 0);
    });
  });

  describe('prompts + hidden prompts', () => {
    it('hiding one text collapses every identical occurrence, and unhiding restores it', async () => {
      const beforeData = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(beforeData.totalPrompts, 3);
      assert.equal(beforeData.totalSessions, 2);
      assert.equal(beforeData.groups[0].directory, '/fixtures/project-alpha');

      // The duplicate text lives in both codex sessions: one hide removes both
      const hideRes = await sendJson(srv.base, 'POST', '/api/prompts/hidden', {
        text: 'fixture: duplicate-prompt-omega',
      });
      assert.equal(hideRes.added, 1);
      assert.match(hideRes.hash, /^[0-9a-f]{16}$/);

      const hiddenList = await getJson(srv.base, '/api/prompts/hidden');
      assert.ok(hiddenList.hidden.some((h) => h.hash === hideRes.hash && h.preview.includes('duplicate-prompt-omega')));

      const afterHide = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(afterHide.totalPrompts, beforeData.totalPrompts - 2);
      assert.equal(afterHide.totalSessions, 1); // session 2 only held the duplicate

      // Store lives under the temp HOME, never the real ~/.agentlray
      assert.ok(await exists(path.join(srv.home, '.agentlray', 'hidden-prompts.json')));

      await sendJson(srv.base, 'DELETE', `/api/prompts/hidden/${hideRes.hash}`, undefined);
      const restored = await getJson(srv.base, '/api/prompts?platform=codex');
      assert.equal(restored.totalPrompts, beforeData.totalPrompts);
    });
  });

  describe('tools audit', () => {
    it('aggregates tool rows across platforms and flags unused MCP servers', async () => {
      const audit = await getJson(srv.base, '/api/tools/audit?platform=all');
      const byName = new Map(audit.tools.map((t) => [t.name, t]));

      const shell = byName.get('shell');
      assert.deepEqual(shell.platforms, ['codex']);
      assert.equal(shell.calls, 1);
      assert.equal(shell.errors, 0);
      assert.equal(shell.avgMs, 400);

      const task = byName.get('Task');
      assert.deepEqual(task.platforms, ['claude-code']);
      assert.equal(task.calls, 1);

      const bash = byName.get('bash');
      assert.deepEqual(bash.platforms, ['omp']);
      assert.equal(bash.errors, 1);
      assert.equal(bash.errorRate, 1);
      assert.equal(bash.avgMs, 2000);

      // From the fixture ~/.claude.json mcpServers entry that no tool ever used
      assert.deepEqual(audit.configuredUnused, [{ name: 'fixture-unused-server', source: 'claude-mcp' }]);
    });
  });

  describe('otlp export', () => {
    it('serializes an omp session as one trace with parented spans', async () => {
      const payload = await getJson(srv.base, `/api/otlp/omp/${OMP1}`);
      const resource = payload.resourceSpans[0];
      const attrs = Object.fromEntries(resource.resource.attributes.map((a) => [a.key, a.value.stringValue]));
      assert.equal(attrs['service.name'], 'agentlray');
      assert.equal(attrs['gen_ai.conversation.id'], OMP1);

      const spans = resource.scopeSpans[0].spans;
      assert.ok(spans.every((s) => s.kind === 1));
      assert.ok(spans.every((s) => s.traceId === spans[0].traceId));

      const roots = spans.filter((s) => s.name === 'invoke_agent');
      assert.equal(roots.length, 1);
      assert.equal(roots[0].parentSpanId, undefined);

      const chats = spans.filter((s) => s.name.startsWith('chat '));
      assert.equal(chats.length, 2);
      for (const c of chats) assert.equal(c.parentSpanId, roots[0].spanId);
      const chatAttrs = Object.fromEntries(
        chats[0].attributes.map((a) => [a.key, a.value.stringValue ?? a.value.intValue])
      );
      assert.equal(chatAttrs['gen_ai.request.model'], 'fixture/model-x');
      assert.equal(chatAttrs['gen_ai.usage.input_tokens'], '100');

      const tools = spans.filter((s) => s.name.startsWith('execute_tool '));
      assert.equal(tools.length, 1);
      assert.equal(tools[0].name, 'execute_tool bash');
      assert.equal(tools[0].parentSpanId, roots[0].spanId);
      assert.deepEqual(tools[0].status, { code: 2 }); // the fixture tool pair errored
      assert.ok(BigInt(tools[0].endTimeUnixNano) > BigInt(tools[0].startTimeUnixNano));
    });
  });
});

describe('csrf guard', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  const send = (method, headers, pathname = '/api/prompts/hidden') =>
    fetch(srv.base + pathname, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify({ hash: 'deadbeef' }),
    });

  it('rejects a state-changing request whose Origin is another site', async () => {
    const res = await send('POST', { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.match(body.reason, /origin https:\/\/evil\.example/);
  });

  it('rejects when Sec-Fetch-Site says cross-site even without Origin', async () => {
    const res = await send('DELETE', { 'Sec-Fetch-Site': 'cross-site' }, '/api/prompts/hidden/deadbeef');
    assert.equal(res.status, 403);
  });

  it('accepts same-origin browser requests and origin-less clients', async () => {
    const host = new URL(srv.base).host;
    const same = await send('POST', { Origin: `http://${host}`, 'Sec-Fetch-Site': 'same-origin' });
    assert.notEqual(same.status, 403);
    const curl = await send('POST', {});
    assert.notEqual(curl.status, 403);
  });

  it('never blocks reads, whatever the origin', async () => {
    const res = await send('GET', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }, '/api/version');
    assert.equal(res.status, 200);
  });
});

describe('GET /api/settings 全量返回各 section 默认形态（单一聚合端点）', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('未保存任何配置时返回各 section 默认值；LLM 密钥不明文回传', async () => {
    const all = await getJson(srv.base, '/api/settings');
    assert.deepEqual(all.ui, { platform: null, selectedPlatforms: [] });
    assert.deepEqual(all.cliBins, {
      codex: { bin: 'codex', configured: false, default: 'codex' },
      'claude-code': { bin: 'claude', configured: false, default: 'claude' },
      omp: { bin: 'omp', configured: false, default: 'omp' },
      dsh: { bin: 'dsh', configured: false, default: 'dsh' },
      gemini: { bin: 'gemini', configured: false, default: 'gemini' },
      hermes: { bin: 'hermes', configured: false, default: 'hermes' },
    });
    assert.deepEqual(all.status, {
      recentActivityMs: { value: 120000, configured: false, default: 120000 },
      activeWorkCeilMs: { value: 1800000, configured: false, default: 1800000 },
      historyCeilMs: { value: 43200000, configured: false, default: 43200000 },
    });
    assert.deepEqual(all.kanban, { maxPerStatus: { value: 20, configured: false, default: 20 } });
    // backend 依赖机器上是否有 claude CLI，不断言具体值；密钥绝不回传。
    assert.equal('backend' in all.llm, true);
    assert.equal(all.llm.baseUrl, '');
    assert.equal(all.llm.model, '');
    assert.equal(all.llm.hasApiKey, false);
    assert.equal('apiKey' in all.llm, false);
  });

  it('PUT 只保存请求体提供的 section；未提供者保持服务器原值；落盘单一 settings.json', async () => {
    // 先写 cliBins + status
    await sendJson(srv.base, 'PUT', '/api/settings', {
      cliBins: {
        codex: '/home/u/.nvm/versions/node/v22.19.0/bin/codex',
        'claude-code': '/home/u/.nvm/versions/node/v22.19.0/bin/claude',
        omp: '',
      },
      status: { recentActivityMs: 5 * 60 * 1000, activeWorkCeilMs: 0 },
    });
    // 再写 kanban + llm → 前面 section 不应被清空
    await sendJson(srv.base, 'PUT', '/api/settings', {
      kanban: { maxPerStatus: 50 },
      llm: { baseUrl: 'http://127.0.0.1:9/v1', model: 'test-model' },
    });
    const all = await getJson(srv.base, '/api/settings');
    assert.equal(all.cliBins.codex.bin, '/home/u/.nvm/versions/node/v22.19.0/bin/codex');
    assert.equal(all.cliBins.codex.configured, true);
    assert.equal(all.cliBins.omp.bin, 'omp'); // 空串 = 清除 → 回退默认
    assert.equal(all.status.recentActivityMs.value, 5 * 60 * 1000);
    assert.equal(all.status.activeWorkCeilMs.value, 1800000); // 非正数清除回默认
    assert.equal(all.kanban.maxPerStatus.value, 50);
    assert.equal(all.llm.baseUrl, 'http://127.0.0.1:9/v1');
    assert.equal(all.llm.hasApiKey, false);

    const onDisk = JSON.parse(
      await fsp.readFile(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(onDisk).sort(), ['cliBins', 'kanban', 'llm', 'status', 'updatedAt']);
    assert.equal(onDisk.cliBins.codex, '/home/u/.nvm/versions/node/v22.19.0/bin/codex');
    assert.equal(onDisk.kanban.maxPerStatus, 50);
    assert.equal(onDisk.llm.model, 'test-model');
  });
});

describe('ui / cliBins 平台选择与 CLI 命令（CLI 缺省 --platform 与 resume 读同一文件）', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('PUT ui section 持久化平台选择，落盘 settings.json 供 CLI 缺省', async () => {
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', {
      ui: { platform: 'omp', selectedPlatforms: ['omp', 'codex'] },
    });
    assert.deepEqual(saved.ui, { platform: 'omp', selectedPlatforms: ['omp', 'codex'] });
    const payload = JSON.parse(
      await fsp.readFile(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8')
    );
    assert.deepEqual(payload.ui.selectedPlatforms, ['omp', 'codex']);
    assert.equal(payload.ui.platform, 'omp');
  });

  it('ui section 拒绝未知平台、过滤非法 selectedPlatforms', async () => {
    const bad = await sendJson(srv.base, 'PUT', '/api/settings', { ui: { platform: 'nope' } }, 400);
    assert.match(bad.error, /platform must be one of/);
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', {
      ui: { platform: 'codex', selectedPlatforms: ['codex', 'nope', 123] },
    });
    assert.deepEqual(saved.ui, { platform: 'codex', selectedPlatforms: ['codex'] });
  });

  it('cliBins section 只存白名单 key，非字符串忽略', async () => {
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', {
      cliBins: { codex: 'codex', hermes: '/tmp/hermes', omp: 123 },
    });
    assert.deepEqual(Object.keys(saved.cliBins).sort(), ['claude-code', 'codex', 'dsh', 'gemini', 'hermes', 'omp']);
    assert.equal(saved.cliBins.codex.bin, 'codex');
    assert.equal(saved.cliBins.hermes.bin, '/tmp/hermes');
    assert.equal(saved.cliBins.omp.bin, 'omp');
    const onDisk = JSON.parse(
      await fsp.readFile(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(onDisk.cliBins).sort(), ['codex', 'hermes']);
  });
});

describe('cliBins bin 反映环境变量（P1：前端复制命令与后端 spawn 一致）', () => {
  let srv;
  before(async () => {
    srv = await startServer({ AGENTLRAY_CODEX_BIN: '/env/bin/codex' });
  });
  after(async () => {
    await srv.stop();
  });

  it('GET /api/settings 的 cliBins bin 优先取环境变量', async () => {
    const all = await getJson(srv.base, '/api/settings');
    assert.equal(all.cliBins.codex.bin, '/env/bin/codex');
    assert.equal(all.cliBins.codex.configured, false);
    assert.equal(all.cliBins.codex.default, 'codex');
    assert.equal(all.cliBins['claude-code'].bin, 'claude');
    assert.equal(all.cliBins.omp.bin, 'omp');
  });

  it('文件配置后 env 仍优先（env > 配置）', async () => {
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', { cliBins: { codex: '/file/bin/codex' } });
    assert.equal(saved.cliBins.codex.bin, '/env/bin/codex');
    assert.equal(saved.cliBins.codex.configured, true);
    assert.equal(saved.cliBins.codex.default, 'codex');
    const all = await getJson(srv.base, '/api/settings');
    assert.equal(all.cliBins.codex.bin, '/env/bin/codex');
  });
});

describe('status 时间配置保存后 GET 读回生效窗口', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('PUT status 后 GET 反映新窗口；非法值清除回退默认', async () => {
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', {
      status: {
        recentActivityMs: 5 * 60 * 1000,
        activeWorkCeilMs: 0,
        historyCeilMs: 48 * 60 * 60 * 1000,
      },
    });
    assert.equal(saved.status.recentActivityMs.value, 5 * 60 * 1000);
    assert.equal(saved.status.recentActivityMs.configured, true);
    assert.equal(saved.status.activeWorkCeilMs.value, 1800000);
    assert.equal(saved.status.activeWorkCeilMs.configured, false);
    assert.equal(saved.status.historyCeilMs.value, 48 * 60 * 60 * 1000);

    const all = await getJson(srv.base, '/api/settings');
    assert.equal(all.status.recentActivityMs.value, 5 * 60 * 1000);
    assert.equal(all.status.historyCeilMs.value, 48 * 60 * 60 * 1000);

    const onDisk = JSON.parse(
      await fsp.readFile(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8')
    );
    assert.deepEqual(Object.keys(onDisk.status).sort(), ['historyCeilMs', 'recentActivityMs']);
  });
});

describe('dirs / platforms section（平台目录与启停随统一设置端点半提交）', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('GET 返回 dirs 各平台形态（key/value/default/envActive）与 platforms 镜像', async () => {
    const all = await getJson(srv.base, '/api/settings');
    // 测试 serverEnv 为全部平台注入了目录 env（OPENCLAW_DIR/CODEX_DIR/…）→ envActive=true。
    for (const pid of ['openclaw', 'codex', 'claude-code', 'omp']) {
      const d = all.dirs[pid];
      assert.ok(d, `dirs 应含 ${pid}`);
      assert.equal(typeof d.key, 'string');
      assert.equal(d.value, '');
      assert.equal(d.configured, false);
      assert.equal(d.envActive, true, `${pid} 因 serverEnv 注入目录 env 而 envActive`);
      assert.ok(typeof d.default === 'string' && d.default.length > 0);
    }
    // platforms 镜像：default 为第一个可查询平台，ids 含全部 catalog
    assert.ok(Array.isArray(all.platforms.ids) && all.platforms.ids.includes('codex'));
    assert.deepEqual(all.platforms.disabled, []);
    assert.deepEqual(all.platforms.replaced, []);
  });

  it('PUT dirs：env 生效平台配置被忽略（env > 配置，Q11-B），非法值清除', async () => {
    // 全部平台 env 生效 → 写目录不落盘（dirEnvActive 丢弃），验证 env 优先于配置目录。
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', {
      dirs: { codexDir: '/data/codex', ompDir: '/data/omp' },
    });
    assert.equal(saved.dirs.codex.value, '');
    assert.equal(saved.dirs.codex.configured, false);
    assert.equal(saved.dirs.omp.value, '');
    assert.equal(saved.dirs.omp.configured, false);

    const onDisk = JSON.parse(
      await fsp.readFile(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8')
    );
    assert.equal(onDisk.dirs, undefined, 'env 生效时 dirs section 不应落盘');
  });

  it('PUT platforms 提交启停 disabled 与撤销替代 replaced，复用 platform-config 守卫', async () => {
    // 停用 hermes + 声明 codex replaced
    const saved = await sendJson(srv.base, 'PUT', '/api/settings', {
      platforms: { disabled: ['hermes'], replaced: ['codex'] },
    });
    assert.deepEqual(saved.platforms.disabled, ['hermes']);
    assert.deepEqual(saved.platforms.replaced, ['codex']);

    // 落盘 settings.json platforms section
    const onDisk = JSON.parse(
      await fsp.readFile(path.join(srv.home, '.agentlray', 'settings.json'), 'utf8')
    );
    assert.deepEqual(onDisk.platforms, { disabled: ['hermes'], replaced: ['codex'] });

    // GET 镜像反映
    const all = await getJson(srv.base, '/api/settings');
    assert.deepEqual(all.platforms.disabled, ['hermes']);
    assert.deepEqual(all.platforms.replaced, ['codex']);
  });

  it('PUT platforms 停用全部可查询平台 → 422（复用 platform-config 守卫）', async () => {
    const srv2 = await startServer();
    try {
      const all0 = await getJson(srv2.base, '/api/settings');
      const ids = all0.platforms.ids;
      const bad = await sendJson(
        srv2.base,
        'PUT',
        '/api/settings',
        { platforms: { disabled: ids } },
        422
      );
      assert.match(bad.error, /last/i);
    } finally {
      await srv2.stop();
    }
  });

  it('PUT platforms 批量停用触发守卫 → 原子：整体 422 且零落盘（无半提交）', async () => {
    const srv2 = await startServer();
    try {
      const all0 = await getJson(srv2.base, '/api/settings');
      const ids = all0.platforms.ids;
      // 已有 1 个平台被停用（hermes）→ 再批量停用其余全部 = 停光全部可查询平台 → 422
      await sendJson(srv2.base, 'PUT', '/api/settings', { platforms: { disabled: ['hermes'] } });
      const bad = await sendJson(
        srv2.base,
        'PUT',
        '/api/settings',
        { platforms: { disabled: ids } },
        422
      );
      assert.match(bad.error, /last/i);
      // 原子性：磁盘 platforms section 保持「只有 hermes 被停用」，其它平台未半写
      const onDisk = JSON.parse(
        await fsp.readFile(path.join(srv2.home, '.agentlray', 'settings.json'), 'utf8')
      );
      assert.deepEqual(onDisk.platforms, { disabled: ['hermes'], replaced: [] });
      // GET 镜像同样只反映 hermes
      const all1 = await getJson(srv2.base, '/api/settings');
      assert.deepEqual(all1.platforms.disabled, ['hermes']);
    } finally {
      await srv2.stop();
    }
  });
});

describe('GET /api/settings/cli-bins 兼容只读端点（legacy 复制恢复命令）', () => {
  let srv;
  before(async () => {
    srv = await startServer();
  });
  after(async () => {
    await srv.stop();
  });

  it('返回与 /api/settings.cliBins 相同的响应结构（内置六平台）', async () => {
    const compat = await getJson(srv.base, '/api/settings/cli-bins');
    assert.deepEqual(Object.keys(compat).sort(), ['claude-code', 'codex', 'dsh', 'gemini', 'hermes', 'omp']);
    assert.equal(compat.codex.bin, 'codex');
    assert.equal(compat.codex.configured, false);
    assert.equal(compat.hermes.bin, 'hermes');
    assert.equal(compat.hermes.configured, false);
  });
});
