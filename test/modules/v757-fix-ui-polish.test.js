// ============================================================
// GENESIS — test/modules/v757-fix-ui-polish.test.js (v7.5.7-fix)
//
// Tests for the v7.5.7-fix UI polish:
//  - Settings modal uses .modal-wide class (720px, not the default 440px)
//  - .modal-wide CSS rule exists with the correct width
//  - main.js installs a webContents 'context-menu' handler
//  - The handler distinguishes editable / selection / empty cases
//
// Live motivation: Garrus saw model names truncated to "mistral-…" /
// "mannix/d…" in the 440px-wide settings modal — similar prefixes were
// indistinguishable. Plus: Genesis chat had no mouse-context-menu, only
// Ctrl+C/V worked, which is unintuitive on Windows.
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

// ── Modal-wide CSS rule ──────────────────────────────────────

test('styles.css defines .modal-wide rule', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(/\.modal-content\.modal-wide\s*\{[^}]*width:\s*720px/.test(css),
    '.modal-content.modal-wide must set width: 720px');
});

test('styles.css default modal-content remains 440px', () => {
  // The default narrow modal stays 440px so dialogs that don't need
  // extra space (confirms, alerts) keep the same compact layout.
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(/\.modal-content\s*\{[^}]*width:\s*440px/.test(css),
    'default .modal-content must remain 440px');
});

test('settings modal in index.html uses modal-wide class', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  // Find the settings-modal block and check its modal-content has modal-wide
  const settingsBlock = html.match(/<div id="settings-modal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(settingsBlock, 'settings-modal block must exist');
  assert.ok(/class="modal-content modal-wide"/.test(settingsBlock[0]),
    'settings-modal must use modal-content modal-wide');
});

test('settings modal in index.html uses modal-wide class', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
  const settingsBlock = html.match(/<div id="settings-modal"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>/);
  assert.ok(settingsBlock, 'settings-modal block must exist (bundled)');
  assert.ok(/class="modal-content modal-wide"/.test(settingsBlock[0]),
    'bundled settings-modal must use modal-content modal-wide');
});

test('fallback-list grows taller in the wider modal (min-height ≥ 140px)', () => {
  // The wider modal lets us show more rows without scrolling; we bumped
  // min-height from 96 to 140 and max-height from 200 to 320.
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  const m = css.match(/\.fallback-list\s*\{[^}]*min-height:\s*(\d+)px[^}]*max-height:\s*(\d+)px/);
  assert.ok(m, '.fallback-list must declare min-height and max-height');
  const minH = parseInt(m[1], 10);
  const maxH = parseInt(m[2], 10);
  assert.ok(minH >= 140, `min-height should be ≥140px, got ${minH}`);
  assert.ok(maxH >= 300, `max-height should be ≥300px, got ${maxH}`);
});

test('fallback-item-name has cursor:help (signals tooltip on hover)', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf8');
  assert.ok(/\.fallback-item-name\s*\{[^}]*cursor:\s*help/.test(css),
    '.fallback-item-name must use cursor: help so users know hovering reveals the full name');
});

// ── Right-click context-menu in main.js ──────────────────────

test('main.js installs webContents context-menu handler', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/webContents\.on\(\s*['"]context-menu['"]/.test(main),
    "main.js must register a 'context-menu' listener on webContents");
});

test('context-menu handler imports Menu and MenuItem from electron', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // We use _CtxMenu / _CtxMenuItem aliases to avoid colliding with any
  // future top-level Menu import.
  assert.ok(/_CtxMenu(Item)?/.test(main) || /Menu,\s*MenuItem/.test(main),
    'context-menu handler must import Menu and MenuItem');
});

test('context-menu handler distinguishes editable fields (cut + paste available)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/isEditable/.test(main), "must check params.isEditable");
  // The editable path must offer cut + paste roles
  assert.ok(/role:\s*['"]cut['"]/.test(main), 'must offer cut role for editable fields');
  assert.ok(/role:\s*['"]paste['"]/.test(main), 'must offer paste role for editable fields');
});

test('context-menu handler offers copy on text selection (non-editable)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/role:\s*['"]copy['"]/.test(main), 'must offer copy role');
  assert.ok(/selectionText/.test(main), 'must consult params.selectionText for has-selection');
});

test('context-menu handler offers selectAll', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(/role:\s*['"]selectAll['"]/.test(main),
    'must offer selectAll role');
});

test('context-menu strings are German (target audience: Garrus)', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  // The user uses Genesis in German; menu items should be German too.
  assert.ok(/Kopieren/.test(main), 'menu must include Kopieren');
  assert.ok(/Einfügen/.test(main), 'menu must include Einfügen');
  assert.ok(/Ausschneiden/.test(main), 'menu must include Ausschneiden');
  assert.ok(/Alles auswählen/.test(main), 'menu must include Alles auswählen');
});

// ── audit-events.js excludes context-menu ───────────────────

test('audit-events excludes "context-menu" as Electron-internal', () => {
  const audit = fs.readFileSync(path.join(ROOT, 'scripts/audit-events.js'), 'utf8');
  assert.ok(/['"]context-menu['"]/.test(audit),
    'context-menu must be in EXCLUDED_EVENTS to avoid false-positive audit failures');
});

// ── Done ─────────────────────────────────────────────

console.log('');
console.log(`  ${passed} passed${failed > 0 ? `, ${failed} failed` : ''}`);
if (failed > 0) {
  console.log('');
  console.log('  Failures:');
  for (const f of failures) console.log(`    - ${f.name}: ${f.error}`);
  process.exit(1);
}
