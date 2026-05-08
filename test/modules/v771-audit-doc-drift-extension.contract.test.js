'use strict';

// ============================================================
// v7.7.1 — audit-doc-drift extension contract
//
// Pins:
//   - audit-doc-drift now covers >= 53 claims (was 40 in v7.7.0)
//   - the new check categories from v7.7.1 are present in the script
// ============================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const AUDIT = path.join(ROOT, 'scripts', 'audit-doc-drift.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

test('v7.7.1 audit-doc-drift JSON output reports >= 53 checked claims', () => {
  const out = execFileSync('node', [AUDIT, '--json'], { encoding: 'utf-8' });
  const data = JSON.parse(out);
  assert.ok(Array.isArray(data.checked),
    'audit JSON must contain a "checked" array');
  assert.ok(data.checked.length >= 53,
    `v7.7.1: expect >= 53 doc claims, got ${data.checked.length}`);
});

test('v7.7.1 audit-doc-drift exits 0 in --strict on a clean repo', () => {
  let exitCode = 0;
  try {
    execFileSync('node', [AUDIT, '--strict'], { stdio: 'pipe' });
  } catch (err) {
    exitCode = err.status;
  }
  assert.strictEqual(exitCode, 0,
    'v7.7.1 baseline: audit-doc-drift --strict must pass');
});

test('v7.7.1 source-presence: new check categories exist in audit script', () => {
  const src = fs.readFileSync(AUDIT, 'utf-8');
  assert.match(src, /header version stamp/, 'ARCHITECTURE.md header check missing');
  assert.match(src, /header catalogued events/, 'ARCHITECTURE.md events check missing');
  assert.match(src, /Current stats events/, 'ARCHITECTURE.md inline stats check missing');
  assert.match(src, /Key Numbers Source Modules/, 'DEEP-DIVE Source Modules check missing');
  assert.match(src, /Key Numbers Test Files/, 'DEEP-DIVE Test Files check missing');
  assert.match(src, /Key Numbers npm Dependencies/, 'DEEP-DIVE npm deps check missing');
  assert.match(src, /test files row/, 'CAPABILITIES test files row check missing');
  assert.match(src, /event types baseline/, 'COMMUNICATION baseline check missing');
  assert.match(src, /MCP-SERVER-SETUP\.md/, 'MCP-SERVER-SETUP check missing');
  assert.match(src, /AUDIT-BACKLOG\.md/, 'AUDIT-BACKLOG check missing');
  assert.match(src, /supported versions Active row/, 'SECURITY versions check missing');
  assert.match(src, /Node version requirement/, 'README Node version check missing');
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.1 audit-doc-drift extension`);
process.exit(failed > 0 ? 1 : 0);
