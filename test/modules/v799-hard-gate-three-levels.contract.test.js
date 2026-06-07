// ============================================================
// v7.9.20 (C): simulation-risk is no longer a gate — contract tests.
//
// Replaces the v7.9.9 three-level dispatch contract (SUPERVISED/
// AUTONOMOUS ask, FULL_AUTONOMY decompose/obsolete). Field 2026-06
// showed a read-only "Inspect Cognitive Monitor" goal scoring
// riskScore 5.78 ("HIGH risk"), aborting, and recursively spawning
// sub-goals to the depth limit — 4 goals, 0 work, 0 F2 nodes.
//
// New contract pinned here:
//   handleHardGateAbort ALWAYS returns { aborted: false } for
//   simulation-risk, on EVERY trust level (and with no TrustLevelSystem):
//     - no abort, no decompose (_trySpawnObstacleSubgoal), no markObsolete
//     - no agent-loop:simulation-abort telemetry
//   What asks for approval is decided solely by trust level via
//   TrustLevelSystem.checkApproval at the STEP level (see Teil D),
//   not by the numerical simulation variance.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const { describe, test, run, assert } = require('../harness');

const ROOT = path.join(__dirname, '../..');
const GATE_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js');

const {
  handleHardGateAbort,
  TRUST_LEVELS,
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

function makeLoop({ trustLevel, bus, hasGoalStack = true }) {
  return {
    running: true,
    currentGoalId: 'goal_test_001',
    _pursuitAttempts: new Map(),
    _workspace: { clear: () => {} },
    bus,
    trustLevelSystem: trustLevel === undefined ? null : { getLevel: () => trustLevel },
    recovery: {
      _trySpawnObstacleSubgoal: async () => ({ spawned: true, subId: 'x' }),
    },
    goalStack: hasGoalStack ? { markObsolete: () => {} } : null,
  };
}

describe('v799-hard-gate-three-levels', () => {

  // ── Source contracts: the abort path is gone ──

  test('SRC-01: handleHardGateAbort has no `return { aborted: true }` path left', () => {
    const src = fs.readFileSync(GATE_PATH, 'utf8');
    const block = src.split(/function handleHardGateAbort/)[1] || '';
    assert(!/return\s*\{\s*aborted:\s*true/.test(block),
      'handleHardGateAbort must not contain a return { aborted: true } path');
  });

  test('SRC-02: handleHardGateAbort no longer fires agent-loop:simulation-abort', () => {
    const src = fs.readFileSync(GATE_PATH, 'utf8');
    const block = src.split(/function handleHardGateAbort/)[1] || '';
    assert(!/\.fire\(\s*['"]agent-loop:simulation-abort/.test(block),
      'handleHardGateAbort must not fire the simulation-abort telemetry event');
  });

  // ── handleHardGateAbort proceeds on EVERY level ──

  for (const [name, lvl] of [
    ['SUPERVISED', 0], ['AUTONOMOUS', 1], ['FULL_AUTONOMY', 2], ['no-TrustLevelSystem', undefined],
  ]) {
    test(`PROCEED-${name}: sim-risk 5.78 -> aborted:false, no telemetry, no decompose, no markObsolete`, async () => {
      const s = makeStubs();
      let spawnCalled = false, obsoleteCalled = false;
      const loop = makeLoop({ trustLevel: lvl, bus: s.bus });
      loop.recovery._trySpawnObstacleSubgoal = async () => { spawnCalled = true; return { spawned: true, subId: 'x' }; };
      if (loop.goalStack) loop.goalStack.markObsolete = () => { obsoleteCalled = true; };
      const cog = { proceed: false, reason: 'simulation-risk', riskScore: 5.78 };
      const res = await handleHardGateAbort(loop, cog, 0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { id: 'step' }, 0);
      assert(res.aborted === false, `${name}: must proceed (aborted:false), got ${JSON.stringify(res)}`);
      assert(!spawnCalled, `${name}: must NOT decompose (no _trySpawnObstacleSubgoal)`);
      assert(!obsoleteCalled, `${name}: must NOT markObsolete`);
      assert(!s.events.some(e => e.ev === 'agent-loop:simulation-abort'),
        `${name}: must NOT fire simulation-abort telemetry`);
    });
  }

  test('PROCEED-under-threshold: proceed=false + risk 4.9 -> aborted:false', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: 2, bus: s.bus });
    const cog = { proceed: false, reason: 'simulation-risk', riskScore: 4.9 };
    const res = await handleHardGateAbort(loop, cog, 0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { id: 'step' }, 0);
    assert(res.aborted === false, 'low-risk must proceed too');
  });

  test('PROCEED-proceed-true: cogResult.proceed === true -> aborted:false', async () => {
    const s = makeStubs();
    const loop = makeLoop({ trustLevel: 0, bus: s.bus });
    const cog = { proceed: true, reason: null, riskScore: 9.9 };
    const res = await handleHardGateAbort(loop, cog, 0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { id: 'step' }, 0);
    assert(res.aborted === false, 'proceed=true must never abort');
  });

  test('NO-CASCADE: two consecutive high-risk goals -> no sub-goal spawned for either', async () => {
    const s = makeStubs();
    let spawnCount = 0;
    const loop = makeLoop({ trustLevel: 2, bus: s.bus });
    loop.recovery._trySpawnObstacleSubgoal = async () => { spawnCount++; return { spawned: true, subId: 'x' }; };
    const cog = { proceed: false, reason: 'simulation-risk', riskScore: 6.1 };
    await handleHardGateAbort(loop, cog, 0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { id: 'a' }, 0);
    loop.currentGoalId = 'goal_test_002';
    await handleHardGateAbort(loop, cog, 0, s.onProgress, s.emitFailure, s.clearTimeout, s.NullWorkspaceCtor, s.log, { id: 'b' }, 0);
    assert(spawnCount === 0, `no decompose cascade — _trySpawnObstacleSubgoal must never fire, got ${spawnCount}`);
  });

  test('LOC-01: AgentLoopPursuit.js stays under 700 LOC after (C) simplification', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
    const lineCount = src.split('\n').length;
    assert(lineCount < 700,
      `AgentLoopPursuit.js must stay under 700 LOC (file-size-guard), got ${lineCount}`);
  });

});

run().catch(err => { console.error(err); process.exit(1); });
