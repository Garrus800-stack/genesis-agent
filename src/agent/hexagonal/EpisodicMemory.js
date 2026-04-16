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
      keyInsights: data.keyInsights || [],
      tags: data.tags || [],
      relatedEpisodes: [],
    };

    // Add to store (newest first)
    this._episodes.unshift(episode);

    // Trim
    if (this._episodes.length > this._maxEpisodes) {
      const removed = this._episodes.splice(this._maxEpisodes);
      for (const ep of removed) {
        this._vectors.delete(ep.id);
        for (const tag of ep.tags) {
          this._tagIndex.get(tag)?.delete(ep.id);
        }
      }
    }

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

    this.bus.emit('episodic:recorded', {
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
  // RELEVANCE SCORING
  // ════════════════════════════════════════════════════════

  _scoreRelevance(episode, query) {
    if (!query) return 0;
    let score = 0;

    // 1. Keyword overlap (simple but effective)
    const queryWords = this._tokenize(query);
    const topicWords = this._tokenize(episode.topic + ' ' + episode.summary);
    const tagWords = episode.tags || [];
    const allEpWords = new Set([...topicWords, ...tagWords]);

    for (const qw of queryWords) {
      if (allEpWords.has(qw)) score += 1;
    }

    // Normalize by query length
    if (queryWords.length > 0) score = score / queryWords.length;

    // 2. Recency bonus (exponential decay)
    const ageHours = (Date.now() - episode.timestampMs) / (1000 * 60 * 60);
    const recencyBonus = Math.exp(-ageHours / (24 * 7)); // Half-life: ~1 week
    score += recencyBonus * 0.3;

    // 3. Semantic similarity (if embeddings available)
    if (this._vectors.has(episode.id)) {
      const similarity = this._semanticSimilarity(query, episode.id);
      if (similarity !== null) {
        score += similarity * 2; // Strong weight for semantic match
      }
    }

    // 4. Insight bonus — episodes with key insights are more valuable
    if (episode.keyInsights && episode.keyInsights.length > 0) {
      const insightWords = this._tokenize(episode.keyInsights.join(' '));
      for (const qw of queryWords) {
        if (insightWords.includes(qw)) score += 0.5;
      }
    }

    return score;
  }

  _tokenize(text) {
    return (text || '').toLowerCase()
      .replace(/[^a-zäöüß0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  }

  // ════════════════════════════════════════════════════════
  // CAUSAL LINKS
  // ════════════════════════════════════════════════════════

  _detectCausalLinks(newEpisode) {
    // Check against recent episodes (last 20)
    const recent = this._episodes.slice(1, 21); // Skip self (index 0)

    for (const older of recent) {
      // Same tags → likely related
      const sharedTags = (newEpisode.tags || []).filter(t => (older.tags || []).includes(t));
      if (sharedTags.length === 0) continue;

      // Same artifact files → likely causal
      const newFiles = new Set((newEpisode.artifacts || []).map(a => a.path));
      const olderFiles = (older.artifacts || []).map(a => a.path);
      const sharedFiles = olderFiles.filter(f => newFiles.has(f));

      if (sharedFiles.length > 0 || sharedTags.length >= 2) {
        const relation = sharedFiles.length > 0
          ? `Modified same files: ${sharedFiles.join(', ')}`
          : `Shared topics: ${sharedTags.join(', ')}`;

        this._causalLinks.push({
          from: older.id,
          to: newEpisode.id,
          relation,
          strength: sharedFiles.length + sharedTags.length,
        });

        // Update relatedEpisodes on both
        newEpisode.relatedEpisodes.push(older.id);
        older.relatedEpisodes = older.relatedEpisodes || [];
        older.relatedEpisodes.push(newEpisode.id);
      }
    }

    // Keep causal links trimmed
    if (this._causalLinks.length > 2000) {
      this._causalLinks = this._causalLinks.slice(-2000);
    }
  }

  _traceCausalChain(episodeId, maxDepth = 3) {
    const visited = new Set([episodeId]);
    const chain = [];
    let current = [episodeId];

    for (let depth = 0; depth < maxDepth && current.length > 0; depth++) {
      const next = [];
      for (const id of current) {
        // Find all links from/to this episode
        const links = this._causalLinks.filter(l => l.from === id || l.to === id);
        for (const link of links) {
          const otherId = link.from === id ? link.to : link.from;
          if (visited.has(otherId)) continue;
          visited.add(otherId);
          next.push(otherId);

          const episode = this._episodes.find(ep => ep.id === otherId);
          if (episode) {
            chain.push({ ...episode, causalRelation: link.relation, causalDepth: depth + 1 });
          }
        }
      }
      current = next;
    }

    return chain;
  }

  // ════════════════════════════════════════════════════════
  // EMBEDDINGS
  // ════════════════════════════════════════════════════════

  async _embedEpisode(episode) {
    if (!this._embeddings || !this._embeddings.isAvailable()) return;

    try {
      const text = `${episode.topic}. ${episode.summary}. ${(episode.keyInsights || []).join('. ')}`;
      const vector = await this._embeddings.embed(text);
      if (vector) {
        this._vectors.set(episode.id, vector);
        if (this._vectors.size > this._maxVectors) {
          // Remove oldest
          const firstKey = this._vectors.keys().next().value;
          this._vectors.delete(firstKey);
        }
      }
    } catch (_e) { _log.debug('[catch] Embedding failure is non-fatal:', _e.message); }
  }

  _semanticSimilarity(query, episodeId) {
    const episodeVec = this._vectors.get(episodeId);
    if (!episodeVec || !this._embeddings) return null;

    // Check query embedding cache (LRU)
    const cached = this._queryCache.get(query);
    if (cached) {
      cached.ts = Date.now(); // Touch for LRU
      return this._cosineSimilarity(cached.vector, episodeVec);
    }

    // Cache miss — schedule async embedding (non-blocking)
    // Return null for this call, but future calls with same query will hit cache
    this._cacheQueryEmbedding(query);
    return null;
  }

  async _cacheQueryEmbedding(query) {
    if (!this._embeddings || this._queryCache.has(query)) return;
    try {
      const vector = await this._embeddings.embed(query);
      if (!vector) return;

      // LRU eviction: remove oldest entry if at capacity
      if (this._queryCache.size >= this._queryCacheMax) {
        let oldestKey = null, oldestTs = Infinity;
        for (const [key, val] of this._queryCache) {
          if (val.ts < oldestTs) { oldestTs = val.ts; oldestKey = key; }
        }
        if (oldestKey) this._queryCache.delete(oldestKey);
      }

      this._queryCache.set(query, { vector, ts: Date.now() });
    } catch (_e) { _log.debug('[catch] Embedding failure is non-fatal:', _e.message); }
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
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


  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('episodic-memory.json', null);
      if (!data) return;
      if (Array.isArray(data.episodes)) this._episodes = data.episodes;
      if (Array.isArray(data.causalLinks)) this._causalLinks = data.causalLinks;
      if (data.counter) this._counter = data.counter;

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

module.exports = { EpisodicMemory };
