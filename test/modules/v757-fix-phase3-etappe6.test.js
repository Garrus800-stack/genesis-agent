// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe6.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 6 — final i18n coverage:
//   1. buildDefaultHint() is i18n-aware (translates "Default", "Min",
//      "Max", "an"/"on", "aus"/"off", "leer"/"empty")
//   2. validateField() returns i18n-aware reason strings
//   3. data-i18n-html attribute supported in i18n.js + renderer.js
//      (for hints with inline <code>/<strong> tags)
//   4. data-i18n-placeholder for input placeholders
//   5. All HTML data-i18n* keys resolve in en + de
//   6. Specific Etappe-6 keys translate differently in en vs de
//   7. No duplicate keys anywhere
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

// ── buildDefaultHint i18n ──────────────────────────────────

test('buildDefaultHint: takes translate fn argument', () => {
  const { buildDefaultHint } = require(path.join(ROOT, 'src/ui/modules/settings-defaults.js'));
  const fakeDoc = {
    createElement: () => ({
      className: '', textContent: '', style: {},
    }),
  };
  // Pretend translation: "Default" → "Standard" (made-up so we can detect it ran)
  const tr = (key) => {
    const dict = { 'default_hint.label': 'Standard', 'default_hint.empty': 'tom',
                   'default_hint.on': 'auf', 'default_hint.off': 'tas' };
    return dict[key] || key;
  };
  const span = buildDefaultHint('set-max-concurrent', fakeDoc, tr);
  assert.ok(span, 'must return element');
  assert.ok(span.textContent.startsWith('Standard:'),
    `expected i18n "Standard:" prefix, got "${span.textContent}"`);
});

test('buildDefaultHint: falls back to German if no translate fn', () => {
  const { buildDefaultHint } = require(path.join(ROOT, 'src/ui/modules/settings-defaults.js'));
  const fakeDoc = { createElement: () => ({ className: '', textContent: '', style: {} }) };
  const span = buildDefaultHint('set-keep-alive', fakeDoc); // no translate
  assert.ok(span);
  // string default null/'' field renders "Default: leer" (German fallback)
  assert.ok(span.textContent.includes('leer') || span.textContent.includes('Default'),
    `expected German fallback, got "${span.textContent}"`);
});

test('buildDefaultHint: bool field uses on/off i18n', () => {
  const { buildDefaultHint } = require(path.join(ROOT, 'src/ui/modules/settings-defaults.js'));
  const fakeDoc = { createElement: () => ({ className: '', textContent: '', style: {} }) };
  const tr = (key) => {
    const dict = { 'default_hint.label': 'Default', 'default_hint.on': 'on', 'default_hint.off': 'off' };
    return dict[key] || key;
  };
  // Find a bool field in the registry
  const { FIELD_REGISTRY } = require(path.join(ROOT, 'src/ui/modules/settings-defaults.js'));
  const boolId = Object.keys(FIELD_REGISTRY).find(id => FIELD_REGISTRY[id].type === 'bool');
  if (!boolId) { console.log('      (skip — no bool fields in registry)'); return; }
  const span = buildDefaultHint(boolId, fakeDoc, tr);
  assert.ok(span);
  assert.ok(/Default: (on|off)/.test(span.textContent),
    `expected "Default: on" or "Default: off", got "${span.textContent}"`);
});

// ── validateField i18n ─────────────────────────────────────

test('validateField: returns i18n-aware reason', () => {
  const { validateField } = require(path.join(ROOT, 'src/ui/modules/settings-defaults.js'));
  const tr = (k) => k === 'default_hint.not_a_number' ? 'NaN' : k === 'default_hint.min' ? 'MinX' : k;
  const r1 = validateField('set-max-concurrent', 'abc', tr);
  assert.strictEqual(r1.ok, false);
  assert.strictEqual(r1.reason, 'NaN', `expected "NaN", got "${r1.reason}"`);
  const r2 = validateField('set-max-concurrent', '0', tr);
  assert.strictEqual(r2.ok, false);
  assert.ok(r2.reason.includes('MinX'), `expected MinX in reason, got "${r2.reason}"`);
});

// ── i18n.js: data-i18n-html support ───────────────────────

test('i18n.js: applyI18n handles data-i18n-html attribute', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/i18n.js'), 'utf8');
  assert.ok(src.includes('data-i18n-html'), 'i18n.js must handle data-i18n-html');
  assert.ok(src.includes('innerHTML'), 'i18n.js must use innerHTML for HTML content');
});

// v7.6.0: legacy `renderer.js: applyI18n handles data-i18n-html` test
// removed when the dual-path was consolidated. v7.7.0 deleted the
// legacy file entirely.

// ── HTML coverage ──────────────────────────────────────────

test('All data-i18n* keys in HTML resolve in en + de', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  // v7.6.0: dual-path consolidated, only one HTML file remains.
  // (v7.7.0: index.bundled.html is identical to index.html and unused
  // — left in repo as a future cleanup target.)
  for (const f of ['src/ui/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const matches = [...html.matchAll(/data-i18n(?:-html|-placeholder)?="([^"]+)"/g)].map(m => m[1]);
    const uniq = [...new Set(matches)];
    const missing = uniq.filter(k => !lang.STRINGS.en[k] || !lang.STRINGS.de[k]);
    assert.deepStrictEqual(missing, [],
      `${f} has unresolved i18n keys: ${missing.slice(0, 5).join(', ')}`);
  }
});

test('Etappe-6 keys exist in en + de and differ where expected', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  const required = [
    'default_hint.label', 'default_hint.min', 'default_hint.max',
    'default_hint.on', 'default_hint.off', 'default_hint.empty',
    'settings.role.chat', 'settings.role.code', 'settings.role.analysis',
    'settings.api_keys', 'settings.keepalive.hint', 'settings.fallback_instructions',
    'settings.mcp.placeholder_name', 'settings.mcp.placeholder_url',
  ];
  for (const k of required) {
    assert.ok(lang.STRINGS.en[k], `EN missing: ${k}`);
    assert.ok(lang.STRINGS.de[k], `DE missing: ${k}`);
  }
  // These specifically should differ EN vs DE
  const mustDiffer = ['default_hint.on', 'default_hint.off', 'default_hint.empty',
                      'settings.api_keys', 'settings.keepalive.hint'];
  for (const k of mustDiffer) {
    assert.notStrictEqual(lang.STRINGS.en[k], lang.STRINGS.de[k],
      `${k} en === de (looks untranslated)`);
  }
});

test('keepalive.hint preserves <code> tags in both languages', () => {
  const lang = require(path.join(ROOT, 'src/agent/core/Language.js'));
  assert.ok(lang.STRINGS.en['settings.keepalive.hint'].includes('<code>'),
    'EN keepalive.hint must keep <code> tags');
  assert.ok(lang.STRINGS.de['settings.keepalive.hint'].includes('<code>'),
    'DE keepalive.hint must keep <code> tags');
});

test('No duplicate keys in any language block', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf8');
  for (const lang of ['en', 'de', 'fr', 'es']) {
    const m = src.match(new RegExp('^  ' + lang + ': \\{([\\s\\S]*?)^  \\},', 'm'));
    assert.ok(m);
    const keys = (m[1].match(/'[^']+':/g) || []);
    const seen = new Set(); const dups = [];
    for (const k of keys) {
      if (seen.has(k)) dups.push(k);
      seen.add(k);
    }
    assert.deepStrictEqual(dups, [], `${lang} duplicates: ${dups.join(', ')}`);
  }
});

// ── HTML cleanup ───────────────────────────────────────────

test('HTML: no German hint text without data-i18n', () => {
  for (const f of ['src/ui/index.html']) {
    const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // Find all setting-hint / setting-section-label without data-i18n
    const pattern = /<(?:span class="setting-hint"|label class="setting-section-label")(?![^>]*data-i18n)[^>]*>([\s\S]*?)<\/(?:span|label)>/g;
    const offending = [];
    for (const m of html.matchAll(pattern)) {
      const plain = m[1].replace(/<[^>]+>/g, '').trim();
      if (!plain) continue;
      // looks German?
      if (/[äöüß]/.test(plain) || /\b(der|die|das|wenn|wie|nach|für|wird|bei|aus|nicht)\b/.test(plain)) {
        offending.push(plain.slice(0, 80));
      }
    }
    assert.deepStrictEqual(offending, [],
      `${f} has German hints/labels without data-i18n: ${offending.join(' | ')}`);
  }
});

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
