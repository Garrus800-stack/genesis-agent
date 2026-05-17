// ============================================================
// GENESIS — test/modules/v785-changelog-split.test.js (v7.8.5)
//
// changelog-split contract: CHANGELOG.md is now a slim index
// keeping only the newest release inline. Older releases live in
// per-major archive files. Genesis' ChatOrchestratorSourceRead
// must keep working: the newest "## [x.y.z]" header is at the
// top of CHANGELOG.md so its regex still finds the latest
// section.
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
const CHANGELOG = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf-8');

test('changelog-split contract: CHANGELOG.md is slim (under 400 lines)', () => {
  const lines = CHANGELOG.split('\n').length;
  assert.ok(lines < 400,
    `CHANGELOG.md must be a slim index after split — found ${lines} lines (limit 400)`);
});

test('changelog-split contract: CHANGELOG.md still contains a version header', () => {
  // ChatOrchestratorSourceRead._readChangelogLatestSection requires a
  // `## [x.y.z]` line at the top. If this regression triggers, Genesis
  // can no longer answer "was hat sich geändert" from disk.
  assert.match(CHANGELOG, /^## \[\d+\.\d+\.\d+/m,
    'CHANGELOG.md must contain at least one ## [x.y.z] header for Genesis to parse');
});

test('changelog-split contract: CHANGELOG.md contains exactly one version header (the newest)', () => {
  const matches = CHANGELOG.match(/^## \[\d+\.\d+\.\d+/gm) || [];
  assert.strictEqual(matches.length, 1,
    `CHANGELOG.md must contain exactly one version header (the newest). Found ${matches.length}.`);
});

test('changelog-split contract: per-major archives exist', () => {
  // v7.9.0: older archives (v5, v6, pre-v5) moved to docs/ for tidier root.
  // CHANGELOG-v7.md stays at root since v7 is the current active major.
  const rootArchives = ['CHANGELOG-v7.md'];
  const docsArchives = ['CHANGELOG-v6.md', 'CHANGELOG-v5.md', 'CHANGELOG-archive.md'];
  for (const f of rootArchives) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} must exist at root`);
  }
  for (const f of docsArchives) {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', f)), `docs/${f} must exist after move`);
  }
});

test('changelog-split contract: CHANGELOG.md indexes the archive files', () => {
  // v7.9.0: docs/-archives still need to be linked from CHANGELOG.md.
  const indexedTargets = [
    'CHANGELOG-v7.md',
    'docs/CHANGELOG-v6.md',
    'docs/CHANGELOG-v5.md',
    'docs/CHANGELOG-archive.md',
  ];
  for (const f of indexedTargets) {
    assert.ok(CHANGELOG.includes(f),
      `CHANGELOG.md index section must link to ${f}`);
  }
});

test('changelog-split contract: no duplicate version headers within any single archive', () => {
  const archivePaths = [
    'CHANGELOG-v7.md',
    'docs/CHANGELOG-v6.md',
    'docs/CHANGELOG-v5.md',
    'docs/CHANGELOG-archive.md',
  ];
  for (const f of archivePaths) {
    const content = fs.readFileSync(path.join(ROOT, f), 'utf-8');
    // Capture the full version expression between [ and ]
    const headers = (content.match(/^## \[[^\]]+\]/gm) || []).map(h => h.replace(/^## /, ''));
    const unique = new Set(headers);
    assert.strictEqual(headers.length, unique.size,
      `${f} contains duplicate version headers — split was not clean`);
  }
});

test('changelog-split contract: archive entries land in the right major file', () => {
  const v7 = fs.readFileSync(path.join(ROOT, 'CHANGELOG-v7.md'), 'utf-8');
  const v6 = fs.readFileSync(path.join(ROOT, 'docs', 'CHANGELOG-v6.md'), 'utf-8');
  // v7 archive must only contain v7.x.x headers
  const v7headers = v7.match(/^## \[(\d+)\./gm) || [];
  for (const h of v7headers) {
    assert.match(h, /^## \[7\./, `CHANGELOG-v7.md contains non-v7 header: ${h}`);
  }
  // v6 archive must only contain v6.x.x headers
  const v6headers = v6.match(/^## \[(\d+)\./gm) || [];
  for (const h of v6headers) {
    assert.match(h, /^## \[6\./, `CHANGELOG-v6.md contains non-v6 header: ${h}`);
  }
});

if (failed > 0) {
  console.log(`\n  ${failed} failure(s):`);
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
console.log(`    ${passed} passed`);
