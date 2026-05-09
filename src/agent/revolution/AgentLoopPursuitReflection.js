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

/**
 * Bin an error message into one of five failure categories.
 * Pure function, no side effects, easy to test.
 *
 * @param {string} errorMessage
 * @returns {'structural'|'execution'|'external'|'user-action'|'unclassified'}
 */
function classifyFailure(errorMessage) {
  const m = String(errorMessage || '').toLowerCase();
  if (/unknown step type|missing required|peer.*unavailable|no peers/.test(m)) return 'structural';
  if (/timeout|llm|model.*unavailable/.test(m)) return 'execution';
  if (/network|api.*rate|fetch.*fail/.test(m)) return 'external';
  if (/rejected|user.*stop|cancel/.test(m)) return 'user-action';
  return 'unclassified';
}

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

  if (lessonsStore && typeof lessonsStore.add === 'function' && stableClass) {
    try {
      lessonsStore.add({
        type: 'plan-failure',
        classification: payload.classification,
        trigger: typeof payload.goalDescription === 'string'
          ? payload.goalDescription.slice(0, 120) : '',
        error: String(payload.errorMessage || '').slice(0, 120),
        ts: Date.now(),
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
}

/**
 * One-call convenience that runs all three steps. AgentLoopPursuit's
 * `_emitFailure` calls this after the existing `agent-loop:complete`
 * emit, so the existing failure path stays unchanged at the top.
 *
 * @param {{
 *   bus: *,
 *   lessonsStore: *,
 *   selfStatementLog: *
 * }} services
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
      goalDescription: context.goalDescription,
      errorMessage: context.errorMessage,
      classification,
    });
  } catch (_e) { /* reflection never breaks failure path */ }
}

module.exports = {
  classifyFailure,
  emitClassifiedEvent,
  recordReflection,
  reflectOnFailure,
};
