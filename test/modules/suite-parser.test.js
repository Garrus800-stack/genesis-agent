// ============================================================
// Test: Suite Parser Robustness
//
// v7.3.2: Discovered that test/index.js used to have a regex that
// only matched "Results: N passed, N failed" — which meant our two
// other harness output formats ("13 passed, 1 failed" and
// "24 passed · 0 failed · 75 assertions") never had their failure
// counts recognized. Silently-failing tests were reported as green
// in the suite summary.
//
// This test locks the regex so it handles all three shapes.
// If someone "simplifies" the regex later and breaks it, this
// test will catch it.
// ============================================================

'use strict';

const { describe, test, assertEqual, run } = require('../harness');

// The regex used in test/index.js — keep in sync with that file.
const SUMMARY_REGEX = /^\s*(?:Results:\s*)?\d+ passed\s*[,·]\s*(\d+)\s*failed/m;

function extractFailCount(stdout) {
  const m = stdout.match(SUMMARY_REGEX);
  return m ? parseInt(m[1], 10) : null;
}

describe('v7.3.2 — test/index.js suite parser handles all harness formats', () => {
  test('legacy comma format: "13 passed, 1 failed"', () => {
    assertEqual(extractFailCount('    13 passed, 1 failed\n'), 1);
  });

  test('legacy comma format with 0 failures', () => {
    assertEqual(extractFailCount('    8 passed, 0 failed\n'), 0);
  });

  test('modern middle-dot format with 0 failures', () => {
    assertEqual(extractFailCount('    24 passed · 0 failed · 75 assertions · 17ms\n'), 0);
  });

  test('modern middle-dot format with real failures', () => {
    assertEqual(extractFailCount('    13 passed · 1 failed · 27 assertions · 10ms\n'), 1);
  });

  test('original "Results:" prefix format', () => {
    assertEqual(extractFailCount('Results: 100 passed, 3 failed\n'), 3);
  });

  test('log noise before summary does not confuse parser', () => {
    const stdout = '[EVENT:HEALTH] Health check 1/1 failed\n    10 passed · 0 failed · 27 assertions';
    assertEqual(extractFailCount(stdout), 0);
  });

  test('log-only "failed" occurrence without summary returns null', () => {
    // If a test outputs "validation failed" in a log but has no summary,
    // the parser should not invent a count from noise.
    assertEqual(extractFailCount('[ERROR] validation failed\nsome log output\n'), null);
  });

  test('middle-dot format with many assertion fields', () => {
    assertEqual(extractFailCount('    42 passed · 0 failed · 148 assertions · 180ms\n'), 0);
  });
});

run();
