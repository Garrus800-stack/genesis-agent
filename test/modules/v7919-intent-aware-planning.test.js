#!/usr/bin/env node
// ============================================================
// GENESIS — test/modules/v7919-intent-aware-planning.test.js
//
// v7.9.19 Strang E — a read-only/inspection goal must not produce mutating
// steps. Field case (2026-05-31): the idle-mind goal "Inspect GoalDriver
// Failure Patterns" had a first pursuit of "36 steps ... 7 errors including
// syntax issues, invalid target paths, and hallucinated file references"
// (PARTIAL), then the retry — steered to ANALYZE-only — completed at 100%.
// A whole pursuit cycle was wasted on write/CODE steps an inspect goal should
// never have produced. The primary FormalPlanner offered CODE/WRITE statically
// (just as it offered DELEGATE before Strang C).
//
// Fix (mirrors Strang C, one level deeper, PRECISE not coarse):
//   1. shared goal-intent module — READONLY_VERBS / isReadOnlyGoal (one
//      vocabulary, hoisted from Plan.js).
//   2. AgentLoopPlanner passes readOnlyGoal; buildPlannerStepTypeList drops
//      CODE+SANDBOX for a read-only goal but KEEPS SHELL (read-only commands:
//      listing, reading, running tests — the successful field pursuit used it).
//   3. FormalPlanner._typifyStep rewrites CODE_GENERATE/WRITE_FILE/SELF_MODIFY
//      → ANALYZE on an explicit read-only goal; SHELL_EXEC/RUN_TESTS/SEARCH/
//      ANALYZE/ASK_USER untouched; static CANONICAL block intact (G3a).
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { READONLY_VERBS, extractLeadingVerb, isReadOnlyGoal } = require(path.join(ROOT, 'src/agent/revolution/goal-intent'));
const { buildPlannerStepTypeList } = require(path.join(ROOT, 'src/agent/revolution/step-types'));
const { FormalPlanner } = require(path.join(ROOT, 'src/agent/revolution/FormalPlanner'));

function makePlanner() {
  return new FormalPlanner({ bus: { fire() {} }, selfModel: null, worldState: null, verifier: null, simulator: null });
}

// ── 1. goal-intent — the shared read-only vocabulary ──
describe('v7.9.19 Strang E — goal-intent read-only classification', () => {
  test('a read-only verb → true', () => {
    assertEqual(isReadOnlyGoal('Inspect GoalDriver Failure Patterns'), true);
    assertEqual(isReadOnlyGoal('Document the boot sequence'), true);
    assertEqual(isReadOnlyGoal('Investigate stalled goals'), true);
  });

  test('a write verb → false (NOT read-only, code allowed)', () => {
    assertEqual(isReadOnlyGoal('Implement caching layer'), false);
    assertEqual(isReadOnlyGoal('Fix the parser'), false);
    assertEqual(isReadOnlyGoal('Refactor the planner'), false);
  });

  test('no leading verb → null (no intervention)', () => {
    assertEqual(isReadOnlyGoal(''), null);
    assertEqual(isReadOnlyGoal('   '), null);
    assertEqual(isReadOnlyGoal(null), null);
    assertEqual(isReadOnlyGoal('123 go'), null);
  });

  test('leading punctuation is stripped before the verb', () => {
    assertEqual(extractLeadingVerb('[Inspect] something'), 'inspect');
    assertEqual(isReadOnlyGoal('"Investigate" the logs'), true);
  });

  test('the verb set is the read-only set (no write verbs leaked in)', () => {
    for (const w of ['implement', 'fix', 'refactor', 'build', 'add', 'optimize', 'write', 'create']) {
      assert(!READONLY_VERBS.has(w), `write verb "${w}" must not be in READONLY_VERBS`);
    }
  });
});

// ── 2. buildPlannerStepTypeList — read-only drops CODE+SANDBOX, keeps SHELL ──
describe('v7.9.19 Strang E — planner step-type list respects read-only intent', () => {
  test('read-only goal: CODE and SANDBOX are NOT offered', () => {
    const list = buildPlannerStepTypeList({ canExecuteCode: true, canDelegate: false, readOnlyGoal: true });
    assert(!/- CODE:/.test(list), 'CODE must be dropped for a read-only goal');
    assert(!/- SANDBOX:/.test(list), 'SANDBOX must be dropped for a read-only goal');
  });

  test('read-only goal: SHELL, SEARCH, ANALYZE, ASK ARE still offered', () => {
    const list = buildPlannerStepTypeList({ canExecuteCode: true, canDelegate: false, readOnlyGoal: true });
    assert(/- SHELL:/.test(list), 'SHELL must stay — read-only commands (list, read, run tests)');
    assert(/- SEARCH:/.test(list), 'SEARCH must stay');
    assert(/- ANALYZE:/.test(list), 'ANALYZE must stay');
    assert(/- ASK:/.test(list), 'ASK must stay');
  });

  test('non-read-only goal: CODE and SHELL are both offered (unchanged)', () => {
    const list = buildPlannerStepTypeList({ canExecuteCode: true, canDelegate: false, readOnlyGoal: false });
    assert(/- CODE:/.test(list), 'CODE offered for a normal goal');
    assert(/- SHELL:/.test(list), 'SHELL offered for a normal goal');
  });

  test('default (no readOnlyGoal arg) is unchanged — back-compat', () => {
    const list = buildPlannerStepTypeList({ canExecuteCode: true, canDelegate: false });
    assert(/- CODE:/.test(list), 'CODE offered by default');
    assert(/- SHELL:/.test(list), 'SHELL offered by default');
  });
});

// ── 3. FormalPlanner._typifyStep — precise mutating-type rewrite ──
describe('v7.9.19 Strang E — _typifyStep rewrites only mutating steps on a read-only goal', () => {
  test('read-only: CODE / WRITE_FILE / SELF_MODIFY → ANALYZE', () => {
    const fp = makePlanner();
    fp._planCapabilities = { canDelegate: false, readOnlyGoal: true };
    assertEqual(fp._typifyStep({ type: 'CODE', description: 'x' }, 0).type, 'ANALYZE');
    assertEqual(fp._typifyStep({ type: 'WRITE_FILE', description: 'x' }, 1).type, 'ANALYZE');
    assertEqual(fp._typifyStep({ type: 'SELF_MODIFY', description: 'x' }, 2).type, 'ANALYZE');
  });

  test('read-only: SHELL / RUN_TESTS / SEARCH / ANALYZE are UNTOUCHED', () => {
    const fp = makePlanner();
    fp._planCapabilities = { canDelegate: false, readOnlyGoal: true };
    assertEqual(fp._typifyStep({ type: 'SHELL', description: 'ls' }, 0).type, 'SHELL_EXEC');
    assertEqual(fp._typifyStep({ type: 'RUN_TESTS', description: 'npm test' }, 1).type, 'RUN_TESTS');
    assertEqual(fp._typifyStep({ type: 'SEARCH', description: 'find' }, 2).type, 'SEARCH');
    assertEqual(fp._typifyStep({ type: 'ANALYZE', description: 'read' }, 3).type, 'ANALYZE');
  });

  test('non-read-only goal: CODE stays CODE_GENERATE (no rewrite)', () => {
    const fp = makePlanner();
    fp._planCapabilities = { canDelegate: false, readOnlyGoal: false };
    assertEqual(fp._typifyStep({ type: 'CODE', description: 'x' }, 0).type, 'CODE_GENERATE');
    assertEqual(fp._typifyStep({ type: 'WRITE_FILE', description: 'x' }, 1).type, 'WRITE_FILE');
  });

  test('legacy caller (capabilities null) is unchanged', () => {
    const fp = makePlanner();
    fp._planCapabilities = null;
    assertEqual(fp._typifyStep({ type: 'CODE', description: 'x' }, 0).type, 'CODE_GENERATE');
    assertEqual(fp._typifyStep({ type: 'WRITE_FILE', description: 'x' }, 1).type, 'WRITE_FILE');
  });

  test('Strang C still holds: DELEGATE→ANALYZE when no peer (no E interference)', () => {
    const fp = makePlanner();
    fp._planCapabilities = { canDelegate: false, readOnlyGoal: false };
    assertEqual(fp._typifyStep({ type: 'DELEGATE', description: 'x' }, 0).type, 'ANALYZE');
  });
});

if (require.main === module) run();
