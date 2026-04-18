// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — KnowledgeGraphSearch.js (v5.6.0)
//
// Extracted from KnowledgeGraph.js — search (keyword + vector),
// context building, text learning, and embedding sync.
// Attached via prototype delegation.
//
// Each method accesses KnowledgeGraph instance state via `this`.
// ============================================================

const { createLogger } = require('../core/Logger');
const { isValidLabel } = require('../core/utils');
const _log = createLogger('KnowledgeGraph');

const searchMethods = {

  // ── Search ────────────────────────────────────────────

  search(query, limit = 10) {
    const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scored = [];

    for (const [id, node] of this.graph.nodes) {
      let score = 0;
      const text = `${node.label} ${node.type} ${JSON.stringify(node.properties)}`.toLowerCase();
      for (const word of queryWords) {
        if (text.includes(word)) score += 2;
        if (node.label.toLowerCase().includes(word)) score += 3;
      }
      const ageDays = (Date.now() - node.accessed) / (1000 * 60 * 60 * 24);
      score += Math.max(0, 1 - ageDays / 30);
      score += Math.min((this.graph.neighborIndex.get(id) || new Set()).size * 0.3, 2);
      score += Math.min((node.accessCount || 0) * 0.1, 1);
      if (score > 0) scored.push({ node, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  },

  async searchAsync(query, limit = 10) {
    const keywordResults = this.search(query, Math.max(limit * 2, 20));
    if (!this._embeddings?.isAvailable()) return keywordResults.slice(0, limit);

    try {
      const queryVec = await this._embeddings.embed(query);
      if (!queryVec) return keywordResults.slice(0, limit);

      const candidates = new Map();
      for (const { node, score } of keywordResults) {
        candidates.set(node.id, { node, keywordScore: score, vectorScore: 0 });
      }
      for (const [id, node] of this.graph.nodes) {
        if (!candidates.has(id)) {
          let vec = this._nodeVectors.get(id);
          if (!vec) {
            vec = await this._embeddings.embed(`${node.label} ${node.type} ${Object.values(node.properties).join(' ')}`);
            if (vec) this._cacheVector(id, vec);
          }
          if (vec) {
            const sim = this._embeddings.cosineSimilarity(queryVec, vec);
            if (sim > 0.3) candidates.set(id, { node, keywordScore: 0, vectorScore: sim * 5 });
          }
        }
      }
      for (const [id, entry] of candidates) {
        let vec = this._nodeVectors.get(id);
        if (!vec) {
          vec = await this._embeddings.embed(`${entry.node.label} ${entry.node.type} ${Object.values(entry.node.properties).join(' ')}`);
          if (vec) this._cacheVector(id, vec);
        }
        if (vec) entry.vectorScore = this._embeddings.cosineSimilarity(queryVec, vec) * 5;
      }
      return Array.from(candidates.values())
        .map(({ node, keywordScore, vectorScore }) => ({ node, score: keywordScore * 0.6 + vectorScore * 0.4 }))
        .sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (err) {
      _log.debug('[KNOWLEDGE] Vector search failed:', err.message);
      return keywordResults.slice(0, limit);
    }
  },

  // ── Context Building ──────────────────────────────────

  buildContext(query, maxTokens = 500) { return this._buildCtx(this.search(query, 8), maxTokens); },
  async buildContextAsync(query, maxTokens = 500) { return this._buildCtx(await this.searchAsync(query, 8), maxTokens); },

  _buildCtx(results, maxTokens) {
    if (results.length === 0) return '';
    const parts = ['KNOWLEDGE CONTEXT:'];
    let tokens = 5;
    for (const { node } of results) {
      const neighbors = this.graph.getNeighbors(node.id).slice(0, 3);
      let line = `- ${node.label} (${node.type})`;
      if (Object.keys(node.properties).length > 0) {
        line += ` [${Object.entries(node.properties).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ')}]`;
      }
      if (neighbors.length > 0) {
        line += ` -> ${neighbors.map(n => `${n.edge.relation} ${n.node.label}`).join(', ')}`;
      }
      const lt = Math.ceil(line.length / 3.5);
      if (tokens + lt > maxTokens) break;
      tokens += lt;
      parts.push(line);
    }
    return parts.join('\n');
  },

  // ── Learning ──────────────────────────────────────────

  learnFromText(text, source = 'conversation') {
    let learned = 0;
    // v7.2.8: isValidLabel filters stop words and fragments (min 4 chars, no pure stop-word labels)
    // v7.2.9: Unicode-aware patterns (\p{L}) — \w was truncating German umlauts ("größer" → "gr")
    for (const m of text.matchAll(/([\p{L}][\p{L}\s]{1,30}?)\s+(?:ist|sind|war|waren)\s+(?:ein[e]?\s+)?([\p{L}][\p{L}\s]{1,30})/giu)) {
      if (isValidLabel(m[1].trim()) && isValidLabel(m[2].trim())) { this.connect(m[1].trim(), 'is', m[2].trim()); learned++; }
    }
    for (const m of text.matchAll(/([\p{L}][\p{L}\s]{1,30}?)\s+(?:benutzt|verwendet|nutzt|braucht)\s+([\p{L}][\p{L}\s]{1,30})/giu)) {
      if (isValidLabel(m[1].trim()) && isValidLabel(m[2].trim())) { this.connect(m[1].trim(), 'uses', m[2].trim()); learned++; }
    }
    for (const m of text.matchAll(/(?:ich hei(?:ss|ß)e|mein name ist|i'm|my name is)\s+([\p{L}]+)/giu)) {
      this.addNode('entity', m[1].trim(), { type: 'person', role: 'user' }); learned++;
    }
    for (const m of text.matchAll(/(?:arbeite|arbeiten|work)\s+(?:mit|an|on|with)\s+([\p{L}][\p{L}\s]{1,30})/giu)) {
      const pid = this.addNode('entity', m[1].trim(), { type: 'project' });
      const u = this.findNode('user');
      const uid = u ? u.id : this.addNode('entity', 'user', { type: 'person' });
      this.addEdge(uid, pid, 'works-on', 0.8); learned++;
    }
    if (learned > 0) this.bus.emit('knowledge:learned', { count: learned, source }, { source: 'KnowledgeGraph' });
    return learned;
  },

  // ── Embedding Sync ────────────────────────────────────

  _cacheVector(id, vec) {
    this._nodeVectors.set(id, vec);
    if (this._nodeVectors.size > this._maxNodeVectors) {
      const firstKey = this._nodeVectors.keys().next().value;
      this._nodeVectors.delete(firstKey);
    }
  },

  async _syncNodeVectors() {
    if (!this._embeddings?.isAvailable()) return;
    const batch = [], ids = [];
    for (const [id, node] of this.graph.nodes) {
      if (!this._nodeVectors.has(id)) { batch.push(`${node.label} ${node.type} ${Object.values(node.properties).join(' ')}`); ids.push(id); }
      if (batch.length >= 50) break;
    }
    if (batch.length === 0) return;
    const vecs = await this._embeddings.embedBatch(batch);
    for (let i = 0; i < vecs.length; i++) { if (vecs[i]) this._cacheVector(ids[i], vecs[i]); }
  },

};

module.exports = { searchMethods };
