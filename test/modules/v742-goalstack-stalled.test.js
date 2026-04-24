// ============================================================
// v7.4.2 "Kassensturz" Baustein B — GoalStack stalled-status semantics
//
// Locks the design decision that `stalled` and `paused` are
// intentionally NOT terminal. If this test fails, someone has
// either added `stalled` to `_isTerminal()` (breaking
// pauseGoal/resumeGoal on stalled goals) or changed the pause/resume
// guard semantics.
//
// See CHANGELOG v7.4.2 Baustein B and GoalStack.js:_isTerminal
// header comment.
//
// Tests bypass addGoal() to avoid pulling the full decomposition +
// capability-gate pipeline, which requires model/prompts. We only
// need static status-transition semantics, not addGoal behavior.
// ============================================================

'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { GoalStack } = require('../../src/agent/planning/GoalStack');

function makeMockBus() {
  const events = [];
  return {
    emit: (n, p) => events.push({ name: n, payload: p }),
    fire: (n, p) => events.push({ name: n, payload: p }),
    on: () => {},
    events,
  };
}

function makeTempStorage() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goalstack-v742-'));
  return {
    baseDir: dir,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function pushTestGoal(gs, { id, status, source = 'daemon', description = 'test' }) {
  const goal = {
    id,
    description,
    source,
    priority: 'medium',
    status,
    steps: [],
    currentStep: 0,
    results: [],
    attempts: 0,
    maxAttempts: 3,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
  };
  gs.goals.push(goal);
  return goal;
}

function findGoal(gs, id) {
  return gs.goals.find(g => g.id === id);
}

describe('v7.4.2 Baustein B — _isTerminal static method', () => {

  it('terminal statuses: completed, failed, abandoned', () => {
    assert.strictEqual(GoalStack._isTerminal('completed'), true);
    assert.strictEqual(GoalStack._isTerminal('failed'), true);
    assert.strictEqual(GoalStack._isTerminal('abandoned'), true);
  });

  it('stalled is NOT terminal (design lock)', () => {
    assert.strictEqual(GoalStack._isTerminal('stalled'), false);
  });

  it('paused is NOT terminal (design lock)', () => {
    assert.strictEqual(GoalStack._isTerminal('paused'), false);
  });

  it('active is NOT terminal', () => {
    assert.strictEqual(GoalStack._isTerminal('active'), false);
  });

  it('blocked is NOT terminal', () => {
    assert.strictEqual(GoalStack._isTerminal('blocked'), false);
  });
});

describe('v7.4.2 Baustein B — pauseGoal/resumeGoal on stalled goals', () => {
  let bus, storage, gs;

  beforeEach(() => {
    bus = makeMockBus();
    storage = makeTempStorage();
    gs = new GoalStack({ lang: { current: 'en', t: (k) => k }, bus, storage });
  });

  afterEach(() => {
    storage.cleanup();
  });

  it('pauseGoal(stalledId) returns true and sets status to paused', () => {
    const goal = pushTestGoal(gs, { id: 'g-stalled-1', status: 'stalled' });

    const result = gs.pauseGoal(goal.id);
    assert.strictEqual(result, true, 'pauseGoal should succeed on stalled');
    assert.strictEqual(findGoal(gs, goal.id).status, 'paused');
  });

  it('resumeGoal(stalledId) returns true and sets status to active', () => {
    const goal = pushTestGoal(gs, { id: 'g-stalled-2', status: 'stalled' });

    const result = gs.resumeGoal(goal.id);
    assert.strictEqual(result, true, 'resumeGoal should succeed on stalled');
    assert.strictEqual(findGoal(gs, goal.id).status, 'active');
  });

  it('pauseGoal(completedId) returns false (terminal guard still works)', () => {
    const goal = pushTestGoal(gs, { id: 'g-complete-1', status: 'completed' });

    const result = gs.pauseGoal(goal.id);
    assert.strictEqual(result, false, 'pauseGoal should refuse on terminal');
    assert.strictEqual(findGoal(gs, goal.id).status, 'completed', 'status unchanged');
  });

  it('resumeGoal(failedId) returns false (terminal guard still works)', () => {
    const goal = pushTestGoal(gs, { id: 'g-failed-1', status: 'failed' });

    const result = gs.resumeGoal(goal.id);
    assert.strictEqual(result, false, 'resumeGoal should refuse on terminal');
    assert.strictEqual(findGoal(gs, goal.id).status, 'failed', 'status unchanged');
  });

  it('stalled goals are skipped in reviewGoals (active-only filter)', () => {
    const goal = pushTestGoal(gs, { id: 'g-stalled-3', status: 'stalled' });

    const { changed, reviewed } = gs.reviewGoals();
    assert.strictEqual(reviewed, 0, 'stalled is not reviewed (status !== active)');
    assert.strictEqual(findGoal(gs, goal.id).status, 'stalled', 'remains stalled');
    assert.strictEqual(changed.length, 0, 'no changes');
  });
});
