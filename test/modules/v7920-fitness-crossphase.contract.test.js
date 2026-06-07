'use strict';

// ============================================================
// v7.9.20 — Cross-Phase-Coupling check hardening contract test
//
// Source-introspection — the established pattern for fitness-check
// tests (e.g. v771-file-size-guard-ui): architectural-fitness.js has
// no module.exports, a hardcoded SRC path, and runs its whole suite
// at require-time, so the cross-phase logic cannot be unit-called with
// synthetic input. We pin the four v7.9.20 fixes in the source; the
// BEHAVIOUR (0 upward edges, score 127/130) is validated by the real
// subprocess run in release verification.
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'architectural-fitness.js'), 'utf-8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

test('Fix 1: cross-phase regex matches multi-level upward requires', () => {
  assert.ok(SRC.includes('(?:\\.\\.\\/)+'),
    'regex must use (?:\\.\\./)+ to catch ../../ multi-level edges');
});

test('Fix 2: PHASE_MAP includes agency at phase 10', () => {
  assert.ok(SRC.includes('agency: 10'),
    'agency must be a known phase so agency edges resolve to a phase number');
});

test('Fix 3: source guard uses === undefined, not falsy', () => {
  assert.ok(SRC.includes('PHASE_MAP[fromDir] === undefined'),
    'phase 0 (core) must be a valid source — the guard cannot use !PHASE_MAP[...]');
});

test('Fix 4: comments are stripped before edge matching', () => {
  assert.ok(SRC.includes('/\\/\\*[\\s\\S]*?\\*\\//g'),
    'block comments must be stripped (e.g. the Container.js DI doc-comment)');
  assert.ok(SRC.includes('/\\/\\/.*$/gm'),
    'line comments must be stripped');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.9.20 fitness-crossphase`);
process.exit(failed > 0 ? 1 : 0);
