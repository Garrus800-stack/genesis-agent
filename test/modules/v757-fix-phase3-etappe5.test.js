// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe5.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 5 — Bug-Fixes after live testing:
//   1. Duplicate modal-footer in bundled HTML (buttons rendering
//      outside the settings modal, visible under chat input)
//   2. Duplicate `ui.blocked` key in Language.js (en + de)
//   3. Settings.setBatch reference-equality bug for arrays/objects
//      (logged unchanged values: `[0 items] → [0 items]`)
//   4. Setting-hint font-size too small (10/11px → 12px)
//   5. Full i18n coverage — every settings label/hint/option in
//      en + de (Etappe-2 onwards), including JSON-Editor
//   6. Language.js parses cleanly with no duplicate keys
//      (esbuild would warn otherwise)
//   7. Symmetric en/de coverage — both blocks must contain the
//      same set of settings.* keys
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

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

// ── Fix 1: only ONE modal-footer in each HTML ──────────────

test('HTML: index.html has exactly one modal-footer', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const matches = html.match(/modal-footer/g) || [];
  assert.strictEqual(matches.length, 1,
    `expected exactly 1 modal-footer, found ${matches.length}`);
});

test('HTML: index.html has exactly one modal-footer', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const matches = html.match(/modal-footer/g) || [];
  assert.strictEqual(matches.length, 1,
    `expected exactly 1 modal-footer, found ${matches.length}`);
});

test('HTML: only one toast-container in bundled (no duplicate)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const matches = html.match(/toast-container/g) || [];
  assert.strictEqual(matches.length, 1,
    `expected exactly 1 toast-container, found ${matches.length}`);
});

// ── Fix 2: no duplicate keys in Language.js ────────────────

test('Language.js: no duplicate keys in any language block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf8');
  for (const lang of ['en', 'de', 'fr', 'es']) {
    const m = src.match(new RegExp('^  ' + lang + ': \\{([\\s\\S]*?)^  \\},', 'm'));
    assert.ok(m, `${lang} block must exist`);
    const block = m[1];
    const keys = block.match(/'[^']+':/g) || [];
    const seen = new Set();
    const dups = [];
    for (const k of keys) {
      if (seen.has(k)) dups.push(k);
      seen.add(k);
    }
    assert.deepStrictEqual(dups, [],
      `${lang} has duplicate keys: ${dups.join(', ')}`);
  }
});

test('Language.js: parses as a Node module (no syntax errors)', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  assert.ok(lang.Language);
  assert.ok(lang.STRINGS);
  assert.ok(lang.STRINGS.en);
  assert.ok(lang.STRINGS.de);
});

test('Language.js: en/de have symmetric settings.* coverage', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  const en = Object.keys(lang.STRINGS.en).filter(k => k.startsWith('settings.'));
  const de = Object.keys(lang.STRINGS.de).filter(k => k.startsWith('settings.'));
  const enSet = new Set(en);
  const deSet = new Set(de);
  const onlyEn = en.filter(k => !deSet.has(k));
  const onlyDe = de.filter(k => !enSet.has(k));
  assert.deepStrictEqual(onlyEn, [], `keys only in en: ${onlyEn.slice(0, 5).join(', ')}`);
  assert.deepStrictEqual(onlyDe, [], `keys only in de: ${onlyDe.slice(0, 5).join(', ')}`);
});

// ── Fix 3: Settings.setBatch deep-equality ─────────────────

test('Settings.setBatch: arrays with same content do not log change', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings.js'));
  const tmpDir = path.join(ROOT, '.test-settings-e5-' + Date.now());
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const settings = new Settings(tmpDir);
    settings.set('mcp.servers', [{ name: 'a', url: 'b' }]);
    const changes = settings.setBatch([
      ['mcp.servers', [{ name: 'a', url: 'b' }]],
    ]);
    assert.strictEqual(changes.length, 0,
      'identical array contents should not log a change');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Settings.setBatch: arrays with different content DO log change', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings.js'));
  const tmpDir = path.join(ROOT, '.test-settings-e5b-' + Date.now());
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const settings = new Settings(tmpDir);
    settings.set('mcp.servers', [{ name: 'a', url: 'b' }]);
    const changes = settings.setBatch([
      ['mcp.servers', [{ name: 'a', url: 'b' }, { name: 'c', url: 'd' }]],
    ]);
    assert.strictEqual(changes.length, 1, 'real array change must log');
    assert.strictEqual(changes[0].key, 'mcp.servers');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

test('Settings.setBatch: empty arrays staying empty does not log', () => {
  const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings.js'));
  const tmpDir = path.join(ROOT, '.test-settings-e5c-' + Date.now());
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    const settings = new Settings(tmpDir);
    settings.set('models.openaiModels', []);
    const changes = settings.setBatch([
      ['models.openaiModels', []],
    ]);
    assert.strictEqual(changes.length, 0,
      '[0 items] → [0 items] must not log');
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
});

// ── Fix 4: hint font sizes ─────────────────────────────────

test('CSS: setting-hint and setting-default-hint at 12px', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  const m1 = css.match(/\.setting-hint \{[^}]*font-size:\s*(\d+)px/);
  assert.ok(m1, 'setting-hint must have font-size');
  assert.ok(parseInt(m1[1]) >= 12,
    `setting-hint should be >= 12px, found ${m1[1]}px`);
  const m2 = css.match(/\.setting-default-hint \{[^}]*font-size:\s*(\d+)px/);
  assert.ok(m2, 'setting-default-hint must have font-size');
  assert.ok(parseInt(m2[1]) >= 12,
    `setting-default-hint should be >= 12px, found ${m2[1]}px`);
});

// ── Fix 5: i18n coverage on important Etappe-2/3/4 keys ────

test('Language.js: Etappe-5 i18n keys present in en + de', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  const required = [
    'settings.tab.models', 'settings.tab.behavior', 'settings.tab.limits',
    'settings.tab.mcp', 'settings.tab.advanced', 'settings.tab.json',
    'settings.maxconcurrent.label', 'settings.maxconcurrent.hint',
    'settings.cost_guard.enabled.hint', 'settings.commit_shutdown.hint',
    'settings.autoroute.hint', 'settings.fallback_chain',
    'settings.json.title', 'settings.json.help',
  ];
  // For these keys, we expect at least ONE that translates differently
  // (some words like "MCP", "Limits" are technical and identical in both).
  let translatedCount = 0;
  for (const k of required) {
    assert.ok(lang.STRINGS.en[k], `EN missing: ${k}`);
    assert.ok(lang.STRINGS.de[k], `DE missing: ${k}`);
    if (lang.STRINGS.en[k] !== lang.STRINGS.de[k]) translatedCount++;
  }
  // At least 80% of required keys should differ between en and de
  assert.ok(translatedCount >= Math.floor(required.length * 0.8),
    `expected >= ${Math.floor(required.length * 0.8)} translated, got ${translatedCount}/${required.length}`);
});

test('HTML: all data-i18n attributes have matching keys in Language.js', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const matches = [...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]);
  const missing = matches.filter(k =>
    !lang.STRINGS.en[k] || !lang.STRINGS.de[k]
  );
  assert.deepStrictEqual(missing.slice(0, 10), [],
    `HTML uses keys missing from en/de: ${missing.slice(0, 10).join(', ')}`);
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
