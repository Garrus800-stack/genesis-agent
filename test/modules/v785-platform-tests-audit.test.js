// ============================================================
// GENESIS — test/modules/v785-platform-tests-audit.test.js (v7.8.5)
//
// platform-tests-audit contract: scripts/audit-platform-tests.js
// reports which test sub-blocks skip themselves based on
// process.platform. Replaces pattern-matched test-count
// estimates with measured data.
// ============================================================

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}

const ROOT = path.join(__dirname, '..', '..');
const audit = require(path.join(ROOT, 'scripts/audit-platform-tests'));

test('platform-tests-audit contract: classifySkip distinguishes pure from conditional', () => {
  const pure = audit.classifySkip("process.platform === 'win32'");
  assert.strictEqual(pure.kind, 'pure');
  assert.deepStrictEqual(pure.skipsOn, ['win32']);

  const conditional = audit.classifySkip("someFlag && process.platform === 'linux'");
  assert.strictEqual(conditional.kind, 'conditional');
});

test('platform-tests-audit contract: classifySkip handles inverted match (!==)', () => {
  // `if (process.platform !== 'win32') return` skips on linux + darwin
  const inv = audit.classifySkip("process.platform !== 'win32'");
  assert.strictEqual(inv.kind, 'pure');
  assert.ok(inv.skipsOn.includes('linux'));
  assert.ok(inv.skipsOn.includes('darwin'));
  assert.ok(!inv.skipsOn.includes('win32'));
});

test('platform-tests-audit contract: classifySkip returns null when no platform pattern', () => {
  assert.strictEqual(audit.classifySkip("someUnrelatedCondition"), null);
});

test('platform-tests-audit contract: buildMatrix produces a summary with numeric counts', () => {
  const result = audit.buildMatrix();
  assert.ok(result.summary, 'must have summary');
  assert.strictEqual(typeof result.summary.pureSkipsOnWin32, 'number');
  assert.strictEqual(typeof result.summary.pureSkipsOnLinux, 'number');
  assert.strictEqual(typeof result.summary.pureSkipsOnDarwin, 'number');
  assert.strictEqual(typeof result.summary.linuxTestCountDeltaFromWin32, 'number');
});

test('platform-tests-audit contract: baseline JSON snapshot exists and has shape', () => {
  const p = path.join(ROOT, 'scripts/platform-tests-baseline.json');
  assert.ok(fs.existsSync(p), 'baseline JSON must exist');
  const b = JSON.parse(fs.readFileSync(p, 'utf-8'));
  assert.ok(b.generated, 'baseline must record generation timestamp');
  assert.ok(b.summary, 'baseline must include summary');
  assert.ok(Array.isArray(b.files), 'baseline must include files array');
});

test('platform-tests-audit contract: known v759-linux-open skip is detected', () => {
  // v759-linux-open.test.js has a `if (process.platform === 'win32') return;`
  // at L101 ("Fix 3: Linux probe uses both command -v AND which"). If this
  // assertion ever fails it means the scanner is broken — not that the test
  // moved (the test name is allowed to change, but the file's first pure
  // skip should still be detected).
  const result = audit.buildMatrix();
  const linuxOpen = result.matrix.find(e => /v759-linux-open\.test\.js/.test(e.file));
  assert.ok(linuxOpen, 'v759-linux-open.test.js must appear in matrix');
  const purePlatformWin = linuxOpen.findings.find(f => f.kind === 'pure' && f.skipsOn.includes('win32'));
  assert.ok(purePlatformWin, 'at least one pure win32 skip must be detected in v759-linux-open');
});

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
