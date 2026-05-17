// ============================================================
// GENESIS — test/modules/v790-koennen-ui-fields.contract.test.js
// Contract: v7.9.0 Phase 2 Können settings UI fields are registered
// in FIELD_REGISTRY (settings-defaults.js) and visible in the GUI
// (index.html). Without this, the toggles only work via the
// /settings slash and Garrus has to remember the dotted paths.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');

const ROOT = path.resolve(__dirname, '..', '..');
const { FIELD_REGISTRY } = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'src/ui/index.html'), 'utf8');
const LOADSAVE = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings-loadsave.js'), 'utf8');

const EXPECTED = {
  'set-koennen-enabled':              'cognitive.koennen.enabled',
  'set-koennen-cryst-enabled':        'cognitive.koennen.crystallization.enabled',
  'set-koennen-cryst-min-candidates': 'cognitive.koennen.crystallization.minCandidatesPerPattern',
  'set-koennen-cryst-cooldown-ms':    'cognitive.koennen.crystallization.cooldownMs',
};

describe('koennen-crystallizer-v790 contract: Können UI fields', () => {
  test('koennen-crystallizer-v790 contract: all four field IDs are registered with correct path', () => {
    for (const [id, expectedPath] of Object.entries(EXPECTED)) {
      const entry = FIELD_REGISTRY[id];
      assert(entry, `FIELD_REGISTRY is missing ${id}`);
      assertEqual(entry.settingsPath, expectedPath,
        `${id} should map to ${expectedPath}`);
    }
  });

  test('koennen-crystallizer-v790 contract: all four field IDs appear in index.html', () => {
    for (const id of Object.keys(EXPECTED)) {
      assert(INDEX_HTML.includes(`id="${id}"`),
        `index.html is missing <input id="${id}">`);
    }
  });

  test('koennen-crystallizer-v790 contract: Können section header is present in HTML', () => {
    assert(/settings\.section\.koennen/.test(INDEX_HTML),
      'HTML must declare a "Können-Konzept" section divider');
  });

  test('koennen-crystallizer-v790 contract: load handler wires all four fields', () => {
    for (const id of Object.keys(EXPECTED)) {
      assert(LOADSAVE.includes(`#${id}`),
        `settings-loadsave.js does not reference #${id}`);
    }
  });
});

run();
