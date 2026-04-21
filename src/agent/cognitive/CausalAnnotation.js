// @ts-check
// ============================================================
// GENESIS — CausalAnnotation.js (v7.0.9 — Phase 1)
//
// The causal tracking engine. Observes WorldState deltas after
// each AgentLoop step and writes causal edges into KnowledgeGraph.
//
// Key mechanisms:
//   1. Temporal Isolation: Single tool-call in a delta → "caused" (conf 0.8).
//      Multiple tool-calls → "correlated_with" (conf 0.4).
//   2. Suspicion Score: asymmetry-based promotion. If a tool-call
//      always correlates with failure (never success), promote early.
//   3. Source Tagging: "user-task" vs "self-improvement" for
//      measuring the autonomous learning feedback loop.
//   4. Staleness Hook: major file refactoring (>40% diff) degrades
//      outgoing "caused" edges to "correlated_with".
//
// Integration:
//   AgentLoopSteps → WorldState.snapshot() → step → WorldState.diff()
//     → CausalAnnotation.record(stepId, delta, provenance)
//     → KnowledgeGraph.addEdge(action, effect, relation, confidence)
//
// Consumed by:
//   GraphReasoner.predictEffects(action) — Phase 2
//   GraphReasoner.causalChain(from, to) — Phase 2
//   DreamCycle — decay / pruning
//   Fitness Check #11 — edge count monitoring
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('CausalAnnotation');

// ── Relation types ──────────────────────────────────────
const REL = {
  CAUSED: 'caused',
  CORRELATED: 'correlated_with',
  PREVENTED: 'prevented',
  REQUIRED: 'required',
};

// ── Node types for causal graph ─────────────────────────
const NODE = {
  ACTION: 'causal-action',
  EFFECT: 'causal-effect',
};

// ── Confidence defaults ─────────────────────────────────
const CONF = {
  CAUSED_INITIAL: 0.8,
  CORRELATED_INITIAL: 0.4,
  PROMOTION_THRESHOLD: 0.7,
  SUSPICION_EARLY_PROMO: 1.0,
  SUSPICION_STANDARD_PROMO: 0.8,
  MIN_OBS_STANDARD: 3,
  MIN_OBS_EARLY: 2,
};

const { applySubscriptionHelper } = require('../core/subscription-helper');

class CausalAnnotation {
  /**
   * @param {{ bus?: object, knowledgeGraph?: object, config?: object }} opts
   */
  constructor({ bus, knowledgeGraph, config } = {}) {
    this.bus = bus || NullBus;
    this.kg = knowledgeGraph || null;

    const cfg = config || {};
    this._refactorThreshold = cfg.refactorThreshold ?? 0.4;

    // ── Tracking state ────────────────────────────────
    /** @type {Map<string, { failCount: number, successCount: number, observations: number, lastSeen: number }>} */
    this._suspicion = new Map(); // key: "tool:arg" → suspicion stats

    this._stats = {
      totalRecorded: 0,
      causedEdges: 0,
      correlatedEdges: 0,
      promotions: 0,
      degradations: 0,
      chatOutcomes: 0,
    };

    // v7.1.3: Listen for chat:completed to build causal edges from user interactions.
    // This closes the feedback loop: InferenceEngine can now learn patterns
    // like "code intent → success" or "greeting intent → correlated_with greeting response".
    this._unsubs = [];
    this._sub('chat:completed', (data) => {
      this.recordChatOutcome(data);
    }, { source: 'CausalAnnotation' });
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Record a causal observation from a completed step.
   *
   * @param {{
   *   stepId: string,
   *   toolCalls: Array<{ tool: string, args: object, timestamp: number }>,
   *   delta: { changes: Array<{ field: string, type: string, value?: * }> },
   *   outcome?: 'success' | 'failure',
   *   source: 'user-task' | 'self-improvement',
   * }} observation
   */
  record(observation) {
    if (!this.kg) return;
    if (!observation.delta || !observation.delta.changes || observation.delta.changes.length === 0) return;

    this._stats.totalRecorded++;
    const { stepId, toolCalls, delta, outcome, source } = observation;
    const isIsolated = toolCalls.length === 1;

    for (const change of delta.changes) {
      const effectLabel = `${change.field}:${change.type}`;

      if (isIsolated) {
        // ── Temporal Isolation: single tool-call → "caused" ──
        const tc = toolCalls[0];
        const actionLabel = this._actionLabel(tc);
        this._addCausalEdge(actionLabel, effectLabel, REL.CAUSED, CONF.CAUSED_INITIAL, { stepId, source });
        this._stats.causedEdges++;
      } else {
        // ── Multiple tool-calls → "correlated_with" for each ──
        for (const tc of toolCalls) {
          const actionLabel = this._actionLabel(tc);
          this._addCausalEdge(actionLabel, effectLabel, REL.CORRELATED, CONF.CORRELATED_INITIAL, { stepId, source });
          this._stats.correlatedEdges++;
        }
      }

      // ── Suspicion tracking (for all tool-calls) ──
      if (outcome) {
        for (const tc of toolCalls) {
          this._updateSuspicion(tc, outcome);
        }
      }
    }

    // ── Check for promotions based on suspicion ──
    this._checkPromotions();

    this.bus.emit('causal:recorded', {
      stepId,
      changes: delta.changes.length,
      relation: isIsolated ? REL.CAUSED : REL.CORRELATED,
    }, { source: 'CausalAnnotation' });
  }

  // ════════════════════════════════════════════════════════
  // SUSPICION SCORING
  // ════════════════════════════════════════════════════════

  /** @private */
  _updateSuspicion(toolCall, outcome) {
    const key = this._actionLabel(toolCall);
    let entry = this._suspicion.get(key);
    if (!entry) {
      entry = { failCount: 0, successCount: 0, observations: 0, lastSeen: Date.now() };
      this._suspicion.set(key, entry);
    }
    entry.observations++;
    entry.lastSeen = Date.now();
    if (outcome === 'failure') entry.failCount++;
    else entry.successCount++;
  }

  /** @private Check if any correlated_with edges should be promoted to caused */
  _checkPromotions() {
    if (!this.kg) return;

    for (const [key, stats] of this._suspicion.entries()) {
      const suspicion = stats.failCount / (stats.failCount + stats.successCount || 1);

      // Early promotion: perfect failure correlation with 2+ observations
      const earlyPromo = suspicion >= CONF.SUSPICION_EARLY_PROMO && stats.observations >= CONF.MIN_OBS_EARLY;
      // Standard promotion: high suspicion with 3+ observations
      const standardPromo = suspicion >= CONF.SUSPICION_STANDARD_PROMO && stats.observations >= CONF.MIN_OBS_STANDARD;

      if (earlyPromo || standardPromo) {
        // Find correlated_with edges for this action and promote them
        // This is a graph operation — in the full implementation,
        // GraphStore.promoteEdge() handles this
        this._stats.promotions++;
        _log.info(`[CAUSAL] Promoting ${key} to "caused" (suspicion: ${suspicion.toFixed(2)}, obs: ${stats.observations})`);
        this.bus.emit('causal:promoted', { action: key, suspicion, observations: stats.observations }, { source: 'CausalAnnotation' });
      }
    }
  }

  /**
   * Get suspicion statistics for all tracked tool-calls.
   * @returns {Object<string, { suspicion: number, failCount: number, successCount: number, observations: number }>}
   */
  getSuspicionStats() {
    const result = {};
    for (const [key, stats] of this._suspicion.entries()) {
      const total = stats.failCount + stats.successCount;
      result[key] = {
        ...stats,
        suspicion: total > 0 ? stats.failCount / total : 0,
      };
    }
    return result;
  }

  // ════════════════════════════════════════════════════════
  // STALENESS HOOK
  // ════════════════════════════════════════════════════════

  /**
   * Called when a file has been significantly refactored.
   * Degrades all outgoing "caused" edges involving this file
   * to "correlated_with" with halved confidence.
   *
   * @param {string} filePath - Relative path to the changed file
   * @param {number} diffPct - Fraction of file changed (0.0 - 1.0)
   */
  onFileChange(filePath, diffPct) {
    if (diffPct < this._refactorThreshold) return;
    // In full implementation: GraphStore.degradeEdges()
    // For now: emit event and track stat
    this._stats.degradations++;
    _log.info(`[CAUSAL] Staleness: ${filePath} changed ${(diffPct * 100).toFixed(0)}% — degrading caused edges`);
    this.bus.emit('causal:staleness-triggered', {
      file: filePath,
      diffPct,
      threshold: this._refactorThreshold,
    }, { source: 'CausalAnnotation' });
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  /** @private Create a stable label for a tool-call action */
  _actionLabel(toolCall) {
    const arg = toolCall.args?.path || toolCall.args?.command || JSON.stringify(toolCall.args || {}).slice(0, 60);
    return `${toolCall.tool}(${arg})`;
  }

  /** @private Add an edge to the KnowledgeGraph */
  _addCausalEdge(actionLabel, effectLabel, relation, confidence, meta) {
    if (!this.kg) return null;
    try {
      // Use graph-level API for proper weight control
      const graph = this.kg.graph || this.kg;
      const sourceId = graph.addNode(NODE.ACTION, actionLabel);
      const targetId = graph.addNode(NODE.EFFECT, effectLabel);
      return graph.addEdge(sourceId, targetId, relation, confidence);
    } catch (err) {
      _log.debug(`[CAUSAL] Edge creation failed: ${err.message}`);
      return null;
    }
  }

  // ── v7.1.3: Chat Outcome → Causal Graph Bridge ────────
  // Closes the InferenceEngine feedback loop. Each chat:completed
  // event creates edges: "intent:X → outcome:success/fail".
  // After ~20 chats, InferenceEngine has enough data for
  // transitive-causation and error-propagation rules.
  recordChatOutcome({ intent, success, message }) {
    if (!this.kg || !intent) return;

    const actionLabel = `intent:${intent}`;
    const outcomeLabel = `outcome:${success !== false ? 'success' : 'fail'}`;
    const relation = success !== false ? REL.CAUSED : REL.CORRELATED;
    const confidence = success !== false ? 0.6 : 0.5;

    this._addCausalEdge(actionLabel, outcomeLabel, relation, confidence, {
      source: 'chat',
    });
    this._stats.chatOutcomes++;

    // Track suspicion: does this intent frequently fail?
    const key = `chat:${intent}`;
    const entry = this._suspicion.get(key) || { failCount: 0, successCount: 0, observations: 0, lastSeen: 0 };
    entry.observations++;
    entry.lastSeen = Date.now();
    if (success !== false) entry.successCount++; else entry.failCount++;
    this._suspicion.set(key, entry);
  }

  /** Stop bus listeners (called during shutdown). */
  stop() { this._unsubAll(); }

  /** Get tracking statistics */
  getStats() {
    return {
      ...this._stats,
      suspicionEntries: this._suspicion.size,
    };
  }
}

applySubscriptionHelper(CausalAnnotation);

module.exports = { CausalAnnotation, REL, CONF };
