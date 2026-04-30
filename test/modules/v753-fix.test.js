// ============================================================
// GENESIS — test/modules/v753-fix.test.js
//
// Regression tests for v7.5.3: Renderer waits for preload bridge.
//
// Bug history:
//   v4.13.0 introduced three-tier preload selection (ESM/Bundled/Raw).
//   On Linux, Tier 1 (ESM .mjs) is selected. ESM preload loads
//   asynchronously, so DOMContentLoaded can fire BEFORE
//   contextBridge.exposeInMainWorld has run. The renderer then calls
//   window.genesis.on(...) on undefined, throwing
//   "Cannot read properties of undefined (reading 'on')".
//
//   On Windows the bundled-CJS preload loads synchronously, which
//   masked the race. v7.5.3 makes the renderer actively wait for
//   the bridge instead of assuming it's there.
//
// What we test:
//   A — bundle source contains the wait-for-bridge guard
//   B — both renderer entry points have the guard
//   C — old "delete preload.mjs" workaround instruction is gone
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_MAIN = path.join(ROOT, 'src/ui/renderer-main.js');
const RENDERER_LEGACY = path.join(ROOT, 'src/ui/renderer.js');

describe('v7.5.3/A · waitForBridge in renderer-main.js (bundled entry)', () => {

  test('A1: waitForBridge function is defined', () => {
    const src = fs.readFileSync(RENDERER_MAIN, 'utf8');
    assert(/function waitForBridge\s*\(/.test(src),
      'renderer-main.js must define waitForBridge function');
  });

  test('A2: waitForBridge polls window.genesis with .on check', () => {
    const src = fs.readFileSync(RENDERER_MAIN, 'utf8');
    // The check must verify both window.genesis exists AND has a callable .on
    // (presence alone is not enough — partial bridge state would still crash).
    assert(/window\.genesis\s*&&\s*typeof\s+window\.genesis\.on\s*===\s*['"]function['"]/.test(src),
      'waitForBridge must check both window.genesis and typeof window.genesis.on === function');
  });

  test('A3: waitForBridge has timeout (no infinite hang)', () => {
    const src = fs.readFileSync(RENDERER_MAIN, 'utf8');
    assert(/timeoutMs\s*=\s*\d+/.test(src) || /5000/.test(src),
      'waitForBridge must have a finite timeout');
  });

  test('A4: DOMContentLoaded handler awaits waitForBridge', () => {
    const src = fs.readFileSync(RENDERER_MAIN, 'utf8');
    // The DOM handler must be async and await the bridge before any
    // window.genesis.* call.
    assert(/DOMContentLoaded['"],\s*async\s*\(/.test(src),
      'DOMContentLoaded handler must be async');
    // Find the position of DOMContentLoaded handler and the first .on call —
    // the handler must call waitForBridge before the .on call.
    const domStart = src.indexOf("addEventListener('DOMContentLoaded'");
    const firstOnCall = src.indexOf('window.genesis.on(', domStart);
    const waitCall = src.indexOf('waitForBridge', domStart);
    assert(domStart > 0, 'DOMContentLoaded handler must exist');
    assert(waitCall > 0, 'waitForBridge must be called inside DOMContentLoaded');
    assert(firstOnCall > waitCall,
      'waitForBridge must be called BEFORE the first window.genesis.on() call');
  });

  test('A5: bridge failure shows real error (not workaround instruction)', () => {
    const src = fs.readFileSync(RENDERER_MAIN, 'utf8');
    // The error UI shown when bridge fails must NOT instruct the user
    // to delete preload.mjs — that was the v4.12.8 anti-pattern.
    assert(!/delete\s+<code>preload\.mjs<\/code>/i.test(src),
      'renderer-main.js must not instruct users to delete preload.mjs');
    assert(!/force CJS fallback/i.test(src),
      'renderer-main.js must not point users at CJS fallback workaround');
  });
});

describe('v7.5.3/B · waitForBridge in renderer.js (legacy entry)', () => {

  test('B1: waitForBridge function is defined in legacy renderer too', () => {
    const src = fs.readFileSync(RENDERER_LEGACY, 'utf8');
    assert(/function waitForBridge\s*\(/.test(src),
      'renderer.js must define waitForBridge function');
  });

  test('B2: legacy renderer also waits before .on() calls', () => {
    const src = fs.readFileSync(RENDERER_LEGACY, 'utf8');
    const domStart = src.indexOf("addEventListener('DOMContentLoaded'");
    const firstOnCall = src.indexOf('window.genesis.on(', domStart);
    const waitCall = src.indexOf('waitForBridge', domStart);
    assert(waitCall > 0, 'waitForBridge must be called inside DOMContentLoaded');
    assert(firstOnCall > waitCall,
      'waitForBridge must come before the first window.genesis.on() call');
  });

  test('B3: legacy renderer no longer points at delete-preload workaround', () => {
    const src = fs.readFileSync(RENDERER_LEGACY, 'utf8');
    assert(!/Delete\s+<code>preload\.mjs<\/code>/i.test(src),
      'renderer.js must not tell users to delete preload.mjs');
    assert(!/force CJS fallback/i.test(src),
      'renderer.js must not point users at CJS fallback workaround');
  });
});

describe('v7.5.3/C · waitForBridge logic (mocked DOM)', () => {

  // Extract the waitForBridge function from renderer-main.js and run it
  // in a controlled environment to verify it actually does what we claim.

  function loadWaitForBridge() {
    const src = fs.readFileSync(RENDERER_MAIN, 'utf8');
    // Match the function definition starting at `function waitForBridge`
    // up to the first closing line `}` on its own at column 0.
    const match = src.match(/function waitForBridge[\s\S]+?\n\}\n/);
    if (!match) throw new Error('Could not extract waitForBridge from renderer-main.js');
    return match[0];
  }

  test('C1: resolves immediately when window.genesis is already present', async () => {
    const fnSource = loadWaitForBridge();
    // Simulate a mini-window with the bridge ready.
    const fakeWindow = { genesis: { on: () => {} } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'setTimeout', 'Date',
      fnSource + '\nreturn waitForBridge;')(fakeWindow, setTimeout, Date);
    const start = Date.now();
    await fn(2000);
    const elapsed = Date.now() - start;
    assert(elapsed < 50, 'should resolve nearly instantly when bridge is ready, took ' + elapsed + 'ms');
  });

  test('C2: resolves when bridge appears after delay', async () => {
    const fnSource = loadWaitForBridge();
    const fakeWindow = {};
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'setTimeout', 'Date',
      fnSource + '\nreturn waitForBridge;')(fakeWindow, setTimeout, Date);
    // Set bridge after 100ms
    setTimeout(() => { fakeWindow.genesis = { on: () => {} }; }, 100);
    const start = Date.now();
    await fn(2000);
    const elapsed = Date.now() - start;
    assert(elapsed >= 90, 'should not resolve before bridge appears, took ' + elapsed + 'ms');
    assert(elapsed < 300, 'should resolve shortly after bridge appears, took ' + elapsed + 'ms');
  });

  test('C3: rejects with descriptive error when bridge never arrives', async () => {
    const fnSource = loadWaitForBridge();
    const fakeWindow = {};
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'setTimeout', 'Date',
      fnSource + '\nreturn waitForBridge;')(fakeWindow, setTimeout, Date);
    let rejected = false;
    let errMsg = '';
    try {
      await fn(150);  // tiny timeout
    } catch (err) {
      rejected = true;
      errMsg = err.message || String(err);
    }
    assert(rejected, 'should reject when bridge never arrives');
    assert(/initialize|bridge|genesis|preload/i.test(errMsg),
      'rejection message should mention bridge/preload context, got: ' + errMsg);
  });

  test('C4: rejects when window.genesis exists but lacks .on (partial bridge)', async () => {
    const fnSource = loadWaitForBridge();
    // Bridge exists but is broken (no .on method)
    const fakeWindow = { genesis: { invoke: () => {} /* no on */ } };
    // eslint-disable-next-line no-new-func
    const fn = new Function('window', 'setTimeout', 'Date',
      fnSource + '\nreturn waitForBridge;')(fakeWindow, setTimeout, Date);
    let rejected = false;
    try {
      await fn(150);
    } catch (_e) {
      rejected = true;
    }
    assert(rejected, 'should reject when window.genesis lacks .on method');
  });
});

run();
