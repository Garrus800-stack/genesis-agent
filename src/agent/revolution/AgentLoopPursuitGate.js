// ============================================================
// GENESIS — AgentLoopPursuitGate.js (v7.9.7 P5/P5b)
//
// Decides whether the cognitive simulation hook should HARD-GATE
// a pursuit (abort, clean up, return failure) or just emit a
// warning and proceed.
//
// Rationale (v7.9.7 P5 outpost trace, fifty-eight minute Win
// session, goal "Improve Calibration Activity Error Handling"):
// three consecutive pursuits in a row logged "Simulation flagged
// risk — proceeding anyway" with riskScore 5.5 to 5.8, all failed
// with the same module-resolution error. The advisory is right
// for first attempts — Genesis should TRY and learn from failure.
// On retries after one or more prior failures plus high risk, the
// advisory becomes a hard gate.
//
// Lives outside AgentLoopPursuit.js so the main pursue() method
// stays under the 700-LOC File-Size-Guard threshold while the
// gate logic remains testable in isolation.
// ============================================================

'use strict';

const HIGH_RISK_THRESHOLD = 5.0;

/**
 * Decide whether to abort the pursuit based on simulation result
 * and prior failure count.
 *
 * @param {object} cogResult      cognition.preExecute return value
 * @param {number} priorFailures  number of prior failed pursuits for this goal
 * @returns {boolean}             true to hard-abort, false to proceed-with-warning
 */
function shouldAbortOnRisk(cogResult, priorFailures) {
  if (!cogResult || cogResult.proceed) return false;
  const score = Number(cogResult.riskScore) || 0;
  return score >= HIGH_RISK_THRESHOLD && priorFailures >= 1;
}

/**
 * Run the full cleanup sequence after a hard-gate abort. Matches
 * the normal failure-path cleanup so no globalTimeout or workspace
 * state leaks past the abort.
 *
 * Pre-v7.9.7-P5b this cleanup was missing — the gate returned
 * directly, leaving running=true, globalTimeout active, workspace
 * dangling. Driver then bounced the next pickup as "already
 * running" (debug-level, invisible), and the orphaned
 * globalTimeout fired ~10 minutes later as "Global timeout
 * reached" with no clear cause.
 *
 * v7.9.8 Fix 5: the attempts counter is intentionally NOT cleared
 * here. The hard-gate aborts when retry-with-high-risk fires, and
 * the pursuit is *about to retry again* via GoalDriver back-off.
 * Clearing the counter resets priorFailures to 0 on the next
 * pursue() pickup, which makes shouldAbortOnRisk return false
 * (needs priorFailures >= 1), the warning-only branch runs, the
 * goal proceeds with the same broken plan, fails again, and the
 * cycle repeats — exactly what the Win outpost trace showed
 * (identical riskScore 5.88 producing abort one cycle and
 * "proceeding anyway" the next). Counter stays alive until the
 * normal success-delete at AgentLoopPursuit.js:391 or until the
 * GoalDriver failure-cap marks the goal stalled/obsolete.
 *
 * @param {object} loop                 AgentLoop instance (mutates running/currentGoalId/_workspace)
 * @param {string} abortedGoalId        the goalId being aborted (kept in counter)
 * @param {function} clearGlobalTimeout closure that clears the running pursuit timeout
 * @param {function} NullWorkspaceCtor  constructor for the empty-workspace placeholder
 */
function cleanupAfterAbort(loop, abortedGoalId, clearGlobalTimeout, NullWorkspaceCtor) {
  loop.running = false;
  loop.currentGoalId = null;
  try { clearGlobalTimeout(); } catch (_e) { /* best-effort */ }
  // v7.9.8 Fix 5: do NOT delete the attempts counter — see header.
  try { loop._workspace.clear(); } catch (_e) { /* best-effort */ }
  loop._workspace = new NullWorkspaceCtor();
}

module.exports = {
  HIGH_RISK_THRESHOLD,
  shouldAbortOnRisk,
  cleanupAfterAbort,
  safeFailureMessage,
};

/**
 * v7.9.8 Fix 7: build a non-empty, semantic failure message from whatever
 * the failure path has at hand. `<empty>` in the GoalDriver log meant the
 * upstream emit had err.message='' or no message at all — useless for
 * FailureAnalyzer and confusing for human readers. This helper centralises
 * the fallback chain used by both _emitFailure and the catch-block emit in
 * AgentLoopPursuit.pursue().
 *
 * Accepts string | Error | undefined. Always returns a non-empty trimmed
 * string. If nothing usable was passed, returns a synthetic message
 * referencing the step count.
 *
 * @param {string|Error|undefined} err  the error or message at hand
 * @param {number} stepCount            current step counter for fallback synth
 * @param {string} [phase]              optional phase tag for the synthetic fallback
 * @returns {string} guaranteed non-empty
 */
function safeFailureMessage(err, stepCount, phase = 'aborted') {
  if (err instanceof Error && err.message && err.message.trim()) return err.message.trim();
  if (typeof err === 'string' && err.trim()) return err.trim();
  return `Pursuit ${phase} after ${stepCount} step(s) without specific error message`;
}
