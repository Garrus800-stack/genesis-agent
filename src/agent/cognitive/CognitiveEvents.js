// ============================================================
// GENESIS — CognitiveEvents.js (v7.0.1 — Typed Event Facade)
//
// Typed facade over EventBus for the Cognitive layer.
// Covers: cognitive, learning, adaptation, dream, expectation,
//         simulation, surprise, online-learning, lessons,
//         narrative, replay, task-outcome, memory (consolidation).
// ============================================================

'use strict';

const { EVENTS } = require('../core/EventTypes');

class CognitiveEvents {
  /** @param {import('../core/EventBus').EventBus} bus */
  constructor(bus) { this._bus = bus; }

  // ── Cognitive core ──────────────────────────────────────
  emitStarted(data, meta)              { this._bus.emit(EVENTS.COGNITIVE.STARTED, data, meta); }
  emitCircularityDetected(data, meta)  { this._bus.emit(EVENTS.COGNITIVE.CIRCULARITY_DETECTED, data, meta); }
  emitDecisionEvaluated(data, meta)    { this._bus.emit(EVENTS.COGNITIVE.DECISION_EVALUATED, data, meta); }
  emitOverload(data, meta)             { this._bus.emit(EVENTS.COGNITIVE.OVERLOAD, data, meta); }
  emitTokenBudgetWarning(data, meta)   { this._bus.emit(EVENTS.COGNITIVE.TOKEN_BUDGET_WARNING, data, meta); }
  emitServiceDegraded(data, meta)      { this._bus.emit(EVENTS.COGNITIVE.SERVICE_DEGRADED, data, meta); }
  emitServiceDisabled(data, meta)      { this._bus.emit(EVENTS.COGNITIVE.SERVICE_DISABLED, data, meta); }
  onServiceDisabled(handler, opts)     { return this._bus.on(EVENTS.COGNITIVE.SERVICE_DISABLED, handler, opts); }
  emitServiceRecovered(data, meta)     { this._bus.emit(EVENTS.COGNITIVE.SERVICE_RECOVERED, data, meta); }

  // ── Learning ────────────────────────────────────────────
  emitPatternDetected(data, meta)      { this._bus.emit(EVENTS.LEARNING.PATTERN_DETECTED, data, meta); }
  emitFrustrationDetected(data, meta)  { this._bus.emit(EVENTS.LEARNING.FRUSTRATION_DETECTED, data, meta); }
  emitIntentSuggestion(data, meta)     { this._bus.emit(EVENTS.LEARNING.INTENT_SUGGESTION, data, meta); }
  emitPerformanceAlert(data, meta)     { this._bus.emit(EVENTS.LEARNING.PERFORMANCE_ALERT, data, meta); }

  // ── Adaptation ──────────────────────────────────────────
  emitAdaptationProposed(data, meta)   { this._bus.emit(EVENTS.ADAPTATION.PROPOSED, data, meta); }
  emitAdaptationApplied(data, meta)    { this._bus.emit(EVENTS.ADAPTATION.APPLIED, data, meta); }
  emitAdaptationValidated(data, meta)  { this._bus.emit(EVENTS.ADAPTATION.VALIDATED, data, meta); }
  emitAdaptationRolledBack(data, meta) { this._bus.emit(EVENTS.ADAPTATION.ROLLED_BACK, data, meta); }
  emitValidationDeferred(data, meta)   { this._bus.emit(EVENTS.ADAPTATION.VALIDATION_DEFERRED, data, meta); }
  emitCycleComplete(data, meta)        { this._bus.emit(EVENTS.ADAPTATION.CYCLE_COMPLETE, data, meta); }

  // ── Dream ───────────────────────────────────────────────
  emitDreamStarted(data, meta)     { this._bus.emit(EVENTS.DREAM.STARTED, data, meta); }
  emitDreamComplete(data, meta)    { this._bus.emit(EVENTS.DREAM.COMPLETE, data, meta); }
  onDreamComplete(handler, opts)   { return this._bus.on(EVENTS.DREAM.COMPLETE, handler, opts); }

  // ── Expectation ─────────────────────────────────────────
  emitExpectationFormed(data, meta)    { this._bus.emit(EVENTS.EXPECTATION.FORMED, data, meta); }
  emitExpectationCompared(data, meta)  { this._bus.emit(EVENTS.EXPECTATION.COMPARED, data, meta); }
  onExpectationCompared(handler, opts) { return this._bus.on(EVENTS.EXPECTATION.COMPARED, handler, opts); }
  emitExpectationCalibrated(data, meta){ this._bus.emit(EVENTS.EXPECTATION.CALIBRATED, data, meta); }

  // ── Simulation ──────────────────────────────────────────
  emitSimulationStarted(data, meta)  { this._bus.emit(EVENTS.SIMULATION.STARTED, data, meta); }
  emitSimulationBranched(data, meta) { this._bus.emit(EVENTS.SIMULATION.BRANCHED, data, meta); }
  emitSimulationComplete(data, meta) { this._bus.emit(EVENTS.SIMULATION.COMPLETE, data, meta); }

  // ── Surprise ────────────────────────────────────────────
  emitSurpriseProcessed(data, meta)    { this._bus.emit(EVENTS.SURPRISE.PROCESSED, data, meta); }
  onSurpriseProcessed(handler, opts)   { return this._bus.on(EVENTS.SURPRISE.PROCESSED, handler, opts); }
  emitAmplifiedLearning(data, meta)    { this._bus.emit(EVENTS.SURPRISE.AMPLIFIED_LEARNING, data, meta); }
  emitNovelEvent(data, meta)           { this._bus.emit(EVENTS.SURPRISE.NOVEL_EVENT, data, meta); }

  // ── Online Learning ─────────────────────────────────────
  emitStreakDetected(data, meta)        { this._bus.emit(EVENTS.ONLINE_LEARNING.STREAK_DETECTED, data, meta); }
  onStreakDetected(handler, opts)       { return this._bus.on(EVENTS.ONLINE_LEARNING.STREAK_DETECTED, handler, opts); }
  emitEscalationNeeded(data, meta)     { this._bus.emit(EVENTS.ONLINE_LEARNING.ESCALATION_NEEDED, data, meta); }
  onEscalationNeeded(handler, opts)    { return this._bus.on(EVENTS.ONLINE_LEARNING.ESCALATION_NEEDED, handler, opts); }
  emitTempAdjusted(data, meta)         { this._bus.emit(EVENTS.ONLINE_LEARNING.TEMP_ADJUSTED, data, meta); }
  onTempAdjusted(handler, opts)        { return this._bus.on(EVENTS.ONLINE_LEARNING.TEMP_ADJUSTED, handler, opts); }
  emitCalibrationDrift(data, meta)     { this._bus.emit(EVENTS.ONLINE_LEARNING.CALIBRATION_DRIFT, data, meta); }
  emitNoveltyShift(data, meta)         { this._bus.emit(EVENTS.ONLINE_LEARNING.NOVELTY_SHIFT, data, meta); }

  // ── Lessons ─────────────────────────────────────────────
  emitLessonRecorded(data, meta)   { this._bus.emit(EVENTS.LESSONS.RECORDED, data, meta); }
  emitLessonLearned(data, meta)    { this._bus.emit(EVENTS.LESSONS.LEARNED, data, meta); }

  // ── Narrative ───────────────────────────────────────────
  emitNarrativeUpdated(data, meta) { this._bus.emit(EVENTS.NARRATIVE.UPDATED, data, meta); }

  // ── Replay ──────────────────────────────────────────────
  emitReplayStarted(data, meta)            { this._bus.emit(EVENTS.REPLAY.STARTED, data, meta); }
  emitReplayEvent(data, meta)              { this._bus.emit(EVENTS.REPLAY.EVENT, data, meta); }
  emitReplayCompleted(data, meta)          { this._bus.emit(EVENTS.REPLAY.COMPLETED, data, meta); }
  emitReplayRecordingComplete(data, meta)  { this._bus.emit(EVENTS.REPLAY.RECORDING_COMPLETE, data, meta); }

  // ── Task Outcomes ───────────────────────────────────────
  emitTaskOutcomeRecorded(data, meta)  { this._bus.emit(EVENTS.TASK_OUTCOME.RECORDED, data, meta); }
  onTaskOutcomeRecorded(handler, opts) { return this._bus.on(EVENTS.TASK_OUTCOME.RECORDED, handler, opts); }
  emitTaskStatsUpdated(data, meta)     { this._bus.emit(EVENTS.TASK_OUTCOME.STATS_UPDATED, data, meta); }
  onTaskStatsUpdated(handler, opts)    { return this._bus.on(EVENTS.TASK_OUTCOME.STATS_UPDATED, handler, opts); }

  // ── Memory (consolidation emits from cognitive layer) ───
  emitMemoryConsolidated(data, meta)   { this._bus.emit('memory:consolidation-complete', data, meta); }
  emitMemoryConsolidationFailed(data, meta) { this._bus.emit('memory:consolidation-failed', data, meta); }

  // ── Cross-layer subscriptions ───────────────────────────
  onAgentLoopComplete(handler, opts)   { return this._bus.on(EVENTS.AGENT_LOOP.COMPLETE, handler, opts); }
  onChatCompleted(handler, opts)       { return this._bus.on('chat:completed', handler, opts); }
  onShellComplete(handler, opts)       { return this._bus.on('shell:complete', handler, opts); }
  onShellOutcome(handler, opts)        { return this._bus.on('shell:outcome', handler, opts); }
  onToolsError(handler, opts)          { return this._bus.on('tools:error', handler, opts); }
  onSelfModSuccess(handler, opts)      { return this._bus.on('selfmod:success', handler, opts); }
  onPromptEvolutionPromoted(handler, opts) { return this._bus.on('prompt-evolution:promoted', handler, opts); }
  onWorkspaceConsolidate(handler, opts) { return this._bus.on(EVENTS.WORKSPACE.CONSOLIDATE, handler, opts); }
}

module.exports = { CognitiveEvents };
