// @ts-checked-v5.8
// ============================================================
// GENESIS — VectorMemory.js (v3.5.0 — REVOLUTION)
//
// PROBLEM: KnowledgeGraph and ConversationMemory use keyword
// matching for retrieval. "How do I fix the auth bug?" won't
// find a memory about "authentication token validation error"
// because the words don't overlap.
//
// SOLUTION: A lightweight in-process vector store that uses
// Ollama's /api/embed endpoint for embeddings. No external
// database needed — vectors are stored as Float32Arrays in
// .genesis/vectors.bin with a JSON index.
//
// Architecture:
//   Text → Ollama embed → Float32Array → cosine similarity search
//   Stored: { id, text, vector, metadata, timestamp }
//
// Three collections:
//   - conversations: Chat history summaries (auto-populated)
//   - knowledge: Facts, insights, learnings (from KG)
//   - code: Code snippets, module summaries (from SelfModel)
//
// This replaces UnifiedMemory's buildContextBlock with
// semantic search instead of keyword matching.
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { TIMEOUTS } = require('../core/Constants');
const _log = createLogger('VectorMemory');

class VectorMemory {
  static containerConfig = {
    name: 'vectorMemory',
    phase: 8,
    deps: ['storage'],
    tags: ['revolution', 'memory'],
    lateBindings: [
      { target: 'promptBuilder', property: 'vectorMemory' },
    ],
    optional: true, // Works without embeddings, just less effective
  };

  constructor({ bus, storage, embeddingService, storageDir }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.embed = embeddingService || null;
    this.storageDir = storageDir;

    // ── Collections ──────────────────────────────────────
    this.collections = {
      conversations: [],  // { id, text, vector, metadata, ts }
      knowledge: [],
      code: [],
    };

    this._maxPerCollection = 500;
    this._dimensions = 0; // Set on first embed call

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      totalVectors: 0,
      searches: 0,
      avgSearchMs: 0,
      embedCalls: 0,
    };

    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
    this._wireEvents();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Add a text to a collection with its embedding.
   * @param {string} collection - 'conversations' | 'knowledge' | 'code'
   * @param {string} text - Text to embed and store
   * @param {object} metadata - Arbitrary metadata
   * @returns {Promise<string|null>}
   */
  async add(collection, text, metadata = {}) {
    if (!this.collections[collection]) return null;
    if (!text || text.length < 10) return null;

    const vector = await this._embed(text);
    if (!vector) return null;

    const id = `${collection}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const entry = {
      id,
      text: text.slice(0, 1000), // Cap stored text
      vector,
      metadata,
      ts: Date.now(),
    };

    this.collections[collection].push(entry);
    this._stats.totalVectors++;

    // Prune if over limit
    if (this.collections[collection].length > this._maxPerCollection) {
      this.collections[collection] = this.collections[collection].slice(-this._maxPerCollection);
    }

    this._debouncedSave();
    return id;
  }

  /**
   * Search across one or all collections by semantic similarity.
   * @param {string} query - Natural language query
   * @param {number} topK - Number of results
   * @param {string|null} collection - Specific collection or null for all
   * @returns {Promise<Array<*>>}
   */
  async search(query, topK = 5, collection = null) {
    const start = Date.now();
    this._stats.searches++;

    const queryVector = await this._embed(query);
    if (!queryVector) return [];

    // Search across collections
    const candidates = [];
    const collectionsToSearch = collection
      ? { [collection]: this.collections[collection] || [] }
      : this.collections;

    for (const [colName, entries] of Object.entries(collectionsToSearch)) {
      for (const entry of entries) {
        if (!entry.vector) continue;
        const score = this._cosineSimilarity(queryVector, entry.vector);
        candidates.push({
          text: entry.text,
          score,
          metadata: entry.metadata,
          collection: colName,
          id: entry.id,
          ts: entry.ts,
        });
      }
    }

    // Sort by similarity score
    candidates.sort((a, b) => b.score - a.score);

    const ms = Date.now() - start;
    this._stats.avgSearchMs = (this._stats.avgSearchMs * (this._stats.searches - 1) + ms) / this._stats.searches;

    return candidates.slice(0, topK);
  }

  /**
   * Build a context block for PromptBuilder using semantic search.
   * Replaces UnifiedMemory.buildContextBlock with vector-based retrieval.
   *
   * @param {string} query - Current user message
   * @param {number} maxChars - Max characters for the context block
   * @returns {Promise<string>}
   */
  async buildContextBlock(query, maxChars = 800) {
    const results = await this.search(query, 6);

    if (results.length === 0) return '';

    // Filter by minimum relevance threshold
    const relevant = results.filter(r => r.score > 0.3);
    if (relevant.length === 0) return '';

    const parts = ['RELEVANT MEMORY (semantic search):'];
    let totalChars = parts[0].length;

    for (const r of relevant) {
      const line = `- [${r.collection}/${Math.round(r.score * 100)}%] ${r.text.slice(0, 200)}`;
      if (totalChars + line.length > maxChars) break;
      parts.push(line);
      totalChars += line.length;
    }

    return parts.join('\n');
  }

  /**
   * Bulk-ingest text items. Used for initial population from
   * existing memory/KG data.
   */
  async ingest(collection, items) {
    let ingested = 0;
    for (const item of items) {
      const text = typeof item === 'string' ? item : item.text;
      const metadata = typeof item === 'object' ? item.metadata : {};
      const id = await this.add(collection, text, metadata);
      if (id) ingested++;
    }
    return ingested;
  }

  getStats() {
    return {
      ...this._stats,
      dimensions: this._dimensions,
      collections: Object.fromEntries(
        Object.entries(this.collections).map(([k, v]) => [k, v.length])
      ),
      available: !!this.embed?.isAvailable(),
    };
  }

  // ════════════════════════════════════════════════════════
  // EMBEDDING
  // ════════════════════════════════════════════════════════

  async _embed(text) {
    if (!this.embed || !this.embed.isAvailable()) return null;

    try {
      this._stats.embedCalls++;
      const vector = await this.embed.embed(text);
      if (vector && vector.length > 0) {
        this._dimensions = vector.length;
        return vector;
      }
    } catch (err) {
      _log.debug('[VECMEM] Embed failed:', err.message);
    }
    return null;
  }

  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  // ════════════════════════════════════════════════════════
  // AUTO-POPULATION VIA EVENTS
  // ════════════════════════════════════════════════════════

  _wireEvents() {
    // Auto-add conversation summaries
    this.bus.on('chat:completed', async (data) => {
      if (!data?.message || !data?.response) return;
      const text = `User: ${data.message.slice(0, 200)}\nGenesis: ${data.response.slice(0, 300)}`;
      await this.add('conversations', text, {
        intent: data.intent,
        success: data.success,
      });
    }, { source: 'VectorMemory', priority: -10 });

    // Auto-add knowledge graph learnings
    this.bus.on('knowledge:learned', async (data) => {
      if (data?.text) {
        await this.add('knowledge', data.text, { source: data.source });
      }
    }, { source: 'VectorMemory', priority: -10 });

    // Auto-add memory facts
    this.bus.on('memory:fact-stored', async (data) => {
      if (data?.key && data?.value) {
        await this.add('knowledge', `${data.key}: ${data.value}`, { type: 'fact' });
      }
    }, { source: 'VectorMemory', priority: -10 });

    // Auto-add idle thoughts
    this.bus.on('idle:thought-complete', async (data) => {
      if (data?.summary) {
        await this.add('knowledge', data.summary, { type: 'thought', activity: data.activity });
      }
    }, { source: 'VectorMemory', priority: -10 });
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      // Save index (text + metadata, no vectors)
      const index = {};
      for (const [colName, entries] of Object.entries(this.collections)) {
        index[colName] = entries.map(e => ({
          // @ts-ignore — TS inference limitation (checkJs)
          id: e.id, text: e.text, metadata: e.metadata, ts: e.ts,
          // @ts-ignore — TS inference limitation (checkJs)
          vecLen: e.vector?.length || 0,
        }));
      }
      // v3.7.1: Non-blocking writes — vector data can be large
      this.storage.writeJSONAsync('vector-index.json', index)
        .catch(err => _log.debug('[VECMEM] Index save failed:', err.message));

      // Save vectors as binary (much smaller than JSON)
      const allVectors = [];
      for (const entries of Object.values(this.collections)) {
        for (const entry of entries) {
          // @ts-ignore — TS inference limitation (checkJs)
          if (entry.vector) allVectors.push({ id: entry.id, vector: Array.from(entry.vector) });
        }
      }
      // Store as JSON for now — binary would be better but more complex
      this.storage.writeJSONAsync('vector-data.json', allVectors)
        .catch(err => _log.debug('[VECMEM] Vector save failed:', err.message));

    } catch (err) {
      _log.debug('[VECMEM] Save failed:', err.message);
    }
  }

  _debouncedSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._save(), TIMEOUTS.VECTOR_SAVE_DEBOUNCE);
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
      const index = this.storage.readJSON('vector-index.json', null);
      const vectors = this.storage.readJSON('vector-data.json', null);

      if (!index) return;

      // Build vector lookup
      const vecLookup = new Map();
      if (vectors) {
        for (const v of vectors) vecLookup.set(v.id, v.vector);
      }

      // Restore collections
      for (const [colName, entries] of Object.entries(index)) {
        if (!this.collections[colName]) continue;
        this.collections[colName] = entries.map(e => ({
          id: e.id,
          text: e.text,
          metadata: e.metadata,
          ts: e.ts,
          vector: vecLookup.get(e.id) || null,
        }));
      }

      this._stats.totalVectors = Object.values(this.collections)
        // @ts-ignore — TS inference limitation (checkJs)
        .reduce((sum, col) => sum + col.filter(e => e.vector).length, 0);

      if (this._stats.totalVectors > 0) {
        _log.info(`[VECMEM] Loaded ${this._stats.totalVectors} vectors`);
      }
    } catch (err) {
      _log.debug('[VECMEM] Load failed:', err.message);
    }
  }
}

module.exports = { VectorMemory };
