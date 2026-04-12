// @ts-checked-v5.7
// ============================================================
// GENESIS — UnifiedMemory.js (P1: Unified Memory Architecture)
//
// Combines ConversationMemory + KnowledgeGraph + EmbeddingService
// into a single semantic retrieval layer. Every query goes
// through ONE interface that searches ALL knowledge stores.
//
// Architecture:
//   Query → [Semantic Search] → Rank & Merge → Context Block
//                ↓
//   ┌──────────────────────────────────┐
//   │  EmbeddingService (vector sim)   │ ← preferred if available
//   │  ConversationMemory (TF-IDF)     │ ← episodic + semantic facts
//   │  KnowledgeGraph (entity search)  │ ← relations + entities
//   └──────────────────────────────────┘
//
// USAGE:
//   const unified = new UnifiedMemory({ memory, knowledgeGraph, embeddingService });
//   const results = await unified.recall('Was weiss ich ueber React?', { limit: 10 });
//   // → [{ source: 'episodic', score: 0.87, content: '...' }, { source: 'knowledge', ... }]
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('UnifiedMemory');

class UnifiedMemory {
  constructor({ bus,  memory, knowledgeGraph, embeddingService, eventStore }) {
    this.bus = bus || NullBus;
    this.memory = memory;           // ConversationMemory
    this.kg = knowledgeGraph;       // KnowledgeGraph
    this.embeddings = embeddingService || null; // EmbeddingService (optional)
    this.eventStore = eventStore || null;

    // Weight configuration for result merging
    this.weights = {
      episodic: 1.0,     // Past conversations
      semantic: 1.2,     // Known facts (higher weight — these are confirmed)
      knowledge: 1.1,    // Knowledge graph entities/relations
      embedding: 1.3,    // Vector similarity (highest signal when available)
    };

    // Cache for recent queries (avoid duplicate searches within same turn)
    this._cache = new Map();
    this._cacheMaxSize = 20;
    this._cacheTTLMs = 30000; // 30s cache
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * Unified recall: searches ALL knowledge stores and returns
   * ranked, deduplicated results.
   *
   * @param {string} query - Natural language query
   * @param {object} [options]
   * @param {number} [options.limit] - Max results (default 10)
   * @param {string[]} [options.sources] - Filter to specific sources (default: all)
   * @param {number} [options.minScore] - Minimum relevance score (default: 0.1)
   * @returns {Promise<Array<{source, score, content, meta}>>}
   */
  async recall(query, options = {}) {
    const { limit = 10, sources = null, minScore = 0.1 } = options;

    // Check cache
    const cacheKey = `${query}:${limit}:${sources?.join(',') || 'all'}`;
    const cached = this._getCache(cacheKey);
    if (cached) return cached;

    const results = [];
    const errors = [];

    // ── 1. Episodic Memory (past conversations) ─────────────
    if (!sources || sources.includes('episodic')) {
      try {
        const episodes = this.embeddings?.isAvailable()
          ? await this.memory.recallEpisodesAsync(query, limit)
          : this.memory.recallEpisodes(query, limit);

        for (const ep of episodes) {
          results.push({
            source: 'episodic',
            score: (ep.score || 0.5) * this.weights.episodic,
            content: ep.summary || ep.text || JSON.stringify(ep.lastExchange || []),
            meta: {
              id: ep.id,
              timestamp: ep.timestamp,
              topics: ep.topics || [],
              turnCount: ep.turnCount,
            },
          });
        }
      } catch (err) {
        errors.push({ source: 'episodic', error: err.message });
      }
    }

    // ── 2. Semantic Facts (stored key-value knowledge) ──────
    if (!sources || sources.includes('semantic')) {
      try {
        const facts = this._searchSemanticFacts(query);
        for (const fact of facts) {
          results.push({
            source: 'semantic',
            score: fact.score * this.weights.semantic,
            content: `${fact.key}: ${fact.value}`,
            meta: {
              key: fact.key,
              confidence: fact.confidence,
              learned: fact.learned,
            },
          });
        }
      } catch (err) {
        errors.push({ source: 'semantic', error: err.message });
      }
    }

    // ── 3. Knowledge Graph (entities + relations) ───────────
    if (!sources || sources.includes('knowledge')) {
      try {
        const kgResults = this.kg.search(query, limit);
        for (const { node, score } of kgResults) {
          // v2.8.1: KG.search() returns {node, score} — destructure correctly
          const neighbors = this.kg.getNeighbors ? this.kg.getNeighbors(node.id, {}).slice(0, 3) : [];
          results.push({
            source: 'knowledge',
            score: (score || 0.5) * this.weights.knowledge,
            content: this._formatKGNode(node, neighbors),
            meta: {
              entity: node.id,
              type: node.type,
              edges: neighbors.length,
            },
          });
        }
      } catch (err) {
        errors.push({ source: 'knowledge', error: err.message });
      }
    }

    // ── 4. Vector Embedding Search (cross-store) ────────────
    if ((!sources || sources.includes('embedding')) && this.embeddings?.isAvailable()) {
      try {
        const embeddingResults = await this._vectorSearch(query, limit);
        for (const er of embeddingResults) {
          // Boost score if result also appeared in another source
          const duplicate = results.find(r => this._isDuplicate(r, er));
          if (duplicate) {
            duplicate.score = Math.max(duplicate.score, er.score * this.weights.embedding);
            duplicate.meta.embeddingBoost = true;
          } else {
            results.push({
              source: 'embedding',
              score: er.score * this.weights.embedding,
              content: er.content,
              meta: er.meta || {},
            });
          }
        }
      } catch (err) {
        errors.push({ source: 'embedding', error: err.message });
      }
    }

    // ── Cross-reference across stores (v7.1.4) ──────────
    const crossReferenced = this._crossReference(results);

    // ── Rank, filter, deduplicate ───────────────────────────
    const ranked = crossReferenced
      .filter(r => r.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    // Cache result
    this._setCache(cacheKey, ranked);

    // Emit retrieval event for metrics
    this.bus.emit('memory:unified-recall', {
      query: query.slice(0, 100),
      resultCount: ranked.length,
      sources: [...new Set(ranked.map(r => r.source))],
      errors: errors.length > 0 ? errors : undefined,
    }, { source: 'UnifiedMemory' });

    return ranked;
  }

  /**
   * Build a context block for PromptBuilder/ContextManager.
   * Returns a formatted string suitable for injection into
   * the system prompt.
   *
   * @param {string} query - Current user message
   * @param {number} maxTokens - Token budget for memory block
   * @returns {Promise<string>}
   */
  async buildContextBlock(query, maxTokens = 600) {
    const results = await this.recall(query, { limit: 8 });
    if (results.length === 0) return '';

    const sections = [];

    // Group by source
    const bySource = {};
    for (const r of results) {
      if (!bySource[r.source]) bySource[r.source] = [];
      bySource[r.source].push(r);
    }

    // Build sections with source labels
    if (bySource.semantic?.length > 0) {
      sections.push('Known facts: ' + bySource.semantic.map(r => r.content).join('; '));
    }
    if (bySource.episodic?.length > 0) {
      sections.push('From past conversations: ' + bySource.episodic.map(r => r.content).slice(0, 3).join(' | '));
    }
    if (bySource.knowledge?.length > 0) {
      sections.push('Knowledge graph: ' + bySource.knowledge.map(r => r.content).slice(0, 3).join(' | '));
    }
    if (bySource.embedding?.length > 0) {
      sections.push('Related: ' + bySource.embedding.map(r => r.content).slice(0, 2).join(' | '));
    }

    let block = sections.join('\n');

    // Rough token budget enforcement
    const estimatedTokens = Math.ceil(block.length / 3.5);
    if (estimatedTokens > maxTokens) {
      const charLimit = Math.floor(maxTokens * 3.5);
      block = block.slice(0, charLimit) + '...';
    }

    return block;
  }

  /**
   * Store a fact across both memory and knowledge graph.
   * Single entry point for learning new information.
   */
  storeFact(key, value, confidence = 0.8, source = 'user') {
    // Store in semantic memory
    if (this.memory?.storeFact) {
      this.memory.storeFact(key, value, confidence);
    } else if (this.memory?.db?.semantic) {
      this.memory.db.semantic[key] = {
        value, confidence, source,
        learned: new Date().toISOString(),
      };
    }

    // Also create a knowledge graph node
    try {
      this.kg.connect(source, 'knows', `${key}:${value}`);
    } catch (err) { /* KG is optional */ }

    this.bus.emit('memory:fact-stored', { key, source }, { source: 'UnifiedMemory' });
  }

  /**
   * Get combined statistics from all memory subsystems.
   */
  getStats() {
    return {
      episodic: this.memory?.getStats?.() || {},
      knowledge: this.kg?.getStats?.() || {},
      embeddings: this.embeddings?.getStats?.() || { available: false },
      cacheSize: this._cache.size,
      weights: { ...this.weights },
    };
  }

  // ════════════════════════════════════════════════════════════
  // CONFLICT RESOLUTION (v4.12.8)
  // ════════════════════════════════════════════════════════════

  /**
   * Detect and resolve contradictory memories across stores.
   *
   * Strategy: For a given topic, query all stores and compare.
   * If two sources say different things about the same entity,
   * use recency + confidence + source priority to pick a winner,
   * then update the losing store.
   *
   * @param {string} topic - Topic to check for conflicts
   * @returns {Promise<{ conflicts: Array, resolutions: Array }>}
   */
  async resolveConflicts(topic) {
    const results = await this.recall(topic, { limit: 20, minScore: 0.05 });
    if (results.length < 2) return { conflicts: [], resolutions: [] };

    const conflicts = [];
    const resolutions = [];

    // Group by entity/key — find contradictions
    const byEntity = new Map();
    for (const r of results) {
      const entity = this._extractEntity(r);
      if (!entity) continue;
      if (!byEntity.has(entity)) byEntity.set(entity, []);
      byEntity.get(entity).push(r);
    }

    for (const [entity, memories] of byEntity) {
      if (memories.length < 2) continue;

      // Check if values actually contradict
      const values = memories.map(m => this._extractValue(m));
      const uniqueValues = [...new Set(values.filter(v => v))];
      if (uniqueValues.length < 2) continue; // No contradiction

      // Conflict detected — resolve by priority
      conflicts.push({
        entity,
        sources: memories.map(m => ({
          source: m.source,
          content: m.content,
          score: m.score,
          timestamp: m.meta?.timestamp || m.meta?.learned,
        })),
      });

      // Resolution strategy:
      // 1. Most recent wins (if timestamps available)
      // 2. Highest confidence wins
      // 3. Source priority: semantic > episodic > knowledge > embedding
      const sorted = [...memories].sort((a, b) => {
        // Recency
        const tsA = a.meta?.timestamp || a.meta?.learned || 0;
        const tsB = b.meta?.timestamp || b.meta?.learned || 0;
        if (tsA && tsB && tsA !== tsB) {
          const tA = typeof tsA === 'string' ? new Date(tsA).getTime() : tsA;
          const tB = typeof tsB === 'string' ? new Date(tsB).getTime() : tsB;
          return tB - tA; // newest first
        }
        // Confidence
        const confA = a.meta?.confidence || a.score || 0;
        const confB = b.meta?.confidence || b.score || 0;
        return confB - confA;
      });

      const winner = sorted[0];
      const losers = sorted.slice(1);

      // Update losers to match winner
      for (const loser of losers) {
        try {
          if (loser.source === 'semantic' && this.memory?.storeFact) {
            const key = loser.meta?.key || entity;
            this.memory.storeFact(key, this._extractValue(winner), winner.meta?.confidence || 0.8);
          } else if (loser.source === 'knowledge') {
            // Update KG node if possible
            this.kg?.updateNode?.(entity, { value: this._extractValue(winner) });
          }
          resolutions.push({
            entity,
            winner: { source: winner.source, content: winner.content },
            loser: { source: loser.source, content: loser.content },
            action: 'updated',
          });
        } catch (err) {
          resolutions.push({
            entity,
            winner: { source: winner.source },
            loser: { source: loser.source },
            action: 'failed',
            error: err.message,
          });
        }
      }
    }

    if (conflicts.length > 0) {
      this.bus.emit('memory:conflicts-resolved', {
        topic,
        conflictCount: conflicts.length,
        resolutionCount: resolutions.length,
      }, { source: 'UnifiedMemory' });
      _log.info(`[UNIFIED-MEMORY] Resolved ${conflicts.length} conflict(s) for "${topic}"`);
    }

    return { conflicts, resolutions };
  }

  /**
   * Consolidate: merge episodic patterns into semantic knowledge.
   * Called during idle time (DreamCycle integration point).
   *
   * Finds repeated episodic themes and promotes them to semantic facts
   * with confidence proportional to repetition count.
   *
   * @param {object} [options]
   * @param {number} [options.minOccurrences] - Min repetitions to promote (default: 3)
   * @param {number} [options.maxPromotions] - Max facts to promote per call (default: 5)
   * @returns {{ promoted: Array<{ key: string, value: string, occurrences: number }> }}
   */
  consolidate(options = {}) {
    const { minOccurrences = 3, maxPromotions = 5 } = options;
    const promoted = [];

    if (!this.memory?.db?.episodic || !this.memory?.storeFact) return { promoted };

    // Count topic frequencies across episodes
    const topicCounts = new Map();
    for (const ep of this.memory.db.episodic) {
      if (!ep?.topics) continue;
      for (const topic of ep.topics) {
        const key = topic.toLowerCase().trim();
        if (key.length < 3) continue;
        if (!topicCounts.has(key)) topicCounts.set(key, { count: 0, episodes: [] });
        const entry = topicCounts.get(key);
        entry.count++;
        entry.episodes.push(ep);
      }
    }

    // Promote frequent topics to semantic facts
    const candidates = [...topicCounts.entries()]
      .filter(([, v]) => v.count >= minOccurrences)
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, maxPromotions);

    for (const [topic, data] of candidates) {
      // Check if already a semantic fact
      const existing = this.memory.db.semantic?.[`topic:${topic}`];
      if (existing && (existing.confidence || 0) > 0.7) continue;

      const confidence = Math.min(0.95, 0.5 + (data.count - minOccurrences) * 0.1);
      this.memory.storeFact(`topic:${topic}`, `Recurring topic (${data.count}x)`, confidence);
      promoted.push({ key: `topic:${topic}`, value: `${data.count}x`, occurrences: data.count });
    }

    if (promoted.length > 0) {
      this.bus.emit('memory:consolidated', {
        promotedCount: promoted.length,
        topics: promoted.map(p => p.key),
      }, { source: 'UnifiedMemory' });
      _log.info(`[UNIFIED-MEMORY] Consolidated ${promoted.length} episodic patterns → semantic facts`);
    }

    return { promoted };
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════════

  /**
   * Extract an entity identifier from a memory result.
   */
  _extractEntity(result) {
    if (result.meta?.key) return result.meta.key;
    if (result.meta?.entity) return result.meta.entity;
    // Fall back to first significant words from content
    const words = (result.content || '').split(/[\s:,]+/).filter(w => w.length > 3);
    return words.slice(0, 2).join('_').toLowerCase() || null;
  }

  /**
   * Extract the core value from a memory result.
   */
  _extractValue(result) {
    if (!result.content) return null;
    // For "key: value" format, return the value part
    const colonIdx = result.content.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) {
      return result.content.slice(colonIdx + 1).trim();
    }
    return result.content.slice(0, 200);
  }

  /**
   * Search semantic facts (key-value store in ConversationMemory)
   * using keyword matching against keys and values.
   */
  _searchSemanticFacts(query) {
    if (!this.memory?.db?.semantic) return [];

    const queryWords = new Set(
      query.toLowerCase()
        .replace(/[^a-zäöüß0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
    );

    const results = [];
    for (const [key, fact] of Object.entries(this.memory.db.semantic)) {
      const keyWords = key.toLowerCase().replace(/[._]/g, ' ').split(/\s+/);
      const valueWords = String(fact.value).toLowerCase().split(/\s+/);
      const allWords = [...keyWords, ...valueWords];

      let matchCount = 0;
      for (const qw of queryWords) {
        if (allWords.some(w => w.includes(qw) || qw.includes(w))) matchCount++;
      }

      if (matchCount > 0) {
        results.push({
          key,
          value: fact.value,
          confidence: fact.confidence || 0.5,
          learned: fact.learned,
          score: matchCount / Math.max(queryWords.size, 1),
        });
      }
    }

    return results.sort((a, b) => b.score - a.score).slice(0, 5);
  }

  /**
   * Vector similarity search across all embedded content.
   */
  async _vectorSearch(query, limit) {
    if (!this.embeddings?.isAvailable()) return [];

    try {
      const queryVec = await this.embeddings.embed(query);
      if (!queryVec) return [];

      const results = [];

      // Search episodic embeddings
      if (this.memory?._embeddingVectors?.length > 0) {
        for (let i = 0; i < this.memory._embeddingVectors.length; i++) {
          const vec = this.memory._embeddingVectors[i];
          if (!vec) continue;
          const sim = this.embeddings.cosineSimilarity(queryVec, vec);
          if (sim > 0.3) {
            const ep = this.memory.db.episodic[i];
            results.push({
              score: sim,
              content: ep?.summary || 'episode',
              meta: { source: 'episodic-vector', index: i },
            });
          }
        }
      }

      return results.sort((a, b) => b.score - a.score).slice(0, limit);
    } catch (err) {
      _log.debug('[UNIFIED-MEMORY] Vector search failed:', err.message);
      return [];
    }
  }

  _formatKGNode(node, neighbors = []) {
    // v2.8.1: node is {id, type, label, properties, ...} from GraphStore
    const props = node.properties && Object.keys(node.properties).length > 0
      ? ` [${Object.entries(node.properties).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(', ')}]`
      : '';
    if (neighbors.length > 0) {
      const rels = neighbors.map(n => `${n.edge.relation} → ${n.node.label}`).join(', ');
      return `${node.label} (${node.type})${props}: ${rels}`;
    }
    return `${node.label} (${node.type})${props}`;
  }

  _isDuplicate(existing, candidate) {
    if (!existing.content || !candidate.content) return false;
    // Simple overlap check — if >60% words match, it's a duplicate
    const wordsA = new Set(existing.content.toLowerCase().split(/\s+/));
    const wordsB = candidate.content.toLowerCase().split(/\s+/);
    let overlap = 0;
    for (const w of wordsB) { if (wordsA.has(w)) overlap++; }
    return overlap / Math.max(wordsB.length, 1) > 0.6;
  }

  // ── v7.1.4 FEATURE 4: CROSS-STORE REFERENCING ────────

  /**
   * Extract keywords from text. Cached on first call per result.
   * @param {string} text
   * @returns {Set<string>}
   */
  _extractKeywords(text) {
    if (!text) return new Set();
    return new Set(
      text.toLowerCase()
        .split(/[\s,.;:!?()\[\]{}"'`]+/)
        .filter(w => w.length > 3)
    );
  }

  /**
   * Cross-reference results from different stores.
   * If two results from DIFFERENT stores describe the same concept (Jaccard > 0.5),
   * merge them: score = max(a, b) * 1.3, keep longer text, source = 'unified'.
   * @param {Array} results
   * @returns {Array}
   */
  _crossReference(results) {
    if (results.length < 2) return results;

    // Extract keywords once per result (cached)
    for (const r of results) {
      if (!r._keywords) r._keywords = this._extractKeywords(r.content);
    }

    const merged = new Set(); // indices of merged-away results
    const output = [];

    for (let i = 0; i < results.length; i++) {
      if (merged.has(i)) continue;

      let best = results[i];
      for (let j = i + 1; j < results.length; j++) {
        if (merged.has(j)) continue;
        if (results[i].source === results[j].source) continue; // same store — skip

        // Jaccard similarity on keyword sets
        const setA = results[i]._keywords;
        const setB = results[j]._keywords;
        if (setA.size === 0 || setB.size === 0) continue;

        let intersection = 0;
        for (const w of setA) { if (setB.has(w)) intersection++; }
        const union = setA.size + setB.size - intersection;
        const jaccard = intersection / union;

        if (jaccard > 0.5) {
          // Merge: keep longer text, boost score
          merged.add(j);
          const longer = (best.content || '').length >= (results[j].content || '').length ? best : results[j];
          best = {
            source: 'unified',
            score: Math.max(best.score, results[j].score) * 1.3,
            content: longer.content,
            meta: { ...best.meta, ...results[j].meta, crossReferenced: true },
          };
        }
      }

      // Remove cached keywords before returning
      delete best._keywords;
      output.push(best);
    }

    // Add remaining un-merged results, clean keywords
    // (already handled — merged items are skipped, non-merged are in output)
    for (const r of output) delete r._keywords;
    return output;
  }

  _getCache(key) {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > this._cacheTTLMs) {
      this._cache.delete(key);
      return null;
    }
    return entry.data;
  }

  _setCache(key, data) {
    if (this._cache.size >= this._cacheMaxSize) {
      const oldest = this._cache.keys().next().value;
      this._cache.delete(oldest);
    }
    this._cache.set(key, { data, time: Date.now() });
  }

  clearCache() {
    this._cache.clear();
  }
}

module.exports = { UnifiedMemory };
