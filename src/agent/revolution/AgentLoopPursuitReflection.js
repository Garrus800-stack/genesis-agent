// GENESIS — revolution/AgentLoopPursuitReflection.js
// ═══════════════════════════════════════════════════════════════
// Plan-failure reflection helper, extracted from AgentLoopPursuit
// in v7.7.8 to keep the parent under the 700-LOC architectural-fitness
// limit (same pattern as ApprovalGate / AgentLoopRecovery extraction).
//
// What this does:
//
// When a goal pursuit fails, three things happen in addition to the
// usual `agent-loop:complete` event:
//
//   1. classifyFailure() bins the error into one of five categories
//      so telemetry and lessons can aggregate by class.
//
//   2. emitClassifiedEvent() fires `agent:goal-failed-classified`
//      carrying goalId, goalDescription, errorMessage, classification,
//      stepsExecuted — the full picture for downstream consumers.
//
//   3. recordReflection() consults LessonsStore (if a stable pattern
//      is detectable) and SelfStatementLog (always — Genesis can later
//      recall: "ich habe X aufgegeben weil Y") so failures become
//      learnable artefacts rather than disappearing into the void.
//
// Background: Live-session 2026-05-09 ended with `Goal failed.
// undefined` after Genesis silently abandoned a 15-step plan that hit
// a DELEGATE-without-peers wall. No reflection, no lesson, no
// transparent self-report. v7.7.8 wires the reflection so future
// failures produce a usable trail.
//
// All three functions wrap their work in try/catch so a reflection
// error never breaks the failure-return path.
// ═══════════════════════════════════════════════════════════════

'use strict';

// v7.9.7: classifyFailure relocated to ../agency/failure-patterns so
// the GoalDriver fast-track regex and the lesson-recording classifier
// share a single source of truth. Pre-fix the two inline regexes drifted
// — the GoalDriver had "Cannot find module" coverage neither side, the
// lesson side had "invalid|malformed" the goal side didn't, and the
// v7.9.6 outpost trace's TypeError fell through both. Importing here
// keeps the existing call sites stable and the public re-export at the
// bottom keeps v778 / v779 contract tests passing. isStructuralFailure
// is imported alongside classifyFailure so any future caller in this
// file (e.g. a reflection short-circuit) can use the same predicate
// without re-resolving the module.
const { classifyFailure, isStructuralFailure } = require('../agency/failure-patterns');

/**
 * Fire the `agent:goal-failed-classified` event.
 * Wrapped in try/catch — emit-error never breaks the failure path.
 *
 * @param {object} bus
 * @param {{
 *   goalId: string|null,
 *   goalDescription: string|null,
 *   errorMessage: string,
 *   classification: string,
 *   stepsExecuted: number
 * }} payload
 */
function emitClassifiedEvent(bus, payload) {
  if (!bus || typeof bus.fire !== 'function') return;
  try {
    bus.fire('agent:goal-failed-classified', {
      goalId: payload.goalId,
      goalDescription: typeof payload.goalDescription === 'string'
        ? payload.goalDescription.slice(0, 200) : null,
      errorMessage: String(payload.errorMessage || '').slice(0, 200),
      classification: payload.classification,
      stepsExecuted: payload.stepsExecuted,
    }, { source: 'AgentLoop' });
  } catch (_e) { /* never propagate */ }
}

/**
 * Store a lesson (if classification stable) and append a self-statement
 * (always). Both modules are optional — silently no-op if not wired.
 *
 * @param {{lessonsStore: *, selfStatementLog: *}} services
 * @param {{
 *   goalDescription: string|null,
 *   errorMessage: string,
 *   classification: string
 * }} payload
 */
function recordReflection(services, payload) {
  const { lessonsStore, selfStatementLog } = services || {};
  const stableClass = payload.classification !== 'unclassified' &&
                      payload.classification !== 'user-action';

  // v7.7.9 (post-Phase-3c): three-part bug fix — silent bug surfaced
  // by burn-in showing 0 obstacle-resolution lessons after multiple
  // plan failures.
  //
  // Bug X1: this called lessonsStore.add() — that method does not exist
  //         on LessonsStore. The correct method is record(). Because
  //         the call was gated by `typeof lessonsStore.add === 'function'`
  //         the bug was silent: every plan-failure-reflection just
  //         skipped the lesson write.
  //
  // Bug X2: even with X1 fixed, the schema sent here used type/trigger/
  //         error/ts — LessonsStore.record() expects category/insight/
  //         strategy/evidence/tags/source. The old schema would have
  //         saved as `category: 'general'` with empty insight — useless
  //         for recall by AgentLoopRecovery.
  //
  // Bug X3: AgentLoopRecovery._recallObstacleLessons calls
  //         lessonsStore.recall('obstacle-resolution', ...). No code
  //         path was writing into that category. Fix: use exactly that
  //         category here so the read side finds what the write side
  //         stored — closes the lessons feedback loop.
  if (lessonsStore && typeof lessonsStore.record === 'function' && stableClass) {
    try {
      const goalDesc = typeof payload.goalDescription === 'string'
        ? payload.goalDescription.slice(0, 120) : '';
      const errMsg = String(payload.errorMessage || '').slice(0, 200);
      lessonsStore.record({
        category: 'obstacle-resolution',
        insight: `Goal "${goalDesc}" failed (${payload.classification}): ${errMsg}`,
        strategy: {
          classification: payload.classification,
          goalDescription: goalDesc,
          errorMessage: errMsg,
          stepsExecuted: payload.stepsExecuted || 0,
        },
        evidence: {
          successRate: 0,         // this is a recorded FAILURE
          confidence: 0.6,        // moderate — one observation, but explicit
          sampleSize: 1,
          surprise: 0.3,
        },
        tags: [
          'plan-failure',
          payload.classification,
          'auto-captured',
        ],
        source: 'plan-failure-reflection',
      });
    } catch (_e) { /* lesson optional */ }
  }

  if (selfStatementLog && typeof selfStatementLog.append === 'function') {
    try {
      selfStatementLog.append({
        kind: 'plan-failure-reflection',
        text: `Ich habe das Ziel "${(payload.goalDescription || '').slice(0, 80)}" aufgegeben — ` +
              `Klassifikation: ${payload.classification}. ` +
              `Grund: ${String(payload.errorMessage || '').slice(0, 120)}.`,
        classification: payload.classification,
        ts: Date.now(),
      });
    } catch (_e) { /* self-statement optional */ }
  }

  // v7.7.9 Phase 2: also emit through InnerSpeech so ProactiveSelfExpression
  // can decide whether to surface this failure to the user as a self-message.
  // This is additive — the selfStatementLog write above is unchanged. PSE
  // applies its own gates/threshold/sanity to decide if the reflection
  // becomes a chat message; without PSE wired (or with PSE muted), nothing
  // user-visible happens here.
  const innerSpeech = payload.innerSpeech;
  if (innerSpeech && typeof innerSpeech.emit === 'function') {
    try {
      const text = `Plan "${(payload.goalDescription || '').slice(0, 80)}" failed — ` +
                   `classification: ${payload.classification}. ` +
                   `Error: ${String(payload.errorMessage || '').slice(0, 200)}.`;
      innerSpeech.emit(text, 'plan-failure-reflection', {
        sourceModule: 'AgentLoopPursuitReflection',
        contextRefs: {
          goalId: payload.goalId || null,
          goalDescription: payload.goalDescription || null,
          classification: payload.classification,
          stepsExecuted: payload.stepsExecuted || 0,
        },
        // Significance is high for plan failures by definition — they
        // represent a goal Genesis decided was worth pursuing, that did
        // not work. Novelty is moderate (1 - some-recency-decay would be
        // ideal but we don't have access to a recent-failure cache here).
        significance: 0.65,
        novelty: 0.6,
      });
    } catch (_e) { /* innerSpeech.emit() never throws but defensive anyway */ }
  }
}

/**
 * One-call convenience that runs all three steps. AgentLoopPursuit's
 * `_emitFailure` calls this after the existing `agent-loop:complete`
 * emit, so the existing failure path stays unchanged at the top.
 *
 * @param {{
 *   bus: *,
 *   lessonsStore: *,
 *   selfStatementLog: *,
 *   innerSpeech?: *
 * }} services — innerSpeech is optional (v7.7.9 Phase 2); when present,
 *               PSE can decide to surface the reflection as a self-message
 * @param {{
 *   goalId: string|null,
 *   goalDescription: string|null,
 *   errorMessage: string,
 *   stepsExecuted: number
 * }} context
 */
function reflectOnFailure(services, context) {
  try {
    const classification = classifyFailure(context.errorMessage);
    emitClassifiedEvent(services.bus, {
      goalId: context.goalId,
      goalDescription: context.goalDescription,
      errorMessage: context.errorMessage,
      classification,
      stepsExecuted: context.stepsExecuted,
    });
    recordReflection({
      lessonsStore: services.lessonsStore,
      selfStatementLog: services.selfStatementLog,
    }, {
      goalId: context.goalId,
      goalDescription: context.goalDescription,
      errorMessage: context.errorMessage,
      classification,
      stepsExecuted: context.stepsExecuted,
      innerSpeech: services.innerSpeech || null,  // v7.7.9 Phase 2
    });
  } catch (_e) { /* reflection never breaks failure path */ }
}

/**
 * v7.7.9 (post-Phase-3c.4) — convenience wrapper used by every
 * reflectOnFailure call site in AgentLoopPursuit. Centralizes:
 *   - the dedup check (`_reflected` flag on the loop instance)
 *   - the services dict assembly (bus / lessonsStore / selfStatementLog
 *     / innerSpeech) so each call site stays a single line
 *   - setting `_reflected=true` after a successful reflection so later
 *     paths skip a duplicate record
 *
 * Returns true if reflection ran (or was attempted), false if skipped
 * because already-reflected. Callers don't need the return value but
 * it's there for tests.
 */
function reflectIfNeeded(loop, payload) {
  if (loop._reflected) return false;
  try {
    reflectOnFailure(
      { bus: loop.bus, lessonsStore: loop.lessonsStore,
        selfStatementLog: loop.selfStatementLog, innerSpeech: loop.innerSpeech || null },
      payload
    );
  } catch (_e) { /* reflection optional, never breaks failure path */ }
  loop._reflected = true;
  return true;
}

/**
 * v7.7.9 (post-Phase-3c.4) — compose a non-empty errorMessage from a
 * pursuit-loop result. Centralises the priority order used on every
 * early-return path: blocked-on-resources → result.error → result.summary
 * → synthesized fallback referencing the step count. classifyFailure
 * needs a non-empty string to categorise; an empty errorMessage routes
 * to 'unclassified' which the stableClass gate then drops.
 */
function composeFailureMessage(result, stepCount) {
  if (!result) return `Pursuit ended without result after ${stepCount} steps`;
  if (result.blocked && Array.isArray(result.blockedByResources)) {
    return `Blocked on missing resources: ${result.blockedByResources.join(', ')}`;
  }
  return result.error || result.summary || `Pursuit ended without success after ${stepCount} steps`;
}

module.exports = {
  classifyFailure,
  isStructuralFailure,
  emitClassifiedEvent,
  recordReflection,
  reflectOnFailure,
  reflectIfNeeded,
  composeFailureMessage,
};
