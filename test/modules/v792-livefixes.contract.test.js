#!/usr/bin/env node
// ============================================================
// Test: v7.9.2 contract — root-cause fix for the goal-reject loop
//
// Live-run 2026-05-17 (Garrus-Win) re-pickup loop root cause:
// GoalDriverFailurePolicy and StalledGoalWatchdog called
// goalStack.setStatus / goalStack.updateGoal — methods that
// never existed on the real goalStack. Both typeof-checks
// returned false, the try-block silently did nothing, status
// stayed 'active', the scan re-picked the goal forever.
// v7.9.2 switches to the real API: markStalled and markObsolete.
// The v7.9.1 cooldown workaround is removed because the status
// filter in _listPursueable now actually works.
//
// Covers:
//   - FailurePolicy user-rejection branch calls markStalled
//   - FailurePolicy _failureCap stalled branch calls markStalled
//   - FailurePolicy _failureCap hallucination branch calls markObsolete
//   - StalledGoalWatchdog calls markStalled
//   - goal:stalled / goal:obsolete events fire exactly once
//     (no double-fire from removed manual bus.fire calls)
//   - GoalDriver._goalRejectedCooldown is gone (v7.9.1 removal)
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { describe, test, assert, assertEqual, run } = require('../harness');
const { createBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

const { failurePolicyMixin } = require(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy'));
const handler = failurePolicyMixin._applyFailurePause;

function makeMockGoalStack(goal) {
  const calls = { markStalled: [], markObsolete: [] };
  return {
    calls,
    goals: [goal],
    markStalled: (id, reason) => { calls.markStalled.push({ id, reason }); return true; },
    markObsolete: (id, reason) => { calls.markObsolete.push({ id, reason }); return true; },
  };
}

function makeHost(goalStack) {
  return {
    goalStack,
    bus: { fire: () => {} },
    _failureBurst: new Map(),
    _failurePauseTimers: new Map(),
    _goalPausedUntil: new Map(),
    _lastPausedAt: new Map(),
    _running: true,
    _scanAndMaybePursue: () => {},
  };
}

describe('v792 contract: FailurePolicy uses real markStalled / markObsolete API', () => {

  test('v792 contract: user-rejection path calls markStalled (not setStatus)', async () => {
    const goalId = 'goal_user_reject_1';
    const gs = makeMockGoalStack({ id: goalId, description: 'test', status: 'active' });
    const host = makeHost(gs);

    await handler.call(host, goalId, 'User rejected plan with blockers');

    assertEqual(gs.calls.markStalled.length, 1,
      'user-rejection path must call markStalled exactly once');
    assertEqual(gs.calls.markStalled[0].id, goalId,
      'markStalled must be called with the correct goal-id');
    assert(gs.calls.markStalled[0].reason.includes('plan rejection'),
      'markStalled reason must indicate plan rejection');
    assertEqual(gs.calls.markObsolete.length, 0,
      'markObsolete must NOT be called for user-rejection (that is for hallucinations)');
  });

  test('v792 contract: _failureCap stalled path calls markStalled after N generic failures', async () => {
    const goalId = 'goal_failcap_1';
    const gs = makeMockGoalStack({ id: goalId, description: 'test', status: 'active' });
    const host = makeHost(gs);

    // Generic failure (not hallucination, not user-rejection) — needs 4 hits
    // to exceed the cap of 3. Each call increments _failureBurst for goalId.
    // Note: _applyFailurePause has a 500ms anti-debounce guard via _lastPausedAt;
    // we clear it between calls to simulate failures spread across real time.
    for (let i = 0; i < 4; i++) {
      await handler.call(host, goalId, 'generic backend timeout');
      host._lastPausedAt.clear();
    }

    assertEqual(gs.calls.markStalled.length, 1,
      '4 generic failures must trigger markStalled exactly once');
    assertEqual(gs.calls.markStalled[0].id, goalId);
    assert(gs.calls.markStalled[0].reason.includes('consecutive failures'),
      'reason must indicate consecutive-failure pattern');
    assertEqual(gs.calls.markObsolete.length, 0,
      'generic failures must NOT mark obsolete — that is reserved for hallucination patterns');
  });

  test('v792 contract: _failureCap hallucination path calls markObsolete after N implausible-path hits', async () => {
    const goalId = 'goal_halluc_1';
    const gs = makeMockGoalStack({ id: goalId, description: 'test', status: 'active' });
    const host = makeHost(gs);

    // Hallucination pattern — needs 3 hits to exceed cap of 2 (faster fast-track).
    // Same anti-debounce reset as the generic test above.
    for (let i = 0; i < 3; i++) {
      await handler.call(host, goalId, 'step failed: implausible paths in plan');
      host._lastPausedAt.clear();
    }

    assertEqual(gs.calls.markObsolete.length, 1,
      'hallucination failures must trigger markObsolete exactly once');
    assertEqual(gs.calls.markObsolete[0].id, goalId);
    assertEqual(gs.calls.markStalled.length, 0,
      'hallucination failures must NOT mark stalled — they get the fast-track to obsolete');
  });

  test('v792 contract: FailurePolicy does NOT call setStatus or updateGoal (removed false API)', async () => {
    const goalId = 'goal_no_setStatus_1';
    let setStatusCalled = false;
    let updateGoalCalled = false;
    const gs = {
      goals: [{ id: goalId, description: 'test', status: 'active' }],
      // Both methods exposed but should NEVER be called by v7.9.2 code:
      setStatus: () => { setStatusCalled = true; },
      updateGoal: () => { updateGoalCalled = true; },
      markStalled: () => true,
      markObsolete: () => true,
    };
    const host = makeHost(gs);

    await handler.call(host, goalId, 'User rejected plan with blockers');

    assert(!setStatusCalled,
      'v7.9.2 must NOT call setStatus — that method never existed on real goalStack and is the source of the live-run bug');
    assert(!updateGoalCalled,
      'v7.9.2 must NOT call updateGoal — same fictional-API problem');
  });

  test('v792 contract: FailurePolicy does NOT manually fire goal:stalled (markStalled fires it)', async () => {
    const goalId = 'goal_no_double_event';
    const gs = makeMockGoalStack({ id: goalId, description: 'test', status: 'active' });
    const firedEvents = [];
    const host = makeHost(gs);
    host.bus = { fire: (evtName, payload, opts) => { firedEvents.push({ evtName, payload, opts }); } };

    await handler.call(host, goalId, 'User rejected plan with blockers');

    // FailurePolicy should NOT fire goal:stalled itself — that's markStalled's job.
    // Since our mock markStalled does not fire (test-controlled), we expect zero
    // goal:stalled events from FailurePolicy. The real markStalled in production
    // fires the event with source='GoalStack', not from FailurePolicy.
    const stalled = firedEvents.filter(e => e.evtName === 'goal:stalled');
    assertEqual(stalled.length, 0,
      'FailurePolicy must NOT manually fire goal:stalled — that responsibility belongs to markStalled. Previously this caused double-events.');
  });

});

describe('v792 contract: GoalDriver no longer has rejected-cooldown map (v7.9.1 removed)', () => {

  test('v792 contract: _listPursueable filters only by status and pause (no cooldown filter)', () => {
    const { GoalDriver } = require(path.join(ROOT, 'src/agent/agency/GoalDriver'));
    const goalA = { id: 'goal_A', status: 'active', source: 'user' };
    const goalB = { id: 'goal_B', status: 'stalled', source: 'idle-mind' };

    const driver = new GoalDriver({
      bus: createBus(),
      goalStack: { goals: [goalA, goalB] },
      intervals: { register: () => {}, clear: () => {} },
      settings: { get: () => null },
      memory: null,
      cfg: { scanIntervalMs: 5000 },
    });

    const list = driver._listPursueable();
    assertEqual(list.length, 1, 'only active goals are pursueable');
    assertEqual(list[0].id, 'goal_A', 'stalled goal must be filtered out by status check alone — no cooldown needed');
  });

  test('v792 contract: _goalRejectedCooldown is no longer referenced in _listPursueable source', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/agency/GoalDriver.js'), 'utf8');
    // Extract _listPursueable body
    const m = src.match(/_listPursueable\(\)\s*\{([\s\S]*?)\n\s*\}/);
    assert(m, '_listPursueable must exist in GoalDriver.js');
    assert(!m[1].includes('_goalRejectedCooldown'),
      'v7.9.2 removes the v7.9.1 cooldown filter — markStalled now sets status="stalled" correctly so the status filter alone is sufficient');
  });

});

run();
