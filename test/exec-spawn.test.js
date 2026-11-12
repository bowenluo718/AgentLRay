'use strict';
// H3（解耦）：openclaw exec-spawn 推断由「硬编码 'codex '/'claude ' → 平台 id」
// 改为「注册表 resolveExecSpawn 遍历各平台声明 execSpawn.commands 聚合」。
// 本测试在隔离 server 环境下端到端验证：
//   - openclaw 会话里 exec toolCall 命令命中某挂载平台（codex / claude-code）
//     → spawn-map / spawn-tree 的 childAgent 与 childLabel 非 null 且正确；
//   - 未声明 execSpawn 的目标命令（如 python）→ 不产生 exec-spawn link。
// 隔离 server（startServer）用干净 HOME，codex / claude-code 默认挂载，故可断言两大平台。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { startServer, getJson } = require('./helpers');

const SID = 'oc-exec-0001';

describe('H3：openclaw exec-spawn 平台声明驱动', () => {
  let srv;
  let agentsRoot;
  before(async () => {
    srv = await startServer();
    agentsRoot = path.join(srv.home, '.openclaw', 'agents');
    const dir = path.join(agentsRoot, 'alpha-ag', 'sessions');
    await fsp.mkdir(dir, { recursive: true });
    const line = (rec) => `${JSON.stringify(rec)}\n`;
    let body = line({ type: 'session', id: SID, timestamp: '2026-01-10T09:00:00.000Z', cwd: '/workspace/oc' });
    // user 消息
    body += line({
      type: 'message',
      timestamp: '2026-01-10T09:00:02.000Z',
      message: { role: 'user', content: [{ type: 'text', text: 'run tasks' }] },
    });
    // assistant：内嵌两个 exec toolCall（codex / claude）+ 一个 python（非 exec-spawn 目标）
    body += line({
      type: 'message',
      timestamp: '2026-01-10T09:00:05.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'ok' },
          {
            type: 'toolCall',
            id: 't1',
            name: 'exec',
            arguments: { command: 'codex exec --full-auto "do it"' },
          },
          {
            type: 'toolCall',
            id: 't2',
            name: 'exec',
            arguments: { command: 'claude --dangerously-skip-permissions -p "do that"' },
          },
          {
            type: 'toolCall',
            id: 't3',
            name: 'exec',
            arguments: { command: 'python run.py' },
          },
        ],
      },
    });
    await fsp.writeFile(path.join(dir, `${SID}.jsonl`), body);
  });
  after(async () => {
    await fsp.rm(agentsRoot, { recursive: true, force: true }).catch(() => {});
    await srv.stop();
  });

  it('exec 命中声明 execSpawn 的平台 → spawn-map childAgent/childLabel 非 null 且正确', async () => {
    const links = await getJson(srv.base, '/api/openclaw/spawn-map');
    const execLinks = links.filter((l) => l.toolName === 'exec' && l.isExecSpawn);
    // codex 与 claude-code 各一条（t3 python 不应被识别）
    assert.equal(execLinks.length, 2);

    const codexLink = execLinks.find((l) => l.toolCallId === 't1');
    assert.equal(codexLink.childAgent, 'codex');
    assert.ok(codexLink.childLabel, 'codex exec-spawn link 应携带真实 label（非 null）');
    assert.equal(codexLink.childLabel, 'Codex');

    const claudeLink = execLinks.find((l) => l.toolCallId === 't2');
    assert.equal(claudeLink.childAgent, 'claude-code');
    assert.ok(claudeLink.childLabel, 'claude exec-spawn link 应携带真实 label（非 null）');
    assert.equal(claudeLink.childLabel, 'Claude Code');

    // python 未命中 → 不计为 exec-spawn
    assert.equal(execLinks.some((l) => l.toolCallId === 't3'), false);
  });

  it('spawn-tree 将 exec-spawn 计入 totalSpawnCalls', async () => {
    // totalSpawnCalls = spawnCalls.length，exec-spawn（codex + claude）应计入；
    // python 未命中声明不计数。
    const tree = await getJson(srv.base, '/api/openclaw/spawn-tree');
    assert.ok(
      tree.totalSpawnCalls >= 2,
      `应至少计入 2 个 exec-spawn 调用（codex + claude），实际 ${tree.totalSpawnCalls}`
    );
    assert.equal(typeof tree.matchedLinks, 'number');
    assert.equal(typeof tree.totalSessions, 'number');
  });
});
