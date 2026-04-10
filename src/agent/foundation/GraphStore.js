// @ts-checked-v5.7
// ============================================================
// GENESIS — GraphStore.js
//
// Pure in-memory graph data structure. Zero I/O, zero side
// effects. Extracted from KnowledgeGraph to separate:
//   GraphStore  = data structure (CRUD, traversal, analytics)
//   KnowledgeGraph = application layer (persistence, search,
//                    embeddings, learning)
//
// This class is independently testable with no mocks needed.
// ============================================================

class GraphStore {
  constructor() {
    this.nodes = new Map();      // id → { id, type, label, properties, created, accessed, accessCount }
    this.edges = new Map();      // id → { id, source, target, relation, weight, created }
    this.typeIndex = new Map();  // type → Set<nodeId>
    this.labelIndex = new Map(); // lowercase label → nodeId (for search/lookup)
    // FIX v3.5.3: Type-aware dedup index — prevents collision between
    // e.g. ('concept', 'REST API') and ('file', 'rest api')
    this._dedupeIndex = new Map(); // "type::label" → nodeId
    this.neighborIndex = new Map(); // nodeId → Set<edgeId>
  }

  // ── Node CRUD ─────────────────────────────────────────

  addNode(type, label, properties = {}) {
    const normalizedLabel = label.toLowerCase().trim();
    // FIX v3.5.3: Type-aware dedup key — same label in different types creates separate nodes
    const dedupeKey = `${type}::${normalizedLabel}`;
    const existing = this._dedupeIndex.get(dedupeKey);

    if (existing) {
      const node = this.nodes.get(existing);
      node.properties = { ...node.properties, ...properties };
      node.accessed = Date.now();
      node.accessCount = (node.accessCount || 0) + 1;
      return existing;
    }

    const id = `n_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const node = { id, type, label, properties, created: Date.now(), accessed: Date.now(), accessCount: 0 };

    this.nodes.set(id, node);
    this._dedupeIndex.set(dedupeKey, id);
    this.labelIndex.set(normalizedLabel, id); // Keep for search/lookup (last-write-wins is fine for search)
    if (!this.typeIndex.has(type)) this.typeIndex.set(type, new Set());
    this.typeIndex.get(type).add(id);

    return id;
  }

  getNode(id) {
    const node = this.nodes.get(id);
    if (node) { node.accessed = Date.now(); node.accessCount++; }
    return node || null;
  }

  findNode(query) {
    const lower = query.toLowerCase().trim();
    const exact = this.labelIndex.get(lower);
    if (exact) return this.nodes.get(exact);
    for (const [label, id] of this.labelIndex) {
      if (label.includes(lower) || lower.includes(label)) return this.nodes.get(id);
    }
    return null;
  }

  removeNode(id) {
    const node = this.nodes.get(id);
    if (!node) return false;
    // Remove all edges connected to this node
    const edgeIds = this.neighborIndex.get(id) || new Set();
    for (const eid of edgeIds) {
      const edge = this.edges.get(eid);
      if (edge) {
        const otherId = edge.source === id ? edge.target : edge.source;
        const otherEdges = this.neighborIndex.get(otherId);
        if (otherEdges) otherEdges.delete(eid);
        this.edges.delete(eid);
      }
    }
    this.neighborIndex.delete(id);
    this.labelIndex.delete(node.label.toLowerCase().trim());
    this._dedupeIndex.delete(`${node.type}::${node.label.toLowerCase().trim()}`);
    const typeSet = this.typeIndex.get(node.type);
    if (typeSet) typeSet.delete(id);
    this.nodes.delete(id);
    return true;
  }

  getNodesByType(type) {
    const ids = this.typeIndex.get(type) || new Set();
    return Array.from(ids).map(id => this.nodes.get(id)).filter(Boolean);
  }

  // ── Edge CRUD ─────────────────────────────────────────

  addEdge(sourceId, targetId, relation, weight = 0.5) {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) return null;

    const existingEdges = this.getEdgesBetween(sourceId, targetId);
    const duplicate = existingEdges.find(e => e.relation === relation);
    if (duplicate) {
      duplicate.weight = Math.min(1.0, duplicate.weight + 0.1);
      return duplicate.id;
    }

    const id = `e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const edge = { id, source: sourceId, target: targetId, relation, weight, created: Date.now() };
    this.edges.set(id, edge);

    if (!this.neighborIndex.has(sourceId)) this.neighborIndex.set(sourceId, new Set());
    if (!this.neighborIndex.has(targetId)) this.neighborIndex.set(targetId, new Set());
    this.neighborIndex.get(sourceId).add(id);
    this.neighborIndex.get(targetId).add(id);

    return id;
  }

  connect(sourceLabel, relation, targetLabel, sourceType = 'concept', targetType = 'concept') {
    const sourceId = this.addNode(sourceType, sourceLabel);
    const targetId = this.addNode(targetType, targetLabel);
    return this.addEdge(sourceId, targetId, relation);
  }

  getEdgesBetween(nodeA, nodeB) {
    const edgesA = this.neighborIndex.get(nodeA) || new Set();
    return Array.from(edgesA)
      .map(eid => this.edges.get(eid))
      .filter(e => e && ((e.source === nodeA && e.target === nodeB) || (e.source === nodeB && e.target === nodeA)));
  }

  // ── Neighbors ─────────────────────────────────────────

  getNeighbors(nodeId, relationFilter = null) {
    const edgeIds = this.neighborIndex.get(nodeId) || new Set();
    const neighbors = [];
    for (const eid of edgeIds) {
      const edge = this.edges.get(eid);
      if (!edge) continue;
      if (relationFilter && edge.relation !== relationFilter) continue;
      const neighborId = edge.source === nodeId ? edge.target : edge.source;
      const node = this.nodes.get(neighborId);
      if (node) neighbors.push({ node, edge, direction: edge.source === nodeId ? 'outgoing' : 'incoming' });
    }
    return neighbors.sort((a, b) => b.edge.weight - a.edge.weight);
  }

  // ── Traversal ─────────────────────────────────────────

  traverse(startNodeId, maxDepth = 3) {
    if (!this.nodes.has(startNodeId)) return [];
    const visited = new Map();
    const queue = [{ id: startNodeId, depth: 0 }];
    visited.set(startNodeId, 0);

    while (queue.length > 0) {
      const item = queue.shift();
      if (!item) break;
      const { id, depth } = item;
      if (depth >= maxDepth) continue;
      const edgeIds = this.neighborIndex.get(id) || new Set();
      for (const edgeId of edgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge) continue;
        const neighborId = edge.source === id ? edge.target : edge.source;
        if (!visited.has(neighborId)) {
          visited.set(neighborId, depth + 1);
          queue.push({ id: neighborId, depth: depth + 1 });
        }
      }
    }

    return Array.from(visited.entries())
      .filter(([id]) => id !== startNodeId)
      .map(([id, depth]) => ({ node: this.nodes.get(id), depth, id }))
      .sort((a, b) => a.depth - b.depth);
  }

  findPath(fromId, toId, maxDepth = 6) {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    if (fromId === toId) return [];

    const visited = new Map();
    const queue = [fromId];
    visited.set(fromId, null);

    while (queue.length > 0) {
      const current = queue.shift();
      if (this._pathDepth(visited, current) >= maxDepth) continue;

      const edgeIds = this.neighborIndex.get(current) || new Set();
      for (const edgeId of edgeIds) {
        const edge = this.edges.get(edgeId);
        if (!edge) continue;
        const neighbor = edge.source === current ? edge.target : edge.source;
        if (!visited.has(neighbor)) {
          visited.set(neighbor, { parent: current, edgeId });
          if (neighbor === toId) {
            const path = [];
            let cursor = toId;
            while (visited.get(cursor)) {
              const step = visited.get(cursor);
              path.unshift({ node: this.nodes.get(cursor), edge: this.edges.get(step.edgeId) });
              cursor = step.parent;
            }
            return path;
          }
          queue.push(neighbor);
        }
      }
    }
    return null;
  }

  _pathDepth(visited, nodeId) {
    let depth = 0, cursor = nodeId;
    while (visited.get(cursor)) { cursor = visited.get(cursor).parent; depth++; }
    return depth;
  }

  // ── Analytics ─────────────────────────────────────────

  pageRank(iterations = 10, dampingFactor = 0.85, topN = 10) {
    const nodeIds = Array.from(this.nodes.keys());
    if (nodeIds.length === 0) return [];
    const N = nodeIds.length;
    const scores = new Map();
    for (const id of nodeIds) scores.set(id, 1 / N);

    for (let i = 0; i < iterations; i++) {
      const newScores = new Map();
      for (const id of nodeIds) newScores.set(id, (1 - dampingFactor) / N);
      for (const id of nodeIds) {
        const edgeIds = this.neighborIndex.get(id) || new Set();
        const outDegree = edgeIds.size || 1;
        const share = scores.get(id) / outDegree;
        for (const edgeId of edgeIds) {
          const edge = this.edges.get(edgeId);
          if (!edge) continue;
          const neighbor = edge.source === id ? edge.target : edge.source;
          newScores.set(neighbor, (newScores.get(neighbor) || 0) + dampingFactor * share);
        }
      }
      for (const [id, score] of newScores) scores.set(id, score);
    }

    return Array.from(scores.entries())
      .map(([id, score]) => ({ node: this.nodes.get(id), score, id }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
  }

  findBridgeNodes(limit = 5) {
    const bridgeScores = new Map();
    for (const [nodeId] of this.nodes) {
      const neighbors = this.neighborIndex.get(nodeId) || new Set();
      if (neighbors.size < 2) continue;
      const neighborIds = [];
      for (const edgeId of neighbors) {
        const edge = this.edges.get(edgeId);
        if (edge) neighborIds.push(edge.source === nodeId ? edge.target : edge.source);
      }
      let bridgeCount = 0;
      for (let i = 0; i < neighborIds.length; i++) {
        for (let j = i + 1; j < neighborIds.length; j++) {
          const ni = this.neighborIndex.get(neighborIds[i]) || new Set();
          let directlyConnected = false;
          for (const eid of ni) {
            const e = this.edges.get(eid);
            if (e && (e.source === neighborIds[j] || e.target === neighborIds[j])) { directlyConnected = true; break; }
          }
          if (!directlyConnected) bridgeCount++;
        }
      }
      if (bridgeCount > 0) bridgeScores.set(nodeId, bridgeCount);
    }
    return Array.from(bridgeScores.entries())
      .map(([id, score]) => ({ node: this.nodes.get(id), bridgeScore: score, id }))
      .sort((a, b) => b.bridgeScore - a.bridgeScore)
      .slice(0, limit);
  }

  // ── Stats ─────────────────────────────────────────────

  getMostConnected(limit = 5) {
    return Array.from(this.nodes.entries())
      .map(([id, node]) => ({ label: node.label, connections: (this.neighborIndex.get(id) || new Set()).size }))
      .sort((a, b) => b.connections - a.connections)
      .slice(0, limit);
  }

  getStats() {
    return {
      nodes: this.nodes.size,
      edges: this.edges.size,
      types: Object.fromEntries(Array.from(this.typeIndex.entries()).map(([type, ids]) => [type, ids.size])),
      mostConnected: this.getMostConnected(5),
    };
  }

  // ── Causal Graph Operations (v7.0.9 Phase 1) ──────────

  /**
   * Promote an edge to a new relation type with updated weight.
   * Used by CausalAnnotation when correlated_with → caused.
   * @param {string} edgeId
   * @param {string} newRelation
   * @param {number} newWeight
   * @returns {boolean} success
   */
  promoteEdge(edgeId, newRelation, newWeight) {
    const edge = this.edges.get(edgeId);
    if (!edge) return false;
    edge.relation = newRelation;
    edge.weight = Math.min(1.0, newWeight);
    return true;
  }

  /**
   * Degrade all outgoing edges from nodes whose label contains the given substring.
   * Used by CausalAnnotation.onFileChange() for staleness.
   * @param {{ sourceContains: string, fromRelation?: string, toRelation: string, confMultiplier: number }} opts
   * @returns {number} count of degraded edges
   */
  degradeEdges({ sourceContains, fromRelation, toRelation, confMultiplier }) {
    let count = 0;
    for (const [id, edge] of this.edges) {
      if (fromRelation && edge.relation !== fromRelation) continue;
      const sourceNode = this.nodes.get(edge.source);
      if (!sourceNode || !sourceNode.label.includes(sourceContains)) continue;
      edge.relation = toRelation;
      edge.weight = Math.max(0, edge.weight * confMultiplier);
      count++;
    }
    return count;
  }

  /**
   * Get all edges of a specific relation type.
   * Used by Fitness Check #11 to count causal edges.
   * @param {string} relation
   * @returns {Array<object>}
   */
  getEdgesByRelation(relation) {
    return Array.from(this.edges.values()).filter(e => e.relation === relation);
  }

  /**
   * Prune edges below a confidence threshold.
   * @param {{ maxAge?: number, minConfidence?: number, relation?: string }} opts
   * @returns {number} count of pruned edges
   */
  pruneEdges({ maxAge, minConfidence, relation } = {}) {
    const now = Date.now();
    const toRemove = [];
    for (const [id, edge] of this.edges) {
      if (relation && edge.relation !== relation) continue;
      if (minConfidence !== undefined && edge.weight >= minConfidence) continue;
      if (maxAge !== undefined && (now - edge.created) < maxAge) continue;
      toRemove.push(id);
    }
    for (const id of toRemove) {
      const edge = this.edges.get(id);
      if (edge) {
        const srcSet = this.neighborIndex.get(edge.source);
        const tgtSet = this.neighborIndex.get(edge.target);
        if (srcSet) srcSet.delete(id);
        if (tgtSet) tgtSet.delete(id);
        this.edges.delete(id);
      }
    }
    return toRemove.length;
  }

  // ── Serialization ─────────────────────────────────────

  serialize() {
    return { nodes: Array.from(this.nodes.entries()), edges: Array.from(this.edges.entries()) };
  }

  deserialize(data) {
    this.nodes = new Map(data.nodes || []);
    this.edges = new Map(data.edges || []);
    // Rebuild indexes
    this.typeIndex.clear();
    this.labelIndex.clear();
    this._dedupeIndex.clear();
    this.neighborIndex.clear();
    for (const [id, node] of this.nodes) {
      this.labelIndex.set(node.label.toLowerCase().trim(), id);
      this._dedupeIndex.set(`${node.type}::${node.label.toLowerCase().trim()}`, id);
      if (!this.typeIndex.has(node.type)) this.typeIndex.set(node.type, new Set());
      this.typeIndex.get(node.type).add(id);
    }
    for (const [id, edge] of this.edges) {
      if (!this.neighborIndex.has(edge.source)) this.neighborIndex.set(edge.source, new Set());
      if (!this.neighborIndex.has(edge.target)) this.neighborIndex.set(edge.target, new Set());
      this.neighborIndex.get(edge.source).add(id);
      this.neighborIndex.get(edge.target).add(id);
    }
  }
}

module.exports = { GraphStore };
