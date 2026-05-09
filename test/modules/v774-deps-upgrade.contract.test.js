'use strict';

// ============================================================
// v7.7.4 — Dependency security upgrade contract pins
//
// One file, six subtests covering the v7.7.4 dependency bumps:
//
//   A. package.json bumps
//      A1. version is 7.7.4
//      A2. electron range >= ^42 (was ^33, EOL since ~2024)
//      A3. monaco-editor range >= ^0.55 (was ^0.52)
//   B. Code-level drift fixes
//      B1. monaco CDN fallback path matches a current major (not 0.44 stale)
//   C. No regression of v7.7.3 audit pins
//      C1. audit-doc-drift still produces ≥ 53 checked claims
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

// ── A. package.json bumps ──────────────────────────────

// A1 was: package.json version is 7.7.4 (v7.7.4 release pin). Retired
// in v7.7.5 — that release bumps the version to 7.7.5. The current
// version is pinned in `test/modules/v775-monaco-esm.contract.test.js`
// subtest A1. Same retirement pattern as v7.7.4 retiring v7.7.3's E1
// (which retired v7.7.2's B3) — keeps the v7.7.x-by-x eras separate
// in the test history.

test('A2: electron dep range targets v42 or newer (EOL escape from v33)', () => {
  const pkg = JSON.parse(read('package.json'));
  const range = pkg.devDependencies?.electron || pkg.dependencies?.electron;
  assert.ok(range, 'electron dep must be present');
  // Accept ^42, ^43, ~42.x, >=42, etc. — anything that resolves to v42+
  const major = /\^?(\d+)/.exec(range);
  assert.ok(major && parseInt(major[1], 10) >= 42,
    `electron range must target ≥ v42, got "${range}"`);
});

test('A3: monaco-editor dep range targets 0.55 or newer (was 0.52)', () => {
  const pkg = JSON.parse(read('package.json'));
  const range = pkg.dependencies?.['monaco-editor'] || pkg.devDependencies?.['monaco-editor'];
  assert.ok(range, 'monaco-editor dep must be present');
  // Match ^0.55.x, ~0.55.0, >=0.55, etc.
  const m = /\^?(\d+)\.(\d+)/.exec(range);
  assert.ok(m, `unparseable monaco-editor range: "${range}"`);
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  assert.ok(major > 0 || (major === 0 && minor >= 55),
    `monaco-editor range must target ≥ 0.55, got "${range}"`);
});

// ── B. Code-level drift fixes ─────────────────────────

// B1 was: monaco CDN fallback path is not stuck at 0.44 (versions-drift fix).
// Retired in v7.7.5 — that release migrates Monaco from CDN to local ESM
// bundle. There is no CDN fallback path anymore (no cdnjs anywhere). The
// equivalent v7.7.5 pin is in `v775-monaco-esm.contract.test.js` subtest C1
// (no cdnjs.cloudflare.com refs in index.html). Same retirement pattern as
// v7.7.4 retiring v7.7.3's E1 — keeps the v7.7.x-by-x eras separate.

test('B2: HTTP-header CSP allows data: in font-src (Monaco 0.55+ codicons)', () => {
  // Monaco 0.55+ embeds codicon glyphs as data: TTF URIs. Pre-v7.7.4
  // the HTTP-header CSP from main.js had `font-src 'self' cdnjs` only,
  // while the HTML-meta CSP already permitted `data:`. Aligned them.
  // Same drift pattern as the v7.5.7 Monaco blob: worker fix.
  const mainJs = read('main.js');
  const cspBlock = /Content-Security-Policy[\s\S]*?\]/.exec(mainJs);
  assert.ok(cspBlock, 'CSP block found in main.js');
  const fontSrcMatch = /font-src ([^;]+);/.exec(cspBlock[0]);
  assert.ok(fontSrcMatch, 'font-src directive present in CSP');
  assert.ok(/\bdata:/.test(fontSrcMatch[1]),
    `font-src must permit data: for Monaco codicons, got "${fontSrcMatch[1].trim()}"`);
});

// ── C. No regression of v7.7.3 audit pins ─────────────

test('C1: audit-doc-drift still produces ≥ 53 checked claims (no v7.7.3 regression)', () => {
  const out = execSync('node scripts/audit-doc-drift.js --json', {
    cwd: ROOT, encoding: 'utf-8',
  });
  const data = JSON.parse(out);
  assert.ok(Array.isArray(data.checked));
  assert.ok(data.checked.length >= 53,
    `expected ≥ 53 doc claims, got ${data.checked.length}`);
});

// ── Result ────────────────────────────────────────

console.log('');
console.log(`    ${passed} passed · ${failed} failed · v7.7.4 dependency upgrade contract`);
process.exit(failed > 0 ? 1 : 0);
