'use strict';

// ============================================================
// v7.7.1 — Script-header anti-drift contract
//
// In v7.7.1, ~30 script-header version stamps (e.g.
// `// GENESIS — scripts/foo.js (v7.5.7)`) were removed because they
// drifted independently of the actual evolution of each script.
// The standardized form is:
//   // GENESIS — scripts/foo.js
// (no version stamp; CHANGELOG is the source of evolution history).
//
// Exception: scripts whose version is part of their identity
// (e.g. diagnose-v741-d0.js for a v7.4.1-specific diagnostic).
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPTS_DIR = path.join(ROOT, 'scripts');

const STAMPED_HEADER = /^\/\/\s*GENESIS\s*[—-]\s*[^()\n]+\s*\(v\d+\.\d+\.\d+/m;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

function listScripts() {
  return fs.readdirSync(SCRIPTS_DIR)
    .filter(f => f.endsWith('.js'))
    .filter(f => !/diagnose-v\d+/.test(f));
}

test('v7.7.1 B8: no scripts/*.js header has a version stamp', () => {
  const scripts = listScripts();
  const stamped = [];
  for (const f of scripts) {
    const head = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf-8')
      .split('\n').slice(0, 6).join('\n');
    if (STAMPED_HEADER.test(head)) {
      stamped.push(f);
    }
  }
  assert.deepStrictEqual(stamped, [],
    `Scripts with header version stamps (drift-prone, should be removed): ${stamped.join(', ')}`);
});

test('v7.7.1 B8: audit-doc-drift includes the script-header anti-drift check', () => {
  const audit = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-doc-drift.js'), 'utf-8');
  assert.match(audit, /scripts\/\*\.js/,
    'audit-doc-drift must reference scripts/*.js as a doc-target');
  assert.match(audit, /header version stamps/,
    'audit-doc-drift must label the anti-drift check');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.1 script-headers-clean`);
process.exit(failed > 0 ? 1 : 0);
