// ============================================================
// GENESIS — KnowledgePort.js (v3.5.0 — Hexagonal Architecture)
//
// Port interface + adapter for KnowledgeGraph access.
// 10 consumers to migrate.
// ============================================================

class KnowledgePort {
  addTriple(subject, predicate, object, meta) { throw new Error('Not implemented'); }
  search(query, limit) { throw new Error('Not implemented'); }
  query(pattern) { throw new Error('Not implemented'); }
  getStats() { return {}; }
  flush() {}
  setEmbeddingService(svc) {}
}

class KnowledgeGraphAdapter extends KnowledgePort {
  static containerConfig = {
    name: 'kg',
    phase: 1,
    deps: ['knowledgeGraph'],
    tags: ['port', 'foundation'],
    lateBindings: [],
    factory: (c) => new KnowledgeGraphAdapter(c.resolve('knowledgeGraph')),
  };

  constructor(knowledgeGraph) {
    super();
    this._kg = knowledgeGraph;
    this._metrics = { triples: 0, searches: 0, queries: 0 };
  }

  addTriple(subject, predicate, object, meta) {
    this._metrics.triples++;
    return this._kg.addTriple
      ? this._kg.addTriple(subject, predicate, object, meta)
      : this._kg.add?.(subject, predicate, object, meta);
  }

  search(query, limit = 5) {
    this._metrics.searches++;
    return this._kg.search(query, limit);
  }

  connect(sourceLabel, relation, targetLabel) {
    this._metrics.triples++;
    return this._kg.connect
      ? this._kg.connect(sourceLabel, relation, targetLabel)
      : this.addTriple(sourceLabel, relation, targetLabel);
  }

  query(pattern) {
    this._metrics.queries++;
    return this._kg.query ? this._kg.query(pattern) : [];
  }

  getStats() { return this._kg.getStats(); }
  flush() { this._kg.flush(); }
  setEmbeddingService(svc) { if (this._kg.setEmbeddingService) this._kg.setEmbeddingService(svc); }
  getMetrics() { return { ...this._metrics }; }
  get raw() { return this._kg; }
}

class MockKnowledge extends KnowledgePort {
  constructor() {
    super();
    this._triples = [];
    this._searchResults = [];
  }
  addTriple(s, p, o, m) { this._triples.push({ s, p, o, m }); }
  search(query, limit = 5) { return this._searchResults.slice(0, limit); }
  query(pattern) { return []; }
  getStats() { return { triples: this._triples.length }; }
  flush() {}
  setSearchResults(r) { this._searchResults = r; }
}

module.exports = { KnowledgePort, KnowledgeGraphAdapter, MockKnowledge };
