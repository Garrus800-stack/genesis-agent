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
