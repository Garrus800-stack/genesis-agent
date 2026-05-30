#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7915-idlemind-thoughtcount-skip-persist.contract.test.js
//
// v7.9.15: thoughtCount is persisted the moment it increments, before
// the early-exit gates in _think() can return.
//
// Background: v7.9.11 made IdleMindActivityStats persist thoughtCount,
// but the only save path was _recordActivity at the END of a fully
// completed cycle. _think() increments thoughtCount near the top, then
// passes through three early-exit gates (user-active <60s,
// homeostasis-block, low-energy). A cycle that increments and then hits
// any of those gates returned without ever calling _recordActivity, so
// the increment was never persisted. A short session (idle threshold
// reached, a couple of gated cycles, then close) wrote the stats file
// zero times — next boot showed thoughtCount 0 despite real cycles.
//
// The fix: _think() calls _saveActivityStats() immediately after the
// increment. This test drives _think() into each early-exit gate and
// asserts the counter is persisted anyway.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

const STATS_FILE = 'idle-activity-stats.json';

// Storage stub matching the StorageService API used by
// IdleMindActivityStats. writeJSONDebounced writes synchronously here
// for deterministic assertions; it also counts calls so the test can
// prove the save path fired during a skipped cycle.
function makeMockStorage() {
  const files = new Map();
  let writeCount = 0;
  return {
    files,
    get writeCount() { return writeCount; },
    writeJSONDebounced(filename, payload /* , _debounceMs */) {
      writeCount++;
      files.set(filename, JSON.parse(JSON.stringify(payload)));
    },
    writeJSON(filename, payload) {
      files.set(filename, JSON.parse(JSON.stringify(payload)));
    },
    readJSON(filename, fallback) {
      return files.has(filename) ? files.get(filename) : fallback;
    },
    readText(filename, fallback) {
      return files.has(filename) ? JSON.stringify(files.get(filename)) : fallback;
    },
    appendText() { /* journal — not relevant here */ },
  };
}

const tmpDir = path.join(os.tmpdir(), `genesis-thoughtcount-skip-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { IdleMind } = require('../../src/agent/autonomy/IdleMind');
const { createBus } = require('../../src/agent/core/EventBus');

// Fake model that passes the activeModel guard and is never "all unavailable",
// so _think() reaches the thoughtCount increment.
function makeModel() {
  return { activeModel: 'fake-model', areAllModelsUnavailable() { return false; } };
}

function makeIdle(storage) {
  const bus = createBus();
  return new IdleMind({
    bus,
    model: makeModel(),
    prompts: null,
    selfModel: null,
    memory: null,
    knowledgeGraph: null,
    eventStore: null,
    storageDir: tmpDir,
    goalStack: null,
    intervals: null,
    storage,
  });
}

describe('v7.9.15 — thoughtCount persists through early-exit gates', () => {

  test('user-active gate: a skipped cycle still persists the counter', async () => {
    const storage = makeMockStorage();
    const idle = makeIdle(storage);
    // user was just active → timeSinceUser < 60s → _think() takes the
    // user-active early-exit, never reaching _recordActivity.
    idle.lastUserActivity = Date.now();

    await idle._think();

    assertEqual(idle.thoughtCount, 1, 'thoughtCount incremented even though the cycle was skipped');
    const saved = storage.files.get(STATS_FILE);
    assert(saved, 'stats file was written during the skipped cycle (pre-fix: never written)');
    assertEqual(saved.thoughtCount, 1, 'persisted thoughtCount is 1');
  });

  test('homeostasis-block gate: a skipped cycle still persists the counter', async () => {
    const storage = makeMockStorage();
    const idle = makeIdle(storage);
    // user idle long enough to pass the user-active gate ...
    idle.lastUserActivity = Date.now() - 120000;
    // ... but homeostasis blocks autonomy → early-exit at the next gate.
    idle._homeostasis = { isAutonomyAllowed() { return false; }, getState() { return 'blocked'; } };

    await idle._think();

    assertEqual(idle.thoughtCount, 1, 'thoughtCount incremented before the homeostasis gate returned');
    const saved = storage.files.get(STATS_FILE);
    assert(saved, 'stats file was written despite the homeostasis block');
    assertEqual(saved.thoughtCount, 1, 'persisted thoughtCount is 1');
  });

  test('repeated skipped cycles each persist (short-session boot scenario)', async () => {
    const storage = makeMockStorage();
    const idle = makeIdle(storage);
    idle.lastUserActivity = Date.now(); // every cycle hits the user-active skip

    await idle._think();
    await idle._think();
    await idle._think();

    assertEqual(idle.thoughtCount, 3, 'three skipped cycles increment to 3');
    const saved = storage.files.get(STATS_FILE);
    assertEqual(saved.thoughtCount, 3, 'on-disk counter reflects all three (would be 0 pre-fix)');
    // a fresh instance reading the same storage restores the count
    const idle2 = makeIdle(storage);
    assertEqual(idle2.thoughtCount, 3, 'next boot restores thoughtCount=3 from disk');
  });

  test('rest-mode tick (all models unavailable) does NOT inflate or persist', async () => {
    const storage = makeMockStorage();
    const idle = makeIdle(storage);
    idle.lastUserActivity = Date.now() - 120000;
    // all models unavailable → _think() enters rest-mode and returns BEFORE
    // the increment, so the counter must not move and nothing is persisted.
    idle.model = { activeModel: 'fake-model', areAllModelsUnavailable() { return true; } };

    await idle._think();

    assertEqual(idle.thoughtCount, 0, 'rest-mode tick is the absence of a cycle — counter stays 0');
    assert(!storage.files.has(STATS_FILE), 'no stats write for a rest-mode tick');
  });

});

if (require.main === module) run();
