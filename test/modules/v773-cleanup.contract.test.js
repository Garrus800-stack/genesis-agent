'use strict';

// ============================================================
// v7.7.3 — Cleanup release contract pins
//
// One file, eleven subtests covering the v7.7.3 changes:
//
//   A. audit-doc-drift refactor (header pattern + baselines)
//   B. 8 newly-pinned docs in audit-doc-drift scope
//   C. CSS dedicated badge classes for thinking/insight/resting
//   D. SKILL-SECURITY.md fs-drift fix
//   E. Version bump (retired in v7.7.4 — see comment near former E1)
//   F. Sandbox.allowedModules contains fs (anchor for SKILL-SEC pin)
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// ── A. audit-doc-drift refactor ─────────────────────────

test('A1: audit-doc-drift header-version check is pattern-only (not exact)', () => {
  const auditSrc = read('scripts/audit-doc-drift.js');
  assert.ok(/header-version-tag \(pattern\)/.test(auditSrc),
    'audit-doc-drift should label its check as "(pattern)"');
  assert.ok(/\/\^\\d\+\\\.\\d\+\\\.\\d\+\$\/\.test\(m\[1\]\)/.test(auditSrc),
    'audit-doc-drift should pattern-test the version, not exact-match');
  const patternLabelCount = (auditSrc.match(/\(pattern\)/g) || []).length;
  assert.ok(patternLabelCount >= 4,
    `expected ≥4 (pattern) labels, got ${patternLabelCount}`);
});

// A2 subtest below was retired in v7.7.7 — all three pinned constants
// became obsolete:
//
//   TESTS_WIN_BASELINE: 6917 → 6943 (post-v7.7.6 baseline)
//   TESTS_WIN:          6917 → 6943
//   TEST_FILES:         413 (literal) → dynamic (fs-based count at audit-time)
//
// The TEST_FILES change is structural: it closes the drift-blind tautology
// where the constant matched the doc only because both were pinned to the
// same number, and any added test file silently bypassed the audit. With
// dynamic counting the audit detects test-file additions/removals on its
// own.
//
// Stage-marker pins like these retire automatically when the next
// release ships (same pattern as v7.7.6 retiring v7.7.5's A1).
//
// test('A2: audit-doc-drift baselines match live values (6917 / 413)', () => {
//   ...
// });

// ── B. 8 newly-pinned docs ──────────────────────────────

test('B1: audit-doc-drift produces ≥ 53 checked doc claims', () => {
  const out = execSync('node scripts/audit-doc-drift.js --json', {
    cwd: ROOT, encoding: 'utf-8',
  });
  const data = JSON.parse(out);
  assert.ok(Array.isArray(data.checked), 'output has checked array');
  assert.ok(data.checked.length >= 53,
    `expected ≥ 53 doc claims, got ${data.checked.length}`);
});

test('B2: 8 newly-pinned docs each have at least one entry in audit-doc-drift', () => {
  const out = execSync('node scripts/audit-doc-drift.js --json', {
    cwd: ROOT, encoding: 'utf-8',
  });
  const data = JSON.parse(out);
  const docsCovered = new Set(data.checked.map(c => c.doc));
  const expected = [
    'BENCHMARKING.md', 'MCP-SERVER-SETUP.md', 'QUICK-START.md',
    'SETTINGS.md', 'SKILL-SECURITY.md', 'TROUBLESHOOTING.md',
    'phase9-cognitive-architecture.md', 'GATE-INVENTORY.md',
  ];
  for (const doc of expected) {
    assert.ok(docsCovered.has(doc),
      `${doc} must have at least one pin in audit-doc-drift`);
  }
});

test('B3: audit-doc-drift exits 0 in --strict mode (no drift)', () => {
  let exitCode = 0;
  try {
    execSync('node scripts/audit-doc-drift.js --strict', {
      cwd: ROOT, stdio: 'pipe',
    });
  } catch (err) {
    exitCode = err.status;
  }
  assert.strictEqual(exitCode, 0, 'strict mode exits 0 on clean repo');
});

// ── C. CSS dedicated badge classes ─────────────────────

test('C1: dedicated badge CSS classes exist (.badge-thinking/insight/resting)', () => {
  const css = read('src/ui/styles.css');
  assert.ok(/\.badge-thinking\s*\{/.test(css), '.badge-thinking class missing');
  assert.ok(/\.badge-insight\s*\{/.test(css), '.badge-insight class missing');
  assert.ok(/\.badge-resting\s*\{/.test(css), '.badge-resting class missing');
});

test('C2: STATE_TO_CSS maps thinking/insight/resting to dedicated classes', () => {
  const sb = read('src/ui/modules/statusbar.js');
  assert.ok(/thinking:\s*'thinking'/.test(sb),
    "thinking should map to 'thinking', not 'working'");
  assert.ok(/insight:\s*'insight'/.test(sb),
    "insight should map to 'insight', not 'ready'");
  assert.ok(/resting:\s*'resting'/.test(sb),
    "resting should map to 'resting', not 'ready'");
});

// ── D. SKILL-SECURITY.md fs-drift fix ─────────────────

test('D1: SKILL-SECURITY.md fs not in "Not available" section anymore', () => {
  const doc = read('docs/SKILL-SECURITY.md');
  const m = /### Not available[\s\S]*?(?=\n##|$)/.exec(doc);
  if (m) {
    assert.ok(!/`fs`/.test(m[0]),
      'fs must not be listed as "Not available" — it is path-restricted');
  }
});

test('D2: SKILL-SECURITY.md documents fs as path-restricted', () => {
  const doc = read('docs/SKILL-SECURITY.md');
  assert.ok(/`fs`[^|\n]*[Pp]ath-restricted/.test(doc),
    'fs should be documented with path-restriction note');
});

// ── E. Version bump ────────────────────────────────────

// E1 was: package.json version is 7.7.3 (v7.7.3 release pin). Retired
// in v7.7.4 — that release bumps the version to 7.7.4. The current
// version is pinned in `test/modules/v774-deps-upgrade.contract.test.js`
// subtest A1. Same pattern as v7.7.3 retiring v7.7.2's B3 — keeps the
// v7.7.x-by-x eras separate in the test history.

// ── F. Sandbox anchor (the pin's reference target) ────

test('F1: Sandbox.allowedModules contains fs (anchor for SKILL-SEC pin)', () => {
  const sandbox = read('src/agent/foundation/Sandbox.js');
  const m = /this\.allowedModules\s*=\s*new Set\(\[([\s\S]*?)\]\)/.exec(sandbox);
  assert.ok(m, 'allowedModules Set found in Sandbox.js');
  assert.ok(/'fs'/.test(m[1]),
    'fs must be in allowedModules — what the SKILL-SECURITY pin verifies');
});

// ── Result ────────────────────────────────────────

console.log('');
console.log(`    ${passed} passed · ${failed} failed · v7.7.3 cleanup contract`);
process.exit(failed > 0 ? 1 : 0);
