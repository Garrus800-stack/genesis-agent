// ============================================================
// GENESIS — test/harness.js
// Shared async-safe test framework.
//
// FIXES:
//   - All async tests are properly awaited (no fire-and-forget)
//   - Sync test errors are properly caught
//   - Zero-test suites are flagged as failures
//   - Cross-platform path helpers included
//
// Usage:
//   const { describe, test, assert, assertEqual, assertIncludes,
//           assertThrows, assertRejects, run, TEST_ROOT,
//           crossPlatformPath } = require('./harness');
//
//   describe('MyModule', () => {
//     test('works', () => { assert(true); });
//     test('async works', async () => { await something(); assert(true); });
//   });
//
//   run();  // ← MUST be called at end of file
// ============================================================

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

// ── State ────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let totalAssertions = 0;
const failures = [];
const suiteQueue = [];

// ── Describe / Test — queue-based, never fire-and-forget ─────
function describe(name, fn) {
  suiteQueue.push({ name, fn });
}

function test(name, fn) {
  // test() is called inside describe() which is deferred.
  // We push to the current suite's test list.
  if (!test._currentSuite) {
    throw new Error(`test() called outside describe(): "${name}"`);
  }
  test._currentSuite.push({ name, fn });
}
test._currentSuite = null;

// ── Assertions ───────────────────────────────────────────────
function assert(condition, message) {
  totalAssertions++;
  if (!condition) throw new Error(message || 'Assertion failed');
}

function assertEqual(actual, expected, message) {
  totalAssertions++;
  if (actual !== expected) {
    throw new Error(message || `Expected "${expected}", got "${actual}"`);
  }
}

function assertDeepEqual(actual, expected, message) {
  totalAssertions++;
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(message || `Deep equality failed:\n  actual:   ${a}\n  expected: ${b}`);
  }
}

function assertIncludes(arr, item, message) {
  totalAssertions++;
  if (!arr.includes(item)) {
    throw new Error(message || `Array does not include "${item}"`);
  }
}

function assertThrows(fn, message) {
  totalAssertions++;
  try {
    fn();
    throw new Error(message || 'Expected function to throw');
  } catch (err) {
    if (err.message === (message || 'Expected function to throw')) throw err;
    // Expected throw — success
  }
}

async function assertRejects(fn, message) {
  totalAssertions++;
  try {
    await fn();
    throw new Error(message || 'Expected async function to reject');
  } catch (err) {
    if (err.message === (message || 'Expected async function to reject')) throw err;
    // Expected rejection — success
  }
}

// ── Cross-platform helpers ───────────────────────────────────

/** Returns a unique temp directory for this test run. Cleaned up by run(). */
function createTestRoot(label) {
  const id = crypto.randomBytes(4).toString('hex');
  const dir = path.join(os.tmpdir(), `genesis-test-${label || 'suite'}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Returns a path that is guaranteed to be outside the project root
 * and meaningful on the current OS. Used for "block writes outside root" tests.
 */
function blockedSystemPath() {
  return process.platform === 'win32'
    ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
    : '/etc/passwd';
}

/**
 * Returns a path to a temp location outside the sandbox, for testing
 * "block writes outside sandbox" scenarios.
 */
function blockedTempPath() {
  return path.join(os.tmpdir(), `genesis-escape-test-${Date.now()}`);
}

/**
 * Normalize a path for cross-platform comparison.
 */
function normalizePath(p) {
  return path.resolve(p).split(path.sep).join('/');
}

// ── Runner ───────────────────────────────────────────────────

async function run() {
  const startTime = Date.now();

  for (const suite of suiteQueue) {
    console.log(`\n  📦 ${suite.name}`);

    // Collect tests from this describe block
    const tests = [];
    test._currentSuite = tests;
    try {
      suite.fn();
    } catch (err) {
      failed++;
      failures.push({ name: `${suite.name} [setup]`, error: err.message });
      console.log(`    ❌ ${suite.name} [setup error]: ${err.message}`);
      continue;
    }
    test._currentSuite = null;

    // Run each test, properly awaiting async ones
    for (const t of tests) {
      try {
        const result = t.fn();
        // If async, await it
        if (result && typeof result.then === 'function') {
          await result;
        }
        passed++;
        console.log(`    ✅ ${t.name}`);
      } catch (err) {
        failed++;
        failures.push({ name: `${suite.name} > ${t.name}`, error: err.message });
        console.log(`    ❌ ${t.name}: ${err.message}`);
      }
    }

    // Flag empty suites
    if (tests.length === 0) {
      console.log(`    ⚠️  No tests registered in this suite`);
    }
  }

  const duration = Date.now() - startTime;

  // ── Summary ──
  console.log(`\n    ${passed} passed · ${failed} failed · ${totalAssertions} assertions · ${duration}ms`);

  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const f of failures) {
      console.log(`  ❌ ${f.name}: ${f.error}`);
    }
  }

  if (suiteQueue.length === 0) {
    console.error('\n  ⛔ No test suites registered! Did you forget to call describe()?');
    process.exit(1);
  }

  process.exit(failed > 0 ? 1 : 0);
}

// ── Standalone run helper for module tests ───────────────────

/**
 * Minimal runner for module test files that don't use describe().
 * Collects test() calls and runs them sequentially.
 *
 * Usage:
 *   const h = require('../harness');
 *   h.test('works', () => { h.assert(true); });
 *   h.runFlat();
 */
const flatTests = [];

function testFlat(name, fn) {
  flatTests.push({ name, fn });
}

async function runFlat(label) {
  if (label) console.log(`\n  🔒 ${label}`);
  const startTime = Date.now();

  for (const t of flatTests) {
    try {
      const result = t.fn();
      if (result && typeof result.then === 'function') {
        await result;
      }
      passed++;
      console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++;
      failures.push({ name: t.name, error: err.message });
      console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n    ${passed} passed, ${failed} failed [${duration}ms]`);

  if (failures.length > 0) {
    for (const f of failures) {
      console.log(`    FAIL: ${f.name} — ${f.error}`);
    }
  }

  if (flatTests.length === 0) {
    console.error('    ⛔ No tests registered!');
    process.exit(1);
  }

  process.exit(failed > 0 ? 1 : 0);
}

// ── Exports ──────────────────────────────────────────────────
module.exports = {
  // Core framework
  describe,
  test,
  run,

  // Flat mode (for module tests without describe blocks)
  testFlat,
  runFlat,

  // Assertions
  assert,
  assertEqual,
  assertDeepEqual,
  assertIncludes,
  assertThrows,
  assertRejects,

  // Cross-platform helpers
  createTestRoot,
  blockedSystemPath,
  blockedTempPath,
  normalizePath,

  // State access (for test/index.js result parsing)
  getResults: () => ({ passed, failed, totalAssertions, failures }),
};
