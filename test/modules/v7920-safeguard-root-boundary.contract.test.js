'use strict';

// ============================================================
// v7.9.20 — SafeGuard root-boundary contract test
//
// Pins the v7.9.20 fix: validateWrite/validateRead compare the
// resolved path against rootDir WITH a trailing separator, so a
// sibling directory with a colliding prefix (<root>-evil/x) is
// rejected instead of passing the "inside project root" check.
// isProtected() already did this; the two write/read guards did not.
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const { SafeGuard } = require(path.join(ROOT, 'src', 'kernel', 'SafeGuard'));
const SAFEGUARD_SRC = fs.readFileSync(path.join(ROOT, 'src', 'kernel', 'SafeGuard.js'), 'utf-8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

const rootDir = path.resolve(path.sep + 'tmp', 'genesis-sg-root');
const guard = new SafeGuard([], rootDir);

test('validateWrite accepts a path inside the project root', () => {
  assert.strictEqual(guard.validateWrite(path.join(rootDir, 'src', 'x.js')), true);
});

test('validateRead accepts a path inside the project root', () => {
  assert.strictEqual(guard.validateRead(path.join(rootDir, 'src', 'x.js')), true);
});

test('validateWrite rejects a sibling dir with a colliding prefix', () => {
  assert.throws(() => guard.validateWrite(rootDir + '-evil' + path.sep + 'x.js'),
    /outside project root/, 'sibling-prefix write must be blocked');
});

test('validateRead rejects a sibling dir with a colliding prefix', () => {
  assert.throws(() => guard.validateRead(rootDir + '-evil' + path.sep + 'x.js'),
    /outside project root/, 'sibling-prefix read must be blocked');
});

test('validateWrite still rejects a clearly outside path', () => {
  assert.throws(() => guard.validateWrite(path.resolve(path.sep, 'etc', 'passwd')),
    /outside project root/);
});

test('source uses trailing-separator boundary compare in both guards', () => {
  const re = /resolved === this\.rootDir \|\| resolved\.startsWith\(this\.rootDir \+ path\.sep\)/g;
  const matches = SAFEGUARD_SRC.match(re) || [];
  assert.ok(matches.length >= 2, `expected >=2 trailing-sep compares, found ${matches.length}`);
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.9.20 safeguard-root-boundary`);
process.exit(failed > 0 ? 1 : 0);
