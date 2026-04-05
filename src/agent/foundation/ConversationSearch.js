// ============================================================
// GENESIS — ConversationSearch.js (v5.2.0 — Delegate Extraction)
//
// Extracted from ConversationMemory.js (29→19 methods).
//
// Contains: TF-IDF search engine, embedding vector management,
// content extraction helpers (summarize, topics, intents).
//
// ConversationMemory calls this delegate for all search/recall
// operations. The delegate owns the index data internally —
// ConversationMemory passes episodes via rebuild().
//
// Pattern: Same as McpCodeExec, DreamCycle phase delegates.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('ConversationSearch');

class ConversationSearchDelegate {
  constructor() {
    this._idfCache = new Map(); this._maxIdfCache = 5000;    // term → idf score
    this._docVectors = [];         // parallel to episodes: Map<term, tfidf>
    this._embeddings = null;       // optional EmbeddingService
    this._embeddingVectors = [];   // parallel to episodes: Float64Array[]
  }

  /** Attach optional EmbeddingService for semantic recall */
  setEmbeddingService(svc) {
    this._embeddings = svc;
  }

  // ════════════════════════════════════════════════════════
  // INDEX
  // ════════════════════════════════════════════════════════

  /**
   * Rebuild TF-IDF index from episode list.
   * @param {Array} episodes - db.episodic array
   */
  rebuild(episodes) {
    const df = new Map();
    const docs = episodes.map(ep => {
      const text = `${ep.summary} ${ep.topics.join(' ')} ${(ep.lastExchange || []).map(m => m.content).join(' ')}`;
      return this.tokenize(text);
    });

    const N = docs.length || 1;
    for (const terms of docs) {
      const unique = new Set(terms);
      for (const term of unique) {
        df.set(term, (df.get(term) || 0) + 1);
      }
    }

    this._idfCache = new Map();
    for (const [term, count] of df) {
      this._idfCache.set(term, Math.log(N / count));
    }

    this._docVectors = docs.map(terms => this._tfVector(terms));
  }

  // ════════════════════════════════════════════════════════
  // RECALL
  // ════════════════════════════════════════════════════════

  /**
   * TF-IDF cosine similarity recall.
   * @param {string} query
   * @param {Array} episodes
   * @param {number} limit
   * @returns {Array} Matching episodes sorted by relevance
   */
  recallTfIdf(query, episodes, limit) {
    const queryVec = this._tfidfVector(query);
    if (queryVec.size === 0) return [];

    const scored = episodes.map((ep, i) => {
      const docVec = this._docVectors[i];
      if (!docVec || docVec.size === 0) return { episode: ep, score: 0 };
      const sim = this.cosineSimilarity(queryVec, docVec);
      const age = Date.now() - new Date(ep.timestamp).getTime();
      const recency = Math.max(0, 1 - age / (30 * 24 * 60 * 60 * 1000));
      return { episode: ep, score: sim * 0.8 + recency * 0.2 };
    });

    return scored
      .filter(s => s.score > 0.05)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(s => s.episode);
  }

  /**
   * Async recall with vector embeddings, falling back to TF-IDF.
   * @param {string} query
   * @param {Array} episodes
   * @param {number} limit
   * @returns {Promise<Array>}
   */
  async recallAsync(query, episodes, limit) {
    if (this._embeddings?.isAvailable() && episodes.length > 0) {
      try {
        const queryVec = await this._embeddings.embed(query);
        if (queryVec) {
          await this._ensureEmbeddingVectors(episodes);

          const scored = episodes.map((ep, i) => {
            const embVec = this._embeddingVectors[i];
            if (!embVec) return { episode: ep, score: 0 };
            const sim = this._embeddings.cosineSimilarity(queryVec, embVec);
            const age = Date.now() - new Date(ep.timestamp).getTime();
            const recency = Math.max(0, 1 - age / (30 * 24 * 60 * 60 * 1000));
            return { episode: ep, score: sim * 0.75 + recency * 0.25 };
          });

          const results = scored
            .filter(s => s.score > 0.1)
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(s => s.episode);

          if (results.length > 0) return results;
        }
      } catch (err) {
        _log.debug('[SEARCH] Embedding recall failed, using TF-IDF:', err.message);
      }
    }
    return this.recallTfIdf(query, episodes, limit);
  }

  /** Pre-compute embedding vectors for episodes missing them */
  async _ensureEmbeddingVectors(episodes) {
    if (!this._embeddings?.isAvailable()) return;
    for (let i = 0; i < episodes.length; i++) {
      if (!this._embeddingVectors[i]) {
        const ep = episodes[i];
        const text = `${ep.summary} ${ep.topics.join(' ')}`;
        this._embeddingVectors[i] = await this._embeddings.embed(text);
      }
    }
  }

  // ════════════════════════════════════════════════════════
  // TF-IDF INTERNALS
  // ════════════════════════════════════════════════════════

  _tfVector(terms) {
    const tf = new Map();
    for (const t of terms) tf.set(t, (tf.get(t) || 0) + 1);
    const vec = new Map();
    for (const [term, count] of tf) {
      const idf = this._idfCache.get(term) || 1;
      vec.set(term, (count / terms.length) * idf);
    }
    return vec;
  }

  _tfidfVector(text) {
    return this._tfVector(this.tokenize(text));
  }

  cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (const [term, val] of a) {
      magA += val * val;
      if (b.has(term)) dot += val * b.get(term);
    }
    for (const [, val] of b) magB += val * val;
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
  }

  // ════════════════════════════════════════════════════════
  // CONTENT EXTRACTION
  // ════════════════════════════════════════════════════════

  tokenize(text) {
    return text.toLowerCase().replace(/[^a-zäöüß0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  }

  autoSummarize(conversation) {
    const firstUser = conversation.find(m => m.role === 'user');
    if (!firstUser) return 'Leere Konversation';
    return firstUser.content.slice(0, 200);
  }

  extractTopics(conversation) {
    const allText = conversation.map(m => m.content).join(' ').toLowerCase();
    const techTerms = [
      'code', 'bug', 'fehler', 'skill', 'modul', 'datei', 'test',
      'architektur', 'performance', 'klon', 'modell', 'prompt',
      'reparatur', 'optimierung', 'memory', 'sandbox', 'api',
    ];
    return techTerms.filter(t => allText.includes(t));
  }

  extractIntents(conversation) {
    const intents = new Set();
    for (const m of conversation) {
      if (m.role !== 'user') continue;
      const lower = m.content.toLowerCase();
      if (/zeig|inspiz|analy|structure/i.test(lower)) intents.add('inspect');
      if (/änder|modif|verbes|optim/i.test(lower)) intents.add('modify');
      if (/repar|fix|heal/i.test(lower)) intents.add('repair');
      if (/skill|fähig/i.test(lower)) intents.add('skill');
      if (/klon|clone|kopie/i.test(lower)) intents.add('clone');
    }
    return [...intents];
  }

  /** DA-1: Evict oldest entries when _idfCache exceeds cap */
  _trimIdfCache() {
    if (this._idfCache.size <= this._maxIdfCache) return;
    this._idfCache.clear(); // Cache — safe to clear entirely
  }
}

module.exports = { ConversationSearchDelegate };
