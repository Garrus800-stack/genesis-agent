// ============================================================
// GENESIS — v797-foundation-pass.contract.test.js
//
// Reproduces the v7.9.6 outpost-trace failure loop end-to-end and
// pins all five foundation fixes that landed in v7.9.7.
//
// The trace: a 7-hour autonomous session where IdleMind synthesized
// the goal "Improve Goal Stack Traceability on Failure", GoalDriver
// pursued it seven times in 25 minutes, every pursuit crashed with
//   "Cannot create property 'description' on string 'Fix syntax
//   error in test file...'"
// and the goal was finally stalled — but no lesson reached
// ~/.genesis-lessons/, fast-track-to-obsolete never fired, the
// counter reset at 10 minutes mid-cycle, IdleMind showed 4 of 17
// activities with count > 0, and the daemon kept logging "19
// issue(s), 0 fixed" every fifteen minutes.
//
// Five interlocking bugs:
//
//   A — normalizeStepTypes and AgentLoopSteps._executeStep crash
//       on bare-string steps because step.description = ... fails
//       on immutable strings. Reflect-LLM produced mixed arrays
//       because the prompt schema was under-specified.
//
//   B — GoalDriverFailurePolicy hallucination regex did not match
//       "Cannot create property" so fast-track-to-obsolete did not
//       fire. Plus the 10-min counter-reset window let slow
//       systematic failures double the pursuit count.
//
//   C — IdleMind._think wrapped _recordActivity in `if (result)`,
//       so activities returning null (Reflect with no episodes,
//       Explore with no targets, …) were never counted, making the
//       insights timeline appear to show only 4 active activities.
//
//   E — AutonomousDaemon counted missing-dependency issues against
//       the actionable issue count even though reflector.repair()
//       cannot fix that type. Made every cycle log "0 fixed" forever.
//
//   G — AgentLoopPursuitReflection.classifyFailure also failed to
//       match "Cannot create property" so the failure became
//       'unclassified', stableClass dropped it, and zero lessons
//       were written.
//
// The fix introduces a shared regex helper (failure-patterns.js)
// so B and G can never drift apart again.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, assertEqual, run } = require('../harness');

const { normalizeStepTypes } = require(
  path.join(ROOT, 'src/agent/revolution/plan-context'));
const { robustJsonParse } = require(
  path.join(ROOT, 'src/agent/core/utils'));
const { isStructuralFailure, STRUCTURAL_FAILURE_RE } = require(
  path.join(ROOT, 'src/agent/core/failure-patterns'));

const TRACE_ERROR = "Cannot create property 'description' on string 'Fix syntax error in test file by completing incomplete code blocks'";

describe('v7.9.7 foundation pass', () => {

// ── Bug A: normalizeStepTypes + AgentLoopSteps type-guard ─────

test('A1: normalizeStepTypes wraps a bare-string step in place', () => {
  const steps = [
    { type: 'ANALYZE', description: 'inspect module' },
    'Fix syntax error in test file by completing incomplete code blocks',
    { type: 'CODE', description: 'add the helper' },
  ];
  let crashed = false;
  try {
    normalizeStepTypes(steps, { logger: { info: () => {}, warn: () => {} }, tag: '[TEST]' });
  } catch (_e) { crashed = true; }
  assert(!crashed, 'must not crash on a bare-string step');
  assertEqual(steps.length, 3, 'array length must stay intact');
  assertEqual(typeof steps[1], 'object');
  assertEqual(steps[1].type, 'ANALYZE');
  assert(steps[1].description.includes('Fix syntax error'),
    'original string content must be preserved in the wrapped description');
  assert(steps[1].description.includes('[was string]'),
    'wrapping must mark the original kind so the fallback stays visible');
});

test('A2: null and array entries are also wrapped, not crashing', () => {
  const steps = [
    { type: 'ANALYZE', description: 'first' },
    null,
    [ 'nested', 'array' ],
    undefined,
    { type: 'CODE', description: 'last' },
  ];
  let crashed = false;
  try {
    normalizeStepTypes(steps, { logger: { info: () => {}, warn: () => {} }, tag: '[TEST]' });
  } catch (_e) { crashed = true; }
  assert(!crashed);
  for (let i = 0; i < steps.length; i++) {
    assertEqual(typeof steps[i], 'object', `entry ${i} must be an object after wrapping`);
    assert(steps[i] !== null, `entry ${i} must not still be null`);
  }
});

test('A3: object steps with valid types are left alone', () => {
  const steps = [
    { type: 'CODE', description: 'kept' },
    { type: 'ANALYZE', description: 'also kept' },
  ];
  normalizeStepTypes(steps, { logger: { info: () => {}, warn: () => {} }, tag: '[TEST]' });
  assertEqual(steps[0].type, 'CODE');
  assertEqual(steps[0].description, 'kept');
  assertEqual(steps[1].type, 'ANALYZE');
  assertEqual(steps[1].description, 'also kept');
});

test('A4: AgentLoopSteps._executeStep has the same type-guard', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopSteps.js'), 'utf8');
  const normalizeIdx = src.indexOf('normalizeStepType(step.type)');
  assert(normalizeIdx > 0, 'normalizeStepType call must still be there');
  const before = src.slice(Math.max(0, normalizeIdx - 1500), normalizeIdx);
  assert(/typeof\s+step\s*!==\s*['"]object['"]/.test(before),
    'AgentLoopSteps must type-guard step before normalizeStepType');
  assert(/wrapping as ANALYZE/.test(before),
    'AgentLoopSteps must emit the "wrapping as ANALYZE" warning');
});

test('A5: reflectOnProgress prompt specifies the newSteps item schema', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery.js'), 'utf8');
  // The prompt must mention that each step is an object with type+description
  // (otherwise the LLM is free to return bare strings).
  assert(/Each step MUST be an object/.test(src),
    'reflectOnProgress prompt must explicitly require each step to be an object');
  assert(/Valid types:.*ANALYZE.*CODE.*SHELL/.test(src),
    'reflectOnProgress prompt must enumerate the canonical step types');
});

// ── Bug A end-to-end — the exact v7.9.6 trace JSON ─────────────

test('A6: the exact mixed-array shape from the outpost trace no longer crashes', () => {
  const reflectLlmOutput = JSON.stringify({
    adjust: true,
    reason: 'Recent errors require plan adjustment',
    newSteps: [
      { type: 'ANALYZE', description: 'Check existing GoalStack module structure' },
      'Fix syntax error in test file by completing incomplete code blocks',
      { type: 'CODE', description: 'Add error handling with code block validation' },
      'Verify EventBus module exists in core directory',
    ],
  });
  const parsed = robustJsonParse(reflectLlmOutput);
  assert(parsed !== null, 'robust parser must accept mixed arrays (the bug shape)');
  const stringCount = parsed.newSteps.filter(s => typeof s === 'string').length;
  assertEqual(stringCount, 2, 'two of the four entries must be bare strings (the exact trace shape)');

  let crashed = false;
  try {
    normalizeStepTypes(parsed.newSteps, { logger: { info: () => {}, warn: () => {} }, tag: '[TEST]' });
  } catch (_e) { crashed = true; }
  assert(!crashed, 'the v7.9.6 outpost-trace crash must no longer occur');
  for (let i = 0; i < parsed.newSteps.length; i++) {
    assertEqual(typeof parsed.newSteps[i], 'object',
      `entry ${i} must be an object after normalisation`);
    assert(parsed.newSteps[i].type, `entry ${i} has a type`);
    assert(parsed.newSteps[i].description, `entry ${i} has a description`);
  }
});

// ── Bug B+G shared helper ─────────────────────────────────────

test('B1: shared regex matches the exact v7.9.6 trace error string', () => {
  assert(isStructuralFailure(TRACE_ERROR),
    'isStructuralFailure must match the literal trace error string');
});

test('B2: shared regex matches the broader JS-runtime TypeError class', () => {
  assert(isStructuralFailure("Cannot create property 'foo' on string 'bar'"));
  assert(isStructuralFailure("Cannot read property 'x' of undefined"));
  assert(isStructuralFailure("Cannot read properties of null (reading 'foo')"));
  assert(isStructuralFailure("step.execute is not a function"));
  assert(isStructuralFailure("steps is not iterable"));
});

test('B3: shared regex still matches the pre-existing patterns', () => {
  assert(isStructuralFailure('Plausibility check failed for: src/foo.js'));
  assert(isStructuralFailure('implausible path detected'));
  assert(isStructuralFailure('unknown step type GIT_SNAPSHOT'));
  assert(isStructuralFailure('ENOENT: no such file or directory'));
});

test('B4: shared regex does not match unrelated failure messages', () => {
  assert(!isStructuralFailure('LLM rate limit exceeded'));
  assert(!isStructuralFailure('User rejected plan with blockers'));
  assert(!isStructuralFailure('Network connection refused'));
  assert(!isStructuralFailure(''));
  assert(!isStructuralFailure(null));
  assert(!isStructuralFailure(undefined));
});

test('B5: GoalDriverFailurePolicy uses the shared helper, not an inline regex', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/agency/GoalDriverFailurePolicy.js'), 'utf8');
  assert(/isStructuralFailure/.test(src),
    'GoalDriverFailurePolicy must import the shared helper');
  // The pre-v7.9.7 inline regex must be gone.
  assert(!/implausible path\|plausibility check failed\|unknown step type/.test(src),
    'inline hallucination regex must be removed in favour of the shared helper');
});

// ── Bug G: classifyFailure uses the shared helper ─────────────

test('G1: classifyFailure marks the trace error as structural (was unclassified)', () => {
  const { classifyFailure } = require(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection'));
  assertEqual(classifyFailure(TRACE_ERROR), 'structural',
    'the literal trace error string must classify as structural so stableClass admits the lesson');
});

test('G2: classifyFailure imports the shared helper', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection.js'), 'utf8');
  assert(/isStructuralFailure/.test(src),
    'classifyFailure must import the shared helper');
  assert(!/unknown step type\|missing required\|peer\.\*unavailable/.test(src),
    'inline structural regex must be removed in favour of the shared helper');
});

test('G3: lesson-recording gate stableClass admits structural failures', () => {
  // v7.9.10 widened the gate further: 'unclassified' is now accepted when
  // errorMessage is non-empty (so LLM-verdict messages like "PARTIAL because..."
  // also reach lessonsStore.record). The structural-failure path still passes
  // through stableClass unchanged. 'user-action' still excluded (not a Genesis
  // failure to learn from).
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection.js'), 'utf8');
  assert(/stableClass/.test(src),
    'stableClass must still exist as the recording-gate name');
  assert(/payload\.classification !== 'user-action'/.test(src),
    'stableClass must still exclude user-action (not a Genesis failure)');
});

// ── Bug C: IdleMind activity-recording unconditional ──────────

test('C1: _recordActivity is called regardless of result truthiness', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/autonomy/IdleMind.js'), 'utf8');
  // The pre-fix shape was: if (result) { ... _recordActivity ... }
  // The post-fix shape has _recordActivity outside the if-block.
  const lines = src.split('\n');
  const recordLine = lines.findIndex(l => /this\._recordActivity\(activity, result\);/.test(l));
  assert(recordLine > 0, '_recordActivity call must still be present');
  // Walk back 5 lines and look for the if (result) line. If it's there
  // AND closer than the _recordActivity call, we still have the bug.
  const ifResultLine = lines.slice(0, recordLine).reverse().findIndex(l => /^\s*if \(result\) \{\s*$/.test(l));
  // ifResultLine is now distance-from-recordLine, or -1.
  if (ifResultLine !== -1 && ifResultLine < 3) {
    assert(false, '_recordActivity is still inside an `if (result)` block — Bug C not fixed');
  }
});

// ── Bug E: health-check splits actionable from informational ──

test('E1: health-check separates actionable from informational issues', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon.js'), 'utf8');
  assert(/actionableIssues/.test(src),
    'AutonomousDaemon must compute an actionableIssues list');
  assert(/informationalIssues/.test(src),
    'AutonomousDaemon must compute an informationalIssues list');
  assert(/actionable issue\(s\)/.test(src),
    'log line must say "actionable issue(s)" so the operator sees the honest count');
});

test('E2: actionable is syntax-only, matching what reflector.repair can actually fix', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/autonomy/AutonomousDaemon.js'), 'utf8');
  // The split filter must specifically include 'syntax' and exclude others
  // (since reflector.repair only handles syntax, and missing-dependency
  // explicitly returns fixed: false).
  assert(/diagnosis\.issues\.filter\(i => i\.type === 'syntax'\)/.test(src),
    'actionableIssues filter must select only type=syntax (what repair can actually fix)');
});

// ── Bug A → G full chain: parse + normalise + classify ────────

test('CHAIN: full v7.9.6 trace path — parse, normalise, classify, record', () => {
  // 1. Reflect-LLM returns mixed array (the bug shape)
  const llmOutput = JSON.stringify({
    adjust: true,
    reason: 'Plan adjustment based on errors',
    newSteps: [
      { type: 'ANALYZE', description: 'inspect existing code' },
      'Fix syntax error in test file by completing incomplete code blocks',
      { type: 'CODE', description: 'add helper file' },
    ],
  });
  // 2. robustJsonParse parses it (does not throw on mixed arrays)
  const parsed = robustJsonParse(llmOutput);
  assert(parsed !== null);

  // 3. normalizeStepTypes wraps bare strings (Bug A)
  let crashed = false;
  try {
    normalizeStepTypes(parsed.newSteps, { logger: { info: () => {}, warn: () => {} }, tag: '[REPLAN]' });
  } catch (_e) { crashed = true; }
  assert(!crashed, 'Bug A: normalizeStepTypes must not crash on mixed arrays');

  // 4. If the pursuit had still failed, the error would be TRACE_ERROR.
  //    Then GoalDriver fast-tracks via isStructuralFailure (Bug B)
  assert(isStructuralFailure(TRACE_ERROR), 'Bug B: fast-track regex must match the trace error');

  // 5. And classifyFailure classifies the same error as structural (Bug G),
  //    so the lesson-recording gate admits it.
  const { classifyFailure } = require(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection'));
  assertEqual(classifyFailure(TRACE_ERROR), 'structural',
    'Bug G: classifier must mark the trace error as structural for the lessons gate');
});

// ════════════════════════════════════════════════════════════════
// v7.9.7 EXTENSION PASS — pins for nine further fixes added to
// v7.9.7 after the v7.9.7-on-outpost trace + v7.9.7-on-Win trace
// surfaced additional issues in the cluster between knowledge and
// action. P1+P2 in the extension pass had broken in-trace because
// the original v7.9.8 attempt at fixing them used the wrong lesson
// shape and the wrong type-normalisation timing — those are corrected
// here with the real lesson shape returned by LessonsStore.recall()
// and with normalizeStepType called inside _buildPathHint.
// ════════════════════════════════════════════════════════════════

// ── P1 corrected — SymbolicResolver filters warning lessons by source ──

test('EXT P1: _checkDirect filters plan-failure-reflection lessons (real recall shape, no tags/evidence)', () => {
  const { SymbolicResolver } = require(
    path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));
  const resolver = new SymbolicResolver({});
  // Lesson as returned by LessonsStore.recall() — no tags, no evidence,
  // but source + strategy.classification ARE present.
  const recallShape = {
    id: 'l1',
    insight: 'Goal "Improve Calibration Activity Error Handling" failed (structural): Cannot find module',
    strategy: { classification: 'structural', goalDescription: 'X', errorMessage: 'Cannot find module' },
    confidence: 0.99,
    relevance: 0.9,
    category: 'obstacle-resolution',
    source: 'plan-failure-reflection',
    useCount: 19,
    lastUsed: Date.now(),
  };
  const result = resolver._checkDirect('ANALYZE', recallShape);
  assertEqual(result, null, 'plan-failure-reflection lesson must not produce DIRECT');
});

test('EXT P1: _checkDirect filters via strategy.classification when source absent', () => {
  const { SymbolicResolver } = require(
    path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));
  const resolver = new SymbolicResolver({});
  const lessonWithoutSource = {
    id: 'l2',
    useCount: 10,
    lastUsed: Date.now(),
    confidence: 0.9,
    strategy: { classification: 'execution' },
    insight: 'Some failure',
  };
  const result = resolver._checkDirect('ANALYZE', lessonWithoutSource);
  assertEqual(result, null, 'execution-classified lesson must not produce DIRECT');
});

test('EXT P1: normal proven-solution lesson still produces DIRECT result', () => {
  const { SymbolicResolver } = require(
    path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));
  const resolver = new SymbolicResolver({});
  const lesson = {
    id: 'l3',
    useCount: 5,
    lastUsed: Date.now(),
    confidence: 0.9,
    strategy: { command: 'npm test' },
    source: 'user-success',
    insight: 'Running tests in this project',
  };
  const result = resolver._checkDirect('SHELL', lesson);
  assert(result !== null, 'positive-source lesson must still produce DIRECT');
  assertEqual(result.level, 'direct');
});

test('EXT P1: _buildDirective inverts framing for plan-failure-reflection lessons', () => {
  const { SymbolicResolver } = require(
    path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));
  const resolver = new SymbolicResolver({});
  const warningLesson = {
    insight: 'Goal "X" failed (structural)',
    strategy: { classification: 'structural', goalDescription: 'X' },
    source: 'plan-failure-reflection',
  };
  const directive = resolver._buildDirective(warningLesson, null);
  assert(/AVOID/.test(directive), 'directive for plan-failure lesson must contain AVOID');
  assert(/different approach/i.test(directive), 'must instruct LLM to choose differently');
  assert(!/proven approach/i.test(directive), 'must NOT use proven-approach framing');
});

// ── P2 corrected — _buildPathHint normalises step.type first ──

test('EXT P2: _buildPathHint matches CODE_GENERATE (LLM-idiomatic) after normalising step.type', () => {
  const { AgentLoopRecoveryDelegate } = require(
    path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery'));
  const fakeLoop = {
    selfModel: { getModuleSummary: () => [
      { file: 'src/agent/core/Logger.js', classes: ['createLogger'] },
      { file: 'src/agent/core/EventBus.js', classes: ['EventBus'] },
      { file: 'src/agent/core/Container.js', classes: ['Container'] },
      { file: 'src/agent/foundation/StorageService.js', classes: ['StorageService'] },
      { file: 'src/agent/foundation/Settings.js', classes: ['Settings'] },
      { file: 'src/agent/core/IntervalManager.js', classes: ['IntervalManager'] },
    ]},
    _currentPlan: { title: 'Improve Calibration Activity Error Handling' },
  };
  const delegate = new AgentLoopRecoveryDelegate(fakeLoop);
  const codegen = delegate._buildPathHint({ type: 'CODE_GENERATE', description: 'add' });
  const writefile = delegate._buildPathHint({ type: 'WRITE_FILE', description: 'add' });
  assert(codegen.length > 0, 'CODE_GENERATE must receive path hint after normalisation');
  assert(writefile.length > 0, 'WRITE_FILE must receive path hint after normalisation');
  assert(/Logger\.js/.test(codegen), 'hint must include Logger.js (core-infrastructure floor)');
});

test('EXT P2: pickRelevantModules core-infrastructure floor still works', () => {
  const { pickRelevantModules } = require(
    path.join(ROOT, 'src/agent/revolution/plan-context'));
  const allModules = [
    { file: 'src/agent/cognitive/Z.js', classes: ['Z'] },
    { file: 'src/agent/core/Logger.js', classes: ['createLogger'] },
    { file: 'src/agent/core/EventBus.js', classes: ['EventBus'] },
    { file: 'src/agent/core/Container.js', classes: ['Container'] },
    { file: 'src/agent/foundation/StorageService.js', classes: ['StorageService'] },
    { file: 'src/agent/foundation/Settings.js', classes: ['Settings'] },
    { file: 'src/agent/core/IntervalManager.js', classes: ['IntervalManager'] },
  ];
  const picked = pickRelevantModules(allModules, 'Research Activity Time Logging');
  assertEqual(picked[0].file, 'src/agent/core/Logger.js', 'Logger at head');
});

// ── P3 — ReasoningTracer wired ──

test('EXT P3: AgentCoreWire._startServices includes start(reasoningTracer)', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/AgentCoreWire.js'), 'utf8');
  assert(/start\(['"]reasoningTracer['"]\)/.test(src),
    'reasoningTracer must be in _startServices');
});

// ── P4 — ASK_USER alias ──

test('EXT P4: ASK_USER normalises to ASK', () => {
  const { normalizeStepType } = require(
    path.join(ROOT, 'src/agent/core/step-types'));
  assertEqual(normalizeStepType('ASK_USER'), 'ASK');
});

// ── P5 — simulation hard-gate on retry ──

test('EXT P5: AgentLoop has _pursuitAttempts map for retry tracking', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoop.js'), 'utf8');
  assert(/_pursuitAttempts\s*=\s*new Map/.test(src),
    'AgentLoop must initialise _pursuitAttempts');
});

test('EXT P5: AgentLoopPursuitGate machinery wired; v7.9.20 gate proceeds (no abort)', () => {
  // v7.9.7-fix (P5/P5b): logic extracted to AgentLoopPursuitGate.js to keep
  // AgentLoopPursuit.js under the 700-LOC File-Size-Guard threshold.
  // v7.9.9 Fix 5: full abort sequence further extracted to handleHardGateAbort
  // helper (sets up Fix 4 trust-level dispatch). pursuit now dispatches to the
  // helper rather than calling shouldAbortOnRisk directly.
  const gateSrc = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js'), 'utf8');
  assert(/HIGH_RISK_THRESHOLD\s*=\s*5\.0/.test(gateSrc),
    'AgentLoopPursuitGate must define HIGH_RISK_THRESHOLD at 5.0');
  assert(/shouldAbortOnRisk/.test(gateSrc),
    'AgentLoopPursuitGate must export shouldAbortOnRisk');
  assert(/function handleHardGateAbort/.test(gateSrc),
    'AgentLoopPursuitGate must define handleHardGateAbort (v7.9.9 Fix 5 extraction)');
  // Pursuit must call the gate helper and act on a true result.
  const pursuitSrc = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js'), 'utf8');
  assert(/handleHardGateAbort\(this,\s*cogResult/.test(pursuitSrc),
    'pursue() must dispatch to handleHardGateAbort with this and cogResult');
  assert(/sim-risk is not a gate/.test(gateSrc),
    'v7.9.20: gate must log that it proceeds (sim-risk is not a gate), not abort');
});

// ── P6 — ContinuationLoop max raised ──

test('EXT P6: MAX_CONTINUATIONS_DEFAULT raised (v7.9.7 P6: 4 → 6)', () => {
  const { MAX_CONTINUATIONS_DEFAULT } = require(
    path.join(ROOT, 'src/agent/foundation/backends/ContinuationLoop'));
  assertEqual(MAX_CONTINUATIONS_DEFAULT, 6,
    'MAX_CONTINUATIONS_DEFAULT must be 6 (v7.9.7 P6 — covers long-manifest LLM outputs)');
});

// ── P7 — CausalAnnotation behavioural consequence + dedup ──

test('EXT P7: CausalAnnotation accepts lessonsStore in constructor', () => {
  const { CausalAnnotation } = require(
    path.join(ROOT, 'src/agent/cognitive/CausalAnnotation'));
  let lessonsCalled = false;
  const fakeLessonsStore = { record: () => { lessonsCalled = true; } };
  const ca = new CausalAnnotation({ lessonsStore: fakeLessonsStore });
  assertEqual(ca.lessonsStore, fakeLessonsStore, 'CausalAnnotation must hold lessonsStore reference');
});

test('EXT P7: causal:promoted fires lesson record (behavioural consequence)', () => {
  const { CausalAnnotation } = require(
    path.join(ROOT, 'src/agent/cognitive/CausalAnnotation'));
  let recordedLesson = null;
  const fakeLessonsStore = { record: (l) => { recordedLesson = l; } };
  const fakeKg = { addEdge: () => {} };
  let firedEvents = [];
  const fakeBus = {
    fire: (event, payload) => { firedEvents.push({ event, payload }); },
    on: () => () => {},
  };
  const ca = new CausalAnnotation({
    bus: fakeBus,
    knowledgeGraph: fakeKg,
    lessonsStore: fakeLessonsStore,
  });
  // Force a promotion: 2 failures, no successes → suspicion=1.0, obs=2 → early-promo
  ca._suspicion.set('shell:rm', { failCount: 2, successCount: 0, observations: 2, lastSeen: Date.now() });
  ca._checkPromotions();
  assert(recordedLesson !== null, 'causal:promoted must trigger a lesson record');
  assertEqual(recordedLesson.source, 'plan-failure-reflection',
    'recorded lesson must use the source SymbolicResolver._checkDirect filters on');
});

test('EXT P7: causal:promoted dedups per key (no event spam)', () => {
  const { CausalAnnotation } = require(
    path.join(ROOT, 'src/agent/cognitive/CausalAnnotation'));
  let firedCount = 0;
  const fakeBus = { fire: (e) => { if (e === 'causal:promoted') firedCount++; }, on: () => () => {} };
  const ca = new CausalAnnotation({ bus: fakeBus, knowledgeGraph: { addEdge: () => {} } });
  ca._suspicion.set('shell:rm', { failCount: 2, successCount: 0, observations: 2, lastSeen: Date.now() });
  ca._checkPromotions();
  ca._checkPromotions(); // second call — must dedup
  ca._checkPromotions(); // third call — must dedup
  assertEqual(firedCount, 1, 'causal:promoted must fire exactly once per key');
});

// ── P8 — Reflector.suggestOptimizations: higher thresholds + dedup ──

test('EXT P8: Reflector raised line threshold 300→500', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/planning/Reflector.js'), 'utf8');
  assert(/fileInfo\.lines\s*>\s*500/.test(src),
    'line-count threshold must be > 500 (was 300, too loose)');
});

test('EXT P8: Reflector raised requires threshold 6→10', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/planning/Reflector.js'), 'utf8');
  assert(/mod\.requires\.length\s*>\s*10/.test(src),
    'requires threshold must be > 10 (was 6, too loose)');
});

test('EXT P8: Reflector dedups suggestions across cycles', () => {
  const { Reflector } = require(
    path.join(ROOT, 'src/agent/planning/Reflector'));
  const fakeSelfModel = {
    rootDir: '/test',
    getFullModel: () => ({
      modules: { 'big.js': { requires: ['a','b','c','d','e','f','g','h','i','j','k','l'] } },
      files: { 'big.js': { lines: 800 } },
    }),
  };
  const fakeGuard = { isProtected: () => false };
  const r = new Reflector(fakeSelfModel, null, null, null, fakeGuard);
  const sug1 = r.suggestOptimizations();
  const sug2 = r.suggestOptimizations();
  assert(sug1.length > 0, 'first call surfaces suggestions');
  assertEqual(sug2.length, 0, 'second call dedups — same file:type pair must not resurface');
});

// ── P9 — EmotionalState adaptive decay ──

test('EXT P9: _decayTick uses 3x rate when value is in extreme territory', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/organism/EmotionalState.js'), 'utf8');
  assert(/inExtreme/.test(src), 'decay tick must compute extreme-territory flag');
  assert(/decayRate\s*\*\s*3/.test(src), 'must triple the decay rate when in extreme territory');
});

// ── P15 — extended stopwords on goal-token-overlap ──

test('EXT P15: core/goal-intent.js token-overlap uses extended stopword list', () => {
  // v7.9.20 (§8): _STOPWORDS moved from activities/Plan.js into the shared
  // core/goal-intent module (Plan.js imports + re-exports the helpers).
  const src = fs.readFileSync(
    path.join(ROOT, 'src/agent/core/goal-intent.js'), 'utf8');
  assert(/_STOPWORDS/.test(src), 'must define _STOPWORDS set');
  assert(/'activity'/.test(src), 'activity must be in stopwords (matched both v7.9.7-trace goals)');
  assert(/'error'/.test(src), 'error must be in stopwords (generic goal-word)');
  assert(/'improve'/.test(src), 'improve must be in stopwords (generic verb)');
});

// ── CHAIN — v7.9.8-Win trace lesson now blocked end-to-end ──

test('CHAIN: v7.9.8 Win-trace lesson (real recall shape) does not produce DIRECT', () => {
  const { SymbolicResolver } = require(
    path.join(ROOT, 'src/agent/intelligence/SymbolicResolver'));
  // Exact shape from LessonsStore.recall() — no tags, no evidence,
  // source set to plan-failure-reflection by AgentLoopPursuitReflection.
  const lesson = {
    id: 'l_trace',
    insight: 'Goal "Improve Calibration Activity Error Handling" failed (structural): Cannot find module',
    strategy: {
      classification: 'structural',
      goalDescription: 'Improve Calibration Activity Error Handling',
      errorMessage: "Cannot find module '../../core/Logger'",
    },
    confidence: 0.99,
    relevance: 0.9,
    category: 'obstacle-resolution',
    source: 'plan-failure-reflection',
    useCount: 19,                                  // exact v7.9.8 trace value
    lastUsed: Date.now(),
  };
  const resolver = new SymbolicResolver({});
  const result = resolver._checkDirect('ANALYZE', lesson);
  assertEqual(result, null,
    'CHAIN: the v7.9.8 Win-trace failure lesson must not produce DIRECT at uses=19');

  const directive = resolver._buildDirective(lesson, null);
  assert(/AVOID/.test(directive), 'CHAIN: GUIDED directive must invert framing');
});

// ════════════════════════════════════════════════════════════════
// Extension pass 2 — fixes from the v7.9.7-on-Win-station live trace
// (1h run, IdleMind goal "Journal Activity Structured Reflection",
// three pursuits, Pursuit 2 was aborted by P5 but cleanup was forgotten
// so Pursuit 3 hung 10 minutes against the orphaned global timeout.
// Plus EventBus path still hallucinated because REFACTOR / IMPLEMENT /
// FIX / UPDATE step types fell through normalizeStepType and the
// path-hint never triggered. Plus Verifications-Pass-Rate dropped to
// 0% because the verifier was running against P5-abort error strings).
// ════════════════════════════════════════════════════════════════

test('EXT2 P5: v7.9.20 — simulation-risk no longer aborts; handleHardGateAbort always proceeds', async () => {
  // v7.9.20: simulation-risk is no longer a gate on ANY trust level. A read-only
  // "Inspect Cognitive Monitor" goal scored 5.78 and cascaded into 4 empty sub-goals.
  // handleHardGateAbort now always returns { aborted: false } and fires no
  // simulation-abort telemetry / decompose / markObsolete. The old "clean up before
  // aborting" invariant is retired together with the abort path itself.
  const { handleHardGateAbort, TRUST_LEVELS } = require(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate'));
  const gateSrc = fs.readFileSync(
    path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js'), 'utf8');
  const hardGateBlock = gateSrc.split(/function handleHardGateAbort/)[1] || '';
  assert(!/return\s*\{\s*aborted:\s*true/.test(hardGateBlock),
    'handleHardGateAbort must not return aborted:true any more (sim-risk is not a gate)');
  const log = { warn() {}, debug() {}, info() {} };
  for (const lvl of [TRUST_LEVELS.SUPERVISED, TRUST_LEVELS.AUTONOMOUS, TRUST_LEVELS.FULL_AUTONOMY]) {
    let sideEffect = false;
    const loop = {
      currentGoalId: 'g1',
      bus: { fire() { sideEffect = true; } },
      trustLevelSystem: { getLevel: () => lvl },
      recovery: { _trySpawnObstacleSubgoal: async () => { sideEffect = true; return { spawned: true, subId: 's' }; } },
      goalStack: { markObsolete() { sideEffect = true; } },
    };
    const cog = { proceed: false, reason: 'simulation-risk', riskScore: 5.78 };
    const res = await handleHardGateAbort(loop, cog, 0, () => {}, () => {}, () => {}, function NW() {}, log, { id: 'step' }, 0);
    assertEqual(res.aborted, false, `level ${lvl}: sim-risk must proceed (aborted:false)`);
    assert(!sideEffect, `level ${lvl}: no simulation-abort / decompose / markObsolete`);
  }
});

test('EXT2 P2: new step-type aliases REFACTOR/IMPLEMENT/FIX/UPDATE/PATCH normalise to CODE', () => {
  const { normalizeStepType } = require(
    path.join(ROOT, 'src/agent/core/step-types'));
  for (const t of ['REFACTOR', 'IMPLEMENT', 'INTEGRATE', 'ADD', 'FIX', 'UPDATE', 'PATCH', 'WIRE']) {
    assertEqual(normalizeStepType(t), 'CODE',
      `${t} must normalise to CODE so _buildPathHint fires`);
  }
});

test('EXT2 P2: _buildPathHint fires for ANALYZE/SEARCH when target looks like a source file', () => {
  const { AgentLoopRecoveryDelegate } = require(
    path.join(ROOT, 'src/agent/revolution/AgentLoopRecovery'));
  const fakeLoop = {
    selfModel: { getModuleSummary: () => [
      { file: 'src/agent/core/Logger.js', classes: ['createLogger'] },
      { file: 'src/agent/core/EventBus.js', classes: ['EventBus'] },
      { file: 'src/agent/core/Container.js', classes: ['Container'] },
      { file: 'src/agent/foundation/StorageService.js', classes: ['StorageService'] },
      { file: 'src/agent/foundation/Settings.js', classes: ['Settings'] },
      { file: 'src/agent/core/IntervalManager.js', classes: ['IntervalManager'] },
    ]},
    _currentPlan: { title: 'Journal Activity' },
  };
  const d = new AgentLoopRecoveryDelegate(fakeLoop);
  // ANALYZE WITHOUT .js target → no hint (no need to pay budget)
  assertEqual(d._buildPathHint({ type: 'ANALYZE', description: 'reflect on state' }).length, 0,
    'ANALYZE without .js target must NOT receive path hint');
  // ANALYZE WITH .js target → hint
  assert(d._buildPathHint({ type: 'ANALYZE', target: 'src/agent/core/EventBus.js', description: 'inspect' }).length > 0,
    'ANALYZE with .js target must receive path hint');
  // SEARCH same logic
  assert(d._buildPathHint({ type: 'SEARCH', target: 'src/agent/core/Logger.js', description: 'find usage' }).length > 0,
    'SEARCH with .js target must receive path hint');
});

test('EXT2 P10: VerificationEngine returns AMBIGUOUS when step result has error and no output', () => {
  const { VerificationEngine } = require(
    path.join(ROOT, 'src/agent/intelligence/VerificationEngine'));
  const v = new VerificationEngine({ rootDir: '/tmp' });
  const r = v.verify('CODE', { type: 'CODE' }, { error: 'High simulation risk (5.78) on retry attempt 2' });
  assertEqual(r.status, 'ambiguous',
    'sim-aborted step result must be AMBIGUOUS, not FAIL — otherwise dragged pass-rate to 0%');
});

test('EXT2 P10: VerificationEngine routes new CODE aliases (REFACTOR etc) through CodeVerifier', () => {
  const { VerificationEngine } = require(
    path.join(ROOT, 'src/agent/intelligence/VerificationEngine'));
  const v = new VerificationEngine({ rootDir: '/tmp' });
  // REFACTOR + valid code → PASS via CodeVerifier
  const r = v.verify('REFACTOR', { type: 'REFACTOR', target: 'test.js' }, { output: 'const x = 1;' });
  assertEqual(r.status, 'pass',
    'REFACTOR with valid code output must PASS — pre-fix the alias fell through to AMBIGUOUS');
});

test('EXT2 P10: VerificationEngine preserves WRITE_FILE → FileVerifier routing (not CODE)', () => {
  const { VerificationEngine } = require(
    path.join(ROOT, 'src/agent/intelligence/VerificationEngine'));
  const v = new VerificationEngine({ rootDir: ROOT });
  // WRITE_FILE checks file existence, not code content
  const r = v.verify('WRITE_FILE', { target: 'package.json' }, {});
  assertEqual(r.status, 'pass',
    'WRITE_FILE must route to FileVerifier (existence check), not to CodeVerifier');
});

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
