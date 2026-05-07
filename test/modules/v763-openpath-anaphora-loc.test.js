// ============================================================
// GENESIS — test/modules/v763-openpath-anaphora-loc.test.js
//
// Regression test for v7.6.3 Bug A + Bug B from the erweiterte
// Analyse-report.
//
// Bug A (anaphora-collision): "öffne urlaub folder auf dem dokumente"
//   Before: matched the doc-anaphora pattern (POSSESSIVE='dem'+'dokumente')
//           and resolved to <rootDir>/docs.
//   After:  location-suffix detection skips the anaphora-loop, so the
//           alias-resolver below picks up `dokumente` → ~/Documents/urlaub.
//
// Bug B (genesis-anaphora swallows location): "zeig genesis-ordner auf
// dem desktop"
//   Before: matched the genesis-anaphora pattern and returned <rootDir>,
//           ignoring the desktop suffix.
//   After:  location-suffix detection skips the anaphora-loop, so the
//           alias-resolver picks up `desktop` → ~/Desktop/genesis.
//
// Both share a single fix: detect the pattern "auf|in|unter|on|im
// (dem|den|der|de|the) <known-alias>" and skip anaphora when present.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const { describe, test, assert, run } = require('../harness');

const ROOT = path.resolve(__dirname, '..', '..');

function makeMockCtx({ rootDir = '/tmp/genesis-fake-root' } = {}) {
  const calls = [];
  return {
    shell: {
      run: async (cmd, _opts) => {
        calls.push(cmd);
        return { ok: true, exitCode: 0, stdout: '', stderr: '' };
      },
    },
    lang: { t: (k) => k },
    fp: { rootDir },
    _calls: calls,
  };
}

// extract the path argument from `xdg-open "..."` / `open "..."` / `explorer "..."`
function extractedPath(cmd) {
  const m = cmd.match(/^[a-z-]+\s+"(.+)"$/);
  return m ? m[1] : null;
}

const { commandHandlersShell } = require(
  path.join(ROOT, 'src/agent/hexagonal/CommandHandlersShell.js'));

describe('v7.6.3 Bug A — anaphora yields to location-suffix (dokumente alias)', () => {

  test('source-presence: hasLocationSuffix gate guards anaphora-loop', () => {
    const src = fs.readFileSync(
      path.join(ROOT, 'src/agent/hexagonal/CommandHandlersShell.js'), 'utf8');
    assert(/hasLocationSuffix/.test(src),
      'hasLocationSuffix gate must be present');
    assert(/if \(!hasLocationSuffix\)/.test(src),
      'anaphora-loop must be guarded by !hasLocationSuffix');
    assert(/dokumente|documents/.test(src),
      'alias list must include dokumente / documents');
  });

  test('behavior: location-suffix regex distinguishes loc-suffix from anaphora', () => {
    const FOLDER_ALIAS_RE = '(?:desktop|schreibtisch|downloads?|dokumente|documents?|bilder|pictures?|musik|music|home)';
    const re = new RegExp(
      `\\b(?:auf|in|unter|on|im)\\s+(?:dem|den|der|de|the)\\s+${FOLDER_ALIAS_RE}\\b`, 'i');

    assert(re.test('öffne urlaub folder auf dem dokumente'),
      'bug A trigger must be detected');
    assert(re.test('öffne urlaub folder auf dem desktop'),
      'desktop alias loc-suffix');
    assert(re.test('öffne urlaub folder auf dem documents'),
      'documents alias loc-suffix');
    assert(re.test('öffne urlaub folder auf dem downloads'),
      'downloads alias loc-suffix');
    assert(re.test('öffne urlaub folder auf dem schreibtisch'),
      'schreibtisch alias loc-suffix');

    assert(!re.test('zeig mir das genesis-ordner'),
      'anaphora-only must not trigger loc-skip');
    assert(!re.test('öffne mir mein dokumente ordner'),
      'plain anaphora must not trigger loc-skip');
    assert(!re.test('öffne mir docs folder'),
      'docs anaphora must not trigger loc-skip');
  });

  test('end-to-end Bug A: "öffne urlaub folder auf dem dokumente" → ~/Documents/urlaub', async () => {
    const ctx = makeMockCtx();
    const realExists = fs.existsSync;
    fs.existsSync = () => true;
    try {
      await commandHandlersShell.openPath.call(ctx, 'öffne urlaub folder auf dem dokumente');
      assert(ctx._calls.length === 1, `expected 1 shell.run call, got ${ctx._calls.length}`);
      const opened = extractedPath(ctx._calls[0]);
      const expected = path.join(os.homedir(), 'Documents', 'urlaub');
      assert(opened === expected, `expected ${expected}, got ${opened}`);
    } finally {
      fs.existsSync = realExists;
    }
  });
});

describe('v7.6.3 Bug B — genesis-anaphora yields to location-suffix', () => {

  test('end-to-end Bug B: "zeig mir das genesis-ordner auf dem desktop" → ~/Desktop/genesis', async () => {
    const ctx = makeMockCtx();
    const realExists = fs.existsSync;
    fs.existsSync = () => true;
    try {
      await commandHandlersShell.openPath.call(ctx, 'zeig mir das genesis-ordner auf dem desktop');
      assert(ctx._calls.length === 1, `expected 1 shell.run call, got ${ctx._calls.length}`);
      const opened = extractedPath(ctx._calls[0]);
      const expected = path.join(os.homedir(), 'Desktop', 'genesis');
      assert(opened === expected, `expected ${expected}, got ${opened}`);
    } finally {
      fs.existsSync = realExists;
    }
  });

  test('regression: "zeig mir das genesis-ordner" (no location) still → rootDir', async () => {
    const ctx = makeMockCtx({ rootDir: '/tmp/genesis-fake-root' });
    const realExists = fs.existsSync;
    fs.existsSync = () => true;
    try {
      await commandHandlersShell.openPath.call(ctx, 'zeig mir das genesis-ordner');
      assert(ctx._calls.length === 1, `expected 1 shell.run call, got ${ctx._calls.length}`);
      const opened = extractedPath(ctx._calls[0]);
      assert(opened === '/tmp/genesis-fake-root', `expected rootDir, got ${opened}`);
    } finally {
      fs.existsSync = realExists;
    }
  });

  test('regression: "öffne mir mein dokumente ordner" (no location) still → rootDir/docs', async () => {
    const ctx = makeMockCtx({ rootDir: '/tmp/genesis-fake-root' });
    const realExists = fs.existsSync;
    fs.existsSync = () => true;
    try {
      await commandHandlersShell.openPath.call(ctx, 'öffne mir mein dokumente ordner');
      assert(ctx._calls.length === 1, `expected 1 shell.run call, got ${ctx._calls.length}`);
      const opened = extractedPath(ctx._calls[0]);
      const expected = path.join('/tmp/genesis-fake-root', 'docs');
      assert(opened === expected, `expected ${expected}, got ${opened}`);
    } finally {
      fs.existsSync = realExists;
    }
  });
});

run();
