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
 * Decide whether to abort the pursuit based on simulation result.
 *
 * v7.9.9 (C): three-level trust system makes the differential decision
 * (ask / decompose / obsolete) — the gate just decides whether the
 * simulation flagged the pursuit as high-risk. priorFailures is no longer
 * a precondition.
 *
 * @param {object} cogResult cognition.preExecute return value
 * @returns {boolean} true to hard-abort, false to proceed-with-warning
 */
function shouldAbortOnRisk(cogResult) {
  if (!cogResult || cogResult.proceed) return false;
  const score = Number(cogResult.riskScore) || 0;
  return score >= HIGH_RISK_THRESHOLD;
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

/**
 * v7.9.9 final: hard-gate trust-level dispatch. Returns one of:
 *   { aborted: false } — risk under threshold OR warn-and-proceed, continue normally
 *   { aborted: true, action: 'decomposed', subId, abortMsg } — sub-goal spawned, parent parked
 *   { aborted: true, action: 'obsolete', abortMsg } — FULL_AUTONOMY + decompose refused → obsolete
 *
 * Dispatch matrix (when shouldAbortOnRisk returns true):
 *   SUPERVISED    → warn-only, return aborted=false; TrustLevelSystem.checkApproval(stepType)
 *                   asks at every step anyway, so the hard-gate ask was a duplicate spam path.
 *   AUTONOMOUS    → warn-only, return aborted=false; TrustLevelSystem.checkApproval(stepType)
 *                   asks for categorically CRITICAL actions (DEPLOY/EXTERNAL_API/EMAIL_SEND)
 *                   so the appropriate ask still happens at the step level. The hard-gate
 *                   should not override that with a "every high-sim-risk needs confirmation"
 *                   prompt — that turns AUTONOMOUS into pseudo-SUPERVISED.
 *   FULL_AUTONOMY → decompose (spawn investigative sub-goal); on refusal → markObsolete.
 *                   Still NEVER asks. Decompose gives Genesis a chance to try a different
 *                   approach when simulation flags structural risk.
 *   No TrustLevelSystem → SUPERVISED behaviour (warn-only).
 *
 * Why no ask path on the hard-gate any more: the user-facing approval mechanism is
 * `TrustLevelSystem.checkApproval(actionType)` — that is the single ask channel,
 * driven by action *category*. Sim-risk is a numerical signal best routed to
 * telemetry/decompose, not stacked as a second ask path on top.
 *
 * @param {object} loop             AgentLoop instance (this)
 * @param {object} cogResult        cognition.preExecute result
 * @param {number} priorFailures    count from _pursuitAttempts (logging only)
 * @param {function} onProgress     progress callback
 * @param {function} emitFailure    pursuit-local _emitFailure helper
 * @param {function} clearTimeout   pursuit-local _clearGlobalTimeout helper
 * @param {object} NullWorkspaceCtor
 * @param {object} log              logger instance
 * @param {object} [step]           current step (passed to decompose path)
 * @param {number} [stepIndex]      step index (passed to decompose path)
 * @returns {Promise<{aborted: boolean, action?: string, abortMsg?: string, subId?: string}>}
 */
async function handleHardGateAbort(loop, cogResult, priorFailures, onProgress, emitFailure, clearTimeout, NullWorkspaceCtor, log, step, stepIndex) {
  if (!shouldAbortOnRisk(cogResult)) {
    log.warn(`[AGENT-LOOP] Simulation flagged risk: ${cogResult.reason} (score: ${cogResult.riskScore}) — proceeding anyway`);
    onProgress({ phase: 'simulation-warning', detail: `Risk flagged: ${cogResult.reason} — proceeding`, risk: cogResult.riskScore });
    return { aborted: false };
  }
  // v7.9.9 final: dedup telemetry per goalId. Pre-fix the simulation-abort
  // event fired on every pursuit retry — field-test 2026-05-24 showed the
  // same goal firing the event 3× during a 3-retry sequence with the gate
  // tripping on every plan regeneration. Dashboard saw it as spam. Track
  // emitted goalIds in a Set on the loop instance; cleared on goal completion.
  loop._simulationAbortEmittedGoals ??= new Set();
  if (!loop._simulationAbortEmittedGoals.has(loop.currentGoalId)) {
    loop.bus.fire('agent-loop:simulation-abort', {
      goalId: loop.currentGoalId, riskScore: cogResult.riskScore, priorFailures, reason: cogResult.reason,
    }, { source: 'AgentLoop' });
    loop._simulationAbortEmittedGoals.add(loop.currentGoalId);
  }

  const level = (typeof loop.trustLevelSystem?.getLevel === 'function')
    ? loop.trustLevelSystem.getLevel()
    : TRUST_LEVELS.SUPERVISED;

  // SUPERVISED + AUTONOMOUS → warn-only, let TrustLevelSystem.checkApproval handle
  // step-level asks based on action category. No duplicate ask path here.
  if (level === TRUST_LEVELS.SUPERVISED || level === TRUST_LEVELS.AUTONOMOUS) {
    const levelName = level === TRUST_LEVELS.SUPERVISED ? 'SUPERVISED' : 'AUTONOMOUS';
    log.warn(`[AGENT-LOOP] Simulation HIGH risk: ${cogResult.reason} (score ${cogResult.riskScore}, ${levelName} — TrustLevelSystem handles ask at step level)`);
    onProgress({ phase: 'simulation-warning', detail: `High risk: ${cogResult.reason} — proceeding (per-action approval via trust level)`, risk: cogResult.riskScore });
    return { aborted: false };
  }

  // FULL_AUTONOMY → try decompose, on refusal mark obsolete (NEVER ask).
  log.warn(`[AGENT-LOOP] Simulation HIGH risk: ${cogResult.reason} (score ${cogResult.riskScore}, FULL_AUTONOMY — attempting decompose)`);
  onProgress({ phase: 'simulation-abort', detail: `High risk: ${cogResult.reason}`, risk: cogResult.riskScore });
  const recovery = loop.recovery;
  if (recovery && typeof recovery._trySpawnObstacleSubgoal === 'function' && step) {
    const syntheticObstacle = {
      contextKey: `high-risk-simulation-${(cogResult.reason || 'unknown').slice(0, 30).replace(/\s+/g, '_')}`,
      subGoalDescription: `Investigate why simulation gives HIGH risk (${cogResult.riskScore.toFixed(2)}) on step ${(stepIndex ?? 0) + 1}: ${cogResult.reason}. Document the risk drivers, then describe a different approach.`,
    };
    try {
      const spawned = await recovery._trySpawnObstacleSubgoal(syntheticObstacle, step, stepIndex ?? 0, onProgress);
      if (spawned.spawned) {
        cleanupAfterAbort(loop, loop.currentGoalId, clearTimeout, NullWorkspaceCtor);
        const abortMsg = `High-risk simulation — decomposed via sub-goal ${spawned.subId} (${cogResult.reason})`;
        emitFailure(abortMsg);
        return { aborted: true, action: 'decomposed', subId: spawned.subId, abortMsg };
      }
      // Decompose refused → obsolete (FULL_AUTONOMY never asks).
      if (loop.goalStack && typeof loop.goalStack.markObsolete === 'function' && loop.currentGoalId) {
        try { loop.goalStack.markObsolete(loop.currentGoalId, `decompose refused (${spawned.reason}) on high-risk simulation: ${cogResult.reason}`); } catch (_e) { /* best-effort */ }
      }
      cleanupAfterAbort(loop, loop.currentGoalId, clearTimeout, NullWorkspaceCtor);
      const abortMsg = `Goal marked obsolete: decompose refused (${spawned.reason}) on high-risk simulation — FULL_AUTONOMY does not ask.`;
      emitFailure(abortMsg);
      return { aborted: true, action: 'obsolete', abortMsg };
    } catch (e) { log.debug('[catch] decompose attempt failed:', e.message); }
  }

  // Fall-through: decompose path unavailable (no recovery delegate / no step) → legacy hard-abort.
  cleanupAfterAbort(loop, loop.currentGoalId, clearTimeout, NullWorkspaceCtor);
  const abortMsg = `High simulation risk (${cogResult.riskScore.toFixed(2)}): ${cogResult.reason}.`;
  emitFailure(abortMsg);
  return { aborted: true, action: 'abort', abortMsg };
}

const { TRUST_LEVELS } = require('../foundation/TrustLevelSystem');

module.exports = {
  HIGH_RISK_THRESHOLD,
  shouldAbortOnRisk,
  cleanupAfterAbort,
  safeFailureMessage,
  handleHardGateAbort,
  TRUST_LEVELS,
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
