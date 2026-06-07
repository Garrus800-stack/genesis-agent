// @ts-checked-v5.7
// ============================================================
// GENESIS — EpisodicMemory.js (v3.5.0 — Cognitive Agent)
//
// "Last week when we worked on the MCP client, we had the
// same transport issue."
//
// Genesis gets a temporal, causal memory. Not just facts, not
// just conversation history — full episodes with temporal
// ordering, causal links, emotional arcs, and artifacts.
//
// Memory types (existing):
//   - ConversationMemory: session-based, TF-IDF
//   - VectorMemory: semantic search, embeddings
//   - KnowledgeGraph: facts, relations, concepts
//
// NEW:
//   - EpisodicMemory: temporal episodes, causal chains
//
// Recall strategies:
//   - Semantic: "things similar to X" (via embeddings)
//   - Temporal: "what did we do this week?" (timestamp filter)
//   - Causal: "what caused this problem?" (follow causal links)
//   - Tag-based: "all MCP-related work" (tag index)
//
// Integrated into UnifiedMemory as the 4th store.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EpisodicMemory');

// ── v7.3.7: Layer System Constants ─────────────────────────
// Episodes start at Layer 1 (Detail), get consolidated to Layer 2
// (Schema) over time, and unprotected ones eventually to Layer 3
// (Feeling). Protected episodes max at Layer 2 — the schema is
// kept plus a feelingEssence one-liner as a bonus marker.
const LAYER_CAPS = Object.freeze({
  1: { max: 500,   name: 'detail' },    // Detail
  2: { max: 1500,  name: 'schema' },    // Schema
  3: { max: null,  name: 'feeling' },   // Feeling (no cap, tiny payloads)
});
const MIN_DETAIL_EPISODES = 50;          // Youngest 50 always stay Layer 1
const HARD_RUNAWAY_CAP_L1 = 1000;        // Beyond this → dream:cycle-forced


class EpisodicMemory {
  constructor({ bus, storage, embeddingService, intervals }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this._embeddings = embeddingService || null;
    this._intervals = intervals || null;

    // ── Episode Store ─────────────────────────────────────
    this._episodes = [];           // Sorted by timestamp (newest first)
    this._maxEpisodes = 500;       // Keep last 500 episodes

    // ── Causal Links ──────────────────────────────────────
    this._causalLinks = [];        // { from, to, relation }

    // ── Vector Index ──────────────────────────────────────
    this._vectors = new Map();     // episodeId → embedding vector
    this._maxVectors = 500;

    // ── Query Embedding Cache (v3.5.0) ─────────────────
    this._queryCache = new Map();  // query string → { vector, ts }
    this._queryCacheMax = 50;      // LRU eviction after 50 entries

    // ── Tag Index ─────────────────────────────────────────
    this._tagIndex = new Map();    // tag → Set<episodeId>

    // ── Episode Counter (for unique IDs) ──────────────────
    this._counter = 0;

    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API: RECORD
  // ════════════════════════════════════════════════════════

  /**
   * Record a new episode. Called at the end of a conversation
   * or after an AgentLoop goal completes.
   *
   * @param {object} data
   * @param {string} data.topic - LLM-generated summary
   * @param {string} data.summary - Detailed description
   * @param {string} data.outcome - 'success'|'partial'|'failed'
   * @param {number} data.duration - seconds
   * @param {Array} data.artifacts - [{ type, path }]
   * @param {Array} data.toolsUsed - ['shell', 'sandbox']
   * @param {object} data.emotionalArc - { start: {}, end: {} }
   * @param {Array} data.keyInsights - ['SSE needs heartbeat timeout']
   * @param {string} [data.timestamp] - ISO timestamp
   * @param {number} [data.timestampMs] - Unix timestamp
   * @param {Array} data.tags - ['mcp', 'networking']
   * @returns {string} Episode ID
   */
  recordEpisode(data) {
    this._counter++;
    const id = `ep_${Date.now().toString(36)}_${this._counter}`;

    const episode = {
      id,
      timestamp: data.timestamp || new Date().toISOString(),
      timestampMs: data.timestampMs || Date.now(),
      topic: data.topic || 'Untitled episode',
      summary: data.summary || '',
      outcome: data.outcome || 'unknown',
      duration: data.duration || 0,
      artifacts: data.artifacts || [],
      toolsUsed: data.toolsUsed || [],
      emotionalArc: data.emotionalArc || null,
      // v7.9.20: carry surprise/emotional weight so DreamCycle prioritises the
      // emotionally salient episodes (read by DreamCycleAnalysis as
      // metadata?.surprise || emotionalWeight). Previously never written, so the
      // read side always saw 0 — a dead feature. Both ends are now wired.
      metadata: data.metadata || {},
      emotionalWeight: data.emotionalWeight != null ? data.emotionalWeight : null,
      keyInsights: data.keyInsights || [],
      tags: data.tags || [],
      relatedEpisodes: [],

      // ── v7.3.7: Layer system + Pin workflow + Anchors ──
      layer: 1,                                    // start in Detail
      layerHistory: [{ layer: 1, since: data.timestamp || new Date().toISOString() }],
      immuneAnchors: data.immuneAnchors || [],
      protected: data.protected === true,
      linkedCoreMemoryId: data.linkedCoreMemoryId || null,
      lastConsolidatedAt: null,
      feelingEssence: null,
      pinStatus: null,
      pinnedAt: null,
      pinReviewedAt: null,
    };

    // Add to store (newest first)
    this._episodes.unshift(episode);

    // v7.3.7: Layer-aware overflow handling.
    // Old behavior was blind splice at 500 episodes total.
    // New behavior:
    //   - Count only Layer-1 episodes against the 500 cap
    //   - When over, mark oldest non-skipped Layer-1 as transitionPending
    //     (DreamCycle Phase 4c will consolidate them on next run)
    //   - Hard runaway protection: > HARD_RUNAWAY_CAP_L1 → emit
    //     dream:cycle-forced so DreamCycle starts immediately
    //   - Always keep at least MIN_DETAIL_EPISODES youngest in Layer 1
    this._enforceLayerCaps();

    // Update tag index
    for (const tag of episode.tags) {
      if (!this._tagIndex.has(tag)) this._tagIndex.set(tag, new Set());
      this._tagIndex.get(tag).add(id);
    }

    // Detect causal links to recent episodes
    this._detectCausalLinks(episode);

    // Embed for semantic search (async, non-blocking)
    this._embedEpisode(episode).catch(() => { /* best effort */ });

    // Persist
    this._save();

    this.bus.fire('episodic:recorded', {
      id, topic: episode.topic, outcome: episode.outcome,
    }, { source: 'EpisodicMemory' });

    return id;
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API: RECALL
  // ════════════════════════════════════════════════════════

  /**
   * Recall episodes matching a query.
   *
   * @param {string} query - Natural language query
   * @param {object} [options]
   * @param {number} [options.maxResults] - Max episodes to return (default 5)
   * @param {number} [options.temporal] - Days to look back (e.g. 7 for last week)
   * @param {boolean} [options.causal] - Follow causal chains
   * @param {string} [options.tag] - Filter by tag
   * @param {string} [options.outcome] - Filter by outcome
   * @returns {Array} Episodes sorted by relevance
   */
  recall(query, options = {}) {
    const maxResults = options.maxResults || 5;
    let candidates = [...this._episodes];

    // ── Filter by temporal window ─────────────────────────
    if (options.temporal) {
      const cutoff = Date.now() - (options.temporal * 24 * 60 * 60 * 1000);
      candidates = candidates.filter(ep => ep.timestampMs >= cutoff);
    }

    // ── Filter by tag ─────────────────────────────────────
    if (options.tag) {
      const tagSet = this._tagIndex.get(options.tag);
      if (tagSet) {
        candidates = candidates.filter(ep => tagSet.has(ep.id));
      } else {
        candidates = [];
      }
    }

    // ── Filter by outcome ─────────────────────────────────
    if (options.outcome) {
      candidates = candidates.filter(ep => ep.outcome === options.outcome);
    }

    // ── Score candidates ──────────────────────────────────
    const scored = candidates.map(ep => ({
      ...ep,
      relevance: this._scoreRelevance(ep, query),
    }));

    // Sort by relevance
    scored.sort((a, b) => b.relevance - a.relevance);

    // ── Follow causal chains if requested ─────────────────
    let results = scored.slice(0, maxResults);
    if (options.causal && results.length > 0) {
      const causalEpisodes = this._traceCausalChain(results[0].id, 3);
      const existingIds = new Set(results.map(r => r.id));
      for (const causal of causalEpisodes) {
        if (!existingIds.has(causal.id)) {
          results.push({ ...causal, relevance: 0.5, causalLink: true });
        }
      }
    }

    return results;
  }

  /**
   * Get all episodes for a specific tag.
   */
  getByTag(tag) {
    const ids = this._tagIndex.get(tag);
    if (!ids) return [];
    return this._episodes.filter(ep => ids.has(ep.id));
  }

  /**
   * Get recent episodes (last N days).
   */
  getRecent(days = 7) {
    const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
    return this._episodes.filter(ep => ep.timestampMs >= cutoff);
  }

  /**
   * Build context string for PromptBuilder.
   * Returns relevant episodes for the current topic.
   */
  buildContext(currentTopic) {
    if (!currentTopic || this._episodes.length === 0) return '';

    const relevant = this.recall(currentTopic, { maxResults: 3 });
    if (relevant.length === 0) return '';

    const lines = relevant.map(ep => {
      const age = this._formatAge(ep.timestampMs);
      const insightStr = ep.keyInsights?.length > 0
        ? ` Insights: ${ep.keyInsights[0]}`
        : '';
      return `- [${age}] ${ep.topic} (${ep.outcome})${insightStr}`;
    });

    return `EPISODIC MEMORY:\n${lines.join('\n')}`;
  }

  /**
   * Get all known tags and their episode counts.
   */
  getTags() {
    const result = {};
    for (const [tag, ids] of this._tagIndex) {
      result[tag] = ids.size;
    }
    return result;
  }

  getStats() {
    return {
      totalEpisodes: this._episodes.length,
      causalLinks: this._causalLinks.length,
      vectorized: this._vectors.size,
      tags: this._tagIndex.size,
      oldestEpisode: this._episodes[this._episodes.length - 1]?.timestamp || null,
      newestEpisode: this._episodes[0]?.timestamp || null,
    };
  }









  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  _formatAge(timestampMs) {
    const diff = Date.now() - timestampMs;
    const hours = diff / (1000 * 60 * 60);
    if (hours < 1) return 'just now';
    if (hours < 24) return `${Math.round(hours)}h ago`;
    const days = hours / 24;
    if (days < 7) return `${Math.round(days)}d ago`;
    const weeks = days / 7;
    return `${Math.round(weeks)}w ago`;
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('episodic-memory.json', {
        episodes: this._episodes.slice(0, 200), // Save last 200
        causalLinks: this._causalLinks.slice(-500),
        counter: this._counter,
      });
    } catch (err) { _log.debug('[EPISODIC] Save error:', err.message); }
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();
  }


  // ════════════════════════════════════════════════════════
  // v7.3.7 — Layer System & Pin Workflow API
  // ════════════════════════════════════════════════════════

  /**
   * Layer-aware overflow enforcement. Called by recordEpisode() after
   * insert. Replaces the old blind splice at 500 episodes.
   *
   * Strategy:
   *  - Count Layer-1 episodes
   *  - Skip the youngest MIN_DETAIL_EPISODES (they always stay Detail)
   *  - Mark older Layer-1 episodes with transitionPending: true
   *    (DreamCycle Phase 4c will consolidate them on next run)
   *  - If Layer-1 count exceeds HARD_RUNAWAY_CAP_L1, emit
   *    dream:cycle-forced so DreamCycle starts immediately
   */
  _enforceLayerCaps() {
    const layer1 = this._episodes.filter(ep => (ep.layer || 1) === 1);
    if (layer1.length <= LAYER_CAPS[1].max) return;

    // Layer-1 sorted by age ascending (oldest first)
    layer1.sort((a, b) => (a.timestampMs || 0) - (b.timestampMs || 0));

    // Skip the youngest MIN_DETAIL_EPISODES → they stay Detail
    const youngestProtected = new Set(
      layer1.slice(-MIN_DETAIL_EPISODES).map(ep => ep.id)
    );

    let pendingTransitions = 0;
    for (const ep of layer1) {
      if (youngestProtected.has(ep.id)) continue;
      // Mark for transition (flüchtig — nicht persistiert, DreamCycle liest's)
      ep.transitionPending = true;
      pendingTransitions++;
    }

    this.bus.fire('memory:layer-overflow', {
      layer: 1,
      count: layer1.length,
      pendingTransitions,
    }, { source: 'EpisodicMemory' });

    if (layer1.length > HARD_RUNAWAY_CAP_L1) {
      this.bus.fire('dream:cycle-forced', {
        reason: 'layer-1-runaway',
        layerCount: layer1.length,
      }, { source: 'EpisodicMemory' });
    }
  }

  /**
   * v7.3.7: Get the most recently recorded episode (for mark-moment tool).
   * Returns null if no episodes yet.
   * @returns {object|null}
   */
  getLatest() {
    // _episodes is maintained newest-first via unshift
    return this._episodes[0] || null;
  }

  /**
   * Count of episodes recorded within the given window from now.
   * @param {number} windowMs
   * @returns {number}
   */
  getRecentCount(windowMs) {
    if (!Number.isFinite(windowMs) || windowMs <= 0) return 0;
    const cutoff = Date.now() - windowMs;
    return this._episodes.filter(ep => (ep.timestampMs || 0) >= cutoff).length;
  }

  /**
   * Episodes that have not been processed by DreamCycle yet.
   * Heuristic: lastConsolidatedAt is null AND not currently
   * marked as transitionPending. Used in DreamCycle.collectDreamContext().
   */
  getUnprocessed() {
    return this._episodes.filter(ep =>
      ep.lastConsolidatedAt == null && ep.transitionPending !== true
    );
  }

  /**
   * Episodes that are ripe for Layer-Transition.
   *
   * @param {object} [opts]
   * @param {number} [opts.maxPerCycle=10] - cap returned candidates
   * @param {(id:string) => boolean} [opts.skipIf] - return true to skip
   *   a given episode (used by DreamCycle to honor ActiveReferencesPort)
   * @returns {object[]}
   */
  getTransitionCandidates({ maxPerCycle = 10, skipIf = null } = {}) {
    // Two sources of candidates:
    //   1. Episodes marked transitionPending by _enforceLayerCaps
    //   2. Episodes naturally aging past layer thresholds
    const out = [];
    const skip = typeof skipIf === 'function' ? skipIf : () => false;

    for (const ep of this._episodes) {
      if (out.length >= maxPerCycle) break;
      if (skip(ep.id)) continue;
      if (ep.transitionPending === true) {
        out.push(ep);
        continue;
      }
      // Future: natural aging thresholds (Layer 2 → 3 after X days)
      // will be added when DreamCycle Phase 4c logic is wired (Step 7).
    }
    return out;
  }

  /**
   * Mark an episode as protected (immune from Layer-3 transition).
   * Idempotent — re-calling with the same value is a no-op.
   * @param {string} id
   * @param {boolean} value
   * @returns {boolean} true on state change
   */
  setProtected(id, value) {
    const ep = this._episodes.find(e => e.id === id);
    if (!ep) return false;
    const next = value === true;
    if (ep.protected === next) return false;
    ep.protected = next;
    this._save();
    return true;
  }

  /**
   * Link an episode to its CoreMemory. Used when Pin-Review
   * elevates a moment.
   * @param {string} id
   * @param {string|null} coreMemoryId
   * @returns {boolean} true on state change
   */
  setLinkedCoreMemoryId(id, coreMemoryId) {
    const ep = this._episodes.find(e => e.id === id);
    if (!ep) return false;
    if (ep.linkedCoreMemoryId === coreMemoryId) return false;
    ep.linkedCoreMemoryId = coreMemoryId;
    this._save();
    return true;
  }

  /**
   * Replace an episode in-place (preserves position, vector, tag index).
   * Used by DreamCycle Phase 4c when consolidating Layer 1 → 2.
   * The new episode MUST keep the original id; otherwise this rejects.
   *
   * @param {string} id
   * @param {object} newEpisode
   * @returns {boolean} true on success
   */
  replaceEpisode(id, newEpisode) {
    if (!newEpisode || newEpisode.id !== id) {
      _log.warn('[EPISODIC] replaceEpisode: id mismatch or null payload');
      return false;
    }
    const idx = this._episodes.findIndex(e => e.id === id);
    if (idx === -1) return false;

    const old = this._episodes[idx];
    // Preserve transient flags by clearing transitionPending on replacement
    delete newEpisode.transitionPending;
    // Preserve layerHistory append-only contract
    if (!Array.isArray(newEpisode.layerHistory)) {
      newEpisode.layerHistory = old.layerHistory || [];
    }

    this._episodes[idx] = newEpisode;

    // Rebuild tag index for this episode
    for (const tag of (old.tags || [])) {
      this._tagIndex.get(tag)?.delete(id);
    }
    for (const tag of (newEpisode.tags || [])) {
      if (!this._tagIndex.has(tag)) this._tagIndex.set(tag, new Set());
      this._tagIndex.get(tag).add(id);
    }

    this._save();
    return true;
  }

  // ════════════════════════════════════════════════════════
  // PRIVATE: Persistence
  // ════════════════════════════════════════════════════════

  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('episodic-memory.json', null);
      if (!data) return;
      if (Array.isArray(data.episodes)) this._episodes = data.episodes;
      if (Array.isArray(data.causalLinks)) this._causalLinks = data.causalLinks;
      if (data.counter) this._counter = data.counter;

      // v7.3.7: Self-migration. Episodes from v7.3.6 and earlier
      // have no layer/layerHistory/anchors fields. Add Defaults
      // using ORIGINAL timestamp as the layer-1 since-marker.
      // This is idempotent — episodes already migrated are skipped.
      let migrated = 0;
      for (const ep of this._episodes) {
        if (ep.layer === undefined) {
          ep.layer = 1;
          ep.layerHistory = [{ layer: 1, since: ep.timestamp }];
          ep.immuneAnchors = ep.immuneAnchors || [];
          ep.protected = ep.protected === true;
          ep.linkedCoreMemoryId = ep.linkedCoreMemoryId || null;
          ep.lastConsolidatedAt = null;
          ep.feelingEssence = null;
          ep.pinStatus = null;
          ep.pinnedAt = null;
          ep.pinReviewedAt = null;
          migrated++;
        }
      }
      if (migrated > 0) {
        _log.info(`[EPISODIC] v7.3.7 migration: ${migrated} legacy episodes initialized at layer 1`);
      }

      // Rebuild tag index
      for (const ep of this._episodes) {
        for (const tag of (ep.tags || [])) {
          if (!this._tagIndex.has(tag)) this._tagIndex.set(tag, new Set());
          this._tagIndex.get(tag).add(ep.id);
        }
      }
    } catch (err) { _log.debug('[EPISODIC] Load error:', err.message); }
  }
}

// v7.6.1 audit-closeout: recall-cluster (scoring, causality, embeddings)
// extracted to EpisodicMemoryRecall.js as a prototype mixin. Methods
// read/write shared state via `this` (the EpisodicMemory instance) —
// see EpisodicMemoryRecall.js header for the state-coupling note and
// ARCHITECTURE.md § 5.8 for the canonical mixin convention.
const { recallMixin } = require('./EpisodicMemoryRecall');
Object.assign(EpisodicMemory.prototype, recallMixin);

module.exports = { EpisodicMemory };
