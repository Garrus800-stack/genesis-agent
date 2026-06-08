'use strict';
// v7.9.21 (Point C) — on a successful pursuit, GoalDriver._beginPursuit must
// pass the pursuit summary as the `outcome` to completeGoal(), so a completed
// goal records what it accomplished instead of a bare status flip (the field
// run showed completed goals carried no outcome).
const { describe, test, run, assert } = require('../harness');
const { GoalDriver } = require('../../src/agent/agency/GoalDriver');
const { goalStackLifecycleMixin } = require('../../src/agent/planning/GoalStackLifecycle');

function makeDriver(pursueResult) {
  const goal = { id: 'g1', status: 'active', description: 'do the thing', priority: 'medium', source: 'user' };
  return {
    goalStack: {
      goals: [goal],
      _completeCall: null,
      completeGoal(goalId, outcome) { this._completeCall = { goalId, outcome }; return true; },
    },
    agentLoop: { running: false, pursue: async () => pursueResult },
    bus: { fire() {} },
    _currentlyPursuing: new Set(),
    _failureBurst: new Map(),
    _goalPausedUntil: new Map(),
    lastActivityAt: 0,
  };
}

describe('v7921 completed goal carries outcome', () => {
  test('success path passes pursuit summary as completeGoal outcome', async () => {
    const d = makeDriver({ success: true, summary: 'accomplished the thing' });
    await GoalDriver.prototype._beginPursuit.call(d, 'g1');
    assert(d.goalStack._completeCall, 'completeGoal must have been called on the success path');
    assert(d.goalStack._completeCall.goalId === 'g1', 'completeGoal got the right goalId');
    assert(
      d.goalStack._completeCall.outcome === 'accomplished the thing',
      'outcome must be the pursuit summary — got: ' + JSON.stringify(d.goalStack._completeCall.outcome),
    );
    assert(!d._currentlyPursuing.has('g1'), 'lock released in finally');
  });

  test('success with no summary → outcome null (not undefined)', async () => {
    const d = makeDriver({ success: true });
    await GoalDriver.prototype._beginPursuit.call(d, 'g1');
    assert(d.goalStack._completeCall, 'completeGoal called');
    assert(d.goalStack._completeCall.outcome === null, 'no summary → null, got: ' + JSON.stringify(d.goalStack._completeCall.outcome));
  });

  test('completeGoal stores the outcome on the goal (end to end)', () => {
    const gs = Object.assign(
      { goals: [{ id: 'g1', status: 'active', description: 'x' }], _save() {}, bus: { emit() {}, fire() {} } },
      goalStackLifecycleMixin,
    );
    const ok = gs.completeGoal('g1', 'accomplished the thing');
    assert(ok === true, 'completeGoal returns true on a live goal');
    assert(gs.goals[0].status === 'completed', 'status flipped to completed');
    assert(gs.goals[0].outcome === 'accomplished the thing', 'outcome stored on the goal — got: ' + JSON.stringify(gs.goals[0].outcome));
  });
});

if (require.main === module) run();
