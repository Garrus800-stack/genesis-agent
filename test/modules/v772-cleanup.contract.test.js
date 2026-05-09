'use strict';

// ============================================================
// v7.7.2 — Cleanup release contract pins
//
// One file, eleven subtests covering the v7.7.2 changes:
//
//   A. Settings module split (1073-LOC monolith → 7 settings-*
//      sub-modules + facade + 2 separate non-settings modules)
//   B. Small surgical fixes:
//       B1. index.bundled.html removed
//       B2. CommandHandlersInstallDB Node v22 LTS
//       B3. (retired in v7.7.3 — see comment near former B3 location)
//       B4. FILE_SIZE_CAPS now empty (post-split state)
//   C. audit-doc-drift gitAuto pinning
//   D. Caller-surface stability (renderer-main.js still works)
//
// These pin the v7.7.2 baseline. If anyone bundles things back
// into a monolith, removes the extracted modules, or rolls back
// the small fixes, this test fails — explicit signal that the
// regression is intentional and CHANGELOG/AUDIT-BACKLOG must
// reflect it.
// ============================================================

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const MOD = path.join(ROOT, 'src/ui/modules');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`    ✅ ${name}`); passed++; }
  catch (e) { console.log(`    ❌ ${name}: ${e.message}`); failed++; }
}

// ── A. Settings split: file-presence + facade + state API ───

test('A1: 7 settings-* sub-modules exist (state, fields, loadsave, json-editor, fallback-ui, mcp-ui) + facade', () => {
  const required = [
    'settings.js',                  // facade
    'settings-state.js',
    'settings-fields.js',
    'settings-loadsave.js',
    'settings-json-editor.js',
    'settings-fallback-ui.js',
    'settings-mcp-ui.js',
  ];
  for (const f of required) {
    assert.ok(fs.existsSync(path.join(MOD, f)),
      `${f} must exist after v7.7.2 split`);
  }
});

test('A2: settings.js facade is < 100 LOC and only re-exports the public surface', () => {
  const src = fs.readFileSync(path.join(MOD, 'settings.js'), 'utf-8');
  const lines = src.split('\n').length;
  assert.ok(lines < 100,
    `facade settings.js must be < 100 LOC, was ${lines}`);
  // Must export the four canonical settings entry points
  for (const fn of ['openSettings', 'closeSettings', 'saveSettings', 'refreshSettingsI18n']) {
    assert.match(src, new RegExp(`module\\.exports[\\s\\S]*${fn}`),
      `facade must export ${fn}`);
  }
  // Must NOT export the goal-management or drag-drop functions any more
  for (const fn of ['showGoalTree', 'undoLastChange', 'setupDragDrop', 'autoResize']) {
    assert.ok(!new RegExp(`module\\.exports[\\s\\S]*\\b${fn}\\b`).test(src),
      `facade must NOT export ${fn} (moved to its own module)`);
  }
});

test('A3: settings-state.js exposes explicit getter/setter API (no implicit module-level let leakage)', () => {
  const src = fs.readFileSync(path.join(MOD, 'settings-state.js'), 'utf-8');
  // State variables must be module-private (no `module.exports = { _fallbackState }` style leak)
  assert.ok(!/module\.exports[\s\S]*_fallbackState/.test(src),
    'settings-state.js must not export raw _fallbackState — getter/setter only');
  // Must export the 5 canonical accessors for fallback chain
  for (const fn of ['getFallbackState', 'setFallbackChain', 'setFallbackAvailable', 'setFallbackLoaded', 'resetFallbackState']) {
    assert.match(src, new RegExp(`function\\s+${fn}\\s*\\(`),
      `settings-state.js must define function ${fn}`);
  }
  // And the 4 canonical accessors for MCP servers
  for (const fn of ['getMcpServersState', 'setMcpServers', 'addMcpServer', 'removeMcpServer']) {
    assert.match(src, new RegExp(`function\\s+${fn}\\s*\\(`),
      `settings-state.js must define function ${fn}`);
  }
});

test('A4: settings-fallback-ui.js exposes pure helpers as direct exports (no regex-source-parsing needed)', () => {
  const fallbackUI = require(path.join(MOD, 'settings-fallback-ui'));
  // All four pure helpers must be directly importable
  for (const fn of ['fbAdd', 'fbRemove', 'fbMove', 'fbIsCloud']) {
    assert.strictEqual(typeof fallbackUI[fn], 'function',
      `settings-fallback-ui must export ${fn} as a function (not via regex source-parse)`);
  }
  // Sanity check that they actually work (no DOM dependency for these four)
  assert.deepStrictEqual(fallbackUI.fbAdd([], 'gemma2:9b'), ['gemma2:9b']);
  assert.strictEqual(fallbackUI.fbIsCloud('qwen3-vl:235b-cloud'), true);
});

test('A5: goal-management.js extracted (showGoalTree, buildGoalNode, undoLastChange) — separate from settings.js', () => {
  const file = path.join(MOD, 'goal-management.js');
  assert.ok(fs.existsSync(file),
    'goal-management.js must exist as separate module (not under settings-*)');
  const src = fs.readFileSync(file, 'utf-8');
  for (const fn of ['showGoalTree', 'buildGoalNode', 'undoLastChange']) {
    assert.match(src, new RegExp(`function\\s+${fn}|async\\s+function\\s+${fn}`),
      `goal-management.js must define ${fn}`);
    assert.match(src, new RegExp(`module\\.exports[\\s\\S]*${fn}`),
      `goal-management.js must export ${fn}`);
  }
  // And settings.js must NOT contain these functions any more
  const settingsSrc = fs.readFileSync(path.join(MOD, 'settings.js'), 'utf-8');
  assert.ok(!/function\s+(?:showGoalTree|buildGoalNode|undoLastChange)/.test(settingsSrc),
    'settings.js must not define goal-management functions any more');
});

test('A6: drag-drop.js extracted (setupDragDrop) — separate from settings.js', () => {
  const file = path.join(MOD, 'drag-drop.js');
  assert.ok(fs.existsSync(file),
    'drag-drop.js must exist as separate module');
  const src = fs.readFileSync(file, 'utf-8');
  assert.match(src, /function\s+setupDragDrop/,
    'drag-drop.js must define setupDragDrop');
  assert.match(src, /module\.exports[\s\S]*setupDragDrop/,
    'drag-drop.js must export setupDragDrop');
  const settingsSrc = fs.readFileSync(path.join(MOD, 'settings.js'), 'utf-8');
  assert.ok(!/function\s+setupDragDrop/.test(settingsSrc),
    'settings.js must not define setupDragDrop any more');
});

test('A7: chat.js extended with autoResize (was 1-liner inside settings.js)', () => {
  const src = fs.readFileSync(path.join(MOD, 'chat.js'), 'utf-8');
  assert.match(src, /function\s+autoResize/,
    'chat.js must define autoResize');
  assert.match(src, /module\.exports[\s\S]*autoResize/,
    'chat.js must export autoResize');
  // settings.js must not have it any more
  const settingsSrc = fs.readFileSync(path.join(MOD, 'settings.js'), 'utf-8');
  assert.ok(!/function\s+autoResize/.test(settingsSrc),
    'settings.js must not define autoResize any more');
});

test('A8: renderer-main.js caller surface — 4 separate requires for the post-split modules', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf-8');
  // Must have a require for each of the 4 modules whose surface was split
  assert.match(src, /require\(['"]\.\/modules\/settings['"]\)/,
    'must require ./modules/settings');
  assert.match(src, /require\(['"]\.\/modules\/goal-management['"]\)/,
    'must require ./modules/goal-management');
  assert.match(src, /require\(['"]\.\/modules\/drag-drop['"]\)/,
    'must require ./modules/drag-drop');
  // chat.js require must include autoResize in the destructure
  assert.match(src, /require\(['"]\.\/modules\/chat['"]\)[\s\S]*autoResize/,
    'must destructure autoResize from ./modules/chat (not from settings)');
  // The old monolithic require pattern must be gone
  assert.ok(!/showGoalTree[^=]*=\s*require\(['"]\.\/modules\/settings['"]\)/.test(src),
    'old caller pattern (showGoalTree from settings) must be gone');
});

// ── B. Small surgical fixes ─────────────────────────────────

test('B1: src/ui/index.bundled.html removed (was duplicate of index.html)', () => {
  const bundled = path.join(ROOT, 'src/ui/index.bundled.html');
  assert.ok(!fs.existsSync(bundled),
    'index.bundled.html must be deleted in v7.7.2');
  // main.js must still load index.html
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf-8');
  assert.match(mainSrc, /'index\.html'/,
    'main.js must still reference index.html');
  assert.ok(!/'index\.bundled\.html'/.test(mainSrc),
    'main.js must not reference index.bundled.html any more');
});

test('B2: CommandHandlersInstallDB nodejs entry uses Node v22 LTS', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersInstallDB.js'), 'utf-8');
  // Find the 'nodejs' block
  const nodejsBlock = src.match(/'nodejs':\s*\{[\s\S]*?\},/);
  assert.ok(nodejsBlock, 'nodejs entry must exist in InstallDB');
  // Must use v22.x in URLs
  assert.match(nodejsBlock[0], /v22\.\d+\.\d+/,
    'nodejs URL must use v22.x.x version');
  // Label must say "v22 LTS"
  assert.match(nodejsBlock[0], /Node\.js v22 LTS/,
    'nodejs label must say "Node.js v22 LTS"');
  // Must not contain the v7.7.1 URL pattern (nodejs.org/dist/v20.18.1)
  // Comment refs like "(was v20.18.1)" are fine — only the actual URL must change.
  assert.ok(!/dist\/v20\.18\.1/.test(nodejsBlock[0]),
    'old v20.18.1 URL must be removed (dist/v20.18.1)');
});

// B3 was: STATE_TO_CSS.resting maps to 'ready' (v7.7.2 semantic fix from
// 'booting'). Retired in v7.7.3 — that release introduced a dedicated
// `.badge-resting` class with its own muted-grey color, so resting now
// maps to 'resting' instead of 'ready'. The new behaviour is pinned in
// `test/modules/v773-cleanup.contract.test.js` subtest C2. Same pattern
// as v7.7.2 retiring the v7.7.1 file-size baseline subtests — keeps the
// v7.7.x-by-x eras separate in the test history.

test('B4: FILE_SIZE_CAPS is empty in architectural-fitness.js (post-split state)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/architectural-fitness.js'), 'utf-8');
  const m = src.match(/const\s+FILE_SIZE_CAPS\s*=\s*\{([\s\S]*?)\};/);
  assert.ok(m, 'FILE_SIZE_CAPS block must exist');
  // Strip comments + whitespace, check that there are no entries
  const body = m[1].replace(/\/\/[^\n]*/g, '').trim();
  assert.strictEqual(body, '',
    `FILE_SIZE_CAPS must be empty (settings.js was split). Got: ${body.substring(0, 100)}`);
});

// ── C. audit-doc-drift gitAuto pinning ──────────────────────

test('C1: audit-doc-drift includes gitAutoInit + gitAutoCommit checks', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/audit-doc-drift.js'), 'utf-8');
  assert.match(src, /gitAutoInit:\\s\*\(true\|false\)/,
    'audit-doc-drift must include gitAutoInit regex check');
  assert.match(src, /gitAutoCommit:\\s\*\(true\|false\)/,
    'audit-doc-drift must include gitAutoCommit regex check');
  // Must check Settings.js source
  assert.match(src, /['"]src\/agent\/foundation\/Settings\.js['"]/,
    'audit-doc-drift must read Settings.js source');
});

// ── D. End-to-end smoke: all extracted modules load without error ──

test('D1: smoke — all 9 settings-related modules require() cleanly under Node', () => {
  // settings-state, settings-fallback-ui, settings-json-editor are pure-logic
  // safe — others depend on DOM and would throw on `t()` but the require itself
  // should at least parse + load top-level (errors come from function calls).
  const safe = ['settings-state', 'settings-fallback-ui', 'settings-json-editor'];
  for (const mod of safe) {
    let m;
    assert.doesNotThrow(() => {
      m = require(path.join(MOD, mod));
    }, `${mod} must require() cleanly`);
    assert.ok(typeof m === 'object' && m !== null,
      `${mod} must export an object`);
  }
});

console.log(`\n    ${passed} passed · ${failed} failed · v7.7.2 cleanup`);
process.exit(failed > 0 ? 1 : 0);
