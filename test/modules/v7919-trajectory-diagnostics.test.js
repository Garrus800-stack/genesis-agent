#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7919-trajectory-diagnostics.test.js
//
// v7.9.19 Tier 1 — the read-only diagnostics on SelfTrajectory
// (the entry owner), surfaced in /trajectory calibration:
//
//   1. Refuse run-length — consecutive REFUSE_TOKEN per field,
//      counted from the latest entry backwards; < min no pattern,
//      = min a pattern; reset by a non-refuse value in between;
//      per-field independent; all six fields; empty / single-entry
//      journals clean.
//   2. Wallclock age — whole days from the latest wallclock_end;
//      empty journal → null; NO threshold/marker is computed
//      (the result is a bare number, deliberately ceiling-free);
//      a future-dated entry clamps to 0.
//   3. Diagnose invariant — getDiagnostics() emits nothing on the
//      bus and creates/touches no draft, and never appends an entry
//      (no auto-close).
//
// Storage is a real StorageService rooted at a throwaway temp dir;
// entries are synthetic journal lines. The clock is injected so the
// age arithmetic is deterministic.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, assertDeepEqual, run } =
  require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { StorageService } = require(path.join(ROOT, 'src/agent/foundation/StorageService'));
const ST = require(path.join(ROOT, 'src/agent/cognitive/SelfTrajectory'));
const { SelfTrajectory, FIELD_NAMES, REFUSE_TOKEN, REFUSE_RUN_PATTERN_MIN, JOURNAL_FILE } = ST;

const NOW = Date.parse('2026-05-30T12:00:00.000Z');

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'st-diag-'));
}

function freshST() {
  const dir = freshDir();
  const storage = new StorageService(dir);
  const st = new SelfTrajectory({ storage, clock: { now: () => NOW } });
  return { st, storage };
}

// Build a synthetic committed entry. `over` overrides specific field
// values; everything else defaults to a plain non-refuse string.
function entryLine(n, ageDays, over = {}) {
  const fields = {};
  for (const k of FIELD_NAMES) fields[k] = 'x';
  Object.assign(fields, over);
  return JSON.stringify({
    cycle_id: `2026-05-01.cycle.${n}`,
    schema_version: 1,
    wallclock_start: '2026-05-01T00:00:00.000Z',
    wallclock_end: new Date(NOW - ageDays * 86400000).toISOString(),
    event_count: null,
    author: ['genesis'],
    first_entry: n === 1,
    fields,
    genesis_note: '',
    garrus_note: '',
    editing_history: [],
    late_notes: [],
  }) + '\n';
}

// Seed a journal from oldest to newest. specs: [{ageDays, over}]
function seed(storage, specs) {
  specs.forEach((s, i) => storage.appendText(JOURNAL_FILE, entryLine(i + 1, s.ageDays, s.over || {})));
}

describe('v7.9.19 — refuse run-length diagnosis', () => {
  test('empty journal → every field run 0, no pattern', () => {
    const { st } = freshST();
    const d = st.getDiagnostics();
    for (const f of FIELD_NAMES) assertEqual(d.refuseRuns[f], 0, `${f} run 0`);
  });

  test('all six fields are present in refuseRuns', () => {
    const { st, storage } = freshST();
    seed(storage, [{ ageDays: 1 }]);
    const keys = Object.keys(st.getDiagnostics().refuseRuns).sort();
    assertDeepEqual(keys, [...FIELD_NAMES].sort(), 'six field keys');
  });

  test('single-entry journal with a refuse → run 1, below pattern', () => {
    const { st, storage } = freshST();
    seed(storage, [{ ageDays: 2, over: { schwaeche: REFUSE_TOKEN } }]);
    const d = st.getDiagnostics();
    assertEqual(d.refuseRuns.schwaeche, 1, 'run 1');
    assert(1 < d.refusePatternMin, '1 is below the pattern marker');
  });

  test('two consecutive refuses → run 2, NOT a pattern (< min)', () => {
    const { st, storage } = freshST();
    seed(storage, [
      { ageDays: 5, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 3, over: { schwaeche: REFUSE_TOKEN } },
    ]);
    const d = st.getDiagnostics();
    assertEqual(d.refuseRuns.schwaeche, 2, 'run 2');
    assert(d.refuseRuns.schwaeche < d.refusePatternMin, '2 < min → no pattern');
  });

  test('three consecutive refuses → run 3, IS a pattern (= min)', () => {
    const { st, storage } = freshST();
    seed(storage, [
      { ageDays: 7, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 5, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 3, over: { schwaeche: REFUSE_TOKEN } },
    ]);
    const d = st.getDiagnostics();
    assertEqual(d.refuseRuns.schwaeche, 3, 'run 3');
    assertEqual(d.refusePatternMin, REFUSE_RUN_PATTERN_MIN, 'marker surfaced');
    assert(d.refuseRuns.schwaeche >= d.refusePatternMin, '3 >= min → pattern');
  });

  test('a non-refuse value in between resets the run (counts only the trailing streak)', () => {
    const { st, storage } = freshST();
    // oldest → newest: refuse, refuse, NON-refuse, refuse, refuse
    seed(storage, [
      { ageDays: 9, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 7, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 5, over: { schwaeche: 'a normal answer' } },
      { ageDays: 3, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 1, over: { schwaeche: REFUSE_TOKEN } },
    ]);
    // trailing streak is 2, not 4 — the middle non-refuse breaks it.
    assertEqual(st.getDiagnostics().refuseRuns.schwaeche, 2, 'trailing streak only');
  });

  test('runs are independent per field', () => {
    const { st, storage } = freshST();
    seed(storage, [
      { ageDays: 5, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 3, over: { schwaeche: REFUSE_TOKEN, traits: REFUSE_TOKEN } },
      { ageDays: 1, over: { schwaeche: REFUSE_TOKEN } },
    ]);
    const d = st.getDiagnostics();
    assertEqual(d.refuseRuns.schwaeche, 3, 'schwaeche unbroken → 3');
    assertEqual(d.refuseRuns.traits, 0, 'traits broken by latest non-refuse → 0');
    assertEqual(d.refuseRuns.wachstum, 0, 'wachstum never → 0');
  });
});

describe('v7.9.19 — wallclock age (ceiling-free)', () => {
  test('empty journal → lastEntryAgeDays is null', () => {
    const { st } = freshST();
    assertEqual(st.getDiagnostics().lastEntryAgeDays, null, 'null age');
  });

  test('age is the whole-day difference from the latest wallclock_end', () => {
    const { st, storage } = freshST();
    seed(storage, [{ ageDays: 10 }, { ageDays: 4 }]); // latest is 4 days old
    assertEqual(st.getDiagnostics().lastEntryAgeDays, 4, 'age = 4');
  });

  test('a future-dated entry clamps to 0 (no negative age)', () => {
    const { st, storage } = freshST();
    seed(storage, [{ ageDays: -2 }]); // wallclock_end 2 days in the future
    assertEqual(st.getDiagnostics().lastEntryAgeDays, 0, 'clamped to 0');
  });

  test('NO threshold/marker is computed for age — result keys are exactly the three', () => {
    const { st, storage } = freshST();
    seed(storage, [{ ageDays: 99 }]); // far past any conceivable ceiling
    const d = st.getDiagnostics();
    const keys = Object.keys(d).sort();
    assertDeepEqual(keys, ['lastEntryAgeDays', 'refusePatternMin', 'refuseRuns'],
      'no age-threshold/marker key — ceiling-free by construction');
    assertEqual(typeof d.lastEntryAgeDays, 'number', 'age is a bare number');
  });
});

describe('v7.9.19 — diagnose invariant (strictly observational)', () => {
  test('getDiagnostics emits nothing on the bus, touches no draft, appends no entry', () => {
    const dir = freshDir();
    const storage = new StorageService(dir);
    const fired = [];
    const recordingBus = {
      fire: (...a) => fired.push(a),
      emit: (...a) => fired.push(a),
      on: () => {},
    };
    const st = new SelfTrajectory({ storage, bus: recordingBus, clock: { now: () => NOW } });
    seed(storage, [
      { ageDays: 3, over: { schwaeche: REFUSE_TOKEN } },
      { ageDays: 1, over: { schwaeche: REFUSE_TOKEN } },
    ]);
    const before = storage.readText(JOURNAL_FILE, '');
    assert(!st.hasDraft(), 'no draft before');

    st.getDiagnostics();
    st.getDiagnostics(); // twice — must stay pure

    assertEqual(fired.length, 0, 'no bus fire/emit during diagnostics');
    assert(!st.hasDraft(), 'no draft created');
    assertEqual(storage.readText(JOURNAL_FILE, ''), before, 'journal unchanged (no auto-close)');
  });
});

if (require.main === module) run();
