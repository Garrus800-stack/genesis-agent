// @ts-checked-v7.9.7
// ============================================================
// GENESIS — core/failure-patterns.js (v7.9.7)
//
// Single source of truth for failure-message pattern matching.
// Two callers depend on identical classification:
//
//   1. GoalDriverFailurePolicy   — fast-track-to-obsolete decision.
//      Uses isStructuralFailure() to pick cap=2 (hallucination) vs
//      cap=3 (generic) and to choose the terminal status.
//
//   2. AgentLoopPursuitReflection — lesson-recording gate.
//      Uses classifyFailure() to bin into {structural, execution,
//      external, user-action, unclassified}. stableClass admits all
//      but the last two so structural and execution failures reach
//      lessonsStore.record().
//
// Pre-v7.9.7 these lived as two separate regex literals in two
// files. They drifted: the v7.9.6 outpost trace surfaced a TypeError
// (`Cannot create property 'description' on string ...`) that
// matched neither and led to the same goal failing seven times in
// twenty-five minutes while zero lessons were written. The v7.9.7
// foundation pass merged the patterns; the v7.9.7 outpost trace
// surfaced one more pair (`Cannot find module ...`, `Logger is not
// a constructor`) that the merged regex still did not cover. Both
// are now first-class patterns in STRUCTURAL_FAILURE_RE.
//
// Class definition:
//
//   structural — output the LLM cannot fix by retrying. Hallucinated
//     paths, hallucinated APIs (new Logger() instead of createLogger,
//     wrong require target), invalid step types, malformed JSON the
//     parser still accepted but the runtime rejected, and the
//     JS-runtime TypeErrors that signal the LLM produced unrunnable
//     code. Each one is a same-shape-will-keep-failing failure;
//     fast-track to obsolete and record a lesson.
//
//   execution — transient or environment-dependent. Timeouts, model
//     unavailable, verification ran but failed, mental simulation
//     blocked, retries exhausted. The next pursuit may succeed if
//     the underlying condition clears.
//
//   external — outside Genesis. Network, rate limit, fetch failure,
//     connection refused, DNS lookup miss. Retry policy belongs to
//     the network sentinel, not the goal driver.
//
//   user-action — the user said stop. Not a system failure; do not
//     record as a lesson, do not punish the goal's success rate.
//
//   unclassified — the message did not match any category. Pursuit
//     is still treated as failed for accounting purposes, but the
//     lesson gate drops it to avoid polluting the store with
//     unstructured snippets.
// ============================================================

'use strict';

/**
 * Regex matching error messages that indicate a STRUCTURAL failure.
 * Used by GoalDriverFailurePolicy (fast-track to obsolete after 2 hits)
 * and by classifyFailure below (structural bucket).
 *
 * Patterns (case-insensitive):
 *   - Plan-shape hallucinations (paths, step types, plausibility)
 *   - JSON/parse output the runtime rejected
 *   - File/module-not-found errors (the LLM referenced a nonexistent path)
 *   - JS-runtime TypeErrors (mixed-array, undefined-property access,
 *     wrong-constructor-call, non-iterable, etc.)
 *   - Module-resolution failures ("Cannot find module ...") — v7.9.7
 *     outpost trace addition; was the most common single failure shape
 *     in the trace and was the one R3.1 was specifically about
 *   - The pre-flight invalid-target-path block (R4)
 */
const STRUCTURAL_FAILURE_RE = /implausible path|plausibility check failed|unknown step type|Unexpected token|missing required|file not found|ENOENT|Cannot find module|Cannot create property|Cannot read propert(y|ies)|is not a function|is not a constructor|is not iterable|peer.*unavailable|no peers|invalid|malformed|Invalid target path \(hallucinated\)/i;

/**
 * Regex matching EXECUTION failures — transient, environment-dependent.
 * Pursuit may succeed on retry once the underlying condition clears.
 */
const EXECUTION_FAILURE_RE = /timeout|llm|model.*unavailable|verification failed|verify.*fail|repair.*fail|exhausted|High simulation risk|simulation flagged/i;

/**
 * Regex matching EXTERNAL failures — outside Genesis (network, APIs).
 */
const EXTERNAL_FAILURE_RE = /network|api.*rate|fetch.*fail|connection|refused|enotfound|ehostunreach/i;

/**
 * Regex matching USER-ACTION failures — the user explicitly stopped.
 * Not recorded as a lesson, not a failure of the goal itself.
 */
const USER_ACTION_FAILURE_RE = /rejected|user.*stop|stop.*by.*user|cancel|aborted/i;

/**
 * Test whether an error message belongs to the structural-failure
 * class. Empty/missing strings return false (no class can be
 * derived from nothing — the caller's own empty-string handling
 * applies).
 *
 * @param {string|null|undefined} errMsg
 * @returns {boolean}
 */
function isStructuralFailure(errMsg) {
  if (!errMsg || typeof errMsg !== 'string') return false;
  return STRUCTURAL_FAILURE_RE.test(errMsg);
}

/**
 * Classify an error message into one of five categories. Order
 * matters: structural is tested first so that messages combining
 * "plausibility check failed" + "timeout" classify as structural
 * (the more actionable bucket for lessons).
 *
 * @param {string|null|undefined} errorMessage
 * @returns {'structural'|'execution'|'external'|'user-action'|'unclassified'}
 */
function classifyFailure(errorMessage) {
  const m = String(errorMessage || '');
  if (!m) return 'unclassified';
  if (STRUCTURAL_FAILURE_RE.test(m)) return 'structural';
  if (EXECUTION_FAILURE_RE.test(m))  return 'execution';
  if (EXTERNAL_FAILURE_RE.test(m))   return 'external';
  if (USER_ACTION_FAILURE_RE.test(m)) return 'user-action';
  return 'unclassified';
}

module.exports = {
  STRUCTURAL_FAILURE_RE,
  EXECUTION_FAILURE_RE,
  EXTERNAL_FAILURE_RE,
  USER_ACTION_FAILURE_RE,
  isStructuralFailure,
  classifyFailure,
};
