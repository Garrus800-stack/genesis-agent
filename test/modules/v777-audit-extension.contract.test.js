// v7.7.7 — Audit extension release contract
//
// Background: v7.7.6 was followed by a full codebase audit (28 categories,
// 904 files). Findings clustered in three areas:
//
//   - Doc-drift: GATE-INVENTORY claimed "9 SECURITY_REQUIRED_SLASH" while
//     the actual Set held 12; CAPABILITIES + ARCHITECTURE-DEEP-DIVE +
//     README + banner.svg held stale test-stats from v7.7.2 baseline
//     (413 / 6917 instead of 417 / 6943)
//   - Two LOW-severity code findings: EffectorRegistry exec-with-string-
//     interpolation in headless-fallback (better as execFile with array-
//     args), AgentLoopSteps regex with quadratic backtracking potential
//     on pathological inputs (length-guard sufficient to neutralise)
//   - Drift-blind audit: audit-doc-drift had TEST_FILES = 413 as a literal
//     constant matching the doc literal — any new test file would slip
//     through silently. v7.7.7 makes TEST_FILES dynamic
//
// All findings have been addressed without runtime semantic changes.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function track(name, fn) {
  return test(name, async (t) => {
    try { await fn(t); passed++; }
    catch (e) { failed++; throw e; }
  });
}

// ── A1: package.json version is 7.7.7 ────────────────────────

track('A1: package.json version is 7.7.7', () => {
  assert.strictEqual(pkg.version, '7.7.7',
    `package.json version must be 7.7.7, got ${pkg.version}`);
});

// ── A2: GATE-INVENTORY says 12 SECURITY_REQUIRED_SLASH ───────

track('A2: GATE-INVENTORY.md claims 12 SECURITY_REQUIRED_SLASH', () => {
  const src = read('docs/GATE-INVENTORY.md');
  assert.ok(/12 SECURITY_REQUIRED_SLASH/.test(src),
    'GATE-INVENTORY.md should claim "12 SECURITY_REQUIRED_SLASH"');
  assert.ok(!/9 SECURITY_REQUIRED_SLASH/.test(src),
    'GATE-INVENTORY.md should no longer claim "9 SECURITY_REQUIRED_SLASH"');
});

// ── A3: AUDIT-BACKLOG slash-discipline entry uses 12 ────────

track('A3: AUDIT-BACKLOG.md slash-discipline entry uses 12 (not 9)', () => {
  const src = read('AUDIT-BACKLOG.md');
  assert.ok(/4 of the 12 SECURITY_REQUIRED_SLASH/.test(src),
    'AUDIT-BACKLOG should say "4 of the 12 SECURITY_REQUIRED_SLASH"');
  assert.ok(!/4 of the 9 SECURITY_REQUIRED_SLASH/.test(src),
    'AUDIT-BACKLOG should no longer say "4 of the 9"');
});

// ── A4: docs claim updated test-stats baseline ──────────────

track('A4: docs claim 418 test files / 6943 tests (post-v7.7.7 stats)', () => {
  const cap = read('docs/CAPABILITIES.md');
  assert.ok(/418 test files/.test(cap),
    'CAPABILITIES.md should claim "418 test files"');
  assert.ok(/6943 tests/.test(cap),
    'CAPABILITIES.md should claim "6943 tests"');
  const adv = read('docs/ARCHITECTURE-DEEP-DIVE.md');
  assert.ok(/418 \/ 6943/.test(adv),
    'ARCHITECTURE-DEEP-DIVE.md should claim "418 / 6943"');
});

// ── A5a: TEST_FILES is dynamic in audit-doc-drift ───────────

track('A5a: audit-doc-drift TEST_FILES is dynamic (no literal `= 413`)', () => {
  const src = read('scripts/audit-doc-drift.js');
  // Must not be a literal assignment any more
  assert.ok(!/TEST_FILES\s*=\s*\d+/.test(src),
    'TEST_FILES should no longer be a literal numeric constant');
  // Must use a dynamic counting function (IIFE or named getter)
  assert.ok(/TEST_FILES\s*=\s*\(?\s*function/.test(src) ||
            /TEST_FILES\s*=\s*countTestFiles/.test(src),
    'TEST_FILES should be assigned from a dynamic counting function');
});

// ── A5b: TESTS_WIN constants bumped to 6943 ─────────────────

track('A5b: audit-doc-drift TESTS_WIN === 6943', () => {
  const src = read('scripts/audit-doc-drift.js');
  assert.ok(/TESTS_WIN\s*=\s*6943/.test(src),
    'TESTS_WIN should be 6943');
  assert.ok(/TESTS_WIN_BASELINE\s*=\s*6943/.test(src),
    'TESTS_WIN_BASELINE should be 6943');
});

// ── B1: EffectorRegistry uses execFile (not exec-with-string) ─

track('B1: EffectorRegistry headless-fallback uses execFile (no exec-string)', () => {
  const src = read('src/agent/capabilities/EffectorRegistry.js');
  // The old exec(cmd) string-interpolation pattern must be gone
  assert.ok(!/const cmd\s*=.*\$\{url\}/s.test(src),
    'EffectorRegistry should no longer build a shell-string with ${url}');
  // execFile must be in use
  assert.ok(/execFile\([^,]+,\s*\[/.test(src),
    'EffectorRegistry should use execFile(bin, [args])');
});

// ── B3: AgentLoopSteps has length-guard before regex match ──

track('B3: AgentLoopSteps shell-arg parser has length-guard', () => {
  const src = read('src/agent/revolution/AgentLoopSteps.js');
  assert.ok(/command\.length\s*>\s*\d+/.test(src),
    'AgentLoopSteps should have a length-guard before the regex match');
});

// ── D1: audit-doc-drift baseline ≥ 55 claims ────────────────

track('D1: audit-doc-drift produces ≥ 55 strict-checked doc claims', () => {
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', ['scripts/audit-doc-drift.js', '--strict'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const m = output.match(/(\d+)\s+(?:doc\s+)?claims?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    assert.ok(n >= 55,
      `audit-doc-drift expected ≥ 55 claims (was 54 in v7.7.6, +1 for SECURITY_REQUIRED_SLASH PIN), got ${n}`);
  } else {
    assert.strictEqual(result.status, 0,
      `audit-doc-drift --strict failed (exit ${result.status}):\n${output}`);
  }
});

// ── Done ─────────────────────────────────────────────────────

process.on('exit', () => {
  console.log('');
  console.log(`    ${passed} passed${failed > 0 ? ` · ${failed} failed` : ''} · v7.7.7 audit extension contract`);
});
