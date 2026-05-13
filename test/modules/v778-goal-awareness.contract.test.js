// v7.7.8 — Goal-awareness release contract
//
// Background: Live-session 2026-05-09 showed Genesis interpreting
// "das kannst du machen oder etwas ganz anderes :-)" (a casual closing
// with smiley) as a goal — built a 15-step plan including SELF_MODIFY
// and DELEGATE, ran it past plan-validator with 4 unknown-step-type
// blockers, auto-approved at trust-level 3, then silently failed with
// "Goal failed. undefined".
//
// Five fixes wired together as "klarer sehen" (clearer perception, not
// restriction):
//
//   G1 — IntentRouter cascade learns conversation-permission-closing
//        (DE+EN, ≥2 markers, action-verb veto). Casual closings no
//        longer trigger pursuit.
//   G2 — TrustLevelSystem gets a 'blocking' risk category that no level
//        auto-approves. plan-has-issues uses it — plans with structural
//        issues always pause, even at full autonomy.
//   G3 — FormalPlanner prompt names canonical step types explicitly,
//        lists the most-common LLM-invented anti-patterns, and removes
//        hardcoded git-snapshot guidance (Genesis has built-in snapshots).
//   G4 — SelfModificationPipeline gains a trigger-sanity-check that
//        refuses self-mod when the origin is a casual conversation,
//        self-closes the origin goal as obsolete with transparent reason.
//   G5 — AgentLoopPursuit failure-handling now classifies the error,
//        stores a lesson if the pattern is stable, and logs a
//        self-statement Genesis can later recall.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let passed = 0;
let failed = 0;
function track(name, fn) {
  return test(name, async (t) => {
    try { await fn(t); passed++; }
    catch (e) { failed++; throw e; }
  });
}

// ── A1: package.json version is 7.7.8 ────────────────────────
//
// A1 subtest below was retired in v7.7.9 — version-pin became obsolete
// once v7.7.9 shipped. Current version is pinned by
// v779-* contract tests instead. The remaining subtests in this file
// (G1-G5 fix surfaces) stay live as regression guards for the v7.7.8
// goal-awareness fixes.
//
// Same retirement pattern as v7.7.8 retired v7.7.7's A1 (single-version
// pins age out by their nature — what they once asserted is no longer true).

// track('A1: package.json version is 7.7.8', () => {
//   assert.strictEqual(pkg.version, '7.7.8',
//     `package.json version must be 7.7.8, got ${pkg.version}`);
// });

// ── G1: Conversation-closing-recognition ─────────────────────

const { IntentRouter } = require(path.join(ROOT, 'src/agent/intelligence/IntentRouter'));
const _stubBus = { fire: () => {} };
const _router = new IntentRouter({ bus: _stubBus });

track('G1a: "das klingt gut :-)" classified as permission-closing (DE)', () => {
  const r = _router._conversationalSignalsCheck('das klingt gut :-)');
  assert.ok(r, 'should classify');
  assert.strictEqual(r.stage, 'conversational-permission-closing');
});

track('G1b: "das kannst du machen oder etwas ganz anderes :-)" → closing', () => {
  const r = _router._conversationalSignalsCheck('das kannst du machen oder etwas ganz anderes :-)');
  assert.ok(r, 'should classify');
  assert.strictEqual(r.stage, 'conversational-permission-closing');
});

track('G1c: "sounds good, you can do that :-)" → closing (EN)', () => {
  const r = _router._conversationalSignalsCheck('sounds good, you can do that :-)');
  assert.ok(r, 'should classify');
  assert.strictEqual(r.stage, 'conversational-permission-closing');
});

track('G1d: "klingt gut" alone (1 marker) does NOT match closing', () => {
  const r = _router._conversationalSignalsCheck('klingt gut');
  // either null (fall-through) or some other stage — but NOT permission-closing
  if (r) {
    assert.notStrictEqual(r.stage, 'conversational-permission-closing',
      'single marker must not be enough for closing');
  }
});

track('G1e: "das klingt gut, refactor X :-)" — action verb vetoes closing', () => {
  const r = _router._conversationalSignalsCheck('das klingt gut, refactor mal X :-)');
  if (r) {
    assert.notStrictEqual(r.stage, 'conversational-permission-closing',
      'action verb (refactor) must veto closing-classification');
  }
});

// ── G2: TrustLevelSystem 'blocking' risk for plan-has-issues ─

const { TrustLevelSystem } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));

track('G2a: plan-has-issues never auto-approved at any trust level', () => {
  const tls = new TrustLevelSystem({ bus: null, storage: null, settings: null });
  for (const level of [0, 1, 2, 3]) {
    tls._level = level;
    const r = tls.checkApproval('plan-has-issues');
    assert.strictEqual(r.approved, false,
      `level ${level}: plan-has-issues must NOT be auto-approved`);
    assert.strictEqual(r.needsUserApproval, true,
      `level ${level}: plan-has-issues must need user approval`);
  }
});

track("G2b: ACTION_RISK['plan-has-issues'] === 'blocking'", () => {
  const { ACTION_RISK } = require(path.join(ROOT, 'src/agent/foundation/TrustLevelSystem'));
  assert.strictEqual(ACTION_RISK['plan-has-issues'], 'blocking');
});

track("G2c: 'blocking' is not in any LEVEL_AUTO_APPROVE entry", () => {
  const src = read('src/agent/foundation/TrustLevelSystem.js');
  // Extract LEVEL_AUTO_APPROVE block
  const m = /const LEVEL_AUTO_APPROVE\s*=\s*\{([\s\S]*?)\}\s*;/.exec(src);
  assert.ok(m, 'LEVEL_AUTO_APPROVE block must be present');
  const body = m[1];
  // 'blocking' must not appear inside any value array
  // (we allow it in comments but those go to end-of-line)
  const codeOnly = body.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/'blocking'/.test(codeOnly),
    "'blocking' must not appear in any LEVEL_AUTO_APPROVE level");
});

// ── G3: FormalPlanner prompt has canonical types + DO NOT INVENT ──

track('G3a: FormalPlanner prompt declares CANONICAL STEP TYPES block', () => {
  const src = read('src/agent/revolution/FormalPlanner.js');
  assert.ok(/CANONICAL STEP TYPES \(use ONLY these/.test(src),
    'prompt must include "CANONICAL STEP TYPES" header');
  for (const type of ['ANALYZE:', 'CODE:', 'SHELL:', 'SANDBOX:', 'SEARCH:', 'ASK:', 'DELEGATE:']) {
    assert.ok(src.includes(type), `prompt must list canonical type ${type}`);
  }
});

track('G3b: FormalPlanner prompt has DO NOT INVENT anti-pattern list', () => {
  const src = read('src/agent/revolution/FormalPlanner.js');
  assert.ok(/DO NOT INVENT step types/.test(src),
    'prompt must include "DO NOT INVENT" instruction');
  // Spot-check a few of the LLM-invented types we observed in the live-session
  for (const bad of ['"ASK_USER"', '"RUN_TESTS"', '"GIT_SNAPSHOT"', '"SELF_MODIFY"']) {
    assert.ok(src.includes(bad), `anti-pattern list must mention ${bad}`);
  }
});

track('G3c: FormalPlanner prompt removed hardcoded GIT_SNAPSHOT guidance', () => {
  const src = read('src/agent/revolution/FormalPlanner.js');
  // The old "Include GIT_SNAPSHOT before any WRITE_FILE or SELF_MODIFY"
  // line must be gone — git is not always initialized, and Genesis has
  // built-in SnapshotManager + GenesisBackup instead.
  assert.ok(!/Include GIT_SNAPSHOT before any/.test(src),
    'old hardcoded GIT_SNAPSHOT directive must be removed');
  assert.ok(/built-in snapshot capabilities/.test(src),
    'prompt must mention Genesis built-in snapshot capabilities');
});

// ── G4: SelfMod trigger-sanity-check ──────────────────────────

track('G4a: SelfModificationPipelineModify accepts originContext parameter', () => {
  const src = read('src/agent/hexagonal/SelfModificationPipelineModify.js');
  assert.ok(/async modify\(message,\s*originContext/.test(src),
    'modify() must accept originContext as second parameter');
});

track('G4b: SelfModificationPipelineModify checks intentClass for casual origin', () => {
  const src = read('src/agent/hexagonal/SelfModificationPipelineModify.js');
  assert.ok(/intentClass\.startsWith\('conversational-'\)/.test(src),
    'must check for conversational-* intentClass');
  assert.ok(/viaSlashCommand\s*===\s*true/.test(src),
    'must check for viaSlashCommand === true as explicit override');
});

track('G4c: SelfMod fires bus event on trigger-sanity-block', () => {
  const src = read('src/agent/hexagonal/SelfModificationPipelineModify.js');
  assert.ok(/selfmod:trigger-sanity-blocked/.test(src),
    'must fire selfmod:trigger-sanity-blocked event for telemetry');
});

track('G4d: SelfMod self-closes origin goal as obsolete on block', () => {
  const src = read('src/agent/hexagonal/SelfModificationPipelineModify.js');
  assert.ok(/markObsolete/.test(src),
    'must self-close origin goal via markObsolete on block');
});

// ── G5: Plan-failure reflection ──────────────────────────────
// Logic extracted into AgentLoopPursuitReflection.js to keep
// AgentLoopPursuit.js under the 700-LOC architectural-fitness limit.
// Tests verify the reflection helper plus the wiring in pursuit.

track('G5a: reflection helper emits agent:goal-failed-classified', () => {
  const src = read('src/agent/revolution/AgentLoopPursuitReflection.js');
  assert.ok(/agent:goal-failed-classified/.test(src),
    'reflection helper must emit goal-failed-classified for telemetry');
});

track('G5b: reflection helper classifies failures by category', () => {
  const src = read('src/agent/revolution/AgentLoopPursuitReflection.js');
  for (const cat of ['structural', 'execution', 'external', 'user-action', 'unclassified']) {
    assert.ok(src.includes(`'${cat}'`) || src.includes(`"${cat}"`),
      `failure-classification must include category "${cat}"`);
  }
  // Also: classifyFailure() is callable and produces expected categories
  const { classifyFailure } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection'));
  assert.strictEqual(classifyFailure('Unknown step type: ASK_USER'), 'structural');
  assert.strictEqual(classifyFailure('LLM timeout after 30s'), 'execution');
  assert.strictEqual(classifyFailure('Network fetch failed'), 'external');
  assert.strictEqual(classifyFailure('User rejected plan'), 'user-action');
  assert.strictEqual(classifyFailure('something weird happened'), 'unclassified');
});

track('G5c: reflection helper stores lesson via lessonsStore.record()', () => {
  // v7.7.9 (post-Phase-3c.2): test updated. Originally asserted
  // lessonsStore.add() — but that method does not exist on
  // LessonsStore (the real API is record()). The test was
  // codifying the bug it was meant to guard. After Phase 3c.2
  // recordReflection writes via record() with the canonical
  // schema and category 'obstacle-resolution'.
  const src = read('src/agent/revolution/AgentLoopPursuitReflection.js');
  assert.ok(/lessonsStore\.record\s*\(/.test(src),
    'reflection helper must call lessonsStore.record() (real API on LessonsStore)');
  // Verify lessonsStore.record is actually called for stable classifications
  let recordedLesson = null;
  const stubLessonsStore = { record: (l) => { recordedLesson = l; } };
  const { recordReflection } = require(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitReflection'));
  recordReflection({ lessonsStore: stubLessonsStore, selfStatementLog: null }, {
    goalDescription: 'test goal', errorMessage: 'no peers available',
    classification: 'structural',
  });
  assert.ok(recordedLesson, 'lessonsStore.record must be called for stable classification');
  assert.strictEqual(recordedLesson.category, 'obstacle-resolution',
    'category must be obstacle-resolution (matches AgentLoopRecovery recall)');
  assert.ok(recordedLesson.insight, 'lesson must carry a non-empty insight');
  assert.ok(recordedLesson.source === 'plan-failure-reflection',
    'source must identify the producer');
});

track('G5d: reflection helper appends to selfStatementLog with reflection text', () => {
  const src = read('src/agent/revolution/AgentLoopPursuitReflection.js');
  assert.ok(/selfStatementLog\.append/.test(src),
    'reflection helper must append a reflection self-statement');
  assert.ok(/plan-failure-reflection/.test(src),
    'self-statement must use kind "plan-failure-reflection"');
});

track('G5e: AgentLoopPursuit wires reflection helper into _emitFailure', () => {
  const src = read('src/agent/revolution/AgentLoopPursuit.js');
  assert.ok(/require\(['"]\.\/AgentLoopPursuitReflection['"]\)/.test(src),
    'pursuit must require the reflection helper');
  // v7.7.9 (post-Phase-3c.4): all reflection sites use reflectIfNeeded
  // which dedups internally via the _reflected flag. The legacy
  // reflectOnFailure export is still available for direct callers.
  assert.ok(/reflectIfNeeded\(|reflectOnFailure\(/.test(src),
    'pursuit must call a reflection helper in failure path');
});

// ── D1: audit-doc-drift baseline ──────────────────────────────

track('D1: audit-doc-drift produces ≥ 55 strict-checked doc claims', () => {
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', ['scripts/audit-doc-drift.js', '--strict'], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000,
  });
  const output = (result.stdout || '') + (result.stderr || '');
  const m = output.match(/(\d+)\s+(?:doc\s+)?claims?/i);
  if (m) {
    const n = parseInt(m[1], 10);
    assert.ok(n >= 55,
      `audit-doc-drift expected ≥ 55 claims (v7.7.7 baseline), got ${n}`);
  } else {
    assert.strictEqual(result.status, 0,
      `audit-doc-drift --strict failed (exit ${result.status}):\n${output}`);
  }
});

// ── Done ─────────────────────────────────────────────────────

process.on('exit', () => {
  console.log('');
  console.log(`    ${passed} passed${failed > 0 ? ` · ${failed} failed` : ''} · v7.7.8 goal-awareness contract`);
});
