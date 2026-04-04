// @ts-checked-v5.7
// ============================================================
// GENESIS — MemoryFacade.js (v4.13.1 — Audit P3)
//
// @deprecated v6.0.1 — Scheduled for removal. Only 4 external
// references remain. Use UnifiedMemory directly for retrieval.
// MemoryFacade adds a layer without adding value — UnifiedMemory
// already aggregates all memory backends. See SELF-ANALYSIS-AUDIT.md
// Claim 2 for rationale.
//
// PROBLEM: 7 parallel memory systems (ConversationMemory,
// EpisodicMemory, UnifiedMemory, VectorMemory, EchoicMemory,
// KnowledgeGraph, SelfNarrative) with duplicated data and
// inconsistent query interfaces.
//
// SOLUTION: Single facade that:
//   1. QUERY: Routes recall() through UnifiedMemory (already
//      aggregates ConversationMemory + KG + Embeddings), then
//      supplements with VectorMemory and EpisodicMemory.
//   2. STORE: Write-through to appropriate backends based on
//      content type (fact → KG, episode → Episodic, embedding → Vector).
//   3. DEPRECATION: All direct access to individual memory
//      systems should migrate to this facade over time.
//
// Architecture:
//   MemoryFacade.recall(query)
//       → UnifiedMemory.recall()     (primary — already merged)
//       → VectorMemory.search()      (supplement — if available)
//       → EpisodicMemory.recall()    (supplement — if available)
//       → deduplicate + rank → return
//
//   MemoryFacade.store(content, type)
//       → type:'fact'    → KnowledgeGraph.addFact()
//       → type:'episode' → EpisodicMemory.record()
//       → type:'message' → ConversationMemory.add()
//       → always:        → VectorMemory.index() (if available)
//
// MIGRATION: Services should import MemoryFacade instead of
// individual memory services. The facade is registered as
// 'memoryFacade' in the Container with late-bindings to all
// memory services.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('MemoryFacade');

class MemoryFacade {
  static containerConfig = {
    name: 'memoryFacade',
    phase: 5,
    deps: [],
    tags: ['memory', 'facade'],
    lateBindings: [
      { prop: 'unifiedMemory', service: 'unifiedMemory', optional: true },
      { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
      { prop: 'vectorMemory', service: 'vectorMemory', optional: true },
      { prop: 'conversationMemory', service: 'memory', optional: true },
      { prop: 'knowledgeGraph', service: 'knowledgeGraph', optional: true },
      { prop: 'selfNarrative', service: 'selfNarrative', optional: true },
      // NOTE: echoicMemory is internal to ConsciousnessExtension, not a container service.
    ],
  };

  /** @param {{ bus?: object }} [opts] */
  constructor({ bus } = {}) {
    this.bus = bus || NullBus;

    // Late-bound backends (all optional for graceful degradation)
    this.unifiedMemory = null;
    this.episodicMemory = null;
    this.vectorMemory = null;
    this.conversationMemory = null;
    this.knowledgeGraph = null;
    this.selfNarrative = null;
    this.echoicMemory = null;

    this._stats = {
      queries: 0,
      stores: 0,
      backendHits: { unified: 0, vector: 0, episodic: 0, echoic: 0, narrative: 0 },
    };
  }

  // ════════════════════════════════════════════════════════
  // QUERY — Single recall interface across all backends
  // ════════════════════════════════════════════════════════

  /**
   * Unified recall across all memory systems.
   * @param {string} query - Natural language query
   * @param {object} [options]
   * @param {number} [options.limit] - Max results (default 10)
   * @param {string[]} [options.sources] - Filter to specific backends
   * @param {boolean} [options.includeNarrative] - Include self-narrative context
   * @returns {Promise<Array<{ source: string, score: number, content: string, meta?: object }>>}
   */
  async recall(query, options = {}) {
    const { limit = 10, sources = null, includeNarrative = false } = options;
    this._stats.queries++;

    const results = [];
    const errors = [];

    // Primary: UnifiedMemory (already aggregates conversation + KG + embeddings)
    if (this.unifiedMemory && (!sources || sources.includes('unified'))) {
      try {
        const unified = await this.unifiedMemory.recall(query, { limit });
        for (const r of unified) {
          results.push({ ...r, _backend: 'unified' });
        }
        this._stats.backendHits.unified++;
      } catch (err) {
        errors.push({ source: 'unified', error: err.message });
      }
    }

    // Supplement: VectorMemory (high-dimensional similarity)
    if (this.vectorMemory && (!sources || sources.includes('vector'))) {
      try {
        const vectors = await this.vectorMemory.search(query, Math.ceil(limit / 2));
        for (const v of vectors) {
          results.push({
            source: 'vector',
            score: v.score || 0.5,
            content: v.text || v.content || '',
            meta: v.meta,
            _backend: 'vector',
          });
        }
        this._stats.backendHits.vector++;
      } catch (err) {
        errors.push({ source: 'vector', error: err.message });
      }
    }

    // Supplement: EpisodicMemory (temporal episodes)
    if (this.episodicMemory && (!sources || sources.includes('episodic'))) {
      try {
        const episodes = this.episodicMemory.recall
          ? await this.episodicMemory.recall(query, { limit: Math.ceil(limit / 2) })
          : [];
        for (const ep of episodes) {
          results.push({
            source: 'episodic',
            score: ep.relevance || ep.score || 0.5,
            content: ep.summary || ep.text || JSON.stringify(ep),
            meta: { timestamp: ep.timestamp, tags: ep.tags },
            _backend: 'episodic',
          });
        }
        this._stats.backendHits.episodic++;
      } catch (err) {
        errors.push({ source: 'episodic', error: err.message });
      }
    }

    // Optional: Self-narrative for identity context
    if (includeNarrative && this.selfNarrative) {
      try {
        const narrative = this.selfNarrative.getCurrentNarrative?.() || null;
        if (narrative) {
          results.push({
            source: 'narrative',
            score: 0.3, // Low score — context, not answer
            content: typeof narrative === 'string' ? narrative : JSON.stringify(narrative),
            _backend: 'narrative',
          });
          this._stats.backendHits.narrative++;
        }
      } catch (err) {
        errors.push({ source: 'narrative', error: err.message });
      }
    }

    if (errors.length > 0) {
      _log.debug('[MEMORY-FACADE] Backend errors:', errors.map(e => `${e.source}: ${e.error}`).join('; '));
    }

    // Deduplicate by content similarity (simple substring check)
    const deduped = this._deduplicate(results);

    // Sort by score descending, limit
    deduped.sort((a, b) => (b.score || 0) - (a.score || 0));
    return deduped.slice(0, limit);
  }

  // ════════════════════════════════════════════════════════
  // STORE — Write-through to appropriate backends
  // ════════════════════════════════════════════════════════

  /**
   * Store content in the appropriate memory backend(s).
   * @param {string} content - Content to store
   * @param {string} type - 'fact' | 'episode' | 'message' | 'insight'
   * @param {object} meta - Additional metadata
   */
  async store(content, type = 'message', meta = {}) {
    this._stats.stores++;
    const stored = [];

    try {
      switch (type) {
        case 'fact':
          if (this.knowledgeGraph) {
            this.knowledgeGraph.addFact?.(content, meta);
            stored.push('knowledgeGraph');
          }
          break;

        case 'episode':
          if (this.episodicMemory) {
            this.episodicMemory.record?.(content, meta);
            stored.push('episodicMemory');
          }
          break;

        case 'message':
          if (this.conversationMemory) {
            this.conversationMemory.add?.(meta.role || 'user', content);
            stored.push('conversationMemory');
          }
          break;

        case 'insight':
          if (this.selfNarrative) {
            this.selfNarrative.addInsight?.(content, meta);
            stored.push('selfNarrative');
          }
          break;
      }

      // Always index in VectorMemory if available (cross-cutting)
      if (this.vectorMemory && content.length > 20) {
        try {
          await this.vectorMemory.index?.(content, { type, ...meta });
          stored.push('vectorMemory');
        } catch (err) {
          _log.debug('[MEMORY-FACADE] Vector index failed:', err.message);
        }
      }
    } catch (err) {
      _log.warn('[MEMORY-FACADE] Store failed:', err.message);
    }

    this.bus.emit('memory:stored', { type, backends: stored }, { source: 'MemoryFacade' });
    return { stored, type };
  }

  // ════════════════════════════════════════════════════════
  // KNOWLEDGE GRAPH — Pass-through (FIX v5.1.0 — A-2)
  //
  // Direct KG access by services like ToolBootstrap bypasses
  // the facade, creating a "memory silo bypass" flagged by
  // the architectural fitness check. These pass-throughs
  // route KG operations through the facade so the fitness
  // check shows zero violations.
  // ════════════════════════════════════════════════════════

  /**
   * Search the knowledge graph.
   * @param {string} query
   * @param {number} [limit=5]
   * @returns {Array} Search results
   */
  knowledgeSearch(query, limit = 5) {
    if (!this.knowledgeGraph) return [];
    return this.knowledgeGraph.search(query, limit);
  }

  /**
   * Connect two nodes in the knowledge graph.
   * @param {string} from - Source node
   * @param {string} relation - Edge type
   * @param {string} to - Target node
   * @returns {string|null} Edge ID
   */
  knowledgeConnect(from, relation, to) {
    if (!this.knowledgeGraph) return null;
    return this.knowledgeGraph.connect(from, relation, to);
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  getStats() {
    return {
      ...this._stats,
      backends: {
        unified: !!this.unifiedMemory,
        episodic: !!this.episodicMemory,
        vector: !!this.vectorMemory,
        conversation: !!this.conversationMemory,
        knowledgeGraph: !!this.knowledgeGraph,
        selfNarrative: !!this.selfNarrative,
        echoic: !!this.echoicMemory,
      },
      activeCount: [
        this.unifiedMemory, this.episodicMemory, this.vectorMemory,
        this.conversationMemory, this.knowledgeGraph, this.selfNarrative,
        this.echoicMemory,
      ].filter(Boolean).length,
    };
  }

  // ── Private ────────────────────────────────────────────

  _deduplicate(results) {
    const seen = new Set();
    return results.filter(r => {
      // Simple dedup: first 80 chars of content
      const key = (r.content || '').slice(0, 80).toLowerCase().trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

module.exports = { MemoryFacade };
