// ============================================================
// GENESIS — v799-final-progress-detector.contract.test.js
//
// Pins v7.9.9 Fix 5 (no-progress detector — Reflexion-style):
//   - AgentLoopProgressDetector module exports ProgressDetector class
//     plus hashStepResult/hashPlan helpers and ACTION_HASH_WINDOW const.
//   - recordStep accumulates last-N hashes per goalId, fires
//     agent-loop:no-progress-detected when last 3 entries identical.
//   - recordPlan fires agent-loop:identical-plan-detected when current
//     plan hash matches the previous pursuit's hash for the same goalId.
//   - clear()/attachCleanupListeners() wipe state on goal-terminal events.
//   - Pursuit lazy-inits ProgressDetector at pursuit-start (plan-ready).
//   - Pursuit calls recordPlan + handles identical → reflectOnProgress.
//   - Pursuit calls recordStep after each step result.
//   - Hard-gate-abort extracted to AgentLoopPursuitGate.handleHardGateAbort.
//   - File-size-guard still passes (< 700 LOC).
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, run } = require('../harness');

const DETECTOR_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopProgressDetector.js');
const PURSUIT_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js');
const GATE_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js');

const { ProgressDetector, hashStepResult, hashPlan, ACTION_HASH_WINDOW } =
  require(DETECTOR_PATH);

describe('v7.9.9 Fix 5 — Progress Detector', () => {

  // ── Module shape ─────────────────────────────────────────────

  test('MOD-01: module exports ProgressDetector class + helpers + window const', () => {
    assert(typeof ProgressDetector === 'function', 'ProgressDetector must be a class');
    assert(typeof hashStepResult === 'function', 'hashStepResult helper must be exported');
    assert(typeof hashPlan === 'function', 'hashPlan helper must be exported');
    assert(typeof ACTION_HASH_WINDOW === 'number' && ACTION_HASH_WINDOW === 3,
      'ACTION_HASH_WINDOW must be exported and equal to 3 (Reflexion heuristic)');
  });

  test('MOD-02: hashStepResult is deterministic and short', () => {
    const a = hashStepResult({ type: 'CODE', description: 'x' }, { error: 'foo' });
    const b = hashStepResult({ type: 'CODE', description: 'x' }, { error: 'foo' });
    assert(a === b, 'identical inputs must produce identical hashes');
    assert(a.length === 16, 'hash must be 16 chars (truncated sha256 hex)');
    const c = hashStepResult({ type: 'CODE', description: 'y' }, { error: 'foo' });
    assert(a !== c, 'different description must produce different hash');
    const d = hashStepResult({ type: 'CODE', description: 'x' }, { error: 'bar' });
    assert(a !== d, 'different error must produce different hash');
    const e = hashStepResult({ type: 'CODE', description: 'x' }, { /* no error */ });
    assert(a !== e, 'error vs ok must produce different hash');
  });

  test('MOD-03: hashPlan reacts to goal description and step shape', () => {
    const steps = [{ type: 'CODE', description: 's1' }, { type: 'VERIFY', description: 's2' }];
    const a = hashPlan({ description: 'goal A' }, steps);
    const b = hashPlan({ description: 'goal A' }, steps);
    assert(a === b, 'identical inputs must produce identical hashes');
    const c = hashPlan({ description: 'goal B' }, steps);
    assert(a !== c, 'different goal description must produce different hash');
    const d = hashPlan({ description: 'goal A' }, [{ type: 'CODE', description: 's1' }]);
    assert(a !== d, 'different step count must produce different hash');
  });

  // ── recordStep behaviour ─────────────────────────────────────

  test('REC-01: recordStep returns noProgress=false until 3 identical hashes', () => {
    const fired = [];
    const bus = { fire: (ev, payload) => fired.push({ ev, payload }) };
    const d = new ProgressDetector({ bus });
    const step = { type: 'CODE', description: 'x' };
    const result = { error: 'same' };

    const r1 = d.recordStep('goal_1', step, result);
    assert(r1.noProgress === false, 'first record should not detect');
    const r2 = d.recordStep('goal_1', step, result);
    assert(r2.noProgress === false, 'second record should not detect');
    const r3 = d.recordStep('goal_1', step, result);
    assert(r3.noProgress === true, 'third identical record must detect no-progress');
    assert(fired.some(f => f.ev === 'agent-loop:no-progress-detected'),
      'no-progress event must fire');
  });

  test('REC-02: recordStep resets detection after a different result', () => {
    const fired = [];
    const bus = { fire: (ev, payload) => fired.push({ ev, payload }) };
    const d = new ProgressDetector({ bus });
    const step = { type: 'CODE', description: 'x' };

    d.recordStep('g', step, { error: 'A' });
    d.recordStep('g', step, { error: 'A' });
    d.recordStep('g', step, { error: 'B' });   // breaks the streak
    const r = d.recordStep('g', step, { error: 'A' });
    assert(r.noProgress === false, 'streak should be broken by intervening different error');
  });

  test('REC-03: empty/null goalId is a no-op', () => {
    const d = new ProgressDetector({ bus: { fire: () => {} } });
    const r1 = d.recordStep('', { type: 'X' }, { error: 'y' });
    const r2 = d.recordStep(null, { type: 'X' }, { error: 'y' });
    assert(r1.noProgress === false && r2.noProgress === false,
      'missing goalId must not trigger detection or accumulate state');
    assert(d.getStats().stepHashKeys === 0, 'no state must accumulate for null goalId');
  });

  // ── recordPlan behaviour ─────────────────────────────────────

  test('PLAN-01: first recordPlan returns identical=false; second identical call returns true', () => {
    const fired = [];
    const bus = { fire: (ev, payload) => fired.push({ ev, payload }) };
    const d = new ProgressDetector({ bus });
    const goal = { description: 'do thing' };
    const steps = [{ type: 'CODE', description: 'x' }];

    const r1 = d.recordPlan('g', goal, steps);
    assert(r1.identical === false, 'first recordPlan must not be identical');
    const r2 = d.recordPlan('g', goal, steps);
    assert(r2.identical === true, 'second identical recordPlan must detect match');
    assert(fired.some(f => f.ev === 'agent-loop:identical-plan-detected'),
      'identical-plan event must fire');
  });

  test('PLAN-02: clear() wipes state for one goalId without affecting others', () => {
    const d = new ProgressDetector({ bus: { fire: () => {} } });
    const step = { type: 'CODE', description: 'x' };
    d.recordStep('g1', step, { error: 'a' });
    d.recordStep('g1', step, { error: 'a' });
    d.recordStep('g2', step, { error: 'b' });
    assert(d.getStats().stepHashKeys === 2);
    d.clear('g1');
    assert(d.getStats().stepHashKeys === 1, 'clear(g1) must leave g2 state intact');
  });

  test('PLAN-03: attachCleanupListeners subscribes to all four goal-terminal events', () => {
    const subscriptions = [];
    const bus = {
      fire: () => {},
      on: (ev, fn) => { subscriptions.push({ ev, fn }); },
    };
    const d = new ProgressDetector({ bus });
    d.attachCleanupListeners();
    const evs = subscriptions.map(s => s.ev);
    for (const required of ['goal:completed', 'goal:abandoned', 'goal:obsolete', 'goal:stalled']) {
      assert(evs.includes(required), `attachCleanupListeners must subscribe to ${required}`);
    }
    // Calling attach again must not double-subscribe.
    d.attachCleanupListeners();
    assert(subscriptions.length === 4, 'attachCleanupListeners must be idempotent');
  });

  test('PLAN-04: terminal event triggers clear()', () => {
    const subs = {};
    const bus = { fire: () => {}, on: (ev, fn) => { subs[ev] = fn; } };
    const d = new ProgressDetector({ bus });
    d.attachCleanupListeners();
    d.recordStep('g1', { type: 'X' }, { error: 'a' });
    assert(d.getStats().stepHashKeys === 1);
    subs['goal:completed']({ goalId: 'g1' });
    assert(d.getStats().stepHashKeys === 0, 'goal:completed must clear state');
  });

  // ── Pursuit wiring ───────────────────────────────────────────

  test('PURSUIT-01: AgentLoopPursuit imports ProgressDetector', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/require\('\.\/AgentLoopProgressDetector'\)/.test(src),
      'AgentLoopPursuit must require AgentLoopProgressDetector');
    assert(/ProgressDetector/.test(src),
      'AgentLoopPursuit must reference ProgressDetector class');
  });

  test('PURSUIT-02: identical-plan check + forced replan wiring exists', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/this\._progressDetector/.test(src),
      'pursuit must hold a _progressDetector instance');
    assert(/recordPlan\(this\.currentGoalId/.test(src),
      'pursuit must call recordPlan(currentGoalId, ...)');
    assert(/reflectOnProgress\?\.\(plan, \[\], 0\)/.test(src),
      'pursuit must trigger reflectOnProgress on identical-plan');
  });

  test('PURSUIT-03: per-step recordStep call exists in execute loop', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/this\._progressDetector\?\.recordStep\(this\.currentGoalId, step, result\)/.test(src),
      'pursuit must call _progressDetector?.recordStep after each step result');
  });

  // ── Hard-gate extraction (sets up Fix 4) ─────────────────────

  test('GATE-01: handleHardGateAbort helper exported from Gate module', () => {
    const src = fs.readFileSync(GATE_PATH, 'utf8');
    assert(/function handleHardGateAbort\(/.test(src),
      'AgentLoopPursuitGate must define handleHardGateAbort');
    assert(/module\.exports\s*=\s*\{[\s\S]*handleHardGateAbort/.test(src),
      'handleHardGateAbort must be in module.exports');
  });

  test('GATE-02: Pursuit calls handleHardGateAbort instead of inline block', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/handleHardGateAbort\(this, cogResult/.test(src),
      'Pursuit must dispatch to handleHardGateAbort helper');
    // The inline pattern `if (shouldAbortOnRisk(cogResult` must not appear
    // anywhere outside the helper (the if-block was extracted).
    assert(!/if \(shouldAbortOnRisk\(cogResult/.test(src),
      'inline shouldAbortOnRisk if-block must be removed from pursuit');
  });

  // ── File-size guard ──────────────────────────────────────────

  test('LOC-01: AgentLoopPursuit.js stays under 700 LOC after Fix 5', () => {
    const loc = fs.readFileSync(PURSUIT_PATH, 'utf8').split('\n').length;
    assert(loc < 700, `AgentLoopPursuit.js has ${loc} LOC — must stay under 700`);
  });

});

run().catch(err => { console.error(err); process.exit(1); });
