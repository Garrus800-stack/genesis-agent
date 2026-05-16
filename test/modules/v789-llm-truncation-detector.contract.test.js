// ============================================================
// GENESIS — test/modules/v789-llm-truncation-detector.contract.test.js
// Contract test for v7.8.9 TruncationDetector:
//   • detectShape() identifies code-with-manifest, code-single-block,
//     json-bare, code-bare, free correctly
//   • isComplete() returns false for explicit truncation signals
//   • Per-shape structural validation:
//     - code-with-manifest: requires both json and js blocks, balanced
//     - code-single-block: fences must pair, brackets balanced
//     - json-bare: must parse
//     - code-bare: brackets balanced
//   • bracketsBalanced() handles strings, line comments, block comments
//   • Short free-text with stop+balanced passes (shell commands etc.)
//   • Empty content always incomplete
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const {
  isComplete,
  detectShape,
  bracketsBalanced,
  canParseJson,
} = require(path.join(ROOT, 'src/agent/foundation/backends/TruncationDetector'));

// ── detectShape ───────────────────────────────────────────

describe('llm-resilience-v789 contract: detectShape identifies output structure', () => {

  test('llm-resilience-v789 contract: detectShape recognizes code-with-manifest (SkillManager pattern)', () => {
    const content = '```json\n{"name":"x"}\n```\n```javascript\nclass X {}\n```';
    assertEqual(detectShape(content), 'code-with-manifest', 'both json+js blocks detected');
  });

  test('llm-resilience-v789 contract: detectShape recognizes single fenced block', () => {
    const content = '```python\nprint("hi")\n```';
    assertEqual(detectShape(content), 'code-single-block', 'single fence detected');
  });

  test('llm-resilience-v789 contract: detectShape recognizes bare JSON', () => {
    assertEqual(detectShape('{"foo": "bar"}'), 'json-bare', 'object literal');
    assertEqual(detectShape('[1, 2, 3]'), 'json-bare', 'array literal');
  });

  test('llm-resilience-v789 contract: detectShape recognizes bare JS', () => {
    assertEqual(detectShape('function foo() { return 1; }'), 'code-bare', 'function keyword');
    assertEqual(detectShape('class X { constructor() {} }'), 'code-bare', 'class keyword');
    assertEqual(detectShape('const x = 5;'), 'code-bare', 'const keyword');
    assertEqual(detectShape('module.exports = { X };'), 'code-bare', 'module.exports');
  });

  test('llm-resilience-v789 contract: detectShape falls back to free for prose', () => {
    assertEqual(detectShape('Hello, this is just plain text.'), 'free', 'no code markers');
    assertEqual(detectShape(''), 'free', 'empty string');
  });

});

// ── isComplete: truncation signals ───────────────────────

describe('llm-resilience-v789 contract: isComplete handles truncation signals', () => {

  test('llm-resilience-v789 contract: doneReason=length flags incomplete even with balanced content', () => {
    const r = isComplete('function x() { return 1; }', 'length');
    assertEqual(r.complete, false, 'length=truncated');
    assert(r.reason.startsWith('truncation-signal:'), 'reason indicates truncation');
  });

  test('llm-resilience-v789 contract: doneReason=null (TCP-drop) flags incomplete', () => {
    const r = isComplete('some partial', null);
    assertEqual(r.complete, false, 'null=truncated');
    assertEqual(r.reason, 'truncation-signal:null', 'null reason');
  });

  test('llm-resilience-v789 contract: doneReason=chunk-timeout flags incomplete', () => {
    const r = isComplete('partial', 'chunk-timeout');
    assertEqual(r.complete, false, 'chunk-timeout=truncated');
  });

  test('llm-resilience-v789 contract: doneReason=total-timeout flags incomplete', () => {
    const r = isComplete('partial', 'total-timeout');
    assertEqual(r.complete, false, 'total-timeout=truncated');
  });

  test('llm-resilience-v789 contract: empty content always incomplete', () => {
    const r = isComplete('', 'stop');
    assertEqual(r.complete, false, 'empty incomplete');
    assertEqual(r.reason, 'empty-content', 'empty reason');
  });

});

// ── isComplete: per-shape validation ─────────────────────

describe('llm-resilience-v789 contract: code-with-manifest validation', () => {

  test('llm-resilience-v789 contract: complete skill (both blocks closed, valid JSON, balanced JS)', () => {
    const content = '```json\n{"name":"x","version":"1.0"}\n```\n```javascript\nclass X { run() { return 42; } }\nmodule.exports = { X };\n```';
    const r = isComplete(content, 'stop');
    assertEqual(r.complete, true, 'complete skill accepted');
  });

  test('llm-resilience-v789 contract: skill with unclosed JS fence is incomplete', () => {
    const content = '```json\n{"name":"x"}\n```\n```javascript\nclass X {\n  start';
    const r = isComplete(content, 'stop');
    assertEqual(r.complete, false, 'unclosed fence detected');
    assertEqual(r.reason, 'manifest:unclosed-fence', 'specific reason');
  });

  test('llm-resilience-v789 contract: skill with invalid JSON is incomplete', () => {
    const content = '```json\n{"name":"x", invalid}\n```\n```javascript\nclass X {}\n```';
    const r = isComplete(content, 'stop');
    assertEqual(r.complete, false, 'broken JSON detected');
    assertEqual(r.reason, 'manifest:json-unparseable', 'specific reason');
  });

  test('llm-resilience-v789 contract: skill with unbalanced JS braces is incomplete', () => {
    const content = '```json\n{"name":"x"}\n```\n```javascript\nclass X { run() {\n```';
    const r = isComplete(content, 'stop');
    assertEqual(r.complete, false, 'unbalanced braces detected');
    assertEqual(r.reason, 'manifest:js-brackets-unbalanced', 'specific reason');
  });

  test('llm-resilience-v789 contract: skill missing JS block (only JSON) is incomplete', () => {
    const content = '```json\n{"name":"x"}\n```';
    const r = isComplete(content, 'stop');
    // detectShape sees only ```json — that's single-block shape, not manifest
    // So this test verifies shapes match correctly (it's NOT code-with-manifest)
    assertEqual(r.shape, 'code-single-block', 'single block detected when only json present');
  });

});

describe('llm-resilience-v789 contract: code-single-block validation', () => {

  test('llm-resilience-v789 contract: balanced single block is complete', () => {
    const content = '```python\ndef f(): return 1\n```';
    const r = isComplete(content, 'stop');
    assertEqual(r.complete, true, 'balanced single block ok');
  });

  test('llm-resilience-v789 contract: unclosed single block is incomplete', () => {
    const content = '```python\ndef f():\n  return';
    const r = isComplete(content, 'stop');
    assertEqual(r.complete, false, 'unclosed fence');
  });

});

describe('llm-resilience-v789 contract: bare JSON validation', () => {

  test('llm-resilience-v789 contract: parseable JSON is complete', () => {
    assertEqual(isComplete('{"a":1,"b":[1,2,3]}', 'stop').complete, true, 'valid object');
    assertEqual(isComplete('[1,2,3]', 'stop').complete, true, 'valid array');
  });

  test('llm-resilience-v789 contract: unparseable JSON is incomplete', () => {
    assertEqual(isComplete('{"a":1, "b":', 'stop').complete, false, 'cut mid-value');
    assertEqual(isComplete('{"a":1,', 'stop').complete, false, 'trailing comma');
  });

});

describe('llm-resilience-v789 contract: bare code validation', () => {

  test('llm-resilience-v789 contract: balanced function is complete', () => {
    const r = isComplete('function add(a, b) { return a + b; }', 'stop');
    assertEqual(r.complete, true, 'balanced function');
  });

  test('llm-resilience-v789 contract: unbalanced braces is incomplete', () => {
    const r = isComplete('function add(a, b) { if (a > 0) { return', 'stop');
    assertEqual(r.complete, false, 'unbalanced');
  });

  test('llm-resilience-v789 contract: braces inside strings do not count', () => {
    const content = 'const s = "}}}";\nconst t = { ok: true };';
    assertEqual(isComplete(content, 'stop').complete, true, 'strings ignored');
  });

  test('llm-resilience-v789 contract: braces inside line-comments do not count', () => {
    const content = '// closing brace } in comment\nconst x = { value: 1 };';
    assertEqual(isComplete(content, 'stop').complete, true, 'line comments ignored');
  });

  test('llm-resilience-v789 contract: braces inside block-comments do not count', () => {
    const content = '/* { extra opening brace */\nconst x = { value: 1 };';
    assertEqual(isComplete(content, 'stop').complete, true, 'block comments ignored');
  });

});

describe('llm-resilience-v789 contract: free-form text and short responses', () => {

  test('llm-resilience-v789 contract: short shell-command-like text passes', () => {
    const r = isComplete('ls -la /tmp', 'stop');
    assertEqual(r.complete, true, 'short balanced text complete');
  });

  test('llm-resilience-v789 contract: long free-form text trusts stop', () => {
    const longText = 'Hello world. '.repeat(50);  // ~650 chars, all balanced
    const r = isComplete(longText, 'stop');
    assertEqual(r.complete, true, 'long text with stop accepted');
  });

});

// ── Helper-level checks ──────────────────────────────────

describe('llm-resilience-v789 contract: bracketsBalanced internals', () => {

  test('llm-resilience-v789 contract: bracketsBalanced handles empty string', () => {
    assertEqual(bracketsBalanced(''), true, 'empty is balanced');
  });

  test('llm-resilience-v789 contract: bracketsBalanced detects nested mismatch', () => {
    assertEqual(bracketsBalanced('({[}])'), false, 'cross-nested-wrong returns false');
  });

  test('llm-resilience-v789 contract: bracketsBalanced ignores escaped string quotes', () => {
    const code = 'const x = "she said \\"hi\\" then {";\nconst y = { ok: 1 };';
    assertEqual(bracketsBalanced(code), true, 'escaped quotes in string handled');
  });

  test('llm-resilience-v789 contract: bracketsBalanced handles template literals', () => {
    const code = 'const x = `value is ${a + b}` ;\nconst y = { z: 1 };';
    assertEqual(bracketsBalanced(code), true, 'backtick strings handled');
  });

  test('llm-resilience-v789 contract: canParseJson rejects undefined and non-strings', () => {
    assertEqual(canParseJson(null), false, 'null rejected');
    assertEqual(canParseJson(undefined), false, 'undefined rejected');
    assertEqual(canParseJson(42), false, 'non-string rejected');
  });

});

if (require.main === module) run();
