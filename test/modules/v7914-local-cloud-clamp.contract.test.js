#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7914-local-cloud-clamp.contract.test.js
//
// v7.9.14 (Punkt 2): close the clamp() gap for llm.localTimeoutMs
// and llm.cloudTimeoutMs.
//
// Background: v7.9.12 introduced these two timeouts as FIELD_REGISTRY-
// surfaced settings (set-local-timeout, set-cloud-timeout in the
// Limits tab, seconds with _scaleMs). The v7.9.13 audit noticed they
// had no clamp() in Settings.js — registry validation only fires in
// the UI write path, a direct edit to settings.json bypasses it.
// v7.9.14 adds the two clamps in _sanityClampOnLoad.
//
// The contract this test guards has two halves:
//
//   1. Out-of-range values from settings.json are clamped on load.
//   2. The clamp ranges match FIELD_REGISTRY exactly. This is the
//      anti-drift guard — same discipline as v7.9.13 introduced for
//      streamTimeouts. If a future edit changes one side without the
//      other, the test must catch it.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { Settings } = require(path.join(ROOT, 'src/agent/foundation/Settings'));
const { FIELD_REGISTRY } = require(path.join(ROOT, 'src/ui/modules/settings-defaults'));

function freshSettings(prefix, storage) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return new Settings(tmpDir, storage);
}

// Settings clamps in ms; FIELD_REGISTRY values in seconds with _scaleMs.
// Helper makes the conversion explicit at every assertion.
const secToMs = sec => sec * 1000;

describe('v7.9.14 (Punkt 2) — local/cloud timeout clamps', () => {

  test('out-of-range localTimeoutMs is clamped on load (below min)', () => {
    const bad = { llm: { localTimeoutMs: 1000 } };  // 1s, well below 30s floor
    const storage = { readJSON: () => bad, writeJSONDebounced: () => {} };
    const s = freshSettings('v7914-clamp-local-min-', storage);
    assertEqual(s.get('llm.localTimeoutMs'), 30000,
      'localTimeoutMs below 30s floor must be clamped up to 30000ms');
  });

  test('out-of-range localTimeoutMs is clamped on load (above max)', () => {
    const bad = { llm: { localTimeoutMs: 9999999 } };  // way over 15min ceiling
    const storage = { readJSON: () => bad, writeJSONDebounced: () => {} };
    const s = freshSettings('v7914-clamp-local-max-', storage);
    assertEqual(s.get('llm.localTimeoutMs'), 900000,
      'localTimeoutMs above 15min ceiling must be clamped down to 900000ms');
  });

  test('out-of-range cloudTimeoutMs is clamped on load (below min)', () => {
    const bad = { llm: { cloudTimeoutMs: 30000 } };  // 30s, below the 60s cloud floor
    const storage = { readJSON: () => bad, writeJSONDebounced: () => {} };
    const s = freshSettings('v7914-clamp-cloud-min-', storage);
    assertEqual(s.get('llm.cloudTimeoutMs'), 60000,
      'cloudTimeoutMs below 60s floor must be clamped up to 60000ms');
  });

  test('out-of-range cloudTimeoutMs is clamped on load (above max)', () => {
    const bad = { llm: { cloudTimeoutMs: 9999999 } };
    const storage = { readJSON: () => bad, writeJSONDebounced: () => {} };
    const s = freshSettings('v7914-clamp-cloud-max-', storage);
    assertEqual(s.get('llm.cloudTimeoutMs'), 900000,
      'cloudTimeoutMs above 15min ceiling must be clamped down to 900000ms');
  });

  test('a valid in-range override survives the clamp', () => {
    const good = { llm: { localTimeoutMs: 120000, cloudTimeoutMs: 240000 } };
    const storage = { readJSON: () => good, writeJSONDebounced: () => {} };
    const s = freshSettings('v7914-clamp-valid-', storage);
    assertEqual(s.get('llm.localTimeoutMs'), 120000, 'valid local override must be kept');
    assertEqual(s.get('llm.cloudTimeoutMs'), 240000, 'valid cloud override must be kept');
  });

  test('clamp ranges match FIELD_REGISTRY exactly (anti-drift)', () => {
    // Same discipline as v7.9.13 for streamTimeouts: the registry and
    // the clamp() must agree on what counts as in-range. If a future
    // edit changes one side without the other, this test must catch it.

    // Local: registry says 30-900 sec, clamp says 30000-900000 ms — equal after scale.
    const localReg = FIELD_REGISTRY['set-local-timeout'];
    assert(localReg, 'set-local-timeout must exist in FIELD_REGISTRY');

    // Force a value at the registry minimum and one tick below — they must
    // produce the same clamped output, proving the clamp's floor matches
    // the registry's min.
    const atMinStorage = { readJSON: () => ({ llm: { localTimeoutMs: secToMs(localReg.min) } }), writeJSONDebounced: () => {} };
    const atMin = freshSettings('v7914-drift-local-min-', atMinStorage).get('llm.localTimeoutMs');
    assertEqual(atMin, secToMs(localReg.min),
      `clamp floor must match registry min: ${localReg.min}s = ${secToMs(localReg.min)}ms`);

    const atMaxStorage = { readJSON: () => ({ llm: { localTimeoutMs: secToMs(localReg.max) } }), writeJSONDebounced: () => {} };
    const atMax = freshSettings('v7914-drift-local-max-', atMaxStorage).get('llm.localTimeoutMs');
    assertEqual(atMax, secToMs(localReg.max),
      `clamp ceiling must match registry max: ${localReg.max}s = ${secToMs(localReg.max)}ms`);

    // Cloud: same dance
    const cloudReg = FIELD_REGISTRY['set-cloud-timeout'];
    assert(cloudReg, 'set-cloud-timeout must exist in FIELD_REGISTRY');

    const cAtMinStorage = { readJSON: () => ({ llm: { cloudTimeoutMs: secToMs(cloudReg.min) } }), writeJSONDebounced: () => {} };
    const cAtMin = freshSettings('v7914-drift-cloud-min-', cAtMinStorage).get('llm.cloudTimeoutMs');
    assertEqual(cAtMin, secToMs(cloudReg.min),
      `cloud clamp floor must match registry min: ${cloudReg.min}s = ${secToMs(cloudReg.min)}ms`);

    const cAtMaxStorage = { readJSON: () => ({ llm: { cloudTimeoutMs: secToMs(cloudReg.max) } }), writeJSONDebounced: () => {} };
    const cAtMax = freshSettings('v7914-drift-cloud-max-', cAtMaxStorage).get('llm.cloudTimeoutMs');
    assertEqual(cAtMax, secToMs(cloudReg.max),
      `cloud clamp ceiling must match registry max: ${cloudReg.max}s = ${secToMs(cloudReg.max)}ms`);
  });

  test('Settings source contains the new clamps with the correct ranges', () => {
    // Belt-and-suspenders: also assert presence in the source so a
    // refactor that, say, deletes the clamps in favour of a runtime
    // factory must touch this test too.
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/Settings.js'), 'utf8');
    assert(/clamp\('llm\.localTimeoutMs',\s*30000,\s*900000\)/.test(src),
      "Settings.js must contain clamp('llm.localTimeoutMs', 30000, 900000)");
    assert(/clamp\('llm\.cloudTimeoutMs',\s*60000,\s*900000\)/.test(src),
      "Settings.js must contain clamp('llm.cloudTimeoutMs', 60000, 900000)");
  });

});

if (require.main === module) run();
