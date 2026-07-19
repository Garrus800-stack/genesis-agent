// ============================================================
// TEST — v7.9.41 (D) Diagnose-Fixe: Verifier prüft CODE statt Prosa,
//        Parsat-Kopf im Fehler, Früh-Log, Spawn-Dedupe, Scheiter-Fakten
//   node test/modules/v7941-diagnose.contract.test.js
// Field 18.07.: every successful CODE step died on "Unexpected token (1:5)"
// — acorn parsing the neutral sentence "Code written: …" (the 'w' at
// 0-based column 5). The whole alias family fell with it.
// ============================================================
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe, test, run } = require('../harness');
const ROOT = path.join(__dirname, '..', '..');
function src(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf-8'); }
const { VerificationEngine } = require('../../src/agent/intelligence/VerificationEngine');

function engine() {
  return new VerificationEngine({ rootDir: ROOT });
}

describe('v7.9.41 D — Diagnose-Fixe', () => {
  test('D1: a successful CODE step with valid code + prose output verifies GREEN', () => {
    const v = engine().verify('CODE', { target: null },
      { output: 'Code written: sandbox (3 lines)', code: 'const a = 1;\nmodule.exports = a;', error: null });
    assert.notStrictEqual(String(v.status).toLowerCase(), 'fail', JSON.stringify(v).slice(0, 200));
  });
  // v7.9.42 A2 contract follow-up (documented): the old pin demanded the very
  // behaviour that killed field goals — textual output syntax-parsed to FAIL.
  // The D1c substance stays pinned on code-looking output; plain text is now
  // accepted as AMBIGUOUS instead of dying in the parser.
  test('D1/A2: textual output (no code) is AMBIGUOUS, not a parse death', () => {
    const v = engine().verify('CODE', { target: null },
      { output: 'Code written: agent-loop-output.js (57 lines)', error: null });
    assert.strictEqual(String(v.status).toLowerCase(), 'ambiguous');
    assert.ok(String(v.reason || '').includes('textual output accepted'), 'A2 reason: ' + String(v.reason).slice(0, 160));
  });
  test('D1c lives: code-looking output still FAILS with the parsat head', () => {
    const v = engine().verify('CODE', { target: null },
      { output: 'const broken = {;', error: null });
    assert.strictEqual(String(v.status).toLowerCase(), 'fail');
    assert.ok(String(v.reason || '').includes('head:'), 'parsat head in reason: ' + String(v.reason).slice(0, 160));
  });
  test('D1: alias family members route through the same healed branch (source pin)', () => {
    const t = src('src/agent/intelligence/VerificationEngine.js');
    assert.ok(t.includes('result.code || result.output'), 'code preferred');
    assert.ok(t.includes('whole alias family'), 'documented');
  });
  test('D1: the success return of the CODE step now carries code (source pin)', () => {
    const t = src('src/agent/revolution/AgentLoopStepsCode.js');
    assert.ok(t.includes('code: newCode, error: null }'), 'success return carries code');
  });
  test('D3: earliest boot trace + crash hooks exist in main.js (source pin)', () => {
    const t = src('main.js');
    assert.ok(t.includes('early-boot.log'));
    assert.ok(t.includes("process.on('uncaughtException'"));
    assert.ok(t.includes("process.on('unhandledRejection'"));
  });
  test('D6/K1: cross-goal investigate dedupe + family registration (source pins)', () => {
    const t = src('src/agent/revolution/AgentLoopObstacles.js');
    assert.ok(t.includes('v7.9.41 K1 dedupe'), 'dedupe present (compact form, LOC-window)');
    assert.ok(t.indexOf('getOpenGoals') < t.indexOf('_trySpawnObstacleSubgoal'), 'dedupe BEFORE spawn');
    assert.ok(t.includes("_fam.push('investigate failure')"), 'family registered');
  });
  test('D6/K2: failures reach refine and decompose (source pins)', () => {
    const r = src('src/agent/autonomy/activities/plan-refine.js');
    assert.ok(r.includes('recentFailedHint'), 'refiner signature');
    assert.ok(r.includes('do NOT drift the refined title toward these'), 'refiner prompt');
    const e = src('src/agent/planning/GoalStackExecution.js');
    assert.ok(e.includes("require('../core/goal-intent')"), 'decompose helper import (correct module)');
    assert.ok(e.includes('DIFFERENT approach than these'), 'decompose prompt');
    const pl = src('src/agent/autonomy/activities/Plan.js');
    assert.ok(pl.includes('recentFailedHint: recentFailed'), 'caller passes through');
  });
});
if (require.main === module) run();
