// ============================================================
// Test: GoalStack extended lifecycle (v7.3.3)
//
// New states: stalled, obsolete.
// New methods: markStalled, markObsolete, reviewGoals.
//
// The reviewGoals method fixes a specific real-world bug:
// goals stuck at 6/8 or 7/8 steps that stayed "active" indefinitely
// because no state transition triggered. reviewGoals walks all active
// goals and auto-transitions those that should have moved on.
// ============================================================

'use strict';

const { describe, test, assert, run } = require('../harness');
const { GoalStack } = require('../../src/agent/planning/GoalStack');

function makeStack({ bus } = {}) {
  const events = [];
  const mockBus = bus || {
    emit: (name, payload) => events.push({ name, payload }),
    fire: () => {},
    on: () => {},
  };
  // Stub storage
  const storage = {
    readJSON: () => [],
    writeJSONDebounced: () => {},
  };
  const stack = new GoalStack({
    lang: { t: (k) => k },
    bus: mockBus,
    model: null,
    prompts: null,
    storageDir: '/tmp/test',
    storage,
  });
  stack._capturedEvents = events;
  return stack;
}

// Helpers to inject a goal at any state (bypassing addGoal's async decomposition)
function injectGoal(stack, partial) {
  const base = {
    id: partial.id || `g_${Date.now()}_${Math.random()}`,
    description: partial.description || 'test goal',
    source: partial.source || 'self',
    priority: partial.priority || 'medium',
    status: partial.status || 'active',
    steps: partial.steps || [{ action: 'a' }, { action: 'b' }],
    currentStep: partial.currentStep ?? 0,
    attempts: partial.attempts ?? 0,
    maxAttempts: partial.maxAttempts ?? 3,
    results: [],
    created: partial.created || new Date().toISOString(),
    updated: partial.updated || new Date().toISOString(),
  };
  stack.goals.push(base);
  return base;
}

// ── markStalled / markObsolete ──────────────────────
describe('v7.3.3 — markStalled: sets state and emits event', () => {
  test('active goal → stalled with reason', () => {
    const s = makeStack();
    const g = injectGoal(s, { description: 'refactor X' });
    const ok = s.markStalled(g.id, 'ran out of time');
    assert(ok === true, 'should succeed on active goal');
    assert(g.status === 'stalled', `status should be stalled, got ${g.status}`);
    assert(g.stalledReason === 'ran out of time', 'reason should be recorded');
    const ev = s._capturedEvents.find(e => e.name === 'goal:stalled');
    assert(ev, 'goal:stalled event should fire');
    assert(ev.payload.id === g.id, 'event has goal id');
  });

  test('completed goal → markStalled refuses', () => {
    const s = makeStack();
    const g = injectGoal(s, { status: 'completed' });
    const ok = s.markStalled(g.id, 'x');
    assert(ok === false, 'should refuse on completed goal');
    assert(g.status === 'completed', 'status should not change');
  });

  test('non-existent goalId returns false', () => {
    const s = makeStack();
    const ok = s.markStalled('nonexistent', 'x');
    assert(ok === false, 'should return false');
  });
});

describe('v7.3.3 — markObsolete: distinct from abandoned/stalled', () => {
  test('active goal → obsolete with reason', () => {
    const s = makeStack();
    const g = injectGoal(s, { description: 'implement feature X' });
    const ok = s.markObsolete(g.id, 'feature X was deprecated upstream');
    assert(ok === true, 'should succeed');
    assert(g.status === 'obsolete', `expected obsolete, got ${g.status}`);
    assert(g.obsoleteReason === 'feature X was deprecated upstream', 'reason persists');
    const ev = s._capturedEvents.find(e => e.name === 'goal:obsolete');
    assert(ev, 'event should fire');
  });

  test('abandoned goal → markObsolete refuses', () => {
    const s = makeStack();
    const g = injectGoal(s, { status: 'abandoned' });
    const ok = s.markObsolete(g.id, 'x');
    assert(ok === false, 'terminal state — refuse');
  });
});

// ── reviewGoals: the core fix for the 6/8, 7/8 bug ──
describe('v7.3.3 — reviewGoals: auto-complete when all steps done but status is active', () => {
  test('goal with currentStep >= steps.length → auto-complete', () => {
    const s = makeStack();
    const g = injectGoal(s, {
      status: 'active',
      steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }],
      currentStep: 3,  // all done, but status never flipped
    });
    const { changed, reviewed } = s.reviewGoals();
    assert(reviewed === 1, 'one goal reviewed');
    assert(changed.length === 1, `one goal changed, got ${changed.length}`);
    assert(g.status === 'completed', `expected completed, got ${g.status}`);
    assert(changed[0].to === 'completed', 'changelog shows transition');
    assert(changed[0].reason.includes('all-steps-done'), 'reason explains auto-complete');
  });
});

describe('v7.3.3 — reviewGoals: auto-fail when attempts exhausted but status is active', () => {
  test('goal with attempts >= maxAttempts mid-execution → auto-fail', () => {
    const s = makeStack();
    const g = injectGoal(s, {
      status: 'active',
      steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }],
      currentStep: 1,
      attempts: 3,
      maxAttempts: 3,  // exhausted
    });
    const { changed } = s.reviewGoals();
    assert(g.status === 'failed', `expected failed, got ${g.status}`);
    assert(changed[0].to === 'failed', 'changelog shows transition');
    const ev = s._capturedEvents.find(e => e.name === 'goal:failed');
    assert(ev, 'goal:failed event fires');
    assert(ev.payload.auto === true, 'auto=true flag');
  });
});

describe('v7.3.3 — reviewGoals: auto-stall when no progress for too long', () => {
  test('active goal not updated for 100h → stalled (default threshold 72h)', () => {
    const s = makeStack();
    const ancient = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const g = injectGoal(s, {
      status: 'active',
      source: 'self',
      steps: [{ action: 'a' }],
      currentStep: 0,
      attempts: 1,
      maxAttempts: 3,
      updated: ancient,
    });
    const { changed } = s.reviewGoals();
    assert(g.status === 'stalled', `expected stalled, got ${g.status}`);
    assert(g.stalledReason, 'reason is set');
    assert(changed[0].to === 'stalled', 'changelog shows transition');
  });

  test('recent goal (10h) → NOT stalled', () => {
    const s = makeStack();
    const recent = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const g = injectGoal(s, {
      status: 'active',
      steps: [{ action: 'a' }],
      currentStep: 0,
      updated: recent,
    });
    const { changed } = s.reviewGoals();
    assert(g.status === 'active', 'should remain active');
    assert(changed.length === 0, 'no changes');
  });

  test('custom stallThresholdHours respected', () => {
    const s = makeStack();
    const old = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
    const g = injectGoal(s, {
      status: 'active',
      steps: [{ action: 'a' }],
      currentStep: 0,
      updated: old,
    });
    const { changed } = s.reviewGoals({ stallThresholdHours: 5 });
    assert(g.status === 'stalled', 'should be stalled under tighter threshold');
  });
});

describe('v7.3.3 — reviewGoals: respects user vs self goals', () => {
  test('user-sourced goal NOT auto-stalled when closeOwnGoals=false', () => {
    const s = makeStack();
    const ancient = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const g = injectGoal(s, {
      status: 'active',
      source: 'user',
      steps: [{ action: 'a' }],
      currentStep: 0,
      updated: ancient,
    });
    const { changed } = s.reviewGoals({ closeOwnGoals: false });
    assert(g.status === 'active', 'user goal should remain untouched');
    assert(changed.length === 0, 'no changes');
  });

  test('user-sourced goal IS auto-stalled when closeOwnGoals=true', () => {
    const s = makeStack();
    const ancient = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const g = injectGoal(s, {
      status: 'active',
      source: 'user',
      steps: [{ action: 'a' }],
      currentStep: 0,
      updated: ancient,
    });
    s.reviewGoals({ closeOwnGoals: true });
    assert(g.status === 'stalled', 'with explicit permission, user goal auto-stalled');
  });

  test('self goals are always eligible for auto-transition (default)', () => {
    const s = makeStack();
    const ancient = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
    const g = injectGoal(s, {
      status: 'active',
      source: 'self',
      steps: [{ action: 'a' }],
      currentStep: 0,
      updated: ancient,
    });
    s.reviewGoals();  // defaults: closeOwnGoals=true
    assert(g.status === 'stalled', 'self goal auto-stalled by default');
  });
});

describe('v7.3.3 — reviewGoals: does not touch non-active states', () => {
  test('completed/failed/abandoned/paused/stalled/obsolete all unchanged', () => {
    const s = makeStack();
    const ancient = new Date(Date.now() - 200 * 60 * 60 * 1000).toISOString();
    const states = ['completed', 'failed', 'abandoned', 'paused', 'stalled', 'obsolete', 'blocked'];
    for (const st of states) {
      injectGoal(s, { status: st, updated: ancient });
    }
    const { changed, reviewed } = s.reviewGoals();
    assert(reviewed === 0, 'no active goals to review');
    assert(changed.length === 0, 'no changes to non-active goals');
  });
});

describe('v7.3.3 — reviewGoals: empty stack does not crash', () => {
  test('empty stack → 0 reviewed, 0 changed', () => {
    const s = makeStack();
    const { changed, reviewed } = s.reviewGoals();
    assert(reviewed === 0);
    assert(changed.length === 0);
  });
});

run();
