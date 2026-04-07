// ============================================================
// GENESIS — AutonomyEvents.js (v7.0.1 — Typed Event Facade)
//
// Typed facade over EventBus for the Autonomy layer.
// Covers: health, idle, network, error.
// ============================================================

'use strict';

const { EVENTS } = require('../core/EventTypes');

class AutonomyEvents {
  /** @param {import('../core/EventBus').EventBus} bus */
  constructor(bus) { this._bus = bus; }

  // ── Health ──────────────────────────────────────────────
  emitHealthStarted(data, meta)          { this._bus.emit(EVENTS.HEALTH.STARTED, data, meta); }
  emitHealthTick(data, meta)             { this._bus.emit(EVENTS.HEALTH.TICK, data, meta); }
  emitHealthMetric(data, meta)           { this._bus.emit(EVENTS.HEALTH.METRIC, data, meta); }
  emitDegradation(data, meta)            { this._bus.emit(EVENTS.HEALTH.DEGRADATION, data, meta); }
  onDegradation(handler, opts)           { return this._bus.on(EVENTS.HEALTH.DEGRADATION, handler, opts); }
  emitMemoryLeak(data, meta)             { this._bus.emit(EVENTS.HEALTH.MEMORY_LEAK, data, meta); }
  emitCircuitForcedOpen(data, meta)      { this._bus.emit(EVENTS.HEALTH.CIRCUIT_FORCED_OPEN, data, meta); }
  emitRecovery(data, meta)               { this._bus.emit(EVENTS.HEALTH.RECOVERY, data, meta); }
  emitRecoveryFailed(data, meta)         { this._bus.emit(EVENTS.HEALTH.RECOVERY_FAILED, data, meta); }
  emitRecoveryExhausted(data, meta)      { this._bus.emit(EVENTS.HEALTH.RECOVERY_EXHAUSTED, data, meta); }

  // ── Idle ────────────────────────────────────────────────
  emitThinking(data, meta)               { this._bus.emit(EVENTS.IDLE.THINKING, data, meta); }
  emitThoughtComplete(data, meta)        { this._bus.emit(EVENTS.IDLE.THOUGHT_COMPLETE, data, meta); }
  emitConsolidateMemory(data, meta)      { this._bus.emit(EVENTS.IDLE.CONSOLIDATE_MEMORY, data, meta); }

  // ── Network ─────────────────────────────────────────────
  emitNetworkStatus(data, meta)          { this._bus.emit(EVENTS.NETWORK.STATUS, data, meta); }
  emitNetworkFailover(data, meta)        { this._bus.emit(EVENTS.NETWORK.FAILOVER, data, meta); }
  emitNetworkRestored(data, meta)        { this._bus.emit(EVENTS.NETWORK.RESTORED, data, meta); }

  // ── Error ───────────────────────────────────────────────
  emitErrorTrend(data, meta)             { this._bus.emit('error:trend', data, meta); }

  // ── Cross-layer subscriptions ───────────────────────────
  onAgentLoopStepComplete(handler, opts) { return this._bus.on(EVENTS.AGENT_LOOP.STEP_COMPLETE, handler, opts); }
  onGoalCompleted(handler, opts)         { return this._bus.on('goal:completed', handler, opts); }
  onDeployRequest(handler, opts)         { return this._bus.on('deploy:request', handler, opts); }
  onLlmCallComplete(handler, opts)       { return this._bus.on('llm:call-complete', handler, opts); }
  onReasoningStep(handler, opts)         { return this._bus.on('reasoning:step', handler, opts); }
  onToolsResult(handler, opts)           { return this._bus.on('tools:result', handler, opts); }
  onCapabilityGap(handler, opts)         { return this._bus.on('learning:capability-gap', handler, opts); }
}

module.exports = { AutonomyEvents };
