'use strict';
// P1-5 全表面等价：自定义平台只要声明对应 hook，即可进入五个分析面
// （search / insights / prompts / tool-audit / inspect），编排层不再
// 硬编码内置平台 id。用独立 HOME 落盘一个探针适配器，子进程内调用五面并断言。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..');

// 探针适配器：每个 hook 都返回可辨识的固定结果，证明编排层确实派发到 hook。
const PROBE_ADAPTER = `'use strict';
const fs = require('fs');
const path = require('path');

module.exports = {
  id: 'probe',
  label: 'Probe',
  dirParam: 'dirProbe',
  defaultDir: () => process.env.PROBE_DIR,
  list: null,
  parse: null,
  getSession: async () => ({ id: 's1', messages: [] }),
  collectFiles: async (dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
      .map((name) => ({ path: path.join(dir, name), file: name, sessionId: name.replace(/\\.jsonl$/, '') })),
  searchFile: (sf, keywords) => ({
    sessionId: sf.sessionId,
    file: sf.file,
    matches: keywords.map((keyword) => ({ snippet: 'probe:' + keyword, role: 'user', timestamp: null })),
  }),
  insightsScanFile: async () => ({
    messageCount: 2,
    toolCallCount: 1,
    toolResultCount: 1,
    errorCount: 0,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheRead: 0,
    totalCost: 0,
    toolStats: { probeTool: { calls: 1, errors: 0, totalDurationMs: 5 } },
    errorExamples: [],
    sessionDate: '2026-11-08',
  }),
  extractPromptsFromFile: async (file) => ({
    prompts: [{ text: 'probe prompt ' + path.basename(file), timestamp: '2026-11-08T00:00:00.000Z' }],
    timestamp: '2026-11-08T00:00:00.000Z',
    lastActivity: '2026-11-08T00:00:00.000Z',
    cwd: '/probe',
  }),
  scanToolAuditFile: async (file, tools, platform) => {
    if (!tools.has('probeTool')) {
      tools.set('probeTool', {
        platforms: new Set(),
        calls: 0,
        errors: 0,
        totalMs: 0,
        msCount: 0,
        lastUsedMs: 0,
        sessions: new Set(),
      });
    }
    const entry = tools.get('probeTool');
    entry.platforms.add(platform);
    entry.calls++;
    entry.totalMs += 3;
    entry.msCount++;
    entry.sessions.add(path.basename(file));
  },
  inspect: {
    normalize: (record) => ({
      id: null,
      timestamp: record.timestamp || null,
      role: 'user',
      content: [{ type: 'text', text: String(record.text || '') }],
      usage: null,
      model: null,
      provider: null,
      toolCallId: null,
      toolName: null,
      details: null,
      isError: false,
    }),
    rawToolEntries: () => ({ calls: [], results: [] }),
    adapterFiles: [],
  },
};
`;

function setupProbeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'axr-surfaces-'));
  const platDir = path.join(home, '.agentlray', 'platforms');
  fs.mkdirSync(platDir, { recursive: true });
  fs.writeFileSync(path.join(platDir, 'probe.js'), PROBE_ADAPTER);
  const dataDir = path.join(home, 'probe-sessions');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 's1.jsonl'), `${JSON.stringify({ text: 'probe needle' })}\n`);
  return { home, platDir, dataDir };
}

// 五面在子进程内执行：HOME / 平台目录都在 require 前隔离。
function runSurfaces(home, platDir, dataDir) {
  const script = `
(async () => {
  const search = require('./lib/search');
  const insights = require('./lib/insights');
  const prompts = require('./lib/prompts');
  const toolAudit = require('./lib/tool-audit');
  const inspect = require('./lib/inspect');
  const dir = process.env.PROBE_DIR;
  const out = {};
  out.search = await search.searchSessions({ q: 'needle', platform: 'probe', dir }, '');
  out.insights = await insights.computeInsights('probe', '', dir);
  out.prompts = await prompts.computePrompts('probe', '', dir);
  out.toolAudit = await toolAudit.computeToolAudit('probe', { probe: dir });
  out.inspect = await inspect.inspectFile(require('path').join(dir, 's1.jsonl'), 'probe');
  process.stdout.write(JSON.stringify(out));
})().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
`;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      AGENTLRAY_PLATFORMS_DIR: platDir,
      AGENTLRAY_PROJECT_PLATFORMS_DIR: path.join(home, 'project-platforms'),
      AGENTLRAY_NO_PLUGINS: '',
      PROBE_DIR: dataDir,
    },
  });
  assert.equal(result.status, 0, `六面调用子进程失败：${result.stderr}`);
  return JSON.parse(result.stdout);
}

test('自定义平台声明 hook 后进入 search/insights/prompts/tool-audit/inspect 五面', () => {
  const { home, platDir, dataDir } = setupProbeHome();
  try {
    const out = runSurfaces(home, platDir, dataDir);

    // search：platform 标记由编排层补上，snippet 来自探针 searchFile hook。
    assert.equal(out.search.length, 1);
    assert.equal(out.search[0].platform, 'probe');
    assert.equal(out.search[0].matches[0].snippet, 'probe:needle');

    // insights：探针扫描器提供的聚合值原样进入响应。
    assert.equal(out.insights.totalSessions, 1);
    assert.equal(out.insights.toolStats[0].name, 'probeTool');

    // prompts：探针提取器的文本进入分组。
    assert.equal(out.prompts.totalSessions, 1);
    assert.equal(out.prompts.totalPrompts, 1);
    assert.match(out.prompts.groups[0].sessions[0].prompts[0].text, /^probe prompt s1\.jsonl$/);

    // tool-audit：探针扫描器写入的工具体被汇总，platforms 标明来源平台。
    assert.equal(out.toolAudit.tools[0].name, 'probeTool');
    assert.deepEqual(out.toolAudit.tools[0].platforms, ['probe']);

    // inspect：平台集来自声明了 inspect hook 的适配器，报告走通。
    assert.equal(out.inspect.source.platform, 'probe');
    assert.equal(out.inspect.coverage.records, 1);
    assert.equal(out.inspect.summary.callCount, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
