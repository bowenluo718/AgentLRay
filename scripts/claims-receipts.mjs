#!/usr/bin/env node

// Receipts behind claims.json: the command that recomputes each number the
// README / hero caption / roadmap publishes. One subcommand per claim, each
// printing exactly one line; claims.json asserts that line and
// .github/workflows/claims.yml runs them all.
//
//   node scripts/claims-receipts.mjs <receipt-id>
//   node scripts/claims-receipts.mjs --list
//
// Every figure is derived here from committed artifacts — the platform
// registry, lib/config.js, package.json, the workflow, the synthetic demo
// sample log, the test fixtures — never typed in as a constant.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(ROOT, 'package.json'));
const README = 'README.md';
const README_ZH = 'README.zh-CN.md';
const GUIDE = 'docs/usage.md';

const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const fromRepo = (rel) => require(path.join(ROOT, rel));
// The ledger column the UI renders uses the view's toLocaleString(); pin the
// locale so the receipt reads the same on a runner with no LANG set.
const formatNumber = (n) => n.toLocaleString('en-US');

const platforms = () => fromRepo('lib/platforms/index.js').PLATFORMS;

// Rows of the first markdown table under `heading`, header row dropped.
function tableRows(md, heading) {
  const start = md.indexOf(heading);
  const end = md.indexOf('\n---', start);
  return md
    .slice(start, end === -1 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|$/.test(line))
    .slice(1);
}

// Top-level keys of a YAML block (`jobs:`, `on:` …); a key is a 2-space-indented
// line, its 4-space-indented children are skipped.
function blockKeys(yaml, anchor) {
  const lines = yaml.split('\n');
  const start = lines.indexOf(anchor);
  const keys = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    if (/^\s*#/.test(line)) continue; // comment
    if (/^ {4}/.test(line)) continue; // nested under the key above
    const match = line.match(/^ {2}([a-z][\w-]*):/);
    if (!match) break; // dedented back out of the block
    keys.push(match[1]);
  }
  return keys;
}

const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

const receipts = {
  // README: "supports OpenClaw, Codex, Claude Code, Hermes, OMP, DeepSeek
  // Harness and Gemini CLI" / "normalizes all seven formats".
  'platform-registry': () => {
    const ids = Object.keys(platforms());
    return `${ids.length} platforms: ${ids.join(', ')}`;
  },

  // README FAQ: "Six of them store JSONL; Hermes stores SQLite".
  'platform-storage': () => {
    const all = platforms();
    const ids = Object.keys(all);
    const sqlite = ids.filter((id) => !all[id].parse);
    return `${ids.length - sqlite.length} JSONL-backed, ${sqlite.length} SQLite-only (${sqlite.join(', ')})`;
  },

  // The prose lists the platforms by hand; the registry is the authority.
  'readme-platform-list': () => {
    const labels = Object.values(platforms()).map((platform) => platform.label);
    const found = (rel) => labels.filter((label) => read(rel).includes(label)).length;
    const rows = tableRows(read(GUIDE), '## Supported Log Formats').length;
    const missing = labels.filter((label) => !read(README).includes(label));
    return `${found(README)}/${labels.length} labels in ${README} (${rows} format-table rows in ${GUIDE}${missing.length ? `, missing ${missing.join(', ')}` : ''}) · ${found(README_ZH)}/${labels.length} in ${README_ZH}`;
  },

  // README "Default directories" table vs the dirs the code actually resolves.
  'default-dirs': () => {
    const home = fromRepo('lib/config.js').HOME;
    const all = platforms();
    const rows = Object.keys(all).map((id) => `~/${path.relative(home, all[id].defaultDir())}`);
    const missing = rows.filter((row) => !read(GUIDE).includes(row));
    if (missing.length) return `default dirs missing from ${GUIDE}: ${missing.join(', ')}`;
    return `${rows.length}/${rows.length} default dirs match ${GUIDE} (${rows.join(' ')})`;
  },

  'diagnostic-example': async () => {
    const file = 'frontend/demo/sample-logs/omp/-demo-diagnostics/2026-09-23T08-00-00-000Z_0199demo-diagnostics.jsonl';
    const report = await fromRepo('lib/inspect.js').createReport(Buffer.from(read(file)), 'omp');
    const keys = ['failureRecords', 'pendingRecords', 'pendingEvents', 'recoveredRecords'];
    const agrees = [README, README_ZH].every((name) => {
      const blocks = [...read(name).matchAll(/```json\n([\s\S]*?)\n```/g)];
      return blocks.some((match) => {
        const excerpt = JSON.parse(match[1]);
        return keys.every((key) => excerpt.summary?.[key] === report.summary[key]);
      });
    });
    return `${report.summary.failureRecords} historical failures · ${report.summary.pendingRecords} pending records · ${report.summary.pendingEvents} events · ${report.summary.recoveredRecords} matching recovery · complete=${report.complete} · both README excerpts ${agrees ? 'agree' : 'DISAGREE'}`;
  },

  // README/Features: per-turn ledger sums input + output + cache read + cache
  // write and only shows a cost column when a platform reports cost.
  // buildTurnLedger lives in frontend/src/lib/pure.ts (TypeScript), so it is
  // transformed with the frontend's esbuild; run `npm ci` in frontend/ first.
  'ledger-fields': async () => {
    const esbuild = require(path.join(ROOT, 'frontend/node_modules/esbuild'));
    const Module = require('node:module');
    const source = read('frontend/src/lib/pure.ts');
    const { code } = esbuild.transformSync(source, { loader: 'ts', format: 'cjs', target: 'node22' });
    const mod = new Module('pure');
    mod._compile(code, 'pure.js');
    const { buildTurnLedger } = mod.exports;
    const all = platforms();
    const one = async (id, file) => {
      const parsed = await all[id].parse(path.join(ROOT, file));
      const ledger = buildTurnLedger(parsed.messages);
      const r = ledger.rows[0];
      const tok = r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens;
      const cost = ledger.hasCost ? `cost $${r.cost} reported` : 'cost not reported';
      return `${id}: ${ledger.rows.length} row, ${tok} tok = ${r.inputTokens} in + ${r.outputTokens} out + ${r.cacheReadTokens} cache read + ${r.cacheWriteTokens} cache write, ${cost}, ${r.toolCalls} tool call, ${plural(r.toolErrors, 'error')}`;
    };
    return [
      await one('dsh', 'test/fixtures/home/.dsh/sessions/--fixtures-project-delta--/dsh-fixture-session-0001/session.jsonl'),
      await one('omp', 'test/fixtures/home/.omp/agent/sessions/-fixtures-project-gamma/2026-01-20T08-00-00-000Z_019a0000-0000-7000-8000-00000000aaaa.jsonl'),
    ].join(' · ');
  },

  // README/usage Development: the only workflow builds and deploys the demo;
  // tests and lint run locally (there is no CI test job).
  'demo-pages-workflow': () => {
    const workflows = readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml'));
    const yaml = read('.github/workflows/pages.yml');
    const jobs = blockKeys(yaml, 'jobs:');
    const triggers = blockKeys(yaml, 'on:');
    const node = yaml.match(/node-version: '?([\d.x]+)'?/)[1];
    const branches = [...new Set([...yaml.matchAll(/branches: \[([^\]]*)\]/g)].map((match) => match[1]))];
    const demo = /VITE_DEMO=1/.test(yaml);
    return `${workflows.length} workflow (${workflows.join(', ')}) · ${jobs.length} job (${jobs.join(', ')}) on Node ${node} · demo build: ${demo ? 'yes' : 'no'} · on ${triggers.join(', ')} of ${branches.join('/')}`;
  },

  // README Install: "npx @bowenluo718/agent-lray".
  'install-command': () => {
    const { name, bin } = readJson('package.json');
    const listed = read(README).includes(`npx ${name}`);
    return `${name} · bins: ${Object.keys(bin).join(', ')} · ${README} npx line ${listed ? 'present' : 'MISSING'}`;
  },

  // README Install: "default http://localhost:3800".
  'default-port': () => {
    const server = read('server.js');
    const port = server.match(/const PORT = process\.env\.PORT \|\| (\d+)/)[1];
    const launcher = read('bin/agentlray.js');
    const flags = /--port/.test(launcher) && /--host/.test(launcher);
    const listed = read(README).includes(`http://localhost:${port}`);
    return `${port} · ${README} states http://localhost:${port}: ${listed ? 'yes' : 'NO'} · launcher --port/--host: ${flags ? 'yes' : 'no'}`;
  },

  // README badge "Node.js-22.13+" and "You cannot run Node.js ≥ 22.13".
  'node-engine-floor': () => {
    const floor = readJson('package.json').engines.node.replace(/^>=/, '');
    const badge = read(README).includes(`Node.js-${floor}+`);
    const prose = read(README).includes(`≥ 22.13`);
    return `>=${floor} · badge ${badge ? 'ok' : 'MISSING'} · README "≥ ${floor}": ${prose ? 'ok' : 'MISSING'}`;
  },

  // README Supported Log Formats: "Reading compressed dsh logs requires
  // Node.js ≥ 22.15 (built-in zstd)". The zstd handling now lives in the
  // shared layer (dsh is a project platform).
  'dsh-zstd-floor': () => {
    const zstd = read('lib/platforms/shared/zstd.js');
    const floor = zstd.match(/Node\.js >= ?([\d.]+)/)[1];
    const gated = /HAS_NODE_ZSTD = typeof zlib\.zstdDecompressSync === 'function'/.test(zstd);
    const listed = read(README).includes(`≥ ${floor}`);
    return `${floor} · shared/zstd.js message "Node.js >= ${floor}" + runtime zstd gate: ${gated ? 'yes' : 'no'} · ${README} "≥ ${floor}": ${listed ? 'ok' : 'MISSING'}`;
  },

  // README Development: "Tests live in test/ and use Node's built-in test
  // runner — no extra dependencies." Runtime deps (express, @agentlray/shared)
  // are reached through ../server.js or the shared alias, so no test-only
  // dependency exists; any other third-party require would be flagged.
  'tests-node-only': () => {
    const dir = path.join(ROOT, 'test');
    const files = readdirSync(dir).filter((file) => file.endsWith('.js'));
    const specifiers = new Set();
    for (const file of files) {
      const source = readFileSync(path.join(dir, file), 'utf8');
      for (const match of source.matchAll(/require\('([^']+)'\)/g)) specifiers.add(match[1]);
    }
    const all = [...specifiers];
    const builtinNames = new Set(require('node:module').builtinModules);
    const builtins = all.filter((s) => s.startsWith('node:') || builtinNames.has(s));
    const relative = all.filter((s) => s.startsWith('.'));
    const shared = all.filter((s) => s.startsWith('@agentlray/shared'));
    // Runtime dependencies the tests set up in-process (an Express app for the
    // proxy/inbound/dsh routes); not test-only packages.
    const runtimeDeps = new Set(['express']);
    const testOnly = all.filter(
      (s) =>
        !builtins.includes(s) && !relative.includes(s) && !shared.includes(s) && !runtimeDeps.has(s)
    );
    return `${files.length} files in test/ · ${all.length} distinct requires: ${builtins.length} node builtins, ${relative.length} relative, ${shared.length} shared alias, ${testOnly.length} test-only third-party${testOnly.length ? ` (${testOnly.join(', ')})` : ''}`;
  },

  // Deliberate: the README names no version, so no published number can go
  // stale against npm (package.json is 1.17.2 while npm still serves 1.17.1).
  'readme-no-version': () => {
    const versions = read(README).match(/(?<![\d.])v?\d+\.\d+\.\d+(?![\d.])/g) || [];
    return `${plural(versions.length, 'version string')} in ${README}`;
  },
};

async function main() {
  const id = process.argv[2];
  if (id === '--list' || !id || !receipts[id]) {
    const known = Object.keys(receipts).sort();
    process.stderr.write(`usage: node scripts/claims-receipts.mjs <${known.join('|')}>\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${await receipts[id]()}\n`);
}

await main();
