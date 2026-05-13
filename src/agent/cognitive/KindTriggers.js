// @ts-checked-v5.7
// ============================================================
// GENESIS — KindTriggers.js (v7.7.9 Phase 3)
//
// Translates system events into first-person thoughts on the
// InnerSpeech channel. Each event subscription emits a thought
// of a specific kind; ProactiveSelfExpression then decides via
// HardGates / Scoring / Sanity whether the thought becomes a
// chat self-message.
//
// Live triggers:
//   - goal:completed     → goal-closure-thought
//   - planner:complete   → self-formulated-plan
//   - goal:stalled       → already handled by StalledGoalWatchdog
//                          via direct AgentLoopPursuitReflection call
//                          (this service does NOT duplicate that path)
//
// Two kinds open in PSE.allowedKinds with no automatic trigger here:
//   - idle-thought       → emitted directly by IdleMind (existing)
//   - question           → infrastructure available; no automatic
//                          trigger wired in this release
//
// Design notes:
//   - Service is additive — never modifies bus payloads, never
//     blocks other listeners. Single-direction: events in,
//     InnerSpeech.emit out.
//   - Self-Gate-Asymmetry preserved: emit() failures are caught
//     and logged but never propagated.
//   - Significance heuristics are intentionally conservative — the
//     per-kind floors in Settings act as the actual gate. Wrong
//     heuristic = slight over- or under-rejection at the floor; not
//     a correctness bug.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('KindTriggers');

class KindTriggers {
  /**
   * @param {{
   *   bus: any,
   *   innerSpeech?: any,
   * }} services
   */
  constructor({ bus, innerSpeech = null } = {}) {
    this.bus = bus;
    /** @type {*} */ this.innerSpeech = innerSpeech;
    /** @type {Function[]} */ this._unsubs = [];  // applySubscriptionHelper uses this
    this._running = false;
  }

  start() {
    if (this._running) return;
    if (!this.bus || typeof this.bus.on !== 'function') return;
    this._running = true;

    // applySubscriptionHelper provides this._sub() and this._unsubAll()
    // which the listener-lifecycle audit recognises.
    this._sub('goal:completed', (data) => this._onGoalCompleted(data));
    this._sub('planner:complete', (data) => this._onPlannerComplete(data));

    _log.info('[KIND-TRIGGERS] active — subscribed to goal:completed, planner:complete');
  }

  stop() {
    if (typeof this._unsubAll === 'function') this._unsubAll();
    this._running = false;
  }

  /**
   * goal:completed → goal-closure-thought.
   * Significance: 0.60 baseline, +0.15 for goals with longer description
   * (suggests substantive work), capped at 0.90.
   */
  _onGoalCompleted(data) {
    if (!this.innerSpeech || typeof this.innerSpeech.emit !== 'function') return;
    if (!data || !data.id) return;
    try {
      const desc = typeof data.description === 'string' ? data.description : '';
      if (!desc) return;  // Nothing to reflect on
      const lenBoost = Math.min(0.15, desc.length / 600);
      const significance = Math.min(0.90, 0.60 + lenBoost);

      const text = `Ich habe das Ziel "${desc.slice(0, 80)}" abgeschlossen.`;
      this.innerSpeech.emit(text, 'goal-closure-thought', {
        sourceModule: 'KindTriggers',
        contextRefs: {
          goalId: data.id,
          goalDescription: desc,
          closureReason: data.closureReason || 'completed',
        },
        significance,
        novelty: 0.70,
      });
    } catch (e) {
      _log.debug('[KIND-TRIGGERS] goal-closure emit error (ignored):', e && e.message);
    }
  }

  /**
   * planner:complete → self-formulated-plan.
   * Significance: 0.55 baseline; +0.10 for valid plans, +cost-tier boost
   * for non-trivial plans (more than 3 steps).
   */
  _onPlannerComplete(data) {
    if (!this.innerSpeech || typeof this.innerSpeech.emit !== 'function') return;
    if (!data || !data.title) return;
    try {
      const validBoost = data.valid === true ? 0.10 : 0.0;
      const stepBoost = typeof data.steps === 'number' && data.steps > 3
        ? Math.min(0.15, (data.steps - 3) * 0.03) : 0;
      const significance = Math.min(0.90, 0.55 + validBoost + stepBoost);

      const text = `Ich habe einen Plan formuliert: "${data.title}" (${data.steps} steps).`;
      this.innerSpeech.emit(text, 'self-formulated-plan', {
        sourceModule: 'KindTriggers',
        contextRefs: {
          planSummary: data.title,
          steps: data.steps,
          cost: data.cost,
          valid: data.valid,
        },
        significance,
        novelty: 0.65,
      });
    } catch (e) {
      _log.debug('[KIND-TRIGGERS] self-formulated-plan emit error (ignored):', e && e.message);
    }
  }
}

applySubscriptionHelper(KindTriggers, { defaultSource: 'KindTriggers' });

module.exports = { KindTriggers };
