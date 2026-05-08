'use strict';

// ============================================================
// v7.7.1 — File-Size-Guard UI extension contract test
//
// Pins the v7.7.1 extension of the architectural-fitness File-Size-Guard:
//   - check now walks both src/agent/ AND src/ui/
//   - settings.js is capped via FILE_SIZE_CAPS (cap-and-shrink pattern)
//   - cap violation FAILs the check, shrinkage is allowed
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const FITNESS_SCRIPT = path.join(ROOT, 'scripts', 'architectural-fitness.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

test('v7.7.1 File-Size-Guard scans src/ui/ in addition to src/agent/', () => {
  const src = fs.readFileSync(FITNESS_SCRIPT, 'utf-8');
  assert.match(src, /walkJs\(path\.join\(SRC,\s*['"]agent['"]\)\)/,
    'agent walk should still be present');
  assert.match(src, /walkJs\(path\.join\(SRC,\s*['"]ui['"]\)\)/,
    'v7.7.1: ui walk must be present');
});

test('v7.7.1 FILE_SIZE_CAPS contains settings.js with explicit cap', () => {
  const src = fs.readFileSync(FITNESS_SCRIPT, 'utf-8');
  assert.match(src, /FILE_SIZE_CAPS\s*=\s*\{[^}]*['"]settings\.js['"]\s*:\s*\d+/,
    'FILE_SIZE_CAPS must include settings.js with a numeric cap');
});

test('v7.7.1 cap violations are added to overFail', () => {
  const src = fs.readFileSync(FITNESS_SCRIPT, 'utf-8');
  assert.match(src, /capViolations\.push/,
    'cap violations must be tracked');
  assert.match(src, /overFail\.length\s*>\s*0\s*\|\|\s*capViolations\.length\s*>\s*0/,
    'cap violations must trigger fail status');
});

test('v7.7.1 thresholds remain at 700/900 LOC', () => {
  const src = fs.readFileSync(FITNESS_SCRIPT, 'utf-8');
  assert.match(src, /WARN_THRESHOLD\s*=\s*700/,
    'WARN threshold should remain 700');
  assert.match(src, /FAIL_THRESHOLD\s*=\s*900/,
    'FAIL threshold should remain 900');
});

test('v7.7.1 settings.js is the only currently-capped file', () => {
  const src = fs.readFileSync(FITNESS_SCRIPT, 'utf-8');
  const m = src.match(/const\s+FILE_SIZE_CAPS\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'FILE_SIZE_CAPS block must exist');
  const entries = m[1].match(/['"][^'"]+['"]\s*:\s*\d+/g) || [];
  assert.strictEqual(entries.length, 1,
    `v7.7.1 baseline: expect exactly 1 capped file, found ${entries.length}: ${entries.join(', ')}`);
  assert.match(entries[0], /settings\.js/, 'the one capped file must be settings.js');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.1 file-size-guard-ui`);
process.exit(failed > 0 ? 1 : 0);
