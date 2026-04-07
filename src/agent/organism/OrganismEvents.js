// ============================================================
// GENESIS — OrganismEvents.js (v7.0.1 — Typed Event Facade)
//
// Typed facade over EventBus for the Organism layer.
// Modules call e.g. `this.events.emitMoodShift(data)` instead
// of `this.bus.emit('emotion:shift', data)`.
//
// Benefits:
//   - Event string typos become ReferenceErrors (caught immediately)
//   - IDE autocomplete on every emit/subscribe
//   - Renaming an event = 1 file change, not N
//   - Reduces direct EventBus imports across the organism layer
// ============================================================

'use strict';

const { EVENTS } = require('../core/EventTypes');

/** @typedef {import('../core/EventBus').EventBus} EventBus */

class OrganismEvents {
  /** @param {EventBus} bus */
  constructor(bus) { this._bus = bus; }

  // ── Emotion ─────────────────────────────────────────────
  emitMoodShift(data, meta)       { this._bus.emit(EVENTS.EMOTION.SHIFT, data, meta); }
  onMoodShift(handler, opts)      { return this._bus.on(EVENTS.EMOTION.SHIFT, handler, opts); }
  emitWatchdogReset(data, meta)   { this._bus.emit(EVENTS.EMOTION.WATCHDOG_RESET, data, meta); }
  emitWatchdogAlert(data, meta)   { this._bus.emit(EVENTS.EMOTION.WATCHDOG_ALERT, data, meta); }

  // ── Homeostasis ─────────────────────────────────────────
  emitStateChange(data, meta)       { this._bus.emit(EVENTS.HOMEOSTASIS.STATE_CHANGE, data, meta); }
  onStateChange(handler, opts)      { return this._bus.on(EVENTS.HOMEOSTASIS.STATE_CHANGE, handler, opts); }
  emitCritical(data, meta)          { this._bus.emit(EVENTS.HOMEOSTASIS.CRITICAL, data, meta); }
  emitRecovering(data, meta)        { this._bus.emit(EVENTS.HOMEOSTASIS.RECOVERING, data, meta); }
  emitPauseAutonomy(data, meta)     { this._bus.emit(EVENTS.HOMEOSTASIS.PAUSE_AUTONOMY, data, meta); }
  emitThrottle(data, meta)          { this._bus.emit(EVENTS.HOMEOSTASIS.THROTTLE, data, meta); }
  onThrottle(handler, opts)         { return this._bus.on(EVENTS.HOMEOSTASIS.THROTTLE, handler, opts); }
  emitReduceLoad(data, meta)        { this._bus.emit(EVENTS.HOMEOSTASIS.REDUCE_LOAD, data, meta); }
  emitReduceContext(data, meta)     { this._bus.emit(EVENTS.HOMEOSTASIS.REDUCE_CONTEXT, data, meta); }
  emitPruneCaches(data, meta)       { this._bus.emit(EVENTS.HOMEOSTASIS.PRUNE_CACHES, data, meta); }
  emitPruneKnowledge(data, meta)    { this._bus.emit(EVENTS.HOMEOSTASIS.PRUNE_KNOWLEDGE, data, meta); }
  onPruneKnowledge(handler, opts)   { return this._bus.on(EVENTS.HOMEOSTASIS.PRUNE_KNOWLEDGE, handler, opts); }
  emitCorrectionApplied(data, meta) { this._bus.emit(EVENTS.HOMEOSTASIS.CORRECTION_APPLIED, data, meta); }
  emitCorrectionLifted(data, meta)  { this._bus.emit(EVENTS.HOMEOSTASIS.CORRECTION_LIFTED, data, meta); }
  emitSimplifiedMode(data, meta)    { this._bus.emit(EVENTS.HOMEOSTASIS.SIMPLIFIED_MODE, data, meta); }
  emitAllostasis(data, meta)        { this._bus.emit(EVENTS.HOMEOSTASIS.ALLOSTASIS, data, meta); }

  // ── Immune ──────────────────────────────────────────────
  emitIntervention(data, meta)    { this._bus.emit(EVENTS.IMMUNE.INTERVENTION, data, meta); }
  emitQuarantine(data, meta)      { this._bus.emit(EVENTS.IMMUNE.QUARANTINE, data, meta); }

  // ── Metabolism ──────────────────────────────────────────
  emitCost(data, meta)            { this._bus.emit(EVENTS.METABOLISM.COST, data, meta); }
  emitConsumed(data, meta)        { this._bus.emit(EVENTS.METABOLISM_EXT.CONSUMED, data, meta); }
  emitInsufficient(data, meta)    { this._bus.emit(EVENTS.METABOLISM_EXT.INSUFFICIENT, data, meta); }
  emitEnergyStateChanged(data, meta) { this._bus.emit(EVENTS.METABOLISM_EXT.STATE_CHANGED, data, meta); }

  // ── Needs ───────────────────────────────────────────────
  emitHighDrive(data, meta)       { this._bus.emit(EVENTS.NEEDS.HIGH_DRIVE, data, meta); }
  emitSatisfied(data, meta)       { this._bus.emit(EVENTS.NEEDS.SATISFIED, data, meta); }

  // ── Embodied Perception ─────────────────────────────────
  emitPanelChanged(data, meta)      { this._bus.emit(EVENTS.EMBODIED.PANEL_CHANGED, data, meta); }
  emitFocusChanged(data, meta)      { this._bus.emit(EVENTS.EMBODIED.FOCUS_CHANGED, data, meta); }
  emitEngagementChanged(data, meta) { this._bus.emit(EVENTS.EMBODIED.ENGAGEMENT_CHANGED, data, meta); }

  // ── Genome ──────────────────────────────────────────────
  emitGenomeLoaded(data, meta)      { this._bus.emit(EVENTS.GENOME.LOADED, data, meta); }
  emitTraitAdjusted(data, meta)     { this._bus.emit(EVENTS.GENOME.TRAIT_ADJUSTED, data, meta); }
  emitReproduced(data, meta)        { this._bus.emit(EVENTS.GENOME.REPRODUCED, data, meta); }

  // ── Cross-layer subscriptions (events FROM other layers) ──
  onChatCompleted(handler, opts)    { return this._bus.on('chat:completed', handler, opts); }
  onChatError(handler, opts)        { return this._bus.on('chat:error', handler, opts); }
  onUserMessage(handler, opts)      { return this._bus.on('user:message', handler, opts); }
  onUIHeartbeat(handler, opts)      { return this._bus.on('ui:heartbeat', handler, opts); }
  onCircuitStateChange(handler, opts) { return this._bus.on('circuit:state-change', handler, opts); }
  onKnowledgeNodeAdded(handler, opts) { return this._bus.on('knowledge:node-added', handler, opts); }

  /** Wildcard subscribe — for monitors that need all organism events */
  onAny(prefix, handler, opts)    { return this._bus.on(prefix + '*', handler, opts); }
}

module.exports = { OrganismEvents };
