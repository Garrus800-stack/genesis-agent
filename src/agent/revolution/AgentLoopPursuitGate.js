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
 * the normal failure-path cleanup so no globalTimeout, attempts-
 * counter, or workspace state leaks past the abort.
 *
 * Pre-v7.9.7-P5b this cleanup was missing — the gate returned
 * directly, leaving running=true, globalTimeout active, workspace
 * dangling. Driver then bounced the next pickup as "already
 * running" (debug-level, invisible), and the orphaned
 * globalTimeout fired ~10 minutes later as "Global timeout
 * reached" with no clear cause.
 *
 * @param {object} loop                 AgentLoop instance (mutates running/currentGoalId/_workspace)
 * @param {string} abortedGoalId        the goalId being aborted
 * @param {function} clearGlobalTimeout closure that clears the running pursuit timeout
 * @param {function} NullWorkspaceCtor  constructor for the empty-workspace placeholder
 */
function cleanupAfterAbort(loop, abortedGoalId, clearGlobalTimeout, NullWorkspaceCtor) {
  loop.running = false;
  loop.currentGoalId = null;
  try { clearGlobalTimeout(); } catch (_e) { /* best-effort */ }
  try { loop._pursuitAttempts.delete(abortedGoalId); } catch (_e) { /* best-effort */ }
  try { loop._workspace.clear(); } catch (_e) { /* best-effort */ }
  loop._workspace = new NullWorkspaceCtor();
}

module.exports = {
  HIGH_RISK_THRESHOLD,
  shouldAbortOnRisk,
  cleanupAfterAbort,
};
