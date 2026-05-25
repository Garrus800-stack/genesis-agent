// ============================================================
// GENESIS — v797-r-bugs.contract.test.js
//
// Pins the four R-class fixes that landed in v7.9.7 alongside the
// foundation (A-G) and extension (P-series) passes:
//
//   R1 — Trust-Level system collapsed from 4 levels to 3.
//        ASSISTED removed; AUTONOMOUS becomes the "ask only for
//        critical" default. Migration maps stored old indices.
//
//   R2 — mark-moment falls back to coreMemories.markAsSignificant
//        when EpisodicMemory has no episode yet but the caller
//        provided a clear summary.
//
//   R3.2 — Reset window for structural failures extended from 10
//          minutes to 60 minutes so slow pursuits don't reset the
//          burst counter mid-cycle and miss fast-track-to-obsolete.
//
//   R3.1 — STRUCTURAL_FAILURE_RE recognises "Cannot find module"
//          and the JS-runtime TypeError class.
//          (Covered in v797-foundation-pass B-tests; not repeated.)
//
//   R4 — _stepCode pre-flight scan for hallucinated require paths,
//        plus PROJECT_API_CONVENTIONS block in the prompt so the
//        LLM sees the right shape before generating.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

describe('v7.9.7 R-bug pass', () => {

// ── R1: TrustLevelSystem (3-level migration) ────────────────

const { TrustLevelSystem, TRUST_LEVELS } = require(
  path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));

test('R1: TRUST_LEVELS exports exactly three named levels', () => {
  const names = Object.keys(TRUST_LEVELS).sort();
  assertEqual(names.length, 3, 'exactly 3 trust level names');
  assert(names.includes('SUPERVISED'), 'has SUPERVISED');
  assert(names.includes('AUTONOMOUS'), 'has AUTONOMOUS');
  assert(names.includes('FULL_AUTONOMY'), 'has FULL_AUTONOMY');
  assertEqual(TRUST_LEVELS.SUPERVISED, 0, 'SUPERVISED = 0');
  assertEqual(TRUST_LEVELS.AUTONOMOUS, 1, 'AUTONOMOUS = 1');
  assertEqual(TRUST_LEVELS.FULL_AUTONOMY, 2, 'FULL_AUTONOMY = 2');
});

test('R1: ASSISTED is gone from the source', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem.js'), 'utf8');
  assert(!/TRUST_LEVELS\.ASSISTED/.test(src), 'TRUST_LEVELS.ASSISTED must not be referenced');
  assert(/_migrateLevel/.test(src), 'TrustLevelSystem must export _migrateLevel');
});

test('R1: _migrateLevel(0..3) maps correctly (v7.9.9 A: ASSISTED → SUPERVISED rebucket)', () => {
  assertEqual(TrustLevelSystem._migrateLevel(0), 0, '0 stays SUPERVISED');
  assertEqual(TrustLevelSystem._migrateLevel(1), 0, 'v7.9.9 (A): 1 (ASSISTED) → 0 (SUPERVISED) — safer-default rebucket');
  assertEqual(TrustLevelSystem._migrateLevel(2), 1, '2 collapses to AUTONOMOUS (was AUTONOMOUS, now index 1)');
  assertEqual(TrustLevelSystem._migrateLevel(3), 2, '3 maps to FULL_AUTONOMY (was FULL, now index 2)');
});

test('R1: _migrateLevel clamps out-of-range to SUPERVISED (v7.9.8)', () => {
  assertEqual(TrustLevelSystem._migrateLevel(99), 0, 'large value clamps to SUPERVISED');
  assertEqual(TrustLevelSystem._migrateLevel(-5), 0, 'negative value clamps to SUPERVISED');
  assertEqual(TrustLevelSystem._migrateLevel(undefined), 0, 'undefined clamps to SUPERVISED');
  assertEqual(TrustLevelSystem._migrateLevel(NaN), 0, 'NaN clamps to SUPERVISED');
});

test('R1: setLevel rejects values outside 0..2', async () => {
  const noopBus = { on: () => () => {}, fire() {}, emit() {} };
  const noopStorage = { readJSON: () => null, writeJSON: async () => {} };
  const tls = new TrustLevelSystem({ bus: noopBus, storage: noopStorage });
  let rejected3 = false, rejectedNeg = false;
  try { await tls.setLevel(3); } catch (_e) { rejected3 = true; }
  try { await tls.setLevel(-1); } catch (_e) { rejectedNeg = true; }
  assert(rejected3, 'setLevel(3) must reject (no longer valid)');
  assert(rejectedNeg, 'setLevel(-1) must reject');
});

test('R1: UI dropdown options [0,1,2] match new system', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/ui/modules/settings-defaults.js'), 'utf8');
  assert(/options:\s*\[0,\s*1,\s*2\]/.test(src), 'set-trust-level options must be [0,1,2]');
});

// ── R2: mark-moment fallback to coreMemories ────────────────

const { registerV737Tools } = require(
  path.join(ROOT, 'src/agent/cognitive/tools/v737-memory-tools'));

function makeRegistry() {
  const handlers = new Map();
  return {
    register: (name, _schema, handler) => { handlers.set(name, handler); },
    handlers,
  };
}

test('R2: summary + no episode → falls back to coreMemories.markAsSignificant', async () => {
  let markedSummary = null;
  const coreMemories = {
    markAsSignificant: async ({ summary }) => {
      markedSummary = summary;
      return { id: 'cm_test_1' };
    },
  };
  const pendingMomentsStore = { mark: () => 'pin_id' };
  const episodicMemory = { getLatest: () => null };

  const reg = makeRegistry();
  registerV737Tools(reg, { pendingMomentsStore, episodicMemory, coreMemories });
  const handler = reg.handlers.get('mark-moment');
  assert(handler, 'mark-moment must be registered');

  const result = await handler({ summary: 'I learned something important about Tracer wiring' });
  assertEqual(result.ok, true, 'fallback path must succeed');
  assertEqual(result.id, 'cm_test_1', 'returns the core-memory id');
  assertEqual(markedSummary, 'I learned something important about Tracer wiring',
    'summary must reach coreMemories.markAsSignificant');
  assert(/core-memory/.test(result.reason), 'reason explains the fallback');
});

test('R2: no summary + no episode → keeps original no-latest-episode error', async () => {
  const coreMemories = { markAsSignificant: async () => { throw new Error('should not be called'); } };
  const pendingMomentsStore = { mark: () => 'pin_id' };
  const episodicMemory = { getLatest: () => null };

  const reg = makeRegistry();
  registerV737Tools(reg, { pendingMomentsStore, episodicMemory, coreMemories });
  const handler = reg.handlers.get('mark-moment');

  const result = await handler({});
  assertEqual(result.ok, false, 'no summary means no fallback');
  assertEqual(result.reason, 'no-latest-episode', 'returns original error path');
});

test('R2: episode present → normal pendingMomentsStore path (no fallback)', async () => {
  let coreCalled = false;
  const coreMemories = { markAsSignificant: async () => { coreCalled = true; return { id: 'x' }; } };
  let pinCalled = false;
  const pendingMomentsStore = { mark: () => { pinCalled = true; return 'pin_id_123'; } };
  const episodicMemory = { getLatest: () => ({ id: 'ep_42', topic: 't' }) };

  const reg = makeRegistry();
  registerV737Tools(reg, { pendingMomentsStore, episodicMemory, coreMemories });
  const handler = reg.handlers.get('mark-moment');

  const result = await handler({ summary: 'a thought' });
  assertEqual(result.ok, true, 'normal path succeeds');
  assertEqual(result.id, 'pin_id_123', 'returns the pin id, not the core id');
  assertEqual(coreCalled, false, 'markAsSignificant must NOT be called when episode exists');
  assertEqual(pinCalled, true, 'pendingMomentsStore.mark MUST be called');
});

// ── R3.2: structural-failure reset window extended to 60 min ──

test('R3.2: GoalDriverFailurePolicy uses 60-min reset window for structural failures', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy.js'), 'utf8');
  assert(/60\s*\*\s*60_?000/.test(src),
    'GoalDriverFailurePolicy must compute a 60-minute reset window for structural failures');
  assert(/isStructuralFailure/.test(src),
    'reset window must be gated on isStructuralFailure (not unconditional)');
});

// ── R4: _stepCode pre-flight check for hallucinated paths ───

test('R4: PROJECT API CONVENTIONS block is in the _stepCode prompt', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
  assert(/PROJECT API CONVENTIONS/.test(src),
    '_stepCode prompt must include PROJECT API CONVENTIONS block');
  assert(/createLogger/.test(src),
    'API conventions must mention createLogger factory');
  assert(/EventBus/.test(src),
    'API conventions must mention EventBus contract');
});

test('R4: structural-failure regex recognises "Invalid target path (hallucinated)"', () => {
  const { isStructuralFailure } = require(path.join(ROOT, 'src/agent/agency/failure-patterns'));
  assertEqual(isStructuralFailure('Invalid target path (hallucinated): ../../core/Logger'), true,
    'hallucinated-path errors must be classified as structural');
});

test('R4: _stepCode contains the pre-flight require-resolution scan', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
  assert(/Invalid target path \(hallucinated\)/.test(src),
    '_stepCode must emit "Invalid target path (hallucinated)" when a require path doesn\'t resolve');
});

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
