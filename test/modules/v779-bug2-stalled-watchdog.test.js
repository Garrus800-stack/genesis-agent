#!/usr/bin/env node
// v7.7.9 Phase 3 — StalledGoalWatchdog tests
//
// Bridges resource-blocked goals back into the failure-reflection pathway.
// Without it, hopelessly-blocked goals (hallucinated paths, missing
// services that won't come back) sit in 'blocked' status forever and
// the PSE pipeline never sees them.

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const { StalledGoalWatchdog } = require('../../src/agent/cognitive/StalledGoalWatchdog');

// ── Test helpers ─────────────────────────────────────────

function makeBus() {
  const events = [];
  return {
    events,
    fire(evt, payload) { events.push({ evt, payload }); },
    on() { return () => {}; },
  };
}

function makeGoalStack(goals = []) {
  const statusChanges = [];
  let _busRef = null;
  // v7.9.2: Mock the REAL goalStack API — markStalled / markObsolete.
  // The previous mock exposed setStatus, but setStatus never existed on
  // the real goalStack. That's why this entire path was silently broken
  // in production: the watchdog called setStatus, found no such method
  // via its typeof-check, and did nothing. The mock made the test pass
  // by accident. With markStalled the test reflects production.
  // Both methods also fire their respective event on the bus to mirror
  // the real GoalStackLifecycle behaviour.
  return {
    goals,
    statusChanges,
    _attachBus(bus) { _busRef = bus; },
    markStalled(id, reason) {
      const g = goals.find(g => g.id === id);
      if (!g) return false;
      g.status = 'stalled';
      g.stalledReason = reason;
      statusChanges.push({ id, status: 'stalled', reason });
      if (_busRef && _busRef.fire) {
        _busRef.fire('goal:stalled', { id, description: g.description, reason }, { source: 'GoalStack' });
      }
      return true;
    },
    markObsolete(id, reason) {
      const g = goals.find(g => g.id === id);
      if (!g) return false;
      g.status = 'obsolete';
      g.obsoleteReason = reason;
      statusChanges.push({ id, status: 'obsolete', reason });
      if (_busRef && _busRef.fire) {
        _busRef.fire('goal:obsolete', { id, description: g.description, reason }, { source: 'GoalStack' });
      }
      return true;
    },
  };
}

function makeSettings(map = {}) {
  return { get: (k) => map[k] };
}

function blockedGoal(id, description, blockedAt, resources = ['file:logs/foo.log']) {
  return {
    id,
    description,
    status: 'blocked',
    blockedAt,
    blockedByResources: resources,
  };
}

// ── Construction ─────────────────────────────────────────

describe('StalledGoalWatchdog — construction', () => {
  test('starts inert (no timer)', () => {
    const w = new StalledGoalWatchdog({ bus: makeBus() });
    assertEqual(w._running, false);
    assertEqual(w._timer, null);
  });

  test('stop() before start() is safe', () => {
    const w = new StalledGoalWatchdog({ bus: makeBus() });
    w.stop();  // should not throw
    assertEqual(w._running, false);
  });

  test('start() twice is idempotent', () => {
    const w = new StalledGoalWatchdog({ bus: makeBus() });
    w.start();
    const first = w._timer;
    w.start();
    assertEqual(w._timer, first, 'second start should not replace timer');
    w.stop();
  });
});

// ── Tick mechanics ───────────────────────────────────────

describe('StalledGoalWatchdog — tick scanning', () => {
  test('no goals → no flagging', async () => {
    const bus = makeBus();
    const w = new StalledGoalWatchdog({ bus, goalStack: makeGoalStack([]) });
    await w._tick();
    assertEqual(bus.events.length, 0);
    assertEqual(w._getFlaggedIds().length, 0);
  });

  test('blocked goal within timeout → not flagged', async () => {
    const bus = makeBus();
    const recentlyBlocked = new Date(Date.now() - 2 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'test', recentlyBlocked)]);
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    await w._tick();
    assertEqual(w._getFlaggedIds().length, 0, 'should not flag recently blocked goal');
  });

  test('blocked goal past timeout → flagged', async () => {
    const bus = makeBus();
    const longBlocked = new Date(Date.now() - 20 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'cognitive load index', longBlocked)]);
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    await w._tick();
    assertEqual(w._getFlaggedIds().length, 1);
    assertEqual(w._getFlaggedIds()[0], 'g1');
  });

  test('goal:stalled event fired with correct payload shape', async () => {
    const bus = makeBus();
    const blockedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'find foo', blockedAt, ['file:logs/x.log'])]);
    gs._attachBus(bus); // v7.9.2: mock fires goal:stalled via the bus, mirroring real markStalled
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    await w._tick();
    const stalled = bus.events.find(e => e.evt === 'goal:stalled');
    assert(stalled, 'goal:stalled must be fired');
    assertEqual(stalled.payload.id, 'g1');
    assertEqual(stalled.payload.description, 'find foo');
    assert(stalled.payload.reason.includes('blocked for'));
    assert(stalled.payload.reason.includes('file:logs/x.log'));
    // v7.9.2: stalledMinutes / blockedAt fields removed from payload — they
    // were only emitted by the watchdog's manual bus.fire which is now gone
    // (markStalled fires the event itself with a smaller, uniform payload).
    // No external consumer was using those fields.
  });

  test('goal status transitions blocked → stalled', async () => {
    const bus = makeBus();
    const blockedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'desc', blockedAt)]);
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    await w._tick();
    const change = gs.statusChanges.find(s => s.id === 'g1');
    assert(change, 'status change must be recorded');
    assertEqual(change.status, 'stalled');
    assertEqual(gs.goals[0].status, 'stalled');
  });

  test('flagging is idempotent — second tick does not re-fire', async () => {
    const bus = makeBus();
    const blockedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'desc', blockedAt)]);
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    await w._tick();
    const firstCount = bus.events.length;
    await w._tick();
    assertEqual(bus.events.length, firstCount, 'second tick must not re-emit');
  });
});

// ── InnerSpeech integration ──────────────────────────────

describe('StalledGoalWatchdog — InnerSpeech reflection', () => {
  test('emits plan-failure-reflection to InnerSpeech when bound', async () => {
    const bus = makeBus();
    const emitted = [];
    const innerSpeech = {
      emit: (text, kind, meta) => { emitted.push({ text, kind, meta }); return { id: 'x' }; },
    };
    const blockedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'cognitive load', blockedAt, ['file:logs/x.log'])]);
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    w.innerSpeech = innerSpeech;
    w.selfStatementLog = { append: () => true };
    await w._tick();
    // recordReflection internally calls innerSpeech.emit
    assert(emitted.length > 0, 'innerSpeech.emit must be called');
    const ev = emitted[0];
    assertEqual(ev.kind, 'plan-failure-reflection');
    assert(ev.text.length > 0, 'reflection text must be non-empty');
  });

  test('works without InnerSpeech (best-effort, no throw)', async () => {
    const bus = makeBus();
    const blockedAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const gs = makeGoalStack([blockedGoal('g1', 'desc', blockedAt)]);
    const w = new StalledGoalWatchdog({
      bus, goalStack: gs,
      settings: makeSettings({ 'goals.stalledTimeoutMs': 15 * 60_000 }),
    });
    // innerSpeech not set — should not throw, still transitions status
    await w._tick();
    assertEqual(gs.goals[0].status, 'stalled');
  });
});

// ── Edge cases ───────────────────────────────────────────

describe('StalledGoalWatchdog — edge cases', () => {
  test('missing blockedAt → goal not flagged (defensive)', async () => {
    const bus = makeBus();
    const gs = makeGoalStack([{ id: 'g1', status: 'blocked', blockedByResources: ['file:x'] }]);
    const w = new StalledGoalWatchdog({ bus, goalStack: gs });
    await w._tick();
    assertEqual(w._getFlaggedIds().length, 0, 'missing blockedAt is undefined behaviour — skip');
  });

  test('non-blocked goals are ignored', async () => {
    const bus = makeBus();
    const ancient = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const gs = makeGoalStack([
      { id: 'g1', status: 'active', blockedAt: ancient },
      { id: 'g2', status: 'completed', blockedAt: ancient },
      { id: 'g3', status: 'failed', blockedAt: ancient },
    ]);
    const w = new StalledGoalWatchdog({ bus, goalStack: gs });
    await w._tick();
    assertEqual(w._getFlaggedIds().length, 0);
  });

  test('null/empty goalStack does not crash', async () => {
    const bus = makeBus();
    const w = new StalledGoalWatchdog({ bus, goalStack: null });
    await w._tick();  // should not throw
    assertEqual(bus.events.length, 0);
  });

  test('tick interval uses default when settings missing', () => {
    const w = new StalledGoalWatchdog({ bus: makeBus() });
    assertEqual(w._getTickInterval(), 60_000);
  });

  test('tick interval clamps invalid settings to default', () => {
    const w = new StalledGoalWatchdog({
      bus: makeBus(),
      settings: makeSettings({ 'goals.stalledWatchdogTickMs': -1 }),
    });
    assertEqual(w._getTickInterval(), 60_000, 'invalid setting falls back to default');
  });

  test('stalledTimeoutMs uses default when settings missing', () => {
    const w = new StalledGoalWatchdog({ bus: makeBus() });
    assertEqual(w._getStalledTimeoutMs(), 15 * 60_000);
  });
});

// ── Manifest / lifecycle integration ─────────────────────

describe('StalledGoalWatchdog — manifest registration', () => {
  test('registered in phase9-cognitive', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/manifest/phase9-cognitive.js'),
      'utf-8',
    );
    assert(/['"]stalledGoalWatchdog['"]/.test(src),
      'stalledGoalWatchdog must be registered');
    assert(/goalStack/.test(src.split('stalledGoalWatchdog')[1].slice(0, 1000)),
      'goalStack late-binding/resolve referenced near registration');
  });

  test('in AgentCoreHealth shutdown list', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/AgentCoreHealth.js'),
      'utf-8',
    );
    assert(/['"]stalledGoalWatchdog['"]/.test(src),
      'stalledGoalWatchdog must be in shutdown list');
  });

  test('start hook in AgentCoreWire', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/AgentCoreWire.js'),
      'utf-8',
    );
    assert(/start\(['"]stalledGoalWatchdog['"]\)/.test(src),
      'AgentCoreWire must start stalledGoalWatchdog');
  });

  test('settings defaults present', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/foundation/Settings.js'),
      'utf-8',
    );
    assert(/goals:\s*\{[^}]*stalledTimeoutMs/s.test(src),
      'goals.stalledTimeoutMs default missing');
    assert(/goals:\s*\{[^}]*stalledWatchdogTickMs/s.test(src),
      'goals.stalledWatchdogTickMs default missing');
  });

  test('schema for goal:stalled has optional blockedAt/stalledMinutes', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', '..', 'src/agent/core/EventPayloadSchemas.js'),
      'utf-8',
    );
    assert(/'goal:stalled':[^}]*blockedAt:\s*'optional'/s.test(src),
      'blockedAt should be optional in goal:stalled schema');
    assert(/'goal:stalled':[^}]*stalledMinutes:\s*'optional'/s.test(src),
      'stalledMinutes should be optional in goal:stalled schema');
  });
});

run();
