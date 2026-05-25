// ============================================================
// GENESIS — v799-final-decompose-on-failure.contract.test.js
//
// Pins v7.9.9 Fix 3 (decompose-on-failure activation):
//   - AgentLoopRecovery constructor initialises _repeatedFailures Map
//     plus _REPEATED_FAILURES_TTL_MS = 1h.
//   - classifyAndRecover calls _tryDecomposeOnRepeatedFailure right
//     before its `return { action: 'none' }` fall-through.
//   - _tryDecomposeOnRepeatedFailure spawns a synthetic obstacle on
//     the 2nd strike of the same (goalId, stepIndex, errorClass)
//     tuple — 1st strike just records, 3rd+ is a no-op.
//   - Synthetic obstacle uses "Investigate" verb (Fix 1 whitelist
//     compatible — sub-goals exempt from Stage A anyway, but staying
//     on-pattern matters for Genesis's own self-consistency).
//   - Fires agent-loop:decompose-on-failure event when triggering.
//   - _sweepRepeatedFailures drops entries older than TTL.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, run } = require('../harness');

const RECOVERY_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js');
const EVENT_TYPES_PATH = path.join(ROOT, 'src/agent/core/EventTypes.js');
const EVENT_SCHEMAS_PATH = path.join(ROOT, 'src/agent/core/EventPayloadSchemas.js');

const { AgentLoopRecoveryDelegate } = require(RECOVERY_PATH);

describe('v7.9.9 Fix 3 — Decompose-on-Failure Activation', () => {

  // ── Constructor state ────────────────────────────────────────

  test('SRC-01: constructor initialises _repeatedFailures Map + TTL', () => {
    const src = fs.readFileSync(RECOVERY_PATH, 'utf8');
    assert(/this\._repeatedFailures\s*=\s*new Map\(\)/.test(src),
      'constructor must initialise this._repeatedFailures as a Map');
    assert(/this\._REPEATED_FAILURES_TTL_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/.test(src),
      'constructor must set _REPEATED_FAILURES_TTL_MS to 1h (60 * 60 * 1000)');
  });

  test('RUNTIME-01: new instance has empty Map + 1h TTL', () => {
    const fakeLoop = { currentGoalId: null, bus: { fire: () => {} } };
    const rec = new AgentLoopRecoveryDelegate(fakeLoop);
    assert(rec._repeatedFailures instanceof Map, '_repeatedFailures must be a Map');
    assert(rec._repeatedFailures.size === 0, 'Map must start empty');
    assert(rec._REPEATED_FAILURES_TTL_MS === 3600000, 'TTL must be 1h in ms');
  });

  // ── classifyAndRecover wiring ────────────────────────────────

  test('SRC-02: classifyAndRecover calls _tryDecomposeOnRepeatedFailure before return none', () => {
    const src = fs.readFileSync(RECOVERY_PATH, 'utf8');
    const callIdx = src.indexOf('this._tryDecomposeOnRepeatedFailure(step, result, stepIndex, onProgress)');
    // The fall-through `return { action: 'none' }` is the LAST occurrence inside
    // classifyAndRecover (an earlier short-circuit return for missing FailureTaxonomy
    // also returns 'none' but is in a different branch).
    const returnNoneIdx = src.lastIndexOf("return { action: 'none' }");
    assert(callIdx > 0, 'classifyAndRecover must call _tryDecomposeOnRepeatedFailure');
    assert(returnNoneIdx > 0, "default return { action: 'none' } must still exist as fall-through");
    assert(callIdx < returnNoneIdx, "_tryDecomposeOnRepeatedFailure must be called BEFORE the fall-through return");
  });

  test('SRC-03: _tryDecomposeOnRepeatedFailure method body has correct shape', () => {
    const src = fs.readFileSync(RECOVERY_PATH, 'utf8');
    const idx = src.search(/_tryDecomposeOnRepeatedFailure\(step, result, stepIndex, onProgress\)\s*\{/);
    assert(idx > 0, '_tryDecomposeOnRepeatedFailure method must be defined');
    const block = src.slice(idx, idx + 2500);
    assert(/this\.loop\.currentGoalId/.test(block),
      'method must read currentGoalId from loop');
    assert(/result\.error/.test(block),
      'method must read result.error to form errorClass');
    assert(/this\._sweepRepeatedFailures\(\)/.test(block),
      'method must sweep expired entries before processing');
    assert(/strikes\s*!==\s*2/.test(block) || /strikes\s*===\s*2/.test(block) || /strikes\s*<\s*2/.test(block) || /strikes\s*>=\s*2/.test(block),
      'method must check strike count (2nd strike triggers spawn)');
    assert(/_trySpawnObstacleSubgoal\(syntheticObstacle/.test(block),
      'method must call _trySpawnObstacleSubgoal with synthetic obstacle');
    assert(/subGoalDescription:[^,]*Investigate/.test(block),
      'synthetic obstacle must use "Investigate" verb (Fix 1 whitelist compatible)');
  });

  test('SRC-04: _sweepRepeatedFailures method exists with TTL-based eviction', () => {
    const src = fs.readFileSync(RECOVERY_PATH, 'utf8');
    const idx = src.search(/_sweepRepeatedFailures\(\)\s*\{/);
    assert(idx > 0, '_sweepRepeatedFailures method must exist');
    const block = src.slice(idx, idx + 600);
    assert(/this\._repeatedFailures\.entries\(\)/.test(block),
      'sweep must iterate _repeatedFailures.entries()');
    assert(/this\._repeatedFailures\.delete\(/.test(block),
      'sweep must delete expired keys');
    assert(/now\s*-\s*entry\.ts\s*>\s*ttl/.test(block) || /now\s*-\s*entry\.ts\s*>\s*this\._REPEATED_FAILURES_TTL_MS/.test(block),
      'sweep must compare entry.ts age against TTL');
  });

  // ── Runtime behavior (1st strike: record, 2nd: spawn, 3rd+: no-op) ──

  test('RUNTIME-02: first strike just records, returns null', async () => {
    let spawnCalls = 0;
    const fakeLoop = {
      currentGoalId: 'goal_test_1',
      bus: { fire: () => {} },
      goalStack: { goals: [{ id: 'goal_test_1' }], addSubGoal: async () => { spawnCalls++; return { id: 'sub_1' }; } },
    };
    const rec = new AgentLoopRecoveryDelegate(fakeLoop);
    // Stub _trySpawnObstacleSubgoal to track calls
    rec._trySpawnObstacleSubgoal = async () => { spawnCalls++; return { spawned: true, subId: 'sub_x' }; };
    const result = await rec._tryDecomposeOnRepeatedFailure(
      { type: 'CODE', description: 's1' },
      { error: 'EACCES: permission denied' },
      0,
      () => {},
    );
    assert(result === null, '1st strike must return null (no spawn)');
    assert(spawnCalls === 0, '_trySpawnObstacleSubgoal must NOT be called on 1st strike');
    assert(rec._repeatedFailures.size === 1, 'Map must contain 1 entry after 1st strike');
  });

  test('RUNTIME-03: second strike on same key triggers spawn', async () => {
    let spawnCalls = 0;
    const fakeLoop = {
      currentGoalId: 'goal_test_2',
      bus: { fire: () => {} },
    };
    const rec = new AgentLoopRecoveryDelegate(fakeLoop);
    rec._trySpawnObstacleSubgoal = async () => { spawnCalls++; return { spawned: true, subId: 'sub_y' }; };
    const step = { type: 'CODE', description: 's' };
    const errResult = { error: 'EACCES: permission denied' };
    await rec._tryDecomposeOnRepeatedFailure(step, errResult, 0, () => {});
    const second = await rec._tryDecomposeOnRepeatedFailure(step, errResult, 0, () => {});
    assert(second && second.action === 'blocked-on-subgoal',
      '2nd strike must return action blocked-on-subgoal');
    assert(second.subId === 'sub_y', '2nd strike must return the spawned subId');
    assert(spawnCalls === 1, '_trySpawnObstacleSubgoal must be called exactly once on 2nd strike');
  });

  test('RUNTIME-04: third strike does NOT double-spawn', async () => {
    let spawnCalls = 0;
    const fakeLoop = { currentGoalId: 'goal_test_3', bus: { fire: () => {} } };
    const rec = new AgentLoopRecoveryDelegate(fakeLoop);
    rec._trySpawnObstacleSubgoal = async () => { spawnCalls++; return { spawned: true, subId: 'sub_z' }; };
    const step = { type: 'CODE', description: 's' };
    const errResult = { error: 'EACCES: permission denied' };
    await rec._tryDecomposeOnRepeatedFailure(step, errResult, 0, () => {}); // 1st
    await rec._tryDecomposeOnRepeatedFailure(step, errResult, 0, () => {}); // 2nd → spawn
    const third = await rec._tryDecomposeOnRepeatedFailure(step, errResult, 0, () => {}); // 3rd
    assert(third === null, '3rd strike must return null (no double-spawn)');
    assert(spawnCalls === 1, '_trySpawnObstacleSubgoal must be called exactly once across all strikes');
  });

  test('RUNTIME-05: different errorClass on same (goal, step) is a separate counter', async () => {
    let spawnCalls = 0;
    const fakeLoop = { currentGoalId: 'goal_test_4', bus: { fire: () => {} } };
    const rec = new AgentLoopRecoveryDelegate(fakeLoop);
    rec._trySpawnObstacleSubgoal = async () => { spawnCalls++; return { spawned: true, subId: 'sub_a' }; };
    const step = { type: 'CODE', description: 's' };
    await rec._tryDecomposeOnRepeatedFailure(step, { error: 'ENOENT' }, 0, () => {});
    const r2 = await rec._tryDecomposeOnRepeatedFailure(step, { error: 'EACCES' }, 0, () => {});
    assert(r2 === null, 'different errorClass on same step must be a separate counter (1st strike for EACCES)');
    assert(spawnCalls === 0, 'no spawn until same errorClass repeats');
    assert(rec._repeatedFailures.size === 2, 'Map must hold both errorClass entries separately');
  });

  test('RUNTIME-06: no goalId is a no-op (e.g. pre-pursuit failure)', async () => {
    const rec = new AgentLoopRecoveryDelegate({ currentGoalId: null, bus: { fire: () => {} } });
    const r = await rec._tryDecomposeOnRepeatedFailure({ type: 'X' }, { error: 'e' }, 0, () => {});
    assert(r === null, 'missing goalId must short-circuit to null');
    assert(rec._repeatedFailures.size === 0, 'no entry recorded when goalId missing');
  });

  test('RUNTIME-07: no error field is a no-op', async () => {
    const rec = new AgentLoopRecoveryDelegate({ currentGoalId: 'g', bus: { fire: () => {} } });
    const r = await rec._tryDecomposeOnRepeatedFailure({ type: 'X' }, { /* no error */ }, 0, () => {});
    assert(r === null, 'result without error field must short-circuit');
    assert(rec._repeatedFailures.size === 0, 'no entry recorded when error is empty');
  });

  test('RUNTIME-08: TTL sweep removes stale entries', () => {
    const rec = new AgentLoopRecoveryDelegate({ currentGoalId: 'g', bus: { fire: () => {} } });
    rec._repeatedFailures.set('old-key', { count: 5, ts: Date.now() - 7200000 }); // 2h ago
    rec._repeatedFailures.set('fresh-key', { count: 1, ts: Date.now() });
    rec._sweepRepeatedFailures();
    assert(!rec._repeatedFailures.has('old-key'), 'old entry must be swept');
    assert(rec._repeatedFailures.has('fresh-key'), 'fresh entry must survive sweep');
  });

  test('RUNTIME-09: fires agent-loop:decompose-on-failure on 2nd strike', async () => {
    const fired = [];
    const fakeLoop = {
      currentGoalId: 'g_event',
      bus: { fire: (ev, payload) => fired.push({ ev, payload }) },
    };
    const rec = new AgentLoopRecoveryDelegate(fakeLoop);
    rec._trySpawnObstacleSubgoal = async () => ({ spawned: true, subId: 'sub' });
    const step = { type: 'CODE', description: 's' };
    const err = { error: 'EACCES denied' };
    await rec._tryDecomposeOnRepeatedFailure(step, err, 0, () => {});
    await rec._tryDecomposeOnRepeatedFailure(step, err, 0, () => {});
    const matches = fired.filter(f => f.ev === 'agent-loop:decompose-on-failure');
    assert(matches.length === 1,
      'agent-loop:decompose-on-failure must fire exactly once (on 2nd strike, not 1st)');
    assert(matches[0].payload.strikes === 2 && matches[0].payload.goalId === 'g_event',
      'event payload must include strikes count and goalId');
  });

  // ── Event registration ──────────────────────────────────────

  test('SRC-05: decompose-on-failure event registered in EventTypes', () => {
    const src = fs.readFileSync(EVENT_TYPES_PATH, 'utf8');
    assert(/DECOMPOSE_ON_FAILURE:\s*'agent-loop:decompose-on-failure'/.test(src),
      'EventTypes.AGENT_LOOP must declare DECOMPOSE_ON_FAILURE');
  });

  test('SRC-06: decompose-on-failure payload schema declared', () => {
    const src = fs.readFileSync(EVENT_SCHEMAS_PATH, 'utf8');
    assert(/'agent-loop:decompose-on-failure':\s*\{.*goalId.*stepIndex.*errorClass.*strikes/.test(src),
      'EventPayloadSchemas must declare goalId/stepIndex/errorClass/strikes for decompose-on-failure');
  });

});

run().catch(err => { console.error(err); process.exit(1); });
