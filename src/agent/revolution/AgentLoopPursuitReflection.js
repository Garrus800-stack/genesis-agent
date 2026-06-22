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

// v7.9.7: classifyFailure relocated to ../core/failure-patterns so
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
const { classifyFailure, isStructuralFailure } = require('../core/failure-patterns');

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
  const { lessonsStore } = services || {};
  // v7.9.10: stableClass also admits 'unclassified' when errorMessage carries
  // signal. LLM-generated goal verdicts ("PARTIAL because the critical step
  // failed...", "FAILED. The goal X was not achieved.") never match the
  // technical-error regex in failure-patterns.js — they describe the verdict,
  // not the error class — so they classified as 'unclassified' and the gate
  // silently dropped them. Field-trace 2026-05-24: 6h run with 4 goals and
  // one PARTIAL retry, lessons folder empty. Now they record (tagged with
  // 'unclassified' so recall knows the signal is weak per individual lesson
  // but still useful as a pattern). 'user-action' stays excluded — user
  // cancellation is not a Genesis failure to learn from.
  const errMsgRaw = String(payload.errorMessage || '').trim();
  const stableClass = payload.classification !== 'user-action' &&
                      (payload.classification !== 'unclassified' || errMsgRaw.length > 0);

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

  // v7.9.26: the per-failure "I gave up" self-statement and the InnerSpeech
  // emit were removed from here. They fired on every pursuit-attempt failure —
  // before GoalDriver decided to pause, retry, or abandon — so Genesis told
  // itself it had given up on goals it was still working on. The truthful
  // narration now hangs off the real terminal events (goal:abandoned /
  // goal:stalled / goal:obsolete) via wireGoalOutcomeNarration. The lesson
  // write above stays here: each failed attempt is worth learning from, even
  // when the goal is later retried rather than abandoned.
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
    }, {
      goalId: context.goalId,
      goalDescription: context.goalDescription,
      errorMessage: context.errorMessage,
      classification,
      stepsExecuted: context.stepsExecuted,
    });
  } catch (_e) { /* reflection never breaks failure path */ }
}

/**
 * v7.7.9 (post-Phase-3c.4) — convenience wrapper used by every
 * reflectOnFailure call site in AgentLoopPursuit. Centralizes:
 *   - the dedup check (`_reflected` flag on the loop instance)
 *   - the services dict assembly (bus / lessonsStore) so each call site
 *     stays a single line. Terminal-outcome narration (the "I gave up" /
 *     "stalled" / "obsolete" self-statement) is handled separately by
 *     wireGoalOutcomeNarration, hung off the real goal lifecycle events.
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
      { bus: loop.bus, lessonsStore: loop.lessonsStore },
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

// ── Terminal-outcome narration (v7.9.26) ─────────────────────
// A goal's real terminal outcome — abandoned, stalled, or obsolete — is the
// truthful moment for an "I gave up / I stalled / I marked obsolete" self-
// statement, not every failed pursuit attempt (which GoalDriver may pause and
// retry). These hang off the goal lifecycle events fired by GoalStack and
// AgentLoop, decoupled from the per-attempt reflection above.
const OUTCOME_NARRATION = {
  'goal:abandoned': { kind: 'goal-abandoned', phrase: (d) => `I gave up on the goal${d}` },
  'goal:stalled':   { kind: 'goal-stalled',   phrase: (d) => `I stalled on the goal${d}` },
  'goal:obsolete':  { kind: 'goal-obsolete',  phrase: (d) => `I marked the goal${d} obsolete` },
};

/**
 * Emit the truthful self-statement (and InnerSpeech thought) for one terminal
 * goal outcome. selfStatementLog / innerSpeech are read from `services` at call
 * time, so a late-bound provider (e.g. the AgentLoop instance) works.
 * @param {{selfStatementLog?: *, innerSpeech?: *}} services
 * @param {string} eventName  one of OUTCOME_NARRATION's keys
 * @param {{id?: string, description?: string, reason?: string}} payload
 */
function narrateGoalOutcome(services, eventName, payload) {
  const spec = OUTCOME_NARRATION[eventName];
  if (!spec) return;
  const desc = String((payload && (payload.description || payload.goalDescription)) || '').slice(0, 80);
  const reason = String((payload && payload.reason) || '').slice(0, 120);
  const descPart = desc ? ` "${desc}"` : '';
  const text = `${spec.phrase(descPart)}${reason ? ` — ${reason}` : ''}.`;

  const selfStatementLog = services && services.selfStatementLog;
  if (selfStatementLog && typeof selfStatementLog.append === 'function') {
    try {
      selfStatementLog.append({ kind: spec.kind, text, ts: Date.now() });
    } catch (_e) { /* self-statement optional */ }
  }

  const innerSpeech = services && services.innerSpeech;
  if (innerSpeech && typeof innerSpeech.emit === 'function') {
    try {
      innerSpeech.emit(text, spec.kind, {
        sourceModule: 'AgentLoopPursuitReflection',
        contextRefs: { goalId: (payload && payload.id) || null, description: desc || null },
        significance: 0.65,
        novelty: 0.6,
      });
    } catch (_e) { /* innerSpeech.emit() never throws but defensive anyway */ }
  }
}

/**
 * Subscribe terminal-outcome narration to the goal lifecycle events. Returns an
 * array of unsubscribe handles. `services` is read lazily inside the handler,
 * so passing a late-bound object (the AgentLoop) is fine.
 * @param {{on: Function}} bus
 * @param {{selfStatementLog?: *, innerSpeech?: *}} services
 * @returns {Function[]}
 */
function wireGoalOutcomeNarration(bus, services) {
  if (!bus || typeof bus.on !== 'function') return [];
  const unsubs = [];
  for (const eventName of Object.keys(OUTCOME_NARRATION)) {
    unsubs.push(bus.on(eventName, (payload) => {
      try { narrateGoalOutcome(services, eventName, payload); } catch (_e) { /* never break the bus */ }
    }));
  }
  return unsubs;
}

module.exports = {
  classifyFailure,
  isStructuralFailure,
  emitClassifiedEvent,
  recordReflection,
  reflectOnFailure,
  reflectIfNeeded,
  composeFailureMessage,
  narrateGoalOutcome,
  wireGoalOutcomeNarration,
};
