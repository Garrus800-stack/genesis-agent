// ============================================================
// GENESIS — v796-plan-context.contract.test.js
//
// v7.9.6 audit-closeout. Pins the path-list-injection behaviour
// shared between AgentLoopPlanner, FormalPlanner, and
// ColonyOrchestrator. The v7.9.5 outpost trace showed the
// FormalPlanner path producing hallucinated file paths
// ('src/agent-core/goal-driver/recovery-logger.js') because that
// prompt had no codebase context. AgentLoopPlanner._llmPlanGoal
// had had pickRelevantModules since v7.7.9 — FormalPlanner and
// ColonyOrchestrator shipped without it for two phases.
//
// v7.9.6 extracts pickRelevantModules into ./plan-context.js so
// all three planners share one source of truth. These tests pin
// that all three callers consult the helper, that the helper
// behaves correctly, and that the prompts include the
// "use these EXACT paths" directive that gives the LLM the
// contract.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

const planContextPath = path.join(ROOT, 'src/agent/revolution/plan-context.js');
const { pickRelevantModules, formatModulePathList } = require(planContextPath);

describe('v7.9.6 plan-context helper', () => {

// ── A: pickRelevantModules behaviour ──────────────────────────

test('A1: returns goal-relevant modules when tokens match', () => {
  const allModules = [
    { file: 'src/agent/agency/GoalDriver.js', classes: ['GoalDriver'] },
    { file: 'src/agent/agency/GoalDriverFailurePolicy.js' },
    { file: 'src/agent/agency/GoalDriverBootRecovery.js' },
    { file: 'src/agent/planning/GoalStack.js' },
    { file: 'src/agent/core/Logger.js', classes: ['Logger'] },
    { file: 'src/ui/modules/i18n.js' },
    { file: 'src/agent/foundation/Settings.js' },
  ];
  const picked = pickRelevantModules(allModules, 'Improve Goal Driver Failure Recovery Logging');
  const files = picked.map(m => m.file);
  // At least the four obvious matches must be in there.
  for (const expected of [
    'src/agent/agency/GoalDriver.js',
    'src/agent/agency/GoalDriverFailurePolicy.js',
    'src/agent/agency/GoalDriverBootRecovery.js',
    'src/agent/core/Logger.js',
  ]) {
    assert(files.includes(expected),
      `Expected ${expected} in goal-relevant matches (got: ${files.join(', ')})`);
  }
});

test('A2: returns [] for empty input', () => {
  assertEqual(pickRelevantModules([], 'anything').length, 0);
  assertEqual(pickRelevantModules(null, 'anything').length, 0);
});

test('A3: falls back to first-N when fewer than 5 token-matches', () => {
  // Goal with no overlap with any file — should still return something
  // so the LLM has baseline context (per v7.7.9 design).
  const allModules = Array.from({ length: 10 }, (_, i) => ({
    file: `src/agent/foundation/Module${i}.js`,
  }));
  const picked = pickRelevantModules(allModules, 'unrelated subject xyzzy');
  assert(picked.length > 0,
    'Helper must surface SOME modules even when nothing token-matches');
});

test('A4: stop-words do not poison the matcher', () => {
  // "the goal driver" — "the" is a stop-word. Token "goal" must still match.
  const allModules = [
    { file: 'src/agent/agency/GoalDriver.js' },
    { file: 'src/agent/random/TheFoo.js' },
  ];
  const picked = pickRelevantModules(allModules, 'understand the goal');
  const files = picked.map(m => m.file);
  assert(files.includes('src/agent/agency/GoalDriver.js'),
    'goal-token match must find GoalDriver.js');
});

// ── B: formatModulePathList ──────────────────────────────────

test('B1: empty list produces the documented placeholder', () => {
  assertEqual(formatModulePathList([]), '(no module manifest available)');
  assertEqual(formatModulePathList(null), '(no module manifest available)');
});

test('B2: formats modules as bullet list with class hints', () => {
  const out = formatModulePathList([
    { file: 'src/agent/agency/GoalDriver.js', classes: ['GoalDriver'] },
    { file: 'src/agent/planning/GoalStack.js' },
  ]);
  assert(out.includes('- src/agent/agency/GoalDriver.js (GoalDriver)'),
    'must include the path and the leading class hint');
  assert(out.includes('- src/agent/planning/GoalStack.js'),
    'must include the bare path when classes are absent');
});

// ── C: AgentLoopPlanner uses the shared helper ───────────────

test('C1: AgentLoopPlanner imports pickRelevantModules from plan-context.js', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPlanner.js'), 'utf8');
  assert(/require\(['"]\.\/plan-context['"]\)/.test(src),
    'AgentLoopPlanner must import from ./plan-context — the shared helper module');
  assert(/pickRelevantModules/.test(src),
    'AgentLoopPlanner must use pickRelevantModules');
});

test('C2: AgentLoopPlanner re-exports pickRelevantModules for back-compat', () => {
  const { pickRelevantModules: reExported } = require(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPlanner.js'));
  assert(typeof reExported === 'function',
    'pickRelevantModules must still be exported from AgentLoopPlanner — tests pre-v7.9.6 imported it from there');
});

// ── D: FormalPlanner uses the shared helper ──────────────────

test('D1: FormalPlanner imports pickRelevantModules from plan-context.js', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/FormalPlanner.js'), 'utf8');
  assert(/require\(['"]\.\/plan-context['"]\)/.test(src),
    'FormalPlanner must import from ./plan-context');
});

test('D2: FormalPlanner decompose prompt contains "use these EXACT paths" directive', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/FormalPlanner.js'), 'utf8');
  assert(/use these EXACT paths when referring to files/.test(src),
    'FormalPlanner._llmDecompose prompt must carry the same anti-hallucination directive as AgentLoopPlanner._llmPlanGoal');
});

// ── E: ColonyOrchestrator uses the shared helper ─────────────

test('E1: ColonyOrchestrator imports pickRelevantModules from plan-context.js', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/ColonyOrchestrator.js'), 'utf8');
  assert(/require\(['"]\.\/plan-context['"]\)/.test(src),
    'ColonyOrchestrator must import from ./plan-context');
});

test('E2: ColonyOrchestrator has a selfModel field for lateBinding', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/ColonyOrchestrator.js'), 'utf8');
  assert(/this\.selfModel\s*=\s*null/.test(src),
    'ColonyOrchestrator must initialise this.selfModel = null so the lateBinding can fill it');
});

test('E3: ColonyOrchestrator manifest declares selfModel lateBinding', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/manifest/phase8-revolution.js'), 'utf8');
  // The colonyOrchestrator manifest block must include a lateBinding for
  // selfModel with optional: true (graceful degradation).
  // We grep for the specific binding shape — keeps the test independent
  // of surrounding manifest-block whitespace.
  assert(
    /prop:\s*['"]selfModel['"],\s*service:\s*['"]selfModel['"]/.test(src),
    'phase8-revolution.js must declare a selfModel lateBinding on colonyOrchestrator'
  );
});

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
