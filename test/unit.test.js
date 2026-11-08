const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const textUtils = require(path.join(__dirname, '..', 'lib', 'text-utils'));
const llmJson = require(path.join(__dirname, '..', 'lib', 'llm-json'));

// --- lib/text-utils ---

test('normalizePromptText collapses whitespace and trims', () => {
  assert.equal(textUtils.normalizePromptText('  a\n\t b   c  '), 'a b c');
  assert.equal(textUtils.normalizePromptText(''), '');
  assert.equal(textUtils.normalizePromptText(null), '');
  assert.equal(textUtils.normalizePromptText(undefined), '');
});

test('hashPromptText is stable and normalization-insensitive', () => {
  const a = textUtils.hashPromptText(textUtils.normalizePromptText('fix the   bug\nin auth'));
  const b = textUtils.hashPromptText(textUtils.normalizePromptText('fix the bug in auth'));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{16}$/);
  // Same input always hashes identically
  assert.equal(textUtils.hashPromptText('hello'), textUtils.hashPromptText('hello'));
  // Different input differs
  assert.notEqual(textUtils.hashPromptText('hello'), textUtils.hashPromptText('hello!'));
});

test('extractErrorSnippet skips trivial structural lines including lone {', () => {
  // Historical case: JSON-body error whose first line is a lone brace
  const snippet = textUtils.extractErrorSnippet([{ type: 'text', text: '{\n  "error": "rate limit exceeded"\n}' }]);
  assert.equal(snippet, '"error": "rate limit exceeded"');
});

test('extractErrorSnippet handles string content, arrays of strings, and empty', () => {
  assert.equal(textUtils.extractErrorSnippet('boom happened\nsecond line'), 'boom happened');
  assert.equal(textUtils.extractErrorSnippet(['```', 'ENOENT: no such file']), 'ENOENT: no such file');
  // Purely structural input falls back to the collapsed joined text
  assert.equal(textUtils.extractErrorSnippet('{ }\n[ ]'), '{ } [ ]');
  assert.equal(textUtils.extractErrorSnippet(null), '');
});

test('extractErrorSnippet truncates to 200 chars', () => {
  const long = 'x'.repeat(500);
  assert.equal(textUtils.extractErrorSnippet(long).length, 200);
});

test('normalizeErrorPattern lowercases, strips paths and hex ids', () => {
  assert.equal(textUtils.normalizeErrorPattern(''), '(empty)');
  assert.equal(textUtils.normalizeErrorPattern(null), '(empty)');
  const out = textUtils.normalizeErrorPattern('ENOENT /Users/me/project/file.txt not found');
  assert.equal(out, 'enoent /… not found');
  const hex = textUtils.normalizeErrorPattern('session deadbeef01234567 crashed');
  assert.equal(hex, 'session … crashed');
  // Only first line is used, capped at 120
  assert.equal(textUtils.normalizeErrorPattern('first\nsecond'), 'first');
  assert.ok(textUtils.normalizeErrorPattern('z'.repeat(300)).length <= 120);
});

// --- lib/llm-json ---

test('parseLlmJson parses plain JSON', () => {
  assert.deepEqual(llmJson.parseLlmJson('{"a": 1, "b": [2, 3]}'), { a: 1, b: [2, 3] });
  assert.deepEqual(llmJson.parseLlmJson('[1, 2]'), [1, 2]);
});

test('parseLlmJson extracts fenced JSON', () => {
  assert.deepEqual(llmJson.parseLlmJson('Here you go:\n```json\n{"ok": true}\n```\nDone.'), { ok: true });
  assert.deepEqual(llmJson.parseLlmJson('```\n{"ok": 2}\n```'), { ok: 2 });
});

test('parseLlmJson handles anchored fence containing inner fences', () => {
  const raw = '```json\n{"suggestions": [{"content": "use ```bash\\n...\\n``` blocks"}]}\n```';
  const parsed = llmJson.parseLlmJson(raw);
  assert.ok(parsed && Array.isArray(parsed.suggestions));
});

test('parseLlmJson repairs unescaped inner quotes (real failure shape)', () => {
  // Derived from the real failure: LLM quotes Chinese terms with literal "
  const raw = '```json\n{"overall": ["用户常说 "帮我修复" 这类模板", "第二条"], "suggestions": []}\n```';
  const parsed = llmJson.parseLlmJson(raw);
  assert.ok(parsed, 'expected repaired parse, got null');
  assert.equal(parsed.overall[0], '用户常说 "帮我修复" 这类模板');
  assert.equal(parsed.overall[1], '第二条');
  assert.deepEqual(parsed.suggestions, []);
});

test('parseLlmJson returns null on garbage', () => {
  assert.equal(llmJson.parseLlmJson('no json here at all'), null);
  assert.equal(llmJson.parseLlmJson(''), null);
  assert.equal(llmJson.parseLlmJson(null), null);
});

test('repairLlmJsonQuotes escapes content quotes, keeps terminators', () => {
  assert.equal(llmJson.repairLlmJsonQuotes('{"a": "x "y" z"}'), '{"a": "x \\"y\\" z"}');
  // Already-valid JSON passes through unchanged
  const valid = '{"a": "clean", "b": 1}';
  assert.equal(llmJson.repairLlmJsonQuotes(valid), valid);
});

