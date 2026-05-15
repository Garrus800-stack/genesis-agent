// ============================================================
// GENESIS — test/modules/v786-sidebar-splitter.contract.test.js
// Contract test for v7.8.6 sidebar-splitter feature.
// Every test prefixed `sidebar-splitter contract:`.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

describe('sidebar-splitter contract: module exports', () => {

  test('sidebar-splitter contract: exports public API', () => {
    const mod = require(path.join(ROOT, 'src/ui/modules/splitter'));
    assertEqual(typeof mod.initSplitters, 'function');
    assertEqual(typeof mod.resetAllPanelWidths, 'function');
    assertEqual(typeof mod.DEFAULTS, 'object');
    assertEqual(typeof mod.MIN_WIDTHS, 'object');
  });

  test('sidebar-splitter contract: exports test-only internals', () => {
    const mod = require(path.join(ROOT, 'src/ui/modules/splitter'));
    assertEqual(typeof mod._readWidth, 'function');
    assertEqual(typeof mod._writeWidth, 'function');
    assertEqual(typeof mod._applyStoredWidths, 'function');
    assertEqual(typeof mod._updateSplitterVisibility, 'function');
  });

});

describe('sidebar-splitter contract: DEFAULTS + MIN_WIDTHS', () => {

  test('sidebar-splitter contract: DEFAULTS has exactly file-tree, goals, editor', () => {
    const { DEFAULTS } = require(path.join(ROOT, 'src/ui/modules/splitter'));
    const keys = Object.keys(DEFAULTS).sort();
    assertEqual(keys.length, 3);
    assert(keys.includes('file-tree'));
    assert(keys.includes('goals'));
    assert(keys.includes('editor'));
    assert(!keys.includes('chat'), 'chat-panel must NOT have a stored width');
  });

  test('sidebar-splitter contract: DEFAULTS values are sensible pixel numbers', () => {
    const { DEFAULTS } = require(path.join(ROOT, 'src/ui/modules/splitter'));
    for (const [k, v] of Object.entries(DEFAULTS)) {
      assert(typeof v === 'number');
      assert(v >= 150 && v <= 800);
    }
  });

  test('sidebar-splitter contract: MIN_WIDTHS keys match DEFAULTS keys', () => {
    const { DEFAULTS, MIN_WIDTHS } = require(path.join(ROOT, 'src/ui/modules/splitter'));
    assertEqual(JSON.stringify(Object.keys(DEFAULTS).sort()), JSON.stringify(Object.keys(MIN_WIDTHS).sort()));
  });

  test('sidebar-splitter contract: every MIN is less than or equal to its DEFAULT', () => {
    const { DEFAULTS, MIN_WIDTHS } = require(path.join(ROOT, 'src/ui/modules/splitter'));
    for (const k of Object.keys(DEFAULTS)) {
      assert(MIN_WIDTHS[k] <= DEFAULTS[k]);
    }
  });

});

describe('sidebar-splitter contract: DOM markup in index.html', () => {

  const html = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf-8');

  test('sidebar-splitter contract: three .splitter divs present with role=separator', () => {
    const matches = html.match(/<div class="splitter[^"]*"[^>]*role="separator"/g) || [];
    assertEqual(matches.length, 3);
  });

  test('sidebar-splitter contract: splitter file-tree↔goals exists', () => {
    assert(/<div class="splitter[^"]*"[^>]*data-prev="file-tree-panel"[^>]*data-next="goals-panel"/.test(html));
  });

  test('sidebar-splitter contract: splitter goals↔editor exists', () => {
    assert(/<div class="splitter[^"]*"[^>]*data-prev="goals-panel"[^>]*data-next="editor-panel"/.test(html));
  });

  test('sidebar-splitter contract: splitter editor↔chat exists', () => {
    assert(/<div class="splitter[^"]*"[^>]*data-prev="editor-panel"[^>]*data-next="chat-panel"/.test(html));
  });

  test('sidebar-splitter contract: every splitter has tabindex=0', () => {
    const matches = html.match(/<div class="splitter[^"]*"[^>]*tabindex="0"/g) || [];
    assertEqual(matches.length, 3);
  });

  test('sidebar-splitter contract: reset-panel-widths button is present', () => {
    assert(/id="btn-reset-panel-widths"/.test(html));
  });

});

describe('sidebar-splitter contract: CSS in styles.css', () => {

  const css = fs.readFileSync(path.join(ROOT, 'src/ui/styles.css'), 'utf-8');

  test('sidebar-splitter contract: .splitter uses col-resize cursor', () => {
    assert(/\.splitter\s*\{[^}]*cursor:\s*col-resize/m.test(css));
  });

  test('sidebar-splitter contract: .splitter has hover or .dragging visual feedback', () => {
    assert(/\.splitter:hover/.test(css) || /\.splitter\.dragging/.test(css));
  });

  test('sidebar-splitter contract: .splitter has grip indicator via ::before pseudo', () => {
    assert(/\.splitter::before/.test(css));
  });

  test('sidebar-splitter contract: three panels reference --panel-width-* variables', () => {
    assert(/#file-tree-panel[^}]*var\(--panel-width-file-tree/.test(css));
    assert(/#goals-panel[^}]*var\(--panel-width-goals/.test(css));
    assert(/#editor-panel[^}]*var\(--panel-width-editor/.test(css));
  });

  test('sidebar-splitter contract: chat-panel is the flex remainder', () => {
    assert(/#chat-panel[^}]*flex:\s*1\s+1/.test(css));
  });

  test('sidebar-splitter contract: hardcoded width: 220px / 280px / flex: 2 removed', () => {
    assert(!/#file-tree-panel\s*\{[^}]*width:\s*220px/.test(css));
    assert(!/#goals-panel\s*\{[^}]*width:\s*280px/.test(css));
    assert(!/#chat-panel\s*\{\s*flex:\s*2/.test(css));
  });

});

describe('sidebar-splitter contract: settings + togglePanel wireup', () => {

  test('sidebar-splitter contract: Settings.js has ui.panelWidths default', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf-8');
    assert(/panelWidths:\s*\{[\s\S]*?'file-tree'[\s\S]*?'goals'[\s\S]*?'editor'/.test(src));
  });

  test('sidebar-splitter contract: renderer-main.js togglePanel fires panel:visibility-changed with guard', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf-8');
    assert(/window\.togglePanel\s*=/.test(src));
    assert(/panel:visibility-changed/.test(src));
    assert(/typeof\s+window\.dispatchEvent\s*===\s*'function'/.test(src),
      'togglePanel must guard window.dispatchEvent for test-shim safety');
  });

  test('sidebar-splitter contract: renderer-main.js wires initSplitters + resetAllPanelWidths', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/renderer-main.js'), 'utf-8');
    assert(/initSplitters/.test(src));
    assert(/resetAllPanelWidths/.test(src));
  });

  test('sidebar-splitter contract: _updateSplitterVisibility uses smart sibling-traversal', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/splitter.js'), 'utf-8');
    assert(/nextElementSibling/.test(src),
      'visibility logic must traverse nextElementSibling to skip hidden intermediate panels');
  });

});

run();
