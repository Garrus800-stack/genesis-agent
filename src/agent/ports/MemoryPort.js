// ============================================================
// GENESIS — MemoryPort.js (v3.5.0 — Hexagonal Architecture)
//
// Port interface + adapter for memory subsystem access.
// Wraps ConversationMemory. 9 consumers to migrate.
// ============================================================

class MemoryPort {
  async addEpisode(messages) { throw new Error('Not implemented'); }
  search(query, limit) { throw new Error('Not implemented'); }
  addSemantic(key, value, source) { throw new Error('Not implemented'); }
  getSemantic(key) { throw new Error('Not implemented'); }
  getStats() { return {}; }
  flush() {}
  setEmbeddingService(svc) {}
}

class ConversationMemoryAdapter extends MemoryPort {
  constructor(conversationMemory) {
    super();
    this._mem = conversationMemory;

    this._metrics = {
      searches: 0,
      episodesAdded: 0,
      semanticWrites: 0,
      searchHits: 0,
      searchMisses: 0,
    };
  }

  async addEpisode(messages) {
    this._metrics.episodesAdded++;
    return this._mem.addEpisode(messages);
  }

  search(query, limit = 5) {
    this._metrics.searches++;
    const results = this._mem.search(query, limit);
    if (results && results.length > 0) {
      this._metrics.searchHits++;
    } else {
      this._metrics.searchMisses++;
    }
    return results;
  }

  addSemantic(key, value, source) {
    this._metrics.semanticWrites++;
    return this._mem.addSemantic
      ? this._mem.addSemantic(key, value, source)
      : (this._mem.db && this._mem.db.semantic
          ? (this._mem.db.semantic[key] = { value, source, ts: Date.now() })
          : null);
  }

  getSemantic(key) {
    return this._mem.getSemantic
      ? this._mem.getSemantic(key)
      : this._mem.db?.semantic?.[key]?.value || null;
  }

  getStats() { return this._mem.getStats(); }
  flush() { this._mem.flush(); }
  setEmbeddingService(svc) { if (this._mem.setEmbeddingService) this._mem.setEmbeddingService(svc); }

  getMetrics() { return { ...this._metrics }; }

  /** Direct access to underlying memory (escape hatch for legacy code) */
  get raw() { return this._mem; }
}

class MockMemory extends MemoryPort {
  constructor() {
    super();
    this._episodes = [];
    this._semantic = {};
    this._searchResults = [];
  }
  async addEpisode(messages) { this._episodes.push(messages); }
  search(query, limit = 5) { return this._searchResults.slice(0, limit); }
  addSemantic(key, value, source) { this._semantic[key] = { value, source }; }
  getSemantic(key) { return this._semantic[key]?.value || null; }
  getStats() { return { episodes: this._episodes.length, semantic: Object.keys(this._semantic).length }; }
  flush() {}
  setSearchResults(results) { this._searchResults = results; }
}

module.exports = { MemoryPort, ConversationMemoryAdapter, MockMemory };
