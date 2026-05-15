// ============================================================
// GENESIS — test/modules/v787-runner-parser.contract.test.js
// Contract test for v7.8.7 test-runner-parser robustness.
// Every test prefixed `runner-parser-v787 contract:`.
//
// The unified parser logic from test/index.js is exercised in
// isolation by feeding it canned stdout strings and asserting
// the (passed, failed) tuple extracted from the "summary line".
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');

// Mirror of test/index.js parser logic. Kept in-test to allow
// isolated unit-testing without invoking the full runner pipeline.
function parseSummary(stdout) {
  const cleanStdout = stdout.replace(/\x1b\[\d+m/g, '');
  const lines = cleanStdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(
      /^\s*(?:[\w\-\. ]+:\s+|Results:\s+)?(\d+)\s+passed(?:\s*[,·]\s*(\d+)\s+failed\b)?/
    );
    if (m) return { passed: parseInt(m[1]), failed: m[2] !== undefined ? parseInt(m[2]) : 0 };
  }
  return null;
}

describe('runner-parser-v787 contract: standard harness formats', () => {

  test('runner-parser-v787 contract: middle-dot format with assertions and duration', () => {
    const out = '    30 passed · 4 failed · 75 assertions · 12ms';
    const r = parseSummary(out);
    assertEqual(r.passed, 30);
    assertEqual(r.failed, 4);
  });

  test('runner-parser-v787 contract: comma format with bracketed duration', () => {
    const out = '    13 passed, 1 failed [42ms]';
    const r = parseSummary(out);
    assertEqual(r.passed, 13);
    assertEqual(r.failed, 1);
  });

  test('runner-parser-v787 contract: legacy "Results: N passed, N failed"', () => {
    const out = '  Results: 8 passed, 0 failed';
    const r = parseSummary(out);
    assertEqual(r.passed, 8);
    assertEqual(r.failed, 0);
  });

});

describe('runner-parser-v787 contract: label-prefix formats (v7.8.7 fix)', () => {

  test('runner-parser-v787 contract: "v756-fix: N passed, M failed" matches', () => {
    const out = '\n  v756-fix: 30 passed, 4 failed\n  Failures:\n    - A1: ...';
    const r = parseSummary(out);
    assertEqual(r.passed, 30);
    assertEqual(r.failed, 4);
  });

  test('runner-parser-v787 contract: "v3.5.0 COGNITIVE TESTS: N passed, M failed" matches (with spaces in label)', () => {
    const out = '  v3.5.0 COGNITIVE TESTS: 82 passed, 0 failed';
    const r = parseSummary(out);
    assertEqual(r.passed, 82);
    assertEqual(r.failed, 0);
  });

  test('runner-parser-v787 contract: dotted-version label "v759-linux-open: ..." matches', () => {
    const out = '  v759-linux-open: 11 passed, 0 failed';
    const r = parseSummary(out);
    assertEqual(r.passed, 11);
    assertEqual(r.failed, 0);
  });

});

describe('runner-parser-v787 contract: ANSI-coloured formats (v7.8.7 fix)', () => {

  test('runner-parser-v787 contract: integration-test style with ANSI escapes around counts', () => {
    const out = '  Integration: \x1b[32m200 passed\x1b[0m, \x1b[32m0 failed\x1b[0m';
    const r = parseSummary(out);
    assertEqual(r.passed, 200);
    assertEqual(r.failed, 0);
  });

  test('runner-parser-v787 contract: ANSI without label', () => {
    const out = '    \x1b[32m24 passed\x1b[0m · \x1b[32m0 failed\x1b[0m · 75 assertions';
    const r = parseSummary(out);
    assertEqual(r.passed, 24);
    assertEqual(r.failed, 0);
  });

});

describe('runner-parser-v787 contract: anti-false-positive (v7.8.7 fix #2)', () => {

  test('runner-parser-v787 contract: mock-demo line BEFORE real summary — real summary wins (suite-parser bug)', () => {
    // suite-parser test prints a mock-output demo line "13 passed, 1 failed"
    // inside its own assertions; the actual summary is "8 passed · 0 failed"
    // at the end. The old non-multiline `(\d+) passed` regex matched the mock
    // line first. v7.8.7 search-from-end fixes this.
    const out = [
      '    ✅ legacy comma format: "13 passed, 1 failed"',
      '    ✅ middle-dot format with assertions',
      '',
      '    8 passed · 0 failed · 8 assertions · 3ms',
    ].join('\n');
    const r = parseSummary(out);
    assertEqual(r.passed, 8);
    assertEqual(r.failed, 0);
  });

  test('runner-parser-v787 contract: progress lines do NOT win over final summary', () => {
    const out = [
      '  sub-test 1: 5 passed, 0 failed',
      '  sub-test 2: 10 passed, 1 failed',
      '    30 passed · 4 failed · 75 assertions · 50ms',
    ].join('\n');
    const r = parseSummary(out);
    assertEqual(r.passed, 30);
    assertEqual(r.failed, 4);
  });

  test('runner-parser-v787 contract: false positives — "Health check 1/1 failed" does NOT match', () => {
    const out = [
      '[12:00:00] Health check 1/1 failed',
      '    24 passed · 0 failed · 8 assertions',
    ].join('\n');
    const r = parseSummary(out);
    assertEqual(r.passed, 24);
    assertEqual(r.failed, 0);
  });

});

describe('runner-parser-v787 contract: edge cases', () => {

  test('runner-parser-v787 contract: empty input returns null', () => {
    assertEqual(parseSummary(''), null);
  });

  test('runner-parser-v787 contract: input without any "N passed" returns null', () => {
    const out = 'just some logs\nnothing to match here\nno numbers either';
    assertEqual(parseSummary(out), null);
  });

  test('runner-parser-v787 contract: zero-zero summary matches with both counts zero', () => {
    const out = '    0 passed · 0 failed · 0 assertions · 1ms';
    const r = parseSummary(out);
    assertEqual(r.passed, 0);
    assertEqual(r.failed, 0);
  });

  test('runner-parser-v787 contract: single "N passed" line (no failed-count, v7.8.7-fix2)', () => {
    // Many test files print `${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`.
    // When failed === 0 the line is just "  14 passed" — failed-group must
    // be optional so the parser doesn't return null and display 0.
    const out = '\n  14 passed';
    const r = parseSummary(out);
    assertEqual(r.passed, 14);
    assertEqual(r.failed, 0);
  });

  test('runner-parser-v787 contract: single "N passed" with label (v7.8.7-fix2)', () => {
    const out = '\n  v757-fix-cloud-fallback: 14 passed';
    const r = parseSummary(out);
    assertEqual(r.passed, 14);
    assertEqual(r.failed, 0);
  });

});

run();
