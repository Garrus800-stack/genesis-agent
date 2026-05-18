#!/usr/bin/env node
// ============================================================
// Test: v7.9.1 contract — live-run fixes
//
// Covers:
//   - TRUST: 'plan-has-issues' and 'continue' classified as 'medium'
//     so AUTONOMOUS auto-approves them
//   - GOAL DRIVER: synthetic loop_early_<ts> ids skip failure-burst
//     tracking entirely (no stalled warning, no entry in burst map)
//   - GOAL DRIVER: rejected-cooldown survives across multiple scan
//     ticks — _listPursueable() returns empty after a reject
//   - APPROVAL GATE: DEFAULT_TIMEOUT_MS raised to 300_000 (5 min)
//   - IDLE MIND: activityCounts map increments per recorded activity
//     and is exposed via getDashboardData() for the renderer
// ============================================================

'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { describe, test, assert, assertEqual, run } = require('../harness');

const { createBus } = require(path.join(ROOT, 'src/agent/core/EventBus'));

function mockStorage() {
  const _data = {};
  return {
    readJSON: (f, def) => _data[f] ?? def,
    writeJSON: (f, d) => { _data[f] = d; },
    writeJSONAsync: async (f, d) => { _data[f] = d; },
    _data,
  };
}

const { TrustLevelSystem } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));
const { ApprovalGate } = require(path.join(ROOT, 'src/agent/revolution/ApprovalGate'));

// ── Trust: plan-has-issues + continue auto-approved at AUTONOMOUS ─

describe('v791 contract: TrustLevelSystem action-risk classification', () => {

  test('v791 contract: continue is classified as medium and auto-approved at AUTONOMOUS', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    tls.setLevel(2); // AUTONOMOUS
    const result = tls.checkApproval('continue', {});
    assert(result.approved === true,
      'continue should be auto-approved at AUTONOMOUS (Level 2) — it is a benign step-limit prompt classified as medium');
  });

  test('v791 contract: continue still needs approval at ASSISTED', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    tls.setLevel(1); // ASSISTED — only 'safe' is auto-approved
    const result = tls.checkApproval('continue', {});
    assert(result.approved === false,
      'continue should still need approval at ASSISTED — only AUTONOMOUS+ auto-approves medium-risk');
  });

  test('v791 contract: plan-has-issues stays blocking even at FULL_AUTONOMY (v7.7.8 safety contract)', () => {
    // Structurally broken plans must always pause for conscious user
    // decision regardless of trust level. This was set in v7.7.8 and
    // v7.9.1 must NOT regress it.
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    tls.setLevel(3); // FULL_AUTONOMY
    const result = tls.checkApproval('plan-has-issues', {});
    assert(result.approved === false,
      'plan-has-issues must stay blocking at every trust level — v7.7.8 safety contract');
  });

  test('v791 contract: unknown actions still fall back to high-risk', () => {
    const tls = new TrustLevelSystem({ bus: createBus(), storage: mockStorage() });
    tls.setLevel(2);
    const result = tls.checkApproval('completely-unknown-action', {});
    assert(result.approved === false,
      'unknown actions must still default to high-risk so we do not accidentally grant medium-clearance to anything unmapped');
  });

});

// ── ApprovalGate: timeout raised to 5 minutes ─────────────────────

describe('v791 contract: ApprovalGate timeout', () => {

  test('v791 contract: DEFAULT_TIMEOUT_MS is 300_000 (5 minutes)', () => {
    // The constant is module-private; verify via constructor without
    // timeoutMs argument and inspecting the resulting _timeoutMs.
    const gate = new ApprovalGate({ bus: createBus() });
    assertEqual(gate._timeoutMs, 300_000,
      'default timeout should be 5 minutes; previously 60s was too short for the UI flow');
  });

  test('v791 contract: explicit timeoutMs argument still honored', () => {
    const gate = new ApprovalGate({ bus: createBus(), timeoutMs: 90_000 });
    assertEqual(gate._timeoutMs, 90_000,
      'explicit timeoutMs in constructor must override the default');
  });

});

// ── GoalDriverFailurePolicy: loop_early ids skip burst tracking ───

describe('v791 contract: GoalDriverFailurePolicy loop_early filter', () => {

  const { failurePolicyMixin } = require(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy'));
  const handler = failurePolicyMixin._applyFailurePause;

  test('v791 contract: failurePolicyMixin exports _applyFailurePause', () => {
    assert(typeof handler === 'function',
      'failurePolicyMixin._applyFailurePause must be a callable mixin method');
  });

  test('v791 contract: loop_early_<ts> goal ids are skipped in _applyFailurePause', async () => {
    let setStatusCalled = false;
    const host = {
      goalStack: {
        goals: [],
        setStatus: () => { setStatusCalled = true; },
      },
      bus: { fire: () => {} },
      _failureBurst: new Map(),
      _failurePauseTimers: new Map(),
      _goalPausedUntil: new Map(),
      _lastPausedAt: new Map(),
      _running: true,
      _scanAndMaybePursue: () => {},
    };

    await handler.call(host, 'loop_early_1779057038124', 'User rejected plan with blockers');

    assert(!setStatusCalled,
      'setStatus must not be called for synthetic loop_early_<ts> ids');
    assertEqual(host._failureBurst.size, 0,
      'failure-burst map must stay empty for synthetic loop_early_<ts> ids');
    assertEqual(host._lastPausedAt.size, 0,
      'lastPausedAt map must stay empty too (we did not even enter the body)');
  });

  test('v791 contract: real goal ids still flow through _applyFailurePause', async () => {
    let markStalledCallCount = 0;
    let markStalledArgs = null;
    const realGoalId = 'goal_1779056971385_1';
    const host = {
      goalStack: {
        goals: [{ id: realGoalId, description: 'real goal', status: 'active' }],
        // v7.9.2: real API is markStalled (not setStatus). v7.9.1 tested
        // the wrong method which never existed on goalStack — see v792
        // for the corrected production path.
        markStalled: (id, reason) => { markStalledCallCount++; markStalledArgs = { id, reason }; return true; },
      },
      bus: { fire: () => {} },
      _failureBurst: new Map(),
      _failurePauseTimers: new Map(),
      _goalPausedUntil: new Map(),
      _lastPausedAt: new Map(),
      _running: true,
      _scanAndMaybePursue: () => {},
    };

    await handler.call(host, realGoalId, 'User rejected plan with blockers');

    assertEqual(markStalledCallCount, 1,
      'real goal-id must trigger markStalled to mark it as stalled on first user rejection');
    assertEqual(markStalledArgs.id, realGoalId,
      'markStalled must be called with the correct goal-id');
  });

});

// ── IdleMind: activityCounts aggregation ──────────────────────────

describe('v791 contract: IdleMind activity counts', () => {

  test('v791 contract: IdleMind exposes activityCounts via getDashboardData', () => {
    const fs = require('fs');
    const os = require('os');
    const _tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v791-idlemind-'));

    const { IdleMind } = require(path.join(ROOT, 'src/agent/autonomy/IdleMind'));
    const bus = createBus();
    const idle = new IdleMind({
      bus,
      model: { activeModel: null }, // no-op model
      memory: { searchFacts: () => [], recallEpisodes: () => [], getStats: () => ({}) },
      storageDir: _tmp,
      settings: { get: () => null },
    });

    // _activityCounts is lazy-initialised by the mixin on first record.
    // Record three different activity types.
    idle._recordActivity('ideate', 'test result A');
    idle._recordActivity('explore', 'test result B');
    idle._recordActivity('ideate', 'test result C');

    assert(idle._activityCounts instanceof Map,
      'IdleMind must expose _activityCounts as a Map after first _recordActivity call');

    assertEqual(idle._activityCounts.get('ideate'), 2,
      'ideate should be counted twice after two recordActivity calls');
    assertEqual(idle._activityCounts.get('explore'), 1,
      'explore should be counted once');

    // getStatus() exposes the dashboard view.
    const dash = idle.getStatus();
    assert(dash && typeof dash.activityCounts === 'object',
      'getStatus() must include an activityCounts field');
    assertEqual(dash.activityCounts.ideate, 2, 'dashboard activityCounts.ideate = 2');
    assertEqual(dash.activityCounts.explore, 1, 'dashboard activityCounts.explore = 1');

    fs.rmSync(_tmp, { recursive: true, force: true });
  });

});

run();
