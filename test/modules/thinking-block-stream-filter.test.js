// ============================================================
// Test: v7.5.6 — Thinking-Block Stream Filter
//
// Strips <think>...</think> and <thinking>...</thinking> blocks
// from streaming output. Reasoning models like DeepSeek-R1, QwQ,
// nemotron-3-nano emit these before the actual answer.
// ============================================================

'use strict';

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
function assertEqual(a, b, m) { if (a !== b) throw new Error(`${m || 'not equal'}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }

const { createThinkingBlockStreamFilter, stripThinkingBlocks } = require('../../src/agent/core/thinking-block-stream-filter');

console.log('  thinking-block-stream-filter tests:');

// ──────────────────────────────────────────────────────────────
// stripThinkingBlocks — pure function variant
// ──────────────────────────────────────────────────────────────

test('strip: empty input returns empty result', () => {
  const r = stripThinkingBlocks('');
  assertEqual(r.clean, '');
  assertEqual(r.reasoning, '');
});

test('strip: null/undefined safe', () => {
  const r1 = stripThinkingBlocks(null);
  const r2 = stripThinkingBlocks(undefined);
  assertEqual(r1.clean, '');
  assertEqual(r2.clean, '');
});

test('strip: non-string safe', () => {
  const r = stripThinkingBlocks(42);
  assertEqual(r.clean, '');
  assertEqual(r.reasoning, '');
});

test('strip: pass-through when no tag', () => {
  const r = stripThinkingBlocks('just an answer with no tags');
  assertEqual(r.clean, 'just an answer with no tags');
  assertEqual(r.reasoning, '');
});

test('strip: single block <think>', () => {
  const r = stripThinkingBlocks('pre <think>secret</think> post');
  assertEqual(r.clean, 'pre  post');
  assertEqual(r.reasoning, 'secret');
});

test('strip: single block <thinking>', () => {
  const r = stripThinkingBlocks('pre <thinking>secret</thinking> post');
  assertEqual(r.clean, 'pre  post');
  assertEqual(r.reasoning, 'secret');
});

test('strip: multiple blocks accumulate reasoning', () => {
  const r = stripThinkingBlocks('a<think>x</think>b<thinking>y</thinking>c');
  assertEqual(r.clean, 'abc');
  assertEqual(r.reasoning, 'xy');
});

test('strip: case-insensitive', () => {
  const r = stripThinkingBlocks('hi <Think>X</THINK> done');
  assertEqual(r.clean, 'hi  done');
  assertEqual(r.reasoning, 'X');
});

test('strip: newlines inside block', () => {
  const r = stripThinkingBlocks('hi <think>\nline1\nline2\n</think> bye');
  assertEqual(r.clean, 'hi  bye');
  assertEqual(r.reasoning, '\nline1\nline2\n');
});

test('strip: no closing tag — all remaining is reasoning', () => {
  const r = stripThinkingBlocks('hi <think>endless reasoning');
  assertEqual(r.clean, 'hi ');
  assertEqual(r.reasoning, 'endless reasoning');
});

test('strip: phantom-tool-call inside reasoning is captured, not leaked', () => {
  const r = stripThinkingBlocks('Hi <think>I should call <tool_call>{"name":"x"}</tool_call> here</think>Done.');
  assertEqual(r.clean, 'Hi Done.');
  assert(r.reasoning.includes('<tool_call>'),
    'tool-call markup must remain inside reasoning, not leak to clean');
  assert(!r.clean.includes('<tool_call>'),
    'clean must NOT contain tool-call markup from inside reasoning');
});

test('strip: only thinking, no answer', () => {
  const r = stripThinkingBlocks('<think>just reasoning</think>');
  assertEqual(r.clean, '');
  assertEqual(r.reasoning, 'just reasoning');
});

test('strip: text before, no closing tag', () => {
  const r = stripThinkingBlocks('answer<think>then thinking');
  assertEqual(r.clean, 'answer');
  assertEqual(r.reasoning, 'then thinking');
});

// ──────────────────────────────────────────────────────────────
// createThinkingBlockStreamFilter — streaming variant
// ──────────────────────────────────────────────────────────────

test('stream: pass-through across many small chunks (no tags)', () => {
  const f = createThinkingBlockStreamFilter();
  const chunks = ['hel', 'lo ', 'wor', 'ld'];
  let out = '';
  for (const c of chunks) out += f.push(c);
  out += f.flush();
  assertEqual(out, 'hello world');
  assertEqual(f.getReasoning(), '');
});

test('stream: tag split across chunk boundary <thi | nk>', () => {
  const f = createThinkingBlockStreamFilter();
  let out = '';
  out += f.push('hello <thi');
  out += f.push('nk>secret</think> bye');
  out += f.flush();
  assertEqual(out, 'hello  bye');
  assertEqual(f.getReasoning(), 'secret');
});

test('stream: closing tag split across chunks <thi | nk>x</thi | nk>', () => {
  const f = createThinkingBlockStreamFilter();
  let out = '';
  out += f.push('hi <think>');
  out += f.push('x</thi');
  out += f.push('nk> bye');
  out += f.flush();
  assertEqual(out, 'hi  bye');
  assertEqual(f.getReasoning(), 'x');
});

test('stream: multi-character chunk-by-chunk (worst case)', () => {
  const f = createThinkingBlockStreamFilter();
  const text = 'pre <think>hidden content</think> post';
  let out = '';
  for (const ch of text) out += f.push(ch);
  out += f.flush();
  assertEqual(out, 'pre  post');
  assertEqual(f.getReasoning(), 'hidden content');
});

test('stream: multiple blocks across chunks', () => {
  const f = createThinkingBlockStreamFilter();
  let out = '';
  out += f.push('a<think>x</think>b<thinking>y');
  out += f.push('y2</thinking>c');
  out += f.flush();
  assertEqual(out, 'abc');
  assertEqual(f.getReasoning(), 'xyy2');
});

test('stream: case-insensitive across chunks', () => {
  const f = createThinkingBlockStreamFilter();
  let out = '';
  out += f.push('hi <Th');
  out += f.push('Ink>X</tHinK> done');
  out += f.flush();
  assertEqual(out, 'hi  done');
  assertEqual(f.getReasoning(), 'X');
});

test('stream: empty chunk handled', () => {
  const f = createThinkingBlockStreamFilter();
  assertEqual(f.push(''), '');
  assertEqual(f.push('hello'), '');  // buffered as lookahead
  assertEqual(f.flush(), 'hello');
  assertEqual(f.getReasoning(), '');
});

test('stream: stream ends inside thinking block — content kept as reasoning', () => {
  const f = createThinkingBlockStreamFilter();
  let out = '';
  out += f.push('hi <think>start');
  out += f.push(' more');
  out += f.flush();
  assertEqual(out, 'hi ');
  assertEqual(f.getReasoning(), 'start more');
});

test('stream: independent instances (no shared state)', () => {
  const f1 = createThinkingBlockStreamFilter();
  const f2 = createThinkingBlockStreamFilter();
  f1.push('<think>f1-secret</think>');
  f1.flush();
  // f2 should be untouched
  assertEqual(f2.getReasoning(), '');
  let out2 = '';
  out2 += f2.push('clean text');
  out2 += f2.flush();
  assertEqual(out2, 'clean text');
});

test('stream: large chunk in single push (no boundary issues)', () => {
  const f = createThinkingBlockStreamFilter();
  const big = 'A'.repeat(500) + '<think>' + 'B'.repeat(500) + '</think>' + 'C'.repeat(500);
  let out = f.push(big);
  out += f.flush();
  assertEqual(out, 'A'.repeat(500) + 'C'.repeat(500));
  assertEqual(f.getReasoning(), 'B'.repeat(500));
});

test('stream: only opening tag in entire stream — flush captures as reasoning', () => {
  const f = createThinkingBlockStreamFilter();
  let out = f.push('<think>only thinking');
  out += f.flush();
  assertEqual(out, '');
  assertEqual(f.getReasoning(), 'only thinking');
});

// ──────────────────────────────────────────────────────────────
// Consistency check — strip and stream variants must agree
// ──────────────────────────────────────────────────────────────

test('consistency: stream-as-one-chunk == stripThinkingBlocks', () => {
  const samples = [
    'simple text',
    'pre <think>x</think> post',
    'a<thinking>1</thinking>b<think>2</think>c',
    'hi <Think>X</THINK> done',
    '<think>only</think>',
    'no closing <think>tail',
  ];
  for (const s of samples) {
    const r1 = stripThinkingBlocks(s);
    const f = createThinkingBlockStreamFilter();
    const main = f.push(s);
    const tail = f.flush();
    const r2 = { clean: main + tail, reasoning: f.getReasoning() };
    assertEqual(r2.clean, r1.clean, `clean differs for input ${JSON.stringify(s)}`);
    assertEqual(r2.reasoning, r1.reasoning, `reasoning differs for input ${JSON.stringify(s)}`);
  }
});

console.log(`\n  thinking-block-stream-filter: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log('  Failures:');
  failures.forEach(f => console.log(`    - ${f.name}: ${f.error}`));
  process.exit(1);
}
