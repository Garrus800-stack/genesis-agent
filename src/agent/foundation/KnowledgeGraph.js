// @ts-checked-v5.7 — prototype delegation not visible to tsc
// ============================================================
// GENESIS — KnowledgeGraph.js (v2 — Split Architecture)
//
// Application-layer facade over GraphStore. Responsibilities:
//   - Persistence (via StorageService — no direct fs I/O)
//   - Search (keyword + vector hybrid)
//   - Embedding integration
//   - Learning from text
//   - Context building for prompts
//
// GraphStore handles: CRUD, indexes, traversal, analytics
// ============================================================

const { GraphStore } = require('./GraphStore');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('KnowledgeGraph');

class KnowledgeGraph {
  constructor({ bus, storage }) {
    this.bus = bus || NullBus;
    this.storage = storage;
    this.graph = new GraphStore();

    this._embeddings = null;
    this._nodeVectors = new Map();
    this._maxNodeVectors = 2000;

    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
  }

  setEmbeddingService(embeddingService) {
    this._embeddings = embeddingService;
    (/** @type {any} */ (this))._syncNodeVectors().catch(err => _log.debug('[KG] Vector sync failed:', err.message));
  }

  // ── Delegated CRUD ────────────────────────────────────

  addNode(type, label, properties = {}) {
    const id = this.graph.addNode(type, label, properties);
    this._save();
    this.bus.emit('knowledge:node-added', { id, type, label }, { source: 'KnowledgeGraph' });
    return id;
  }

  getNode(id) { return this.graph.getNode(id); }
  findNode(query) { return this.graph.findNode(query); }
  getNodesByType(type) { return this.graph.getNodesByType(type); }

  addEdge(sourceId, targetId, relation, weight = 0.5) {
    const id = this.graph.addEdge(sourceId, targetId, relation, weight);
    this._save();
    return id;
  }

  connect(sourceLabel, relation, targetLabel, sourceType = 'concept', targetType = 'concept') {
    const edgeId = this.graph.connect(sourceLabel, relation, targetLabel, sourceType, targetType);
    this._save();
    return edgeId;
  }

  getEdgesBetween(a, b) { return this.graph.getEdgesBetween(a, b); }
  getNeighbors(nodeId, filter) { return this.graph.getNeighbors(nodeId, filter); }

  removeNode(id) {
    const removed = this.graph.removeNode(id);
    if (removed) this._save();
    return removed;
  }

  /**
   * v2.8.1: Prune stale nodes that were never accessed.
   * Encapsulates direct graph.nodes access — IdleMind and other
   * modules should use this instead of reaching into graph.nodes.
   * @param {number} maxAgeDays - Remove nodes older than this (default: 7)
   * @returns {number} Number of nodes removed
   */
  pruneStale(maxAgeDays = 7) {
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const toRemove = [];
    for (const [id, node] of this.graph.nodes) {
      if (node.accessCount === 0 && (now - node.created) > maxAgeMs) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      this.graph.removeNode(id);
    }
    if (toRemove.length > 0) this._save();
    return toRemove.length;
  }

  // ── Delegated analytics ───────────────────────────────

  traverse(startId, maxDepth) { return this.graph.traverse(startId, maxDepth); }
  findPath(fromId, toId, maxDepth) { return this.graph.findPath(fromId, toId, maxDepth); }
  pageRank(iterations, dampingFactor, topN) { return this.graph.pageRank(iterations, dampingFactor, topN); }
  findBridgeNodes(limit) { return this.graph.findBridgeNodes(limit); }

  // ── Search, Context, Learning, Embeddings → KnowledgeGraphSearch.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  // ── Stats ─────────────────────────────────────────────

  getStats() {
    return { ...this.graph.getStats(), embeddings: { available: !!this._embeddings?.isAvailable(), vectorizedNodes: this._nodeVectors.size } };
  }

  // ── v7.1.4 FEATURE 2: FRONTIER NODE ──────────────────

  /** Ensure the frontier node exists. Called at boot. */
  ensureFrontier() {
    const existing = this.graph.findNode('frontier');
    if (!existing) {
      this.graph.addNode('system', 'frontier', { role: 'focus-anchor', created: Date.now() });
      _log.info('[KG] Frontier node created');
      this._save();
    }
    return this.graph.findNode('frontier');
  }

  /**
   * Get all nodes connected to the frontier within depth edges.
   * @param {number} depth - Traversal depth (default 2)
   * @returns {{ nodes: Array<*>, edges: Array<*> }}
   */
  getFrontierContext(depth = 2) {
    const frontier = this.graph.findNode('frontier');
    if (!frontier) return { nodes: [], edges: [] };

    const visited = new Set();
    const resultNodes = [];
    const resultEdges = [];
    const queue = [{ id: frontier.id, d: 0 }];
    visited.add(frontier.id);

    while (queue.length > 0) {
      const { id, d } = queue.shift();
      const node = this.graph.getNode(id);
      if (node && id !== frontier.id) resultNodes.push(node);

      if (d < depth) {
        const neighbors = this.graph.getNeighbors(id) || [];
        for (const n of neighbors) {
          // GraphStore returns { node, edge, direction } or plain id/object
          const nid = n.node?.id || (typeof n === 'string' ? n : (n.id || n.target || n.source));
          if (nid && !visited.has(nid)) {
            visited.add(nid);
            queue.push({ id: nid, d: d + 1 });
            // Collect edge from neighbor result
            if (n.edge && !resultEdges.some(re => re.id === n.edge.id)) {
              resultEdges.push(n.edge);
            }
          }
        }
      }
    }

    // Sort by weight/confidence descending
    resultEdges.sort((a, b) => (b.weight || 0) - (a.weight || 0));
    return { nodes: resultNodes, edges: resultEdges };
  }

  /**
   * Connect a node to the frontier with a typed relation.
   * @param {string} relation - Edge type (SESSION_COMPLETED, ACTIVE_GOAL, etc.)
   * @param {string} targetLabel - Label of the target node (created if not exists)
   * @param {number} weight - Edge weight/confidence
   * @param {string} targetType - Node type for the target
   * @param {Object} targetProps - Additional properties for the target node
   */
  connectToFrontier(relation, targetLabel, weight = 1.0, targetType = 'session', targetProps = {}) {
    this.ensureFrontier();
    const frontier = this.graph.findNode('frontier');
    if (!frontier) return null;

    // Create or find target node
    let target = this.graph.findNode(targetLabel);
    if (!target) {
      const tid = this.graph.addNode(targetType, targetLabel, { ...targetProps, created: Date.now() });
      target = this.graph.getNode(tid);
    }
    if (!target) return null;

    const edgeId = this.graph.addEdge(frontier.id, target.id, relation, weight);
    this._save();
    return edgeId;
  }

  /**
   * Remove an edge from the frontier to a specific target label.
   * @param {string} targetLabel - Label of the target node
   */
  disconnectFromFrontier(targetLabel) {
    const frontier = this.graph.findNode('frontier');
    const target = this.graph.findNode(targetLabel);
    if (!frontier || !target) return false;

    const edges = this.graph.getEdgesBetween(frontier.id, target.id);
    if (edges && edges.length > 0) {
      for (const e of edges) {
        if (this.graph.edges) this.graph.edges.delete(e.id);
      }
      this._save();
      return true;
    }
    return false;
  }

  /**
   * v7.1.6: Update a frontier node's properties and edge weight atomically.
   * Ensures _save() is called — prevents silent mutation without persistence.
   *
   * @param {object} node     - KG node reference (from getNode)
   * @param {object} merged   - New properties to apply
   * @param {object} edge     - Edge to refresh weight on
   */
  updateFrontierNode(node, merged, edge) {
    Object.assign(node.properties, merged);
    node.properties.last_merged = Date.now();
    node.accessed = Date.now();
    if (edge) edge.weight = Math.min((edge.weight || 0.5) + 0.2, 1.0);
    this._save();
  }

  /**
   * Decay old frontier edges. Called at boot by SessionPersistence.
   * SESSION_COMPLETED edges lose confidence each session.
   * @param {number} factor - Decay multiplier (default 0.5)
   */
  decayFrontierEdges(factor = 0.5) {
    const frontier = this.graph.findNode('frontier');
    if (!frontier || !this.graph.edges) return 0;

    // v7.1.6: Per-type decay factors. Each frontier edge type decays at its
    // own rate. Unfinished work persists longest (0.7), emotions fade fastest (0.5).
    // The `factor` parameter serves as fallback for unknown types.
    const DECAY_FACTORS = {
      'SESSION_COMPLETED':  0.5,
      'EMOTIONAL_IMPRINT':  0.5,
      'UNFINISHED_WORK':    0.7,
      'HIGH_SUSPICION':     0.6,
      'LESSON_APPLIED':     0.6,
    };

    let decayed = 0;
    const toRemove = [];
    for (const [id, edge] of this.graph.edges) {
      if (edge.source !== frontier.id) continue;
      const typeFactor = DECAY_FACTORS[edge.relation];
      if (typeFactor === undefined) {
        // v7.1.6: Warn once per unknown type — catches missing DECAY_FACTORS entries
        if (!this._warnedDecayTypes) this._warnedDecayTypes = new Set();
        if (!this._warnedDecayTypes.has(edge.relation)) {
          _log.debug(`[KG] decayFrontierEdges: unknown type "${edge.relation}" — using fallback factor ${factor}`);
          this._warnedDecayTypes.add(edge.relation);
        }
        edge.weight = (edge.weight || 1) * factor;
        decayed++;
        if (edge.weight < 0.05) toRemove.push(id);
        continue;
      }
      edge.weight = (edge.weight || 1) * typeFactor;
      decayed++;
      if (edge.weight < 0.05) toRemove.push(id);
    }
    for (const id of toRemove) this.graph.edges.delete(id);
    if (decayed > 0) this._save();
    return decayed;
  }

  // ── Persistence ───────────────────────────────────────

  _save() { if (this.storage) this.storage.writeJSONDebounced('knowledge-graph.json', this.graph.serialize()); }
  async flush() { if (this.storage) await this.storage.flush(); }
  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();
    this.ensureFrontier(); // v7.1.4: Guarantee frontier node exists
  }

  _load() {
    if (!this.storage) return;
    const data = this.storage.readJSON('knowledge-graph.json', null);
    if (data) this.graph.deserialize(data);
  }
}

module.exports = { KnowledgeGraph };

// Extracted to KnowledgeGraphSearch.js (v5.6.0) — same pattern
// as IdleMind → IdleMindActivities, DreamCycle → DreamCycleAnalysis.
const { searchMethods } = require('./KnowledgeGraphSearch');
Object.assign(KnowledgeGraph.prototype, searchMethods);
