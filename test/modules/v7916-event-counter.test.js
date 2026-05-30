#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7916-event-counter.test.js
//
// v7.9.16 (EventCounter: passive significant-event observer).
// Covers the service in isolation against a real EventBus and a
// real StorageService rooted at a throwaway temp dir:
//
//   1. Record & count — each observed event type appends a journal
//      line; the three goal outcomes stay as three separate tags;
//      session:ending carries durationMs; planner:complete is NOT
//      counted; counts are additive.
//   2. Half-open window — countSince(ts) counts only ts > since;
//      an event exactly at the boundary is excluded.
//   3. Crash-safety & restart — the count survives a fresh instance
//      on the same dir (journal is the only state, read on demand);
//      an append is durable immediately, no flush needed.
//   4. Lifecycle & dashboard — stop() unsubscribes; summary().byDay
//      buckets by date; double start does not double-subscribe; a
//      corrupt journal line is skipped defensively; constructor
//      requires storage.
//
// Offline by construction: no model, no Electron. A controllable
// clock lets the window tests place events at exact timestamps.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, assertThrows, run } =
  require('../harness');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { StorageService } = require(path.join(ROOT, 'src/agent/foundation/StorageService'));
const { createBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));
const { EventCounter, JOURNAL_FILE } = require(path.join(ROOT, 'src/agent/cognitive/EventCounter'));
const { SelfTrajectory, FIELD_NAMES } = require(path.join(ROOT, 'src/agent/cognitive/SelfTrajectory'));
const { commandHandlersTrajectory } = require(path.join(ROOT, 'src/agent/hexagonal/CommandHandlersTrajectory'));

const FAKE_GENOME = { getTraits: () => ({
  curiosity: 0.6, caution: 0.5, verbosity: 0.5, riskTolerance: 0.3,
  socialDrive: 0.5, consolidation: 0.6, selfAwareness: 0.5,
}) };
const FAKE_LESSONS = { getAll: () => ([{ insight: 'A', useCount: 9 }]) };
const FAKE_CSM = { buildPromptContext: () => 'Capability floor: CODE 70%.' };

async function commitEntryLocal(st, suffix) {
  await st.generateDraft();
  for (const k of FIELD_NAMES) st.setDraftField(k, `${suffix}-${k}`);
  st.setDraftNote('genesis', `${suffix}-gn`);
  st.setDraftNote('garrus', `${suffix}-hn`);
  return st.commit();
}

// ── fixtures ────────────────────────────────────────────────

function freshDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ec-test-'));
}

function freshEC({ clockRef = null } = {}) {
  const dir = freshDir();
  const storage = new StorageService(dir);
  const bus = createBus();
  const clock = clockRef || Date;
  const ec = new EventCounter({ bus, storage, clock });
  return { dir, storage, bus, ec, clock };
}

// ── 1. Record & count ───────────────────────────────────────

describe('EventCounter — record & count', () => {
  test('records each observed event type as a journal line', async () => {
    const { bus, ec } = freshEC();
    ec.start();
    await bus.emit('goal:completed', { id: 'g1', description: 'x' });
    await bus.emit('goal:failed', { id: 'g2' });
    await bus.emit('goal:abandoned', { id: 'g3' });
    await bus.emit('lessons:recorded', {});
    await bus.emit('emotion:watchdog-reset', {});
    await bus.emit('emotion:watchdog-alert', {});
    await bus.emit('session:ending', { sessionId: 's1', durationMs: 700000 });
    assertEqual(ec.countSince(null), 7, 'all 7 observed events recorded');
  });

  test('the three goal outcomes are three separate tags, not one bucket', async () => {
    const { bus, ec } = freshEC();
    ec.start();
    await bus.emit('goal:completed', { id: 'a', description: 'd' });
    await bus.emit('goal:failed', { id: 'b' });
    await bus.emit('goal:abandoned', { id: 'c' });
    const s = ec.summary();
    assertEqual(s.byType['goal:completed'], 1, 'goal:completed tagged');
    assertEqual(s.byType['goal:failed'], 1, 'goal:failed tagged separately');
    assertEqual(s.byType['goal:abandoned'], 1, 'goal:abandoned tagged separately');
    assertEqual(s.total, 3, 'summary total matches');
  });

  test('session:ending carries durationMs into the journal line', async () => {
    const { bus, ec, storage } = freshEC();
    ec.start();
    await bus.emit('session:ending', { sessionId: 's1', durationMs: 123456 });
    const raw = storage.readText(JOURNAL_FILE, '');
    const line = JSON.parse(raw.trim().split('\n').pop());
    assertEqual(line.type, 'session:ending', 'type recorded');
    assertEqual(line.durationMs, 123456, 'durationMs recorded');
  });

  test('planner:complete is NOT counted (fires at plan construction)', async () => {
    const { bus, ec } = freshEC();
    ec.start();
    await bus.emit('planner:complete', { title: 'p', steps: 3 });
    assertEqual(ec.countSince(null), 0, 'planner:complete ignored');
  });

  test('counts are additive across emits', async () => {
    const { bus, ec } = freshEC();
    ec.start();
    await bus.emit('lessons:recorded', {});
    assertEqual(ec.countSince(null), 1, 'one after first');
    await bus.emit('lessons:recorded', {});
    await bus.emit('goal:completed', { id: 'g', description: 'd' });
    assertEqual(ec.countSince(null), 3, 'accumulates');
  });
});

// ── 2. Half-open window & cycle boundary ────────────────────

describe('EventCounter — half-open window', () => {
  test('countSince(ts) counts only events strictly after since', async () => {
    const clock = { _t: Date.parse('2026-01-01T00:00:00.000Z'), now() { return this._t; } };
    const { bus, ec } = freshEC({ clockRef: clock });
    ec.start();
    clock._t = Date.parse('2026-01-01T10:00:00.000Z');
    await bus.emit('goal:completed', { id: 'a', description: 'd' });
    clock._t = Date.parse('2026-01-01T11:00:00.000Z');
    await bus.emit('lessons:recorded', {});
    const boundary = '2026-01-01T12:00:00.000Z';
    clock._t = Date.parse('2026-01-01T13:00:00.000Z');
    await bus.emit('goal:failed', { id: 'b' });
    clock._t = Date.parse('2026-01-01T14:00:00.000Z');
    await bus.emit('emotion:watchdog-alert', {});
    assertEqual(ec.countSince(null), 4, 'all four counted with null (first cycle)');
    assertEqual(ec.countSince(boundary), 2, 'only events after boundary counted');
  });

  test('event exactly at the boundary is excluded (ts > since)', async () => {
    const clock = { _t: 0, now() { return this._t; } };
    const { bus, ec } = freshEC({ clockRef: clock });
    ec.start();
    const boundary = '2026-02-01T00:00:00.000Z';
    clock._t = Date.parse(boundary);
    await bus.emit('goal:completed', { id: 'x', description: 'd' });
    assertEqual(ec.countSince(boundary), 0, 'event at boundary excluded');
    clock._t = Date.parse(boundary) + 1;
    await bus.emit('goal:completed', { id: 'y', description: 'd' });
    assertEqual(ec.countSince(boundary), 1, 'event 1ms after boundary included');
  });
});

// ── 3. Crash-safety & restart ───────────────────────────────

describe('EventCounter — crash-safety & restart', () => {
  test('count survives a restart (journal is the only state)', async () => {
    const dir = freshDir();
    const ec1 = new EventCounter({ bus: createBus(), storage: new StorageService(dir) });
    ec1.start();
    // emit through ec1's own bus
    await ec1.bus.emit('goal:completed', { id: 'g', description: 'd' });
    await ec1.bus.emit('lessons:recorded', {});
    ec1.stop();
    // simulate restart: fresh instance + fresh storage on the SAME dir,
    // no in-memory carryover whatsoever
    const ec2 = new EventCounter({ bus: createBus(), storage: new StorageService(dir) });
    assertEqual(ec2.countSince(null), 2, 'count restored from journal after restart');
  });

  test('append is durable immediately — readable without any flush', async () => {
    const { bus, ec, dir } = freshEC();
    ec.start();
    await bus.emit('goal:completed', { id: 'g', description: 'd' });
    const raw = new StorageService(dir).readText(JOURNAL_FILE, '');
    assert(raw.includes('goal:completed'), 'line on disk immediately after append');
  });
});

// ── 4. Lifecycle & dashboard ────────────────────────────────

describe('EventCounter — lifecycle & dashboard', () => {
  test('stop() unsubscribes — no recording after stop', async () => {
    const { bus, ec } = freshEC();
    ec.start();
    await bus.emit('goal:completed', { id: 'g', description: 'd' });
    assertEqual(ec.countSince(null), 1, 'recorded while running');
    ec.stop();
    await bus.emit('goal:completed', { id: 'h', description: 'd' });
    assertEqual(ec.countSince(null), 1, 'no new record after stop');
  });

  test('double start does not double-subscribe', async () => {
    const { bus, ec } = freshEC();
    ec.start();
    ec.start();
    await bus.emit('goal:completed', { id: 'g', description: 'd' });
    assertEqual(ec.countSince(null), 1, 'event recorded once, not twice');
  });

  test('summary().byDay buckets by ts date', async () => {
    const clock = { _t: 0, now() { return this._t; } };
    const { bus, ec } = freshEC({ clockRef: clock });
    ec.start();
    clock._t = Date.parse('2026-03-01T09:00:00.000Z');
    await bus.emit('goal:completed', { id: 'a', description: 'd' });
    clock._t = Date.parse('2026-03-01T20:00:00.000Z');
    await bus.emit('lessons:recorded', {});
    clock._t = Date.parse('2026-03-02T09:00:00.000Z');
    await bus.emit('goal:failed', { id: 'b' });
    const s = ec.summary();
    assertEqual(s.byDay['2026-03-01'], 2, 'two events on day 1');
    assertEqual(s.byDay['2026-03-02'], 1, 'one event on day 2');
  });

  test('corrupt journal line is skipped (defensive read)', async () => {
    const { ec, storage } = freshEC();
    storage.appendText(JOURNAL_FILE, '{"ts":"2026-01-01T00:00:00.000Z","type":"goal:completed"}\n');
    storage.appendText(JOURNAL_FILE, 'this is not json\n');
    storage.appendText(JOURNAL_FILE, '{"ts":"2026-01-02T00:00:00.000Z","type":"lessons:recorded"}\n');
    assertEqual(ec.countSince(null), 2, 'corrupt line skipped, valid lines counted');
  });

  test('constructor requires a storage service', () => {
    assertThrows(() => new EventCounter({ bus: createBus() }), 'throws without storage');
  });
});

// ── 5. Commit-hook integration (EventCounter ↔ SelfTrajectory) ──

describe('EventCounter ↔ SelfTrajectory commit-hook', () => {
  test('commit fills event_count from countSince(prevEnd); derived window across two cycles', async () => {
    const dir = freshDir();
    const clock = { _t: Date.parse('2026-04-01T00:00:00.000Z'), now() { return this._t; } };
    const storage = new StorageService(dir);
    const bus = createBus();
    const ec = new EventCounter({ bus, storage, clock });
    const st = new SelfTrajectory({
      storage, genome: FAKE_GENOME, cognitiveSelfModel: FAKE_CSM, lessonsStore: FAKE_LESSONS, clock,
    });
    st.eventCounter = ec;  // what the manifest late-binding does at boot
    ec.start();

    // first cycle: 3 events before the first commit
    clock._t = Date.parse('2026-04-01T08:00:00.000Z');
    await bus.emit('goal:completed', { id: 'a', description: 'd' });
    clock._t = Date.parse('2026-04-01T09:00:00.000Z');
    await bus.emit('goal:failed', { id: 'b' });
    clock._t = Date.parse('2026-04-01T10:00:00.000Z');
    await bus.emit('lessons:recorded', {});
    clock._t = Date.parse('2026-04-01T12:00:00.000Z');           // commit time
    const r1 = await commitEntryLocal(st, 'c1');
    assertEqual(r1.entry.event_count, 3, 'first cycle counts all 3 events (null boundary)');

    // second cycle: 2 events AFTER the first entry's wallclock_end
    clock._t = Date.parse('2026-04-02T08:00:00.000Z');
    await bus.emit('goal:abandoned', { id: 'c' });
    clock._t = Date.parse('2026-04-02T09:00:00.000Z');
    await bus.emit('session:ending', { sessionId: 's', durationMs: 700000 });
    clock._t = Date.parse('2026-04-02T12:00:00.000Z');
    const r2 = await commitEntryLocal(st, 'c2');
    assertEqual(r2.entry.event_count, 2, 'second cycle counts only events after first wallclock_end');

    // append-only: nothing pruned, the per-day view keeps all 5
    assertEqual(ec.countSince(null), 5, 'journal append-only, all 5 events retained');
  });

  test('event_count stays null when no eventCounter is bound', async () => {
    const dir = freshDir();
    const storage = new StorageService(dir);
    const st = new SelfTrajectory({
      storage, genome: FAKE_GENOME, cognitiveSelfModel: FAKE_CSM, lessonsStore: FAKE_LESSONS,
    });
    const r = await commitEntryLocal(st, 'x');
    assertEqual(r.entry.event_count, null, 'no counter bound → null (graceful)');
  });
});

// ── 6. Dashboard (/trajectory events + event_count in show) ──

describe('EventCounter — /trajectory dashboard', () => {
  test('/trajectory events renders the per-type and per-day distribution', async () => {
    const dir = freshDir();
    const clock = { _t: Date.parse('2026-05-01T00:00:00.000Z'), now() { return this._t; } };
    const storage = new StorageService(dir);
    const bus = createBus();
    const ec = new EventCounter({ bus, storage, clock });
    const st = new SelfTrajectory({
      storage, genome: FAKE_GENOME, cognitiveSelfModel: FAKE_CSM, lessonsStore: FAKE_LESSONS, clock,
    });
    st.eventCounter = ec;
    ec.start();
    const h = Object.assign({ selfTrajectory: st }, commandHandlersTrajectory);

    clock._t = Date.parse('2026-05-01T08:00:00.000Z'); await bus.emit('goal:completed', { id: 'a', description: 'd' });
    clock._t = Date.parse('2026-05-01T09:00:00.000Z'); await bus.emit('goal:completed', { id: 'b', description: 'd' });
    clock._t = Date.parse('2026-05-02T08:00:00.000Z'); await bus.emit('lessons:recorded', {});

    const out = await h.trajectory('/trajectory events');
    assert(/Significant events/.test(out), 'renders events view');
    assert(/3 recorded across 2 day\(s\)/.test(out), 'total + day count');
    assert(/goal:completed\s+2/.test(out), 'per-type, busiest first');
    assert(/2026-05-01\s+2/.test(out) && /2026-05-02\s+1/.test(out), 'per-day buckets');

    // event_count now shows in `show` (committed entry, all 3 in the first cycle)
    clock._t = Date.parse('2026-05-02T12:00:00.000Z');
    await commitEntryLocal(st, 'e1');
    const shown = await h.trajectory('/trajectory show');
    assert(/events: 3/.test(shown), 'show renders the filled event_count');
  });

  test('/trajectory events is graceful when no counter is bound', async () => {
    const dir = freshDir();
    const st = new SelfTrajectory({
      storage: new StorageService(dir), genome: FAKE_GENOME, cognitiveSelfModel: FAKE_CSM, lessonsStore: FAKE_LESSONS,
    });
    const h = Object.assign({ selfTrajectory: st }, commandHandlersTrajectory);
    const out = await h.trajectory('/trajectory events');
    assert(/not available/i.test(out), 'graceful when no counter bound');
  });
});

run();
