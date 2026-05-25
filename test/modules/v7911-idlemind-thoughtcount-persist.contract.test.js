#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7911-idlemind-thoughtcount-persist.contract.test.js
//
// v7.9.11: IdleMindActivityStats persists thoughtCount alongside
// activityCounts. Pre-fix the dashboard showed "0 thoughts" next to
// stored activity counts in double digits. Save and load now keep
// both, with a legacy-file fallback to sum(activityCounts.values()).
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const os = require('os');
const fs = require('fs');

// STATS_FILE constant in IdleMindActivityStats.js is 'idle-activity-stats.json'
// (verified by grep before writing this test — see plan v4 Pre-flight check).
const STATS_FILE = 'idle-activity-stats.json';

// Minimal storage stub matching the StorageService API used by
// IdleMindActivityStats: writeJSONDebounced (sync write here for
// deterministic testing) and readJSON.
function makeMockStorage() {
  const files = new Map();
  return {
    files,
    writeJSONDebounced(filename, payload /* , _debounceMs */) {
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

const tmpDir = path.join(os.tmpdir(), `genesis-thoughtcount-${Date.now()}`);
fs.mkdirSync(tmpDir, { recursive: true });

const { IdleMind } = require('../../src/agent/autonomy/IdleMind');
const { createBus } = require('../../src/agent/core/EventBus');

function makeIdle(storage) {
  const bus = createBus();
  return new IdleMind({
    bus,
    model: null,
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

describe('v7.9.11 — IdleMind thoughtCount persistence', () => {

  test('save+load preserves thoughtCount across instances', () => {
    const storage = makeMockStorage();

    const idle1 = makeIdle(storage);
    idle1.thoughtCount = 42;
    // _recordActivity triggers _saveActivityStats
    idle1._recordActivity('explore', { output: 'mock' });
    idle1._recordActivity('reflect', { output: 'mock' });

    const saved = storage.files.get(STATS_FILE);
    assert(saved, `stats file written under name '${STATS_FILE}'`);
    assertEqual(saved.thoughtCount, 42, 'thoughtCount persisted as 42');

    const idle2 = makeIdle(storage);
    assertEqual(idle2.thoughtCount, 42, 'thoughtCount restored after restart');
    assertEqual(idle2._activityCounts.get('explore'), 1, 'activityCounts also restored (explore)');
    assertEqual(idle2._activityCounts.get('reflect'), 1, 'activityCounts also restored (reflect)');
  });

  test('legacy stats file without thoughtCount falls back to sum of activityCounts', () => {
    const storage = makeMockStorage();

    // Pre-v7.9.11 stats file: no thoughtCount field. These numbers match
    // Garrus's Win field-trace 2026-05-25: explore 5 · ideate 5 · reflect 4 ·
    // plan 4 · research 4 = 22.
    storage.writeJSONDebounced(STATS_FILE, {
      version: 1,
      lastUpdated: Date.now(),
      // NOTE: deliberately NO thoughtCount field
      activityCounts: {
        explore: 5,
        ideate: 5,
        reflect: 4,
        plan: 4,
        research: 4,
      },
      activityLog: [],
    });

    const idle = makeIdle(storage);
    assertEqual(idle.thoughtCount, 22, 'thoughtCount fallback = sum(activityCounts.values())');
  });

  test('save writes thoughtCount=0 explicitly even on fresh stats', () => {
    const storage = makeMockStorage();
    const idle = makeIdle(storage);
    assertEqual(idle.thoughtCount, 0, 'fresh constructor: thoughtCount=0');

    idle._recordActivity('ideate', { output: 'mock' });

    const saved = storage.files.get(STATS_FILE);
    assert(saved, 'stats file written');
    assertEqual(typeof saved.thoughtCount, 'number', 'thoughtCount is a number');
    assertEqual(saved.thoughtCount, 0, 'thoughtCount serialised as 0 (not undefined or missing)');
  });

});

if (require.main === module) run();
