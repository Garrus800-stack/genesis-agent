// ============================================================
// GENESIS — test/modules/v757-fix-phase3-etappe4.test.js
//
// Tests for v7.5.7-fix Phase 3 Etappe 4 — JSON-Editor:
//   - JSON-Editor tab in HTML (both index.html and bundled)
//   - Textarea + Validate-Button + Reload-Button
//   - settings.js: load/validate/diff functions
//   - API keys are masked in editor view (security)
//   - Save-flow integrates JSON-Editor changes into the batch
//   - i18n strings for JSON-Editor (en + de)
//   - CSS styling
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

// ── HTML: tab + panel + textarea + buttons ─────────────────

test('HTML: JSON-Editor tab button (index.html)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(html.includes('data-tab="json"'), 'tab button must exist');
  assert.ok(html.includes('data-tab-panel="json"'), 'panel must exist');
});

test('HTML: JSON-Editor tab button (index.bundled.html — synced)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.bundled.html'), 'utf8');
  assert.ok(html.includes('data-tab="json"'), 'tab button must exist');
  assert.ok(html.includes('data-tab-panel="json"'), 'panel must exist');
});

test('HTML: textarea + buttons present', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  assert.ok(html.includes('id="json-editor-textarea"'), 'textarea missing');
  assert.ok(html.includes('id="btn-json-validate"'), 'validate button missing');
  assert.ok(html.includes('id="btn-json-reload"'), 'reload button missing');
  assert.ok(html.includes('id="json-editor-status"'), 'status span missing');
});

// ── settings.js: editor functions ──────────────────────────

test('settings.js: _loadJsonEditor + _validateJsonEditor + _wireJsonEditorButtons', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  assert.ok(src.includes('_loadJsonEditor'), 'must have _loadJsonEditor');
  assert.ok(src.includes('_validateJsonEditor'), 'must have _validateJsonEditor');
  assert.ok(src.includes('_wireJsonEditorButtons'), 'must have _wireJsonEditorButtons');
  assert.ok(src.includes('_collectJsonEditorChanges'), 'must have diff collector');
});

test('settings.js: SENSITIVE_PATHS for masking', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  assert.ok(src.includes("'models.anthropicApiKey'"), 'must list anthropic key');
  assert.ok(src.includes("'models.openaiApiKey'"), 'must list openai key');
  assert.ok(src.includes("'peer.discoveryToken'"), 'must list peer token');
  assert.ok(src.includes('***MASKED***'), 'must use MASKED token');
});

test('settings.js: opens load on settings open', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  assert.ok(src.includes('_wireJsonEditorButtons()'), 'must wire buttons on open');
  assert.ok(src.includes('_loadJsonEditor()'), 'must load editor on open');
});

test('settings.js: save integrates JSON-editor changes', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  // _collectJsonEditorChanges must be called inside saveSettings
  const saveStart = src.indexOf('async function saveSettings');
  const saveEnd = src.indexOf('async function ', saveStart + 1);
  const saveSlice = src.slice(saveStart, saveEnd > 0 ? saveEnd : src.length);
  assert.ok(saveSlice.includes('_collectJsonEditorChanges'),
    'saveSettings must call _collectJsonEditorChanges');
});

test('settings.js: invalid JSON aborts save (no half-save)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings.js'), 'utf8');
  // The save flow must include an abort path when JSON is invalid
  assert.ok(src.includes('jsonChanges === null') ||
            src.includes('jsonChanges == null'),
    'must check for null (= invalid JSON) and abort');
});

// ── i18n: en + de keys ─────────────────────────────────────

test('Language.js: JSON-editor keys in en + de', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/core/Language.js'), 'utf8');
  const keys = ['settings.json.title', 'settings.json.help',
                'settings.json.validate', 'settings.json.reload'];
  for (const k of keys) {
    const count = (src.match(new RegExp(`'${k.replace(/\./g, '\\.')}'`, 'g')) || []).length;
    assert.ok(count >= 2, `'${k}' must appear in both en + de (found ${count})`);
  }
});

// ── CSS ────────────────────────────────────────────────────

test('CSS: JSON-editor styles present', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(css.includes('.json-editor-textarea'));
  assert.ok(css.includes('.json-editor-toolbar'));
  assert.ok(css.includes('.json-editor-status'));
  assert.ok(css.includes('json-editor-textarea.invalid') || css.includes('.json-editor-textarea.invalid'),
    'invalid state styling must exist');
});

// ── Smoke: settings.js parses (JS valid) ───────────────────

test('settings.js parses as JavaScript', () => {
  const settingsPath = path.join(ROOT, 'src/ui/modules/settings.js');
  // settings.js is browser-targeted, so we can't require() it here
  // (it pulls in window-only deps). But we can syntax-check by
  // running it through Node's parser via 'new Function' on the raw text
  // wrapped in a noop guard for browser-only globals.
  const src = fs.readFileSync(settingsPath, 'utf8');
  // Strip require() lines (Node-specific) for parser-test
  const stub = src.replace(/^const \{[^}]+\} = require\([^)]+\);?$/gm, '// stripped');
  try {
    new Function('window', 'document', stub);
  } catch (err) {
    throw new Error(`settings.js syntax error: ${err.message}`);
  }
});

// ── Done ───────────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
