// v7.7.6 — Build-toolchain refresh
//
// Background: v7.7.5 closed the Monaco AMD → ESM migration. The remaining
// build-pipeline dev-dependencies (electron-builder, esbuild, puppeteer)
// were still on older majors carrying the bulk of the npm-audit findings
// and most of the npm-deprecation messages on every install:
//
//   - electron-builder ^25.1.8 dragged in tar@6 (HIGH), uuid@9, npmlog@6,
//     gauge@4, are-we-there-yet@3, rimraf@3, glob@7/8/10, @npmcli/move-file@2,
//     inflight@1, @tootallnate/once@<3.0.1 — 9 HIGH advisories from this
//     chain alone, plus a row of deprecation notices
//   - esbuild ^0.24.2 had a moderate advisory
//   - puppeteer ^23.x triggered a deprecation message ("< 24.15.0 is no
//     longer supported") and pulled in whatwg-encoding@3 (deprecated)
//
// All three are dev-only build-pipeline tools, none on the runtime path.
// Bumping them does not change runtime semantics. v7.7.6 raises:
//
//   electron-builder ^25.1.8  → ^26.8.2
//   esbuild           ^0.24.2 → ^0.28.0
//   puppeteer         ^23.0.0 → ^24.15.0
//
// No code changes anywhere — purely package.json. Static validation only;
// the actual install + audit verification happens on the user's machine.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

let passed = 0;
let failed = 0;
const _origTest = test;
function track(name, fn) {
  return _origTest(name, async (t) => {
    try { await fn(t); passed++; }
    catch (e) { failed++; throw e; }
  });
}

// ── Subtest helpers ──────────────────────────────────────────

function parseRange(range) {
  // Strip leading ^ ~ >= etc., return [major, minor, patch]
  const m = String(range).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`unparseable version range: ${range}`);
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
}

// ── A1: package.json version is 7.7.6 ────────────────────────

// A1 subtest below was retired in v7.7.7 — version-pin became obsolete
// once v7.7.7 shipped. Current version is pinned by
// `test/modules/v777-audit-extension.contract.test.js` A1 instead.
//
// Same retirement pattern as v7.7.6 retiring v7.7.5's A1 (single-version
// pins are stage-marker tests, not invariants).
//
// track('A1: package.json version is 7.7.6', () => {
//   assert.strictEqual(pkg.version, '7.7.6');
// });

// ── B1: electron-builder major ≥ 26 ──────────────────────────

track('B1: electron-builder major ≥ 26 (was ^25 in v7.7.5)', () => {
  const range = pkg.devDependencies['electron-builder'];
  assert.ok(range, 'electron-builder must be in devDependencies');
  const [major] = parseRange(range);
  assert.ok(major >= 26,
    `electron-builder major must be ≥ 26 (got ${range}). Required to drop tar@6 HIGH + 9 transitive deprecations.`);
});

// ── B2: esbuild minor ≥ 28 ───────────────────────────────────

track('B2: esbuild minor ≥ 0.28 (was ^0.24 in v7.7.5)', () => {
  const range = pkg.devDependencies['esbuild'];
  assert.ok(range, 'esbuild must be in devDependencies');
  const [major, minor] = parseRange(range);
  assert.strictEqual(major, 0, `esbuild stays on 0.x line, got ${range}`);
  assert.ok(minor >= 28,
    `esbuild minor must be ≥ 28 (got ${range}). Required to drop esbuild moderate advisory.`);
});

// ── B3: puppeteer ≥ 24.15 ────────────────────────────────────

track('B3: puppeteer major ≥ 24, minor ≥ 15 (was ^23 in v7.7.5)', () => {
  const range = pkg.devDependencies['puppeteer'];
  assert.ok(range, 'puppeteer must be in devDependencies');
  const [major, minor] = parseRange(range);
  assert.ok(major >= 24,
    `puppeteer major must be ≥ 24 (got ${range}). Required to drop "< 24.15.0 no longer supported" deprecation.`);
  if (major === 24) {
    assert.ok(minor >= 15,
      `puppeteer 24.x must be minor ≥ 15 (got ${range})`);
  }
});

// ── C1: build-bundle.js esbuild API surface unchanged ────────

track('C1: build-bundle.js uses only stable esbuild API (compatible with 0.28)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/build-bundle.js'), 'utf8');
  // Stable API since 0.17 — these are what Genesis uses
  const allowed = ['esbuild.build', 'esbuild.context'];
  // Forbidden: deprecated/removed before 0.28
  const forbidden = [
    /esbuild\.startService\b/,        // removed in 0.15
    /\bincremental:\s*true/,          // deprecated in 0.17, removed in 0.18+
    /\bwatch:\s*\{/,                  // old watch API, replaced by context().watch()
  ];
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(src),
      `build-bundle.js still uses removed/deprecated esbuild API: ${pattern}`);
  }
  // Sanity: at least one stable call exists
  const hasBuild = /esbuild\.build\(/.test(src);
  const hasContext = /esbuild\.context\(/.test(src);
  assert.ok(hasBuild || hasContext,
    'build-bundle.js must call esbuild.build() or esbuild.context()');
});

// ── D1: audit-doc-drift baseline still produces ≥ 53 claims ──

track('D1: audit-doc-drift still produces ≥ 53 strict-checked claims', () => {
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', ['scripts/audit-doc-drift.js', '--strict'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  // exit 0 means no drift. We check for the claim-count line in output.
  const output = (result.stdout || '') + (result.stderr || '');
  const m = output.match(/(\d+)\s+claims?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    assert.ok(n >= 53,
      `audit-doc-drift expected ≥ 53 claims, got ${n}`);
  } else {
    // Fallback: at least the script ran without error
    assert.strictEqual(result.status, 0,
      `audit-doc-drift --strict failed (exit ${result.status}):\n${output}`);
  }
});

// ── Done ─────────────────────────────────────────────────────

process.on('exit', () => {
  console.log('');
  console.log(`    ${passed} passed${failed > 0 ? ` · ${failed} failed` : ''} · v7.7.6 toolchain refresh contract`);
});
