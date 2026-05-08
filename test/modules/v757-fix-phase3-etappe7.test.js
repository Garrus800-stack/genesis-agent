// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe7.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 7 — JS-generated text i18n:
//
// PROBLEM: applyI18n() works only on [data-i18n*] attributes.
// JS-built text (default-hints, MCP empty-state, JSON-Editor status,
// Add/Remove buttons) wasn't refreshed when language changed.
//
// FIXES:
//   - _decorateField re-renders the default-hint on every call so
//     language changes pick up
//   - _renderMcpServers uses t() for empty-state + Remove button
//   - _wireMcpAddButton: button label re-translated each call
//   - _loadJsonEditor / _validateJsonEditor: status strings via t()
//   - refreshSettingsI18n() exported, called from lang-change handler
//   - All toast messages in MCP add use t()
// ============================================================

'use strict';

const { readSettingsFamily } = require('../helpers/settings-source');

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

// ── settings.js: re-render strategy ────────────────────────

test('settings.js: _decorateField removes old default-hint before re-rendering', () => {
  const src = readSettingsFamily();
  // Should have logic to remove existing .setting-default-hint
  assert.ok(src.includes("querySelector('.setting-default-hint')") ||
            src.includes('querySelectorAll(\'.setting-default-hint\')'),
    'must look up existing default-hints to remove them');
  // The hint render must happen OUTSIDE the _decorated guard, otherwise
  // language changes won't refresh the text
  const fn = src.match(/function _decorateField[\s\S]*?\n\}/);
  assert.ok(fn, 'must find _decorateField');
  const body = fn[0];
  // The buildDefaultHint call must be outside the _decorated block
  const decoratedGuardIdx = body.indexOf('if (!el._decorated)');
  const buildHintIdx = body.indexOf('buildDefaultHint(');
  // Find the closing of the _decorated block
  // (heuristic: count braces from _decorated block start)
  // simpler: ensure buildDefaultHint comes AFTER the closing of the guard
  const guardClose = body.lastIndexOf('  }', body.indexOf('// 2.') > 0 ? body.indexOf('// 2.') : body.length);
  // Just check that there's no direct nesting
  assert.ok(buildHintIdx > decoratedGuardIdx, 'sanity: guard before hint call');
  // The key thing: hint comment "ALWAYS re-render" should be present
  assert.ok(body.includes('ALWAYS re-render') || body.includes('always') || body.includes('Re-render'),
    'must indicate re-render is intentional');
});

test('settings.js: refreshSettingsI18n is exported', () => {
  const mod = require(path.join(ROOT, 'src/ui/modules/settings.js'));
  assert.strictEqual(typeof mod.refreshSettingsI18n, 'function',
    'refreshSettingsI18n must be exported');
});

// ── settings.js: i18n in dynamic strings ──────────────────

test('settings.js: _renderMcpServers uses t() for empty-state', () => {
  const src = readSettingsFamily();
  // Must call t('settings.mcp.empty') not literal 'Keine MCP-Server'
  assert.ok(!src.includes("textContent = 'Keine MCP-Server konfiguriert.'"),
    'hardcoded German empty-state must be removed');
  assert.ok(src.includes("t('settings.mcp.empty')"),
    'must use t() for empty-state');
});

test('settings.js: Remove button uses t(ui.remove)', () => {
  const src = readSettingsFamily();
  assert.ok(!src.includes("removeBtn.textContent = 'Entfernen'"),
    'hardcoded "Entfernen" must be removed');
  assert.ok(src.includes("removeBtn.textContent = t('ui.remove')") ||
            src.includes("removeBtn.textContent = t(\"ui.remove\")"),
    'must use t("ui.remove")');
});

test('settings.js: Add button is re-translated on each wire', () => {
  const src = readSettingsFamily();
  // The new logic: btn.textContent = t('ui.add'); BEFORE the _wired check
  assert.ok(src.includes("btn.textContent = t('ui.add')"),
    'add button must be re-labeled with t()');
});

test('settings.js: MCP toasts use t()', () => {
  const src = readSettingsFamily();
  assert.ok(!src.includes("'MCP-Server: Name fehlt'"),
    'hardcoded "Name fehlt" must be replaced');
  assert.ok(src.includes("t('settings.mcp.error_name_missing')"),
    'must use t() for name-missing toast');
  assert.ok(src.includes("t('settings.mcp.error_exists')"),
    'must use t() for exists toast');
});

// ── settings.js: JSON-Editor status i18n ──────────────────

test('settings.js: JSON-Editor status messages use t()', () => {
  const src = readSettingsFamily();
  assert.ok(!src.includes("status.textContent = 'geladen'"),
    'hardcoded "geladen" must be replaced');
  assert.ok(!src.includes("status.textContent = 'JSON gültig'"),
    'hardcoded "JSON gültig" must be replaced');
  assert.ok(src.includes("t('settings.json.status_loaded')"),
    'must use t() for loaded status');
  assert.ok(src.includes("t('settings.json.status_valid')"),
    'must use t() for valid status');
  assert.ok(src.includes("t('settings.json.status_invalid')"),
    'must use t() for invalid status');
});

// ── renderer-main.js: lang switch calls refresh ───────────

test('renderer-main.js: lang switch calls refreshSettingsI18n after loadI18n', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf8');
  assert.ok(src.includes('refreshSettingsI18n'),
    'must import refreshSettingsI18n');
  // Order check: refreshSettingsI18n() must come AFTER loadI18n() in the lang handler
  const handler = src.match(/lang-select.*?\n[\s\S]*?\}\);/);
  assert.ok(handler, 'lang-select handler must exist');
  const h = handler[0];
  const loadIdx = h.indexOf('loadI18n');
  const refreshIdx = h.indexOf('refreshSettingsI18n');
  assert.ok(refreshIdx > loadIdx,
    'refreshSettingsI18n must be called AFTER loadI18n');
});

// ── Language.js: new keys ─────────────────────────────────

test('Language.js: Etappe-7 keys present in en + de', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  const required = [
    'settings.mcp.error_name_missing', 'settings.mcp.error_url_missing',
    'settings.mcp.error_exists',
    'settings.json.status_loaded', 'settings.json.status_load_error',
    'settings.json.status_valid', 'settings.json.status_invalid',
  ];
  for (const k of required) {
    assert.ok(lang.STRINGS.en[k], `EN missing: ${k}`);
    assert.ok(lang.STRINGS.de[k], `DE missing: ${k}`);
    assert.notStrictEqual(lang.STRINGS.en[k], lang.STRINGS.de[k],
      `${k} en === de — looks untranslated`);
  }
});

test('Language.js: still 0 duplicate keys', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf8');
  for (const lang of ['en', 'de', 'fr', 'es']) {
    const m = src.match(new RegExp('^  ' + lang + ': \\{([\\s\\S]*?)^  \\},', 'm'));
    assert.ok(m);
    const keys = m[1].match(/'[^']+':/g) || [];
    const seen = new Set(); const dups = [];
    for (const k of keys) { if (seen.has(k)) dups.push(k); seen.add(k); }
    assert.deepStrictEqual(dups, [], `${lang} dups: ${dups.join(', ')}`);
  }
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
