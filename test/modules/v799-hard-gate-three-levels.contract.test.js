// ============================================================
// v7.9.9 (C): hard-gate three-level dispatch contract tests.
//
// Replaces v799-final-trust-dispatch (which encoded the dropped
// α2.Fix 4 priorFailures matrix + LiveFixP5 first-attempt path).
//
// Pin the new simpler behaviour:
//   shouldAbortOnRisk(cogResult) — no priorFailures param, returns
//     true iff cogResult.proceed === false AND riskScore >= 5.0.
//   handleHardGateAbort dispatch:
//     SUPERVISED    → ask-user
//     AUTONOMOUS    → ask-user
//     FULL_AUTONOMY → decompose (refusal → obsolete, NEVER asks)
//     No TrustLevelSystem → SUPERVISED behaviour (safe default)
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const GATE_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js');

const {
  shouldAbortOnRisk,
  handleHardGateAbort,
  TRUST_LEVELS,
  HIGH_RISK_THRESHOLD,
} = require(GATE_PATH);

// ── Test doubles ───────────────────────────────────────────

function makeStubs() {
  const events = [];
  const bus = {
    fire: (ev, payload, opts) => events.push({ ev, payload, opts }),
    on: () => {},
    _container: { resolve: () => null },
  };
  return {
    bus,
    events,
    onProgress: () => {},
    emitFailure: () => {},
    clearTimeout: () => {},
    NullWorkspaceCtor: function () { this.clear = () => {}; },
    log: { warn: () => {}, info: () => {}, debug: () => {} },
  };
}

function makeLoop({ trustLevel, bus, spawnReturn = { spawned: false, reason: 'depth-limit' }, hasGoalStack = true }) {
  return {
    running: true,
    currentGoalId: 'goal_test_001',
    _pursuitAttempts: new Map(),
    _workspace: { clear: () => {} },
    bus,
    trustLevelSystem: trustLevel === undefined ? null : { getLevel: () => trustLevel },
    recovery: {
      _trySpawnObstacleSubgoal: async () => spawnReturn,
    },
    goalStack: hasGoalStack ? {
      markObsolete: () => {},
    } : null,
  };
}

describe('v799-hard-gate-three-levels', () => {

  // ── Source-grep contracts (no priorFailures, no first-attempt threshold) ──

  test('SRC-01: shouldAbortOnRisk signature drops priorFailures param', () => {
    const src = fs.readFileSync(GATE_PATH, 'utf8');
    assert(/function shouldAbortOnRisk\(cogResult\)/.test(src),
      'shouldAbortOnRisk must take only cogResult (no priorFailures)');
  });

  test('SRC-02: FIRST_ATTEMPT_RISK_THRESHOLD constant removed', () => {
    const src = fs.readFileSync(GATE_PATH, 'utf8');
    assert(!/FIRST_ATTEMPT_RISK_THRESHOLD/.test(src),
      'v7.9.9 (D): LiveFixP5 constant must be removed');
  });

  test('SRC-03: only one threshold constant — HIGH_RISK_THRESHOLD = 5.0', () => {
    const src = fs.readFileSync(GATE_PATH, 'utf8');
    assert(/const HIGH_RISK_THRESHOLD = 5\.0/.test(src),
      'HIGH_RISK_THRESHOLD = 5.0 must be present');
  });

  // ── shouldAbortOnRisk ──────────────────────────────────────

  test('GATE-01: proceed=true → no abort regardless of risk', () => {
    assert(shouldAbortOnRisk({ proceed: true, riskScore: 9.9 }) === false,
      'proceed=true must short-circuit to false');
  });

  test('GATE-02: proceed=false + risk 5.9 → abort (was bypassed pre-v7.9.9)', () => {
    assert(shouldAbortOnRisk({ proceed: false, riskScore: 5.9 }) === true,
      'risk 5.9 must abort (no priorFailures gate any more)');
  });

  test('GATE-03: proceed=false + risk 4.9 → no abort', () => {
    assert(shouldAbortOnRisk({ proceed: false, riskScore: 4.9 }) === false,
      'risk below 5.0 must not abort');
  });

  test('GATE-04: null cogResult → no abort', () => {
    assert(shouldAbortOnRisk(null) === false,
      'null cogResult must not abort');
  });

  // ── handleHardGateAbort: three-branch dispatch ──────────

  test('DISP-01: SUPERVISED + high risk → warn-only (TrustLevelSystem handles step-level asks)', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: TRUST_LEVELS.SUPERVISED, bus: s.bus });
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 5.9, reason: 'simulation-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.aborted === false,
      `SUPERVISED must warn-only on hard-gate, got aborted=${result.aborted} action=${result.action}`);
    assert(!s.events.some(e => e.ev === 'agent-loop:needs-input'),
      'hard-gate must NOT fire needs-input — TrustLevelSystem.checkApproval(stepType) is the single ask channel');
  });

  test('DISP-02: AUTONOMOUS + high risk → warn-only (no hard-gate spam, ask handled at step level)', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: TRUST_LEVELS.AUTONOMOUS, bus: s.bus });
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 5.9, reason: 'simulation-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.aborted === false,
      `AUTONOMOUS must NOT abort on hard-gate spam — got aborted=${result.aborted} action=${result.action}`);
    assert(!s.events.some(e => e.ev === 'agent-loop:needs-input'),
      'AUTONOMOUS must NEVER emit needs-input from hard-gate (only TrustLevelSystem.checkApproval may)');
  });

  test('DISP-03: AUTONOMOUS + high risk + many prior failures still warn-only (no escalation via hard-gate)', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: TRUST_LEVELS.AUTONOMOUS, bus: s.bus });
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 7.0, reason: 'simulation-risk' },
      5, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.aborted === false,
      'AUTONOMOUS + 5 prior failures must still warn-only via hard-gate (escalation is per-step, not via gate)');
    assert(!s.events.some(e => e.ev === 'agent-loop:needs-input'),
      'no needs-input even on repeated AUTONOMOUS failures from hard-gate');
  });

  test('DISP-04: FULL_AUTONOMY + high risk + spawn succeeds → decomposed (never asks)', async () => {
    const s = makeStubs();
    const loop = makeLoop({
      trustLevel: TRUST_LEVELS.FULL_AUTONOMY,
      bus: s.bus,
      spawnReturn: { spawned: true, subId: 'sub_x_001' },
    });
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 5.9, reason: 'simulation-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.action === 'decomposed', `FULL_AUTONOMY must decompose, got ${result.action}`);
    assert(result.subId === 'sub_x_001', 'subId must propagate');
    assert(!s.events.some(e => e.ev === 'agent-loop:needs-input'),
      'FULL_AUTONOMY must NEVER emit needs-input');
  });

  test('DISP-05: FULL_AUTONOMY + spawn refused → mark obsolete (never asks)', async () => {
    const s = makeStubs();
    let obsoleteCalledWith = null;
    const loop = makeLoop({
      trustLevel: TRUST_LEVELS.FULL_AUTONOMY,
      bus: s.bus,
      spawnReturn: { spawned: false, reason: 'depth-limit' },
    });
    loop.goalStack.markObsolete = (id, reason) => { obsoleteCalledWith = { id, reason }; };
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 5.9, reason: 'simulation-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.action === 'obsolete', `expected obsolete, got ${result.action}`);
    assert(obsoleteCalledWith && obsoleteCalledWith.id === 'goal_test_001',
      'markObsolete must be called with the goalId');
    assert(!s.events.some(e => e.ev === 'agent-loop:needs-input'),
      'FULL_AUTONOMY must NEVER emit needs-input even on decompose refusal');
  });

  test('DISP-06: no TrustLevelSystem → SUPERVISED behaviour (warn-only)', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: undefined, bus: s.bus });
    loop.trustLevelSystem = null; // explicitly absent
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 5.9, reason: 'simulation-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.aborted === false,
      'missing TrustLevelSystem must default to SUPERVISED behaviour (warn-only)');
    assert(!s.events.some(e => e.ev === 'agent-loop:needs-input'),
      'no needs-input from hard-gate when TrustLevelSystem is missing');
  });

  test('DISP-07: telemetry simulation-abort event fires at any level when gate triggers', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: TRUST_LEVELS.AUTONOMOUS, bus: s.bus });
    await handleHardGateAbort(loop, { proceed: false, riskScore: 5.9, reason: 'simulation-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(s.events.some(e => e.ev === 'agent-loop:simulation-abort'),
      'simulation-abort telemetry must fire at any trust level so dashboards see the high-risk class');
  });

  test('DISP-08: cogResult.proceed === true → aborted=false even at high risk', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: TRUST_LEVELS.SUPERVISED, bus: s.bus });
    const result = await handleHardGateAbort(loop, { proceed: true, riskScore: 9.9, reason: 'flagged but allowed' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.aborted === false,
      'proceed=true must short-circuit even at risk 9.9');
  });

  test('DISP-09: risk under threshold → aborted=false, no telemetry, no warning event fire', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: TRUST_LEVELS.AUTONOMOUS, bus: s.bus });
    const result = await handleHardGateAbort(loop, { proceed: false, riskScore: 3.0, reason: 'low-risk' },
      0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { type: 'CODE', description: 'x' }, 0);
    assert(result.aborted === false, 'risk 3.0 must not abort');
    assert(!s.events.some(e => e.ev === 'agent-loop:simulation-abort'),
      'risk below threshold must NOT fire simulation-abort telemetry');
  });

  // ── File-size guard preservation ────────────────────────

  test('LOC-01: AgentLoopPursuit.js stays under 700 LOC after (C) simplification', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    const lineCount = src.split('\n').length;
    assert(lineCount < 700,
      `AgentLoopPursuit.js must stay under 700 LOC (file-size-guard), got ${lineCount}`);
  });

});

run().catch(err => { console.error(err); process.exit(1); });
