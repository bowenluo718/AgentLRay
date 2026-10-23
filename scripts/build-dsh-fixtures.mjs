// Regenerates the versioned DeepSeek Harness (dsh) test fixtures:
//   dsh-fixture-session-0003/session.jsonl.zstd      → format version 0 (legacy)
//   dsh-fixture-session-0003/session.v3.jsonl.zstd   → format version 3 (current, superset)
//   dsh-fixture-session-0004/session.v4.jsonl.zstd   → format version 4 (only file)
//
// Mirrors how a real harness session dir looks after format migration: the
// legacy session.jsonl.zstd stays frozen next to the versioned live log, and
// session dirs created by the current harness may hold ONLY session.v4.jsonl.zstd.
// Every log is a concatenation of independent zstd frames (one per durable
// append batch) with checksums enabled, like the runtime writer.
//
// Deterministic: fixed ids/timestamps/content. Run after editing sample logs:
//   node scripts/build-dsh-fixtures.mjs
//
// Keeps fixture 0001 (plain JSONL) and 0002 (multi-frame zstd, version 0) untouched.

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DSH_ROOT = path.join(
  ROOT,
  'test',
  'fixtures',
  'home',
  '.dsh',
  'sessions'
);

const ZSTD_OPTS = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), ZSTD_OPTS);

// One durable append batch per frame — same shape the real writer produces.
function writeFrames(relDir, file, batches) {
  const dir = path.join(DSH_ROOT, relDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, file),
    Buffer.concat(batches.map((b) => frame(b.map((rec) => JSON.stringify(rec)).join('\n') + '\n')))
  );
}

// --- 0003: legacy v0 file + current v3 file for the same session ---
// The v3 log contains the v0 turn AND a second turn (migration superset).

const v0Legacy = [
  { type: 'session', version: 0, id: 'dsh-fixture-session-0003', createdAt: 1768564800000, cwd: '/fixtures/project-eta', delegationDepth: 0 },
  { type: 'permission/preset', seq: 0, time: 1768564800100, data: { preset: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 1768564800200, data: { turn: 1 } },
  {
    type: 'user/message', seq: 2, time: 1768564801000,
    data: { content: [{ type: 'text', text: 'fixture: dsh-legacy-needle-eta first prompt' }], source: { kind: 'user' }, role: 'user', id: 'aaaa1111-aaaa-4aaa-8aaa-aaaa1111aaaa' },
    surfaceOp: 'append',
  },
  {
    type: 'assistant/message', seq: 3, time: 1768564805000,
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'fixture: legacy assistant only.' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' }, id: 'bbbb2222-bbbb-4bbb-8bbb-bbbb2222bbbb' },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
    },
    sourceEventSeqs: [], surfaceOp: 'append',
  },
  { type: 'turn/end', seq: 4, time: 1768564806000, data: { turn: 1, reason: { kind: 'completed' } } },
];

const v3Current = [
  { type: 'session', version: 3, id: 'dsh-fixture-session-0003', createdAt: 1768564800000, cwd: '/fixtures/project-eta', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
  { type: 'permission/preset', seq: 0, time: 1768564800100, data: { preset: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 1768564800200, data: { turn: 1 } },
  { type: 'system/message', seq: 2, time: 1768564800300, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'system scaffold' }] } } },
  {
    type: 'user/message', seq: 3, time: 1768564801000,
    data: { content: [{ type: 'text', text: 'fixture: dsh-legacy-needle-eta first prompt' }], source: { kind: 'user' }, role: 'user', id: 'aaaa1111-aaaa-4aaa-8aaa-aaaa1111aaaa' },
    surfaceOp: 'append',
  },
  {
    type: 'assistant/message', seq: 4, time: 1768564805000,
    data: {
      turn: 1, step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'fixture: migrated assistant.' }], source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' }, id: 'bbbb2222-bbbb-4bbb-8bbb-bbbb2222bbbb' },
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, reasoningTokens: 0 },
    },
    sourceEventSeqs: [], surfaceOp: 'append',
  },
  { type: 'turn/end', seq: 5, time: 1768564806000, data: { turn: 1, reason: { kind: 'completed' } } },
  { type: 'turn/start', seq: 6, time: 1768564807000, data: { turn: 2 } },
  {
    type: 'user/message', seq: 7, time: 1768564808000,
    data: { content: [{ type: 'text', text: 'fixture: second prompt using the current v3 log' }], source: { kind: 'user' }, role: 'user', id: 'cccc3333-cccc-4ccc-8ccc-cccc3333cccc' },
    surfaceOp: 'append',
  },
  {
    type: 'assistant/message', seq: 8, time: 1768564809000,
    data: {
      turn: 2, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'fixture: v3 thinking' },
          { type: 'text', text: 'fixture: running the v3 check.' },
          { type: 'tool-call', id: 'call-v3-1', name: 'run_command', arguments: '{"command":"echo eta"}' },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' }, id: 'dddd4444-dddd-4ddd-8ddd-dddd4444dddd',
      },
      usage: { inputTokens: 40, outputTokens: 12, cacheReadTokens: 5, reasoningTokens: 6 },
    },
    sourceEventSeqs: [], surfaceOp: 'append',
  },
  {
    type: 'tool/call', seq: 9, time: 1768564809000,
    data: { turn: 2, step: 1, callId: 'call-v3-1', name: 'run_command', arguments: '{"command":"echo eta"}' },
  },
  {
    type: 'tool/result', seq: 10, time: 1768564811000,
    data: {
      turn: 2, step: 1,
      message: { source: { kind: 'tool', callId: 'call-v3-1' }, content: [{ type: 'tool-result', toolCallId: 'call-v3-1', content: [{ type: 'text', text: 'eta\n' }], isError: false }], role: 'user', id: 'eeee5555-eeee-4eee-8eee-eeee5555eeee' },
    },
    sourceEventSeqs: [9], surfaceOp: 'append',
  },
  { type: 'turn/end', seq: 11, time: 1768564812000, data: { turn: 2, reason: { kind: 'completed' } } },
];

writeFrames('--fixtures-project-eta--/dsh-fixture-session-0003', 'session.jsonl.zstd', [v0Legacy]);
writeFrames('--fixtures-project-eta--/dsh-fixture-session-0003', 'session.v3.jsonl.zstd', [v3Current]);

// --- 0004: current harness session, ONLY session.v4.jsonl.zstd ---

const v4Only = [
  { type: 'session', version: 4, id: 'dsh-fixture-session-0004', createdAt: 1768572000000, cwd: '/fixtures/project-zeta', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' },
  { type: 'permission/preset', seq: 0, time: 1768572000100, data: { preset: 'workspace-write' } },
  { type: 'turn/start', seq: 1, time: 1768572000200, data: { turn: 1 } },
  { type: 'system/message', seq: 2, time: 1768572000300, data: { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'system scaffold' }] } } },
  {
    type: 'user/message', seq: 3, time: 1768572001000,
    data: { content: [{ type: 'text', text: 'fixture: dsh-v4-needle-zeta build the report' }], source: { kind: 'user' }, role: 'user', id: '12ab34cd-56ef-4789-abcd-ef0123456789' },
    surfaceOp: 'append',
  },
  {
    type: 'assistant/message', seq: 4, time: 1768572005000,
    data: {
      turn: 1, step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'fixture: v4 reasoning' },
          { type: 'text', text: 'fixture: v4 report generated.' },
          { type: 'tool-call', id: 'call-v4-1', name: 'read_file', arguments: '{"path":"report.md"}' },
        ],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4' }, id: 'fedcba98-7654-4321-abcd-9876543210ff',
      },
      usage: { inputTokens: 150, outputTokens: 25, cacheReadTokens: 10, reasoningTokens: 7 },
    },
    sourceEventSeqs: [], surfaceOp: 'append',
  },
  {
    type: 'tool/call', seq: 5, time: 1768562005000,
    data: { turn: 1, step: 1, callId: 'call-v4-1', name: 'read_file', arguments: '{"path":"report.md"}' },
  },
  {
    type: 'tool/result', seq: 6, time: 1768572007000,
    data: {
      turn: 1, step: 1,
      message: { source: { kind: 'tool', callId: 'call-v4-1' }, content: [{ type: 'tool-result', toolCallId: 'call-v4-1', content: [{ type: 'text', text: 'zeta report body\n' }], isError: false }], role: 'user', id: '00112233-4455-4667-7889-9aabbccddeef' },
    },
    sourceEventSeqs: [5], surfaceOp: 'append',
  },
  { type: 'developer/message', seq: 7, time: 1768572007500, data: { turn: 1, step: 1, message: { role: 'developer', content: [{ type: 'text', text: 'dev note ignored by the adapter' }] } } },
  { type: 'turn/end', seq: 8, time: 1768572008000, data: { turn: 1, reason: { kind: 'completed' } } },
];

writeFrames('--fixtures-project-zeta--/dsh-fixture-session-0004', 'session.v4.jsonl.zstd', [v4Only]);

console.log('dsh fixture logs regenerated (0003 legacy-v0 + v3-current, 0004 v4-only).');
