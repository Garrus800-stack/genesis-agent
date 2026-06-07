'use strict';

// ============================================================
// v7.9.20 — audit-doc-drift README-pin extension contract test
//
// Pins that audit-doc-drift.js now also pins README.md's OWN copies of the
// test-file count and the dependency row. Before v7.9.20 only the
// ARCHITECTURE-DEEP-DIVE / CAPABILITIES copies and the README shields.io
// badges were pinned, so the README stats-table rows could drift on their own.
// Source-introspection, per the v771-audit-doc-drift-extension precedent.
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-doc-drift.js'), 'utf-8');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

test('README test-file count is pinned as its own check', () => {
  assert.ok(SRC.includes("'Test suites file count'"),
    'a check labelled "Test suites file count" must exist');
  assert.ok(SRC.includes('Test suites\\s*\\|\\s*(\\d+)\\s*files'),
    'the README Test-suites file-count regex must be present');
});

test('README dependency row is pinned as its own check', () => {
  assert.ok(SRC.includes("'Dependencies row'"),
    'a check labelled "Dependencies row" must exist');
  assert.ok(SRC.includes('Dependencies\\s*\\|\\s*([^|]+?)'),
    'the README Dependencies-row regex must be present');
});

test('both new pins target README.md and are wired into drifts', () => {
  assert.ok(SRC.includes("check('README.md', readme"),
    'the new checks must run against README.md content');
  assert.ok(SRC.includes('drifts.push(rRTF)') && SRC.includes('drifts.push(rRD)'),
    'both new check results must be pushed into the drifts list');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.9.20 audit-doc-drift-readme-pins`);
process.exit(failed > 0 ? 1 : 0);
