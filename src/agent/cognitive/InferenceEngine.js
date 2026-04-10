// @ts-check
// ============================================================
// GENESIS — InferenceEngine.js (v7.0.9 — Phase 2)
//
// Rule-based deterministic inference on the KnowledgeGraph.
// No LLM calls — pure graph traversal with configurable rules.
//
// Two rule types:
//   hardcoded: Starter-set, logically provable, fire immediately.
//   learned:   Discovered from patterns, require minObservations
//              confirmations before activation.
//
// Rule index: Map<relationType, Rule[]> for O(1) lookup.
// Rule cap: 200 active rules max.
// Auto-deactivation: rules with hitCount=0 after 30 days.
//
// Integration:
//   GraphReasoner.tryAnswer() → InferenceEngine.infer() first
//   SymbolicResolver → INFERRED level (conf >0.7, no LLM)
//   ReasoningEngine → "deterministic-inferred" strategy
//
// Consumed by:
//   Phase 3: PatternMatcher activates "success-transfer" rule
//   Phase 4: GoalSynthesizer.causalChain() via GraphReasoner
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('InferenceEngine');

const MAX_RULES = 200;
const AUTO_DEACTIVATE_DAYS = 30;

// ── Contradiction pairs ─────────────────────────────────
const CONTRADICTIONS = [
  ['caused', 'prevented'],
];

class InferenceEngine {
  static containerConfig = {
    name: 'inferenceEngine',
    phase: 9,
    deps: [],
    tags: ['cognitive', 'reasoning', 'inference'],
    lateBindings: [
      { prop: 'graph', service: 'knowledgeGraph', optional: true },
    ],
  };

  /**
   * @param {{ bus?: object, graph?: object, config?: object }} opts
   */
  constructor({ bus, graph, config } = {}) {
    this.bus = bus || NullBus;
    /** @type {*} */ this.graph = graph || null;

    const cfg = config || {};
    this._maxRules = cfg.maxRules || MAX_RULES;
    this._minConfidence = cfg.minConfidence || 0.7;

    // ── Rule storage ──────────────────────────────────
    /** @type {Map<string, object>} id → rule */
    this._rules = new Map();
    /** @type {Map<string, Array<string>>} relationType → [ruleId] */
    this._ruleIndex = new Map();
    /** @type {Map<string, { observations: number, lastHit: number | null, hitCount: number }>} */
    this._ruleStats = new Map();

    this._stats = { evaluations: 0, inferences: 0 };

    // Load starter rules
    this._loadStarterRules();
  }

  // ════════════════════════════════════════════════════════
  // STARTER RULES (hardcoded, fire immediately)
  // ════════════════════════════════════════════════════════

  /** @private */
  _loadStarterRules() {
    const starters = [
      {
        id: 'transitive-causation',
        type: 'hardcoded',
        minObservations: 0,
        antecedent: [
          { from: '?A', to: '?B', relation: 'caused' },
          { from: '?B', to: '?C', relation: 'caused' },
        ],
        consequent: { from: '?A', to: '?C', relation: 'caused', confidence: 0.7 },
        description: 'Transitive causation: A→B→C ⟹ A→C',
      },
      {
        id: 'error-propagation',
        type: 'hardcoded',
        minObservations: 0,
        antecedent: [
          { from: '?A', to: '?B', relation: 'caused' },
          { from: '?B', to: '?C', relation: 'depends_on' },
        ],
        consequent: { from: '?A', to: '?C', relation: 'may_break', confidence: 0.6 },
        description: 'Error propagation: A caused error in B, C depends on B → A may break C',
      },
      {
        id: 'resource-conflict',
        type: 'hardcoded',
        minObservations: 0,
        antecedent: [
          { from: '?A', to: '?R', relation: 'requires' },
          { from: '?B', to: '?R', relation: 'requires' },
        ],
        consequent: { from: '?A', to: '?B', relation: 'may_conflict', confidence: 0.9 },
        description: 'Resource conflict: A and B both require R',
      },
      {
        id: 'correlation-promotion',
        type: 'hardcoded',
        minObservations: 0,
        antecedent: [
          { from: '?A', to: '?B', relation: 'correlated_with' },
        ],
        consequent: { from: '?A', to: '?B', relation: 'caused', confidence: 0.6 },
        description: 'Promotion: correlated_with with sufficient observations → caused',
        // Special: only fires when edge weight > 0.6 (high suspicion)
        condition: (edge) => edge.weight > 0.6,
      },
      {
        id: 'repair-pattern',
        type: 'hardcoded',
        minObservations: 0,
        antecedent: [
          { from: '?E', to: '?A', relation: 'repaired_by' },
        ],
        consequent: { from: '?E', to: '?A', relation: 'auto_suggest', confidence: 0.8 },
        description: 'Repair pattern: error E repaired by action A → auto-suggest A',
        applicableWhen: [],
      },
      // Phase 3 rule — deferred until PatternMatcher available
      // {
      //   id: 'success-transfer',
      //   type: 'learned',
      //   minObservations: 5,
      //   antecedent: [
      //     { from: '?S', to: '?T1', relation: 'caused_success' },
      //     { from: '?T1', to: '?T2', relation: 'similar_to' },
      //   ],
      //   consequent: { from: '?S', to: '?T2', relation: 'may_help', confidence: 0.5 },
      //   description: 'Success transfer: strategy S helped T1, T2 similar to T1 → S may help T2',
      // },
    ];

    for (const rule of starters) {
      this.addRule(rule);
    }
  }

  // ════════════════════════════════════════════════════════
  // RULE MANAGEMENT
  // ════════════════════════════════════════════════════════

  /**
   * Add a rule to the engine.
   * @param {object} rule - { id, type, minObservations, antecedent, consequent, description?, applicableWhen?, condition? }
   * @returns {boolean}
   */
  addRule(rule) {
    if (this._rules.size >= this._maxRules) {
      _log.warn(`[INFERENCE] Rule cap reached (${this._maxRules}). Cannot add "${rule.id}".`);
      return false;
    }

    this._rules.set(rule.id, rule);

    // Index by primary relation type (first antecedent's relation)
    const primaryRelation = rule.antecedent?.[0]?.relation || 'unknown';
    if (!this._ruleIndex.has(primaryRelation)) {
      this._ruleIndex.set(primaryRelation, []);
    }
    this._ruleIndex.get(primaryRelation).push(rule.id);

    // Init stats
    if (!this._ruleStats.has(rule.id)) {
      this._ruleStats.set(rule.id, {
        observations: rule.type === 'hardcoded' ? Infinity : 0,
        lastHit: null,
        hitCount: 0,
      });
    }

    return true;
  }

  /**
   * Record an observation that supports a learned rule.
   * @param {string} ruleId
   */
  recordRuleObservation(ruleId) {
    const stats = this._ruleStats.get(ruleId);
    if (!stats) return;
    if (stats.observations !== Infinity) stats.observations++;
  }

  /**
   * Get stats for a specific rule.
   * @param {string} ruleId
   * @returns {{ observations: number, hitCount: number, status: string } | null}
   */
  getRuleStats(ruleId) {
    const rule = this._rules.get(ruleId);
    const stats = this._ruleStats.get(ruleId);
    if (!rule || !stats) return null;

    const minObs = rule.minObservations || 0;
    const isActive = rule.type === 'hardcoded' || stats.observations >= minObs;

    return {
      observations: stats.observations === Infinity ? -1 : stats.observations,
      hitCount: stats.hitCount,
      status: isActive ? 'active' : 'candidate',
    };
  }

  // ════════════════════════════════════════════════════════
  // INFERENCE
  // ════════════════════════════════════════════════════════

  /**
   * Run inference for a query.
   * @param {{ from?: string, to?: string, relation?: string }} query
   * @returns {Array<{ source: string, target: string, relation: string, confidence: number, rule: string }>}
   */
  infer(query) {
    const gs = this._getGraphStore();
    if (!gs) return [];

    const results = [];
    const relation = query.relation || 'caused';

    // Get rules indexed under this relation type
    const ruleIds = this._ruleIndex.get(relation) || [];

    for (const ruleId of ruleIds) {
      const rule = this._rules.get(ruleId);
      if (!rule) continue;

      // Check if rule is active
      const stats = this._ruleStats.get(ruleId);
      if (rule.type === 'learned' && stats && stats.observations < (rule.minObservations || 5)) {
        continue; // Candidate, not yet active
      }

      this._stats.evaluations++;

      // Evaluate rule against graph
      const matches = this._evaluateRule(rule, query, gs);
      for (const match of matches) {
        results.push({
          ...match,
          rule: ruleId,
        });
        stats.hitCount++;
        stats.lastHit = Date.now();
        this._stats.inferences++;
      }
    }

    // Also run transitive inference for multi-hop queries
    if (query.from && relation === 'caused') {
      const transitiveResults = this._transitiveInfer(query.from, gs);
      for (const tr of transitiveResults) {
        if (!results.find(r => r.target === tr.target)) {
          results.push(tr);
        }
      }
    }

    return results;
  }

  /** @private Evaluate a single rule against the graph */
  _evaluateRule(rule, query, gs) {
    const results = [];

    if (!query.from) return results;

    const fromNode = gs.findNode(query.from);
    if (!fromNode) return results;

    // For single-antecedent rules: check direct neighbors
    const neighbors = gs.getNeighbors(fromNode.id, rule.antecedent[0]?.relation);

    for (const neighbor of neighbors) {
      // Check condition if present
      if (rule.condition && !rule.condition(neighbor.edge)) continue;

      // Only outgoing edges
      if (neighbor.edge.source !== fromNode.id) continue;

      if (rule.antecedent.length === 1) {
        // Single-antecedent: direct match
        results.push({
          source: query.from,
          target: neighbor.node.label,
          relation: rule.consequent.relation,
          confidence: Math.min(neighbor.edge.weight, rule.consequent.confidence),
        });
      } else if (rule.antecedent.length === 2) {
        // Two-antecedent: check second hop
        const secondRelation = rule.antecedent[1].relation;
        const secondNeighbors = gs.getNeighbors(neighbor.node.id, secondRelation);
        for (const n2 of secondNeighbors) {
          if (n2.edge.source !== neighbor.node.id) continue;
          results.push({
            source: query.from,
            target: n2.node.label,
            relation: rule.consequent.relation,
            confidence: Math.min(neighbor.edge.weight, n2.edge.weight, rule.consequent.confidence),
          });
        }
      }
    }

    return results;
  }

  /** @private Transitive causal inference: follow caused chains */
  _transitiveInfer(fromLabel, gs) {
    const results = [];
    const fromNode = gs.findNode(fromLabel);
    if (!fromNode) return results;

    const visited = new Set([fromNode.id]);
    const queue = [{ id: fromNode.id, depth: 0, conf: 1.0 }];

    while (queue.length > 0) {
      const { id, depth, conf } = queue.shift();
      if (depth > 4) continue; // Max transitive depth

      const neighbors = gs.getNeighbors(id, 'caused');
      for (const n of neighbors) {
        if (n.edge.source !== id) continue;
        const targetId = n.edge.target;
        if (visited.has(targetId)) continue;
        visited.add(targetId);

        const combinedConf = conf * n.edge.weight;
        if (combinedConf < 0.2) continue; // Too weak

        if (depth > 0) { // Skip direct (depth=0 is the first hop, already in direct results)
          results.push({
            source: fromLabel,
            target: n.node.label,
            relation: 'caused',
            confidence: Math.round(combinedConf * 100) / 100,
            rule: 'transitive-causation',
          });
        }

        queue.push({ id: targetId, depth: depth + 1, conf: combinedConf });
      }
    }

    return results;
  }

  // ════════════════════════════════════════════════════════
  // CONTRADICTION DETECTION
  // ════════════════════════════════════════════════════════

  /**
   * Find contradictory edges in the graph.
   * E.g. A "caused" B and A "prevented" B simultaneously.
   * @returns {Array<{ nodeA: string, nodeB: string, relations: string[], weights: number[] }>}
   */
  findContradictions() {
    const gs = this._getGraphStore();
    if (!gs) return [];

    const contradictions = [];

    for (const [relA, relB] of CONTRADICTIONS) {
      const edgesA = gs.getEdgesByRelation(relA);
      const edgesB = gs.getEdgesByRelation(relB);

      for (const ea of edgesA) {
        for (const eb of edgesB) {
          if (ea.source === eb.source && ea.target === eb.target) {
            contradictions.push({
              nodeA: gs.nodes.get(ea.source)?.label || ea.source,
              nodeB: gs.nodes.get(ea.target)?.label || ea.target,
              relations: [relA, relB],
              weights: [ea.weight, eb.weight],
            });
          }
        }
      }
    }

    if (contradictions.length > 0) {
      this.bus.emit('inference:contradictions-found', {
        count: contradictions.length,
      }, { source: 'InferenceEngine' });
    }

    return contradictions;
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  /** @private Get the underlying GraphStore */
  _getGraphStore() {
    if (!this.graph) return null;
    return this.graph.graph || this.graph;
  }

  /** Get engine statistics */
  getStats() {
    return {
      ruleCount: this._rules.size,
      indexSize: this._ruleIndex.size,
      evaluations: this._stats.evaluations,
      inferences: this._stats.inferences,
    };
  }
}

module.exports = { InferenceEngine };
