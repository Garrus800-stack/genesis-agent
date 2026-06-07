// ============================================================
// GENESIS — v799-hard-gate-emit.contract.test.js
//
// Pins the v7.9.9 invariant: hard-gate-abort (simulation HIGH
// risk + prior failure) emits agent-loop:complete via the shared
// _emitFailure helper so the abort reason reaches GoalDriver
// instead of landing as `<empty>` in the backing-off log.
//
// Pre-fix the abort path returned directly from pursue() without
// firing agent-loop:complete. GoalDriver got the failure via the
// result-promise resolve path, but the event handler is the
// canonical source for the failure-pause counter.
//
// v7.9.20 (Teil C): simulation-risk is no longer a gate on any trust
// level, so the sim-risk abort+emit path is retired (SRC-01 updated).
// SRC-02..05 still pin the shared _emitFailure helper + catch clause,
// which remain in use for general pursuit failures.
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const { describe, test, assert, run } = require('../harness');

const PURSUIT_PATH = path.join(ROOT, 'src/agent/revolution/AgentLoopPursuit.js');

describe('v7.9.9 Hard-Gate Abort Emit', () => {

  test('SRC-01: v7.9.20 — handleHardGateAbort no longer aborts/emits on sim-risk', () => {
    // v7.9.20 (Teil C): simulation-risk is no longer a gate on any trust level.
    // The sim-risk abort path is gone, so there is no emitFailure-before-abort to
    // pin any more. pursue() still dispatches to the helper and keeps an (inert)
    // guard so any future aborted:true would still be handled and early-return.
    const pursuitSrc = fs.readFileSync(PURSUIT_PATH, 'utf8');
    const gateSrc = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js'), 'utf8');
    assert(/handleHardGateAbort\(this,\s*cogResult/.test(pursuitSrc),
      'pursue() must dispatch to handleHardGateAbort');
    assert(/_gateResult\.aborted/.test(pursuitSrc) && /return\s*\{\s*success:\s*false/.test(pursuitSrc),
      'pursue() must keep the aborted guard (early-return success:false)');
    const helperBlock = gateSrc.split(/function handleHardGateAbort/)[1] || '';
    assert(!/return\s*\{\s*aborted:\s*true/.test(helperBlock),
      'handleHardGateAbort must not return aborted:true any more (sim-risk is not a gate)');
    assert(!/emitFailure\(/.test(helperBlock),
      'handleHardGateAbort must not emit a failure for sim-risk (it proceeds)');
  });

  test('SRC-02: _emitFailure routes through safeFailureMessage', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    // _emitFailure is the shared helper that calls safeFailureMessage internally.
    assert(/const _emitFailure\s*=\s*\(errorMessage\)\s*=>/.test(src),
      '_emitFailure helper must exist');
    assert(/safeFailureMessage\(errorMessage/.test(src),
      '_emitFailure must call safeFailureMessage to guarantee non-empty error');
  });

  test('SRC-03: v7.9.9 Fix 4 marker comment present (in pursuit or in extracted Gate helper)', () => {
    const pursuitSrc = fs.readFileSync(PURSUIT_PATH, 'utf8');
    const gateSrc = fs.readFileSync(path.join(ROOT, 'src/agent/revolution/AgentLoopPursuitGate.js'), 'utf8');
    assert(/v7\.9\.9 Fix 4/.test(pursuitSrc) || /v7\.9\.9 Fix [45]/.test(gateSrc),
      'v7.9.9 Fix 4 marker must be present in the hard-gate-abort path (pursuit OR Gate helper)');
  });

  test('SRC-04: catch clause uses safeMsg + explicit error field', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    // The catch block must use safeFailureMessage and include error:safeMsg
    // when firing agent-loop:complete.
    const catchIdx = src.indexOf('} catch (err) {');
    assert(catchIdx > 0, 'catch block must exist');
    const catchTail = src.slice(catchIdx, catchIdx + 1500);
    assert(/safeFailureMessage\(err/.test(catchTail),
      'catch-block must build safeMsg via safeFailureMessage');
    assert(/error:\s*safeMsg/.test(catchTail),
      'catch-block agent-loop:complete must include explicit error field');
  });

  test('SRC-05: catch clause synthesizes goalId for early-fail (Fix 6)', () => {
    const src = fs.readFileSync(PURSUIT_PATH, 'utf8');
    assert(/this\.currentGoalId\s*\|\|\s*`loop_early_/.test(src),
      'catch-block must synth loop_early_<ts> goalId when currentGoalId not yet set');
  });

}); // describe

run().catch(err => { console.error(err); process.exit(1); });
