// ============================================================
// GENESIS — hexagonal/EpisodicMemoryRecall.js (v7.6.1)
//
// Recall/scoring/embedding mixin extracted from EpisodicMemory.js
// in the v7.6.1 audit-closeout. Holds eight methods that operate on
// the EpisodicMemory instance via `this`:
//
//   _scoreRelevance       (relevance scoring with semantic boost)
//   _tokenize             (text → keyword set)
//   _detectCausalLinks    (auto-link to recent episodes)
//   _traceCausalChain     (BFS over _causalLinks)
//   _embedEpisode         (async embedding via embeddingService)
//   _semanticSimilarity   (cached cosine similarity)
//   _cacheQueryEmbedding  (LRU cache for query vectors)
//   _cosineSimilarity     (pure helper)
//
// Why split: EpisodicMemory.js was 758 LOC, mixing storage/lifecycle
// (constructor, recordEpisode, recall, layer-caps, getTransitionCandidates,
// setProtected, _save/_load) with scoring/causality/embedding (~205 LOC).
// The two concerns share state via `this` (_vectors, _queryCache,
// _embeddings, _episodes, _causalLinks) but the recall cluster is
// conceptually self-contained and doesn't need the persistence APIs.
//
// Coupling note: methods read/write
//   this._vectors           Map<id, vector>
//   this._queryCache        Map<query, {vector, ts}>
//   this._maxVectors        cap
//   this._embeddings        boolean — embeddingService available
//   this._episodes          array of records
//   this._causalLinks       array of {from, to, type, ts}
//   this.embeddingService   late-bound; null-checked at call-site
// All state is set in the EpisodicMemory constructor; the mixin never
// constructs its own state. Mixed onto EpisodicMemory.prototype at
// module-load via Object.assign — see EpisodicMemory.js bottom + the
// canonical Mixin Convention in ARCHITECTURE.md § 5.8.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('EpisodicMemory');

const recallMixin = {

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
  },

  _tokenize(text) {
    return (text || '').toLowerCase()
      .replace(/[^a-zäöüß0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2);
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },


};

module.exports = { recallMixin };
