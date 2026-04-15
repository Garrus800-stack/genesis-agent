// @ts-checked-v5.8
// ============================================================
// GENESIS — GraphReasoner.js (Phase 12 — Symbolic+Neural Hybrid)
//
// PROBLEM: All reasoning goes through the LLM. Questions like
// "What modules depend on EventBus?" or "If I change Container,
// what tests might break?" require traversing the KnowledgeGraph
// — not asking a language model.
//
// SOLUTION: Deterministic graph-based reasoning:
//   - Transitive dependency queries
//   - Impact analysis (change propagation)
//   - Cycle detection
//   - Shortest path between concepts
//   - Pattern matching (subgraph queries)
//   - Contradiction detection
//
// This replaces LLM calls for structural/logical questions
// and augments LLM reasoning for complex questions.
//
// Integration:
//   ReasoningEngine._assessComplexity() → uses GraphReasoner
//   FormalPlanner._typifyStep() → impact analysis before changes
//   PromptBuilder → injects graph context for relevant queries
//   AgentLoop → pre-check dependencies before self-modification
// ============================================================

const { NullBus } = require('../core/EventBus');

class GraphReasoner {
  // NOTE: containerConfig is informational only — this module is registered
  // via the phase manifest, not via ModuleRegistry auto-discovery.
  // Real lateBindings are declared in the manifest entry.
  static containerConfig = {
    name: 'graphReasoner',
    phase: 4,
    deps: ['knowledgeGraph', 'selfModel'],
    tags: ['intelligence', 'reasoning'],
  };

  constructor({ bus, knowledgeGraph, selfModel, config }) {
    this.bus = bus || NullBus;
    this.kg = knowledgeGraph;
    this.selfModel = selfModel || null;

    const cfg = config || {};
    this._maxTraversalDepth = cfg.maxDepth || 10;
    this._maxResults = cfg.maxResults || 50;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      queries: 0,
      impactAnalyses: 0,
      cycles: 0,
      contradictions: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Find all transitive dependencies of a node.
   * "What does X depend on, recursively?"
   *
   * @param {string} label — Node label (e.g., "AgentLoop")
   * @param {string} relation — Edge type to follow (e.g., "depends_on", "imports")
   * @param {object} options — { maxDepth, direction: 'outgoing'|'incoming' }
   * @returns {{ root: string, nodes: Array<{label: string, type: string, depth: number}>, edges: Array<*>, totalDepth: number, error?: string }}
   */
  transitiveDeps(label, relation = 'depends_on', options = {}) {
    this._stats.queries++;
    const maxDepth = options.maxDepth || this._maxTraversalDepth;
    const direction = options.direction || 'outgoing';

    const graph = this.kg?.graph;
    if (!graph) return { root: label, nodes: [], edges: [], totalDepth: 0 };

    const root = graph.findNode(label);
    if (!root) return { root: label, nodes: [], edges: [], totalDepth: 0, error: 'Node not found' };

    const visited = new Set();
    const result = [];
    const edges = [];

    const traverse = (nodeId, depth) => {
      if (depth > maxDepth || visited.has(nodeId)) return;
      visited.add(nodeId);

      const node = graph.getNode(nodeId);
      if (!node) return;

      const connected = direction === 'outgoing'
        ? graph.getEdgesFrom?.(nodeId) || []
        : graph.getEdgesTo?.(nodeId) || [];

      for (const edge of connected) {
        if (relation && edge.relation !== relation) continue;
        const targetId = direction === 'outgoing' ? edge.target : edge.source;
        if (visited.has(targetId)) continue;

        const target = graph.getNode(targetId);
        if (target) {
          result.push({ id: targetId, label: target.label, type: target.type, depth });
          edges.push({ from: node.label, to: target.label, relation: edge.relation, weight: edge.weight });
          traverse(targetId, depth + 1);
        }
      }
    };

    traverse(root.id, 1);

    return {
      root: label,
      nodes: result.slice(0, this._maxResults),
      edges,
      totalDepth: result.length > 0 ? Math.max(...result.map(r => r.depth)) : 0,
    };
  }

  /**
   * Impact analysis: "If I change X, what else is affected?"
   * Follows incoming dependency edges (who depends on X?).
   *
   * @param {string} label — Changed module/concept
   * @param {object} options — { maxDepth, includeTests }
   * @returns {{ changed: string, impacted: Array<{label: string, type: string, depth: number, risk: string, hasTests?: boolean}>, riskScore: number, totalImpacted: number }}
   */
  impactAnalysis(label, options = {}) {
    this._stats.impactAnalyses++;

    // Find everything that depends ON this node (incoming deps)
    const deps = this.transitiveDeps(label, 'depends_on', {
      ...options,
      direction: 'incoming',
    });

    // Compute risk based on depth and count
    const impacted = deps.nodes.map(n => ({
      ...n,
      risk: n.depth === 1 ? 'high' : n.depth === 2 ? 'medium' : 'low',
      /** @type {boolean|undefined} */ hasTests: undefined,
    }));

    // Check SelfModel for test associations
    if (this.selfModel && options.includeTests !== false) {
      const model = this.selfModel.getFullModel?.();
      if (model?.modules) {
        const testModules = Object.entries(model.modules)
          .filter(([, m]) => m.file?.includes('test'))
          .map(([name]) => name);

        for (const imp of impacted) {
          imp.hasTests = testModules.some(t =>
            t.toLowerCase().includes(imp.label.toLowerCase())
          );
        }
      }
    }

    const riskScore = impacted.reduce((sum, n) => {
      return sum + (n.risk === 'high' ? 3 : n.risk === 'medium' ? 2 : 1);
    }, 0) / Math.max(impacted.length, 1);

    this.bus.emit('reasoning:impact-analysis', {
      changed: label,
      impactedCount: impacted.length,
      riskScore: Math.round(riskScore * 100) / 100,
    }, { source: 'GraphReasoner' });

    return {
      changed: label,
      impacted: impacted.slice(0, this._maxResults),
      riskScore: Math.round(riskScore * 100) / 100,
      totalImpacted: deps.nodes.length,
    };
  }

  /**
   * Detect cycles in the dependency graph.
   * Useful for finding circular imports after self-modification.
   *
   * @param {string} relation — Edge type to check
   * @returns {{ hasCycles: boolean, cycles: Array<Array<string>> }}
   */
  detectCycles(relation = 'depends_on') {
    this._stats.queries++;

    const graph = this.kg?.graph;
    if (!graph) return { hasCycles: false, cycles: [] };

    const allNodes = graph.getAllNodes?.() || [];
    const visited = new Set();
    const inStack = new Set();
    const cycles = [];

    const dfs = (nodeId, path) => {
      if (inStack.has(nodeId)) {
        // Found cycle
        const cycleStart = path.indexOf(nodeId);
        const cycle = path.slice(cycleStart).map(id => graph.getNode(id)?.label || id);
        cycle.push(cycle[0]); // Close the cycle
        cycles.push(cycle);
        return;
      }
      if (visited.has(nodeId)) return;

      visited.add(nodeId);
      inStack.add(nodeId);

      const edges = graph.getEdgesFrom?.(nodeId) || [];
      for (const edge of edges) {
        if (relation && edge.relation !== relation) continue;
        dfs(edge.target, [...path, nodeId]);
      }

      inStack.delete(nodeId);
    };

    for (const node of allNodes) {
      if (!visited.has(node.id)) {
        dfs(node.id, []);
      }
    }

    if (cycles.length > 0) this._stats.cycles += cycles.length;

    return { hasCycles: cycles.length > 0, cycles };
  }

  /**
   * Find shortest path between two concepts.
   * Uses BFS — ignores edge direction.
   *
   * @param {string} fromLabel
   * @param {string} toLabel
   * @returns {{ found: boolean, path: string[], distance: number, relations?: string[] }}
   */
  shortestPath(fromLabel, toLabel) {
    this._stats.queries++;

    const graph = this.kg?.graph;
    if (!graph) return { found: false, path: [], distance: -1, relations: [] };

    const from = graph.findNode(fromLabel);
    const to = graph.findNode(toLabel);
    if (!from || !to) return { found: false, path: [], distance: -1, relations: [] };

    // BFS
    const visited = new Set();
    /** @type {Array<{ nodeId: *, path: string[], relations: string[] }>} */
    const queue = [{ nodeId: from.id, path: [fromLabel], relations: [] }];
    visited.add(from.id);

    while (queue.length > 0) {
      const item = /** @type {{ nodeId: *, path: string[], relations: string[] }} */ (queue.shift());
      const { nodeId, path: currentPath, relations } = item;

      if (nodeId === to.id) {
        return { found: true, path: currentPath, distance: currentPath.length - 1, relations };
      }

      if (currentPath.length > this._maxTraversalDepth) continue;

      // Get all connected edges (both directions)
      const outEdges = graph.getEdgesFrom?.(nodeId) || [];
      const inEdges = graph.getEdgesTo?.(nodeId) || [];
      const allEdges = [
        ...outEdges.map(e => ({ target: e.target, relation: e.relation })),
        ...inEdges.map(e => ({ target: e.source, relation: `←${e.relation}` })),
      ];

      for (const edge of allEdges) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target);

        const targetNode = graph.getNode(edge.target);
        if (targetNode) {
          queue.push({
            nodeId: edge.target,
            path: [...currentPath, targetNode.label],
            relations: [...relations, edge.relation],
          });
        }
      }
    }

    return { found: false, path: [], distance: -1, relations: [] };
  }

  /**
   * Find contradictions in the knowledge graph.
   * Checks for conflicting edges (e.g., A is_a B AND A is_not B).
   *
   * @returns {{ contradictions: Array<{node: string, target: string, positive: string, negative: string}> }}
   */
  findContradictions() {
    this._stats.queries++;

    const graph = this.kg?.graph;
    if (!graph) return { contradictions: [] };

    const contradictions = [];
    const negationPairs = [
      ['is_a', 'is_not'],
      ['has', 'lacks'],
      ['depends_on', 'independent_of'],
      ['compatible', 'incompatible'],
    ];

    const allNodes = graph.getAllNodes?.() || [];
    for (const node of allNodes) {
      const outEdges = graph.getEdgesFrom?.(node.id) || [];

      for (const [pos, neg] of negationPairs) {
        const posTargets = outEdges.filter(e => e.relation === pos).map(e => e.target);
        const negTargets = outEdges.filter(e => e.relation === neg).map(e => e.target);

        for (const target of posTargets) {
          if (negTargets.includes(target)) {
            const targetNode = graph.getNode(target);
            contradictions.push({
              node: node.label,
              target: targetNode?.label || target,
              positive: pos,
              negative: neg,
            });
          }
        }
      }
    }

    this._stats.contradictions += contradictions.length;
    return { contradictions };
  }

  /**
   * Answer a structural question deterministically.
   * Returns null if the question can't be answered by graph alone.
   *
   * @param {string} question — Natural language question
   * @returns {{ answered: boolean, result: string, method: string, data?: * } | null}
   */
  tryAnswer(question) {
    const q = question.toLowerCase();

    // "What depends on X?" / "Was hängt von X ab?"
    let match = q.match(/what (?:depends on|uses|imports|requires) ['"]?(\w+)['"]?/i)
      || q.match(/was (?:hängt|haengt) von ['"]?(\w+)['"]? ab/i)
      || q.match(/wer (?:nutzt|braucht|importiert) ['"]?(\w+)['"]?/i);
    if (match) {
      const result = this.transitiveDeps(match[1], 'depends_on', { direction: 'incoming' });
      if (result.nodes.length > 0) {
        return {
          answered: true,
          result: `${result.nodes.length} modules depend on ${match[1]}: ${result.nodes.map(n => n.label).join(', ')}`,
          method: 'graph:transitive-deps',
          data: result,
        };
      }
    }

    // "What does X depend on?"
    match = q.match(/what does ['"]?(\w+)['"]? (?:depend on|use|import|require)/i)
      || q.match(/wovon (?:hängt|haengt) ['"]?(\w+)['"]? ab/i);
    if (match) {
      const result = this.transitiveDeps(match[1], 'depends_on', { direction: 'outgoing' });
      if (result.nodes.length > 0) {
        return {
          answered: true,
          result: `${match[1]} depends on ${result.nodes.length} modules: ${result.nodes.map(n => n.label).join(', ')}`,
          method: 'graph:transitive-deps',
          data: result,
        };
      }
    }

    // "If I change X, what breaks?"
    match = q.match(/(?:if i change|impact of changing|was passiert wenn ich) ['"]?(\w+)['"]?/i);
    if (match) {
      const result = this.impactAnalysis(match[1]);
      if (result.impacted.length > 0) {
        const highRisk = result.impacted.filter(n => n.risk === 'high');
        return {
          answered: true,
          result: `Changing ${match[1]} impacts ${result.totalImpacted} modules (${highRisk.length} high-risk). Risk score: ${result.riskScore}`,
          method: 'graph:impact-analysis',
          data: result,
        };
      }
    }

    // "Are there circular dependencies?"
    if (/circular|zirkul|cycle|kreislauf/i.test(q)) {
      const result = this.detectCycles();
      return {
        answered: true,
        result: result.hasCycles
          ? `Found ${result.cycles.length} cycles: ${result.cycles.map(c => c.join(' → ')).join('; ')}`
          : 'No circular dependencies detected.',
        method: 'graph:cycle-detection',
        data: result,
      };
    }

    return null; // Can't answer → fall through to LLM
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // CAUSAL REASONING (v7.0.9 Phase 1)
  // ════════════════════════════════════════════════════════

  /**
   * Find the causal chain from an action to an effect.
   * Only follows "caused" edges (not "correlated_with").
   * @param {string} fromLabel - Action label
   * @param {string} toLabel - Effect label
   * @param {{ maxDepth?: number, minConfidence?: number }} [options]
   * @returns {{ found: boolean, chain: Array<{ node: string, relation: string, weight: number }>, depth: number }}
   */
  causalChain(fromLabel, toLabel, options = {}) {
    const maxDepth = options.maxDepth || 6;
    const minConf = options.minConfidence || 0.3;
    const graph = this.kg?.graph || this.kg;
    if (!graph) return { found: false, chain: [], depth: 0 };

    const fromNode = graph.findNode(fromLabel);
    const toNode = graph.findNode(toLabel);
    if (!fromNode || !toNode) return { found: false, chain: [], depth: 0 };

    // BFS for shortest causal path
    const queue = [{ id: fromNode.id, chain: [], depth: 0 }];
    const visited = new Set([fromNode.id]);

    while (queue.length > 0) {
      const { id, chain, depth } = queue.shift();
      if (depth > maxDepth) continue;

      const neighbors = graph.getNeighbors(id, 'caused');
      for (const neighbor of neighbors) {
        if (neighbor.edge.weight < minConf) continue;
        const targetId = neighbor.edge.source === id ? neighbor.edge.target : neighbor.edge.source;
        const newChain = [...chain, {
          node: neighbor.node.label,
          relation: 'caused',
          weight: neighbor.edge.weight,
        }];

        if (targetId === toNode.id) {
          this._stats.causalChains = (this._stats.causalChains || 0) + 1;
          return { found: true, chain: newChain, depth: depth + 1 };
        }

        if (!visited.has(targetId)) {
          visited.add(targetId);
          queue.push({ id: targetId, chain: newChain, depth: depth + 1 });
        }
      }
    }

    return { found: false, chain: [], depth: 0 };
  }

  /**
   * Predict the effects of a planned action based on historical causal edges.
   * Looks at all outgoing "caused" edges from the action node.
   * @param {string} actionLabel - The action being planned
   * @param {{ minConfidence?: number, source?: string }} [options]
   * @returns {Array<{ effect: string, confidence: number, occurrences: number }>}
   */
  predictEffects(actionLabel, options = {}) {
    const minConf = options.minConfidence || 0.3;
    const graph = this.kg?.graph || this.kg;
    if (!graph) return [];

    const actionNode = graph.findNode(actionLabel);
    if (!actionNode) return [];

    const neighbors = graph.getNeighbors(actionNode.id, 'caused');
    const effects = [];

    for (const neighbor of neighbors) {
      // Only outgoing edges (action → effect)
      if (neighbor.edge.source !== actionNode.id) continue;
      if (neighbor.edge.weight < minConf) continue;

      effects.push({
        effect: neighbor.node.label,
        confidence: neighbor.edge.weight,
        occurrences: neighbor.node.accessCount || 1,
      });
    }

    this._stats.predictions = (this._stats.predictions || 0) + 1;
    return effects.sort((a, b) => b.confidence - a.confidence);
  }
}

module.exports = { GraphReasoner };
