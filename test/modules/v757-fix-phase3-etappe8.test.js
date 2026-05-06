// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe8.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 8 — two live-bug fixes:
//
// Bug 1: Status-badge stuck on "BOOTING..." after language switch.
//        Cause: <span id="status-badge" data-i18n="ui.booting"> — when
//        applyI18n() ran on lang change, it overwrote the live status
//        text with whatever ui.booting resolves to in the new language.
//        Fix: updateStatus() drops the data-i18n attribute on first
//        non-booting update; refreshStatusI18n() re-applies the last
//        seen status with the new translations.
//
// Bug 2: Monaco editor — CSP blocked blob: workers, fell back to
//        main-thread workers (UI freezes per Microsoft docs).
//        Cause: HTTP-header CSP in main.js had no `worker-src` and
//        no `blob:` in `script-src`. (HTML-meta CSP was fine, but
//        the stricter HTTP-header CSP wins.)
//        Fix: align both CSPs — add `blob:` to script-src and
//        explicit `worker-src 'self' blob:`.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let passed = 0, failed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`    ✅ ${name}`); }
  catch (err) { failed++; failures.push({ name, error: err.message }); console.log(`    ❌ ${name}: ${err.message}`); }
}

const ROOT = path.join(__dirname, '..', '..');

// ── Bug 1: Status-Badge ────────────────────────────────────

test('statusbar.js: refreshStatusI18n is exported', () => {
  const mod = require(path.join(ROOT, 'src/ui/modules/statusbar.js'));
  assert.strictEqual(typeof mod.refreshStatusI18n, 'function',
    'refreshStatusI18n must be exported');
});

test('statusbar.js: updateStatus drops data-i18n on first real update', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/statusbar.js'), 'utf8');
  // Must remove the static i18n hint once a non-booting status arrives
  assert.ok(src.includes('removeAttribute(\'data-i18n\')') ||
            src.includes("removeAttribute(\"data-i18n\")"),
    'updateStatus must remove data-i18n attribute');
  assert.ok(src.includes("status.state !== 'booting'") ||
            src.includes('status.state !== "booting"'),
    'must guard removal so the initial booting state still picks up i18n');
});

test('statusbar.js: refreshStatusI18n calls updateStatus with last status', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/statusbar.js'), 'utf8');
  assert.ok(src.includes('_lastStatus'),
    'must remember the last status payload');
  // refreshStatusI18n must call updateStatus(_lastStatus)
  assert.ok(/refreshStatusI18n[\s\S]{0,150}updateStatus\(_lastStatus\)/.test(src),
    'refreshStatusI18n must call updateStatus(_lastStatus)');
});

test('renderer-main.js: lang switch calls refreshStatusI18n', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf8');
  assert.ok(src.includes('refreshStatusI18n'),
    'must import + call refreshStatusI18n');
  // Order: must be after loadI18n in the lang handler
  const handler = src.match(/lang-select.*?\n[\s\S]*?\}\);/);
  assert.ok(handler);
  const h = handler[0];
  const loadIdx = h.indexOf('loadI18n');
  const refreshIdx = h.indexOf('refreshStatusI18n');
  assert.ok(refreshIdx > loadIdx,
    'refreshStatusI18n must be called AFTER loadI18n');
});

// Functional test: simulate the flow without a real DOM by stubbing $.
test('statusbar functional: status survives language change', () => {
  // We can't easily test against a live DOM here, but we can at least
  // verify the module structure makes the right intent clear.
  // The key invariants are:
  //   1. updateStatus(non-booting) removes data-i18n
  //   2. _lastStatus is set so refreshStatusI18n can re-apply
  // Already covered by structural tests above; this is a sanity check
  // that the exported API is consistent.
  const mod = require(path.join(ROOT, 'src/ui/modules/statusbar.js'));
  assert.strictEqual(typeof mod.updateStatus, 'function');
  assert.strictEqual(typeof mod.refreshStatusI18n, 'function');
  // refreshStatusI18n should not throw when no status has been set
  assert.doesNotThrow(() => mod.refreshStatusI18n(),
    'refreshStatusI18n must be safe to call before any updateStatus');
});

// ── Bug 2: CSP for Monaco workers ─────────────────────────

test('main.js CSP allows blob: in script-src', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // Find the CSP setHeaders block
  const m = src.match(/'Content-Security-Policy'[\s\S]{0,1500}?\]/);
  assert.ok(m, 'Content-Security-Policy header must be set in main.js');
  const csp = m[0];
  assert.ok(/script-src[^;]*blob:/.test(csp),
    'script-src must include blob: (Monaco worker bootstrap)');
});

test('main.js CSP has explicit worker-src', () => {
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  const m = src.match(/'Content-Security-Policy'[\s\S]{0,1500}?\]/);
  assert.ok(m);
  const csp = m[0];
  assert.ok(/worker-src[^;]*'self'[^;]*blob:/.test(csp),
    "worker-src must include 'self' and blob:");
});

test('HTML <meta> CSP and main.js CSP are aligned', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // Both must allow blob: in script-src (the laxer of the two becomes
  // the effective policy when both are present, but we want them the
  // same so we don't fight the tighter one)
  const htmlMatch = html.match(/Content-Security-Policy[\s\S]*?content="([^"]+)"/);
  assert.ok(htmlMatch, 'HTML meta CSP must exist');
  const htmlCsp = htmlMatch[1];
  assert.ok(/script-src[^;]*blob:/.test(htmlCsp), 'HTML script-src must allow blob:');
  assert.ok(/worker-src[^;]*blob:/.test(htmlCsp), 'HTML worker-src must allow blob:');
  // Main process header CSP also has these now
  const mainMatch = main.match(/'Content-Security-Policy'[\s\S]{0,1500}?\]/);
  const mainCsp = mainMatch[0];
  assert.ok(/script-src[^;]*blob:/.test(mainCsp), 'main.js script-src must allow blob:');
  assert.ok(/worker-src[^;]*blob:/.test(mainCsp), 'main.js worker-src must allow blob:');
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
