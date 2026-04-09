// @ts-checked-v5.7 — prototype delegation not visible to tsc
// ============================================================
// GENESIS — SchemaStore.js (Phase 9 — Cognitive Architecture)
//
// The wisdom library. Stores abstract patterns extracted by
// DreamCycle from episodic memory. These are reusable templates
// that modify expectations and guide planning.
//
// A Schema represents a learned insight:
//   "When refactoring after 5pm, test failures increase 20%"
//   "ANALYZE → CODE_GENERATE → RUN_TESTS fails on first try 40%"
//   "Shell commands on Windows need extra path escaping"
//
// SchemaStore is passive — it stores and retrieves. DreamCycle
// writes schemas, ExpectationEngine reads them. This separation
// means SchemaStore can exist at Phase 4 (planning layer) without
// depending on anything beyond StorageService.
//
// Integration:
//   DreamCycle.dream()          → schemaStore.store(schema)
//   ExpectationEngine.expect()  → schemaStore.match(action, context)
//   SelfNarrative.update()      → schemaStore.getConfident()
//   MentalSimulator.simulate()  → schemaStore.match() via ExpectationEngine
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('SchemaStore');

class SchemaStore {
  static containerConfig = {
    name: 'schemaStore',
    phase: 4,
    deps: ['storage'],
    tags: ['intelligence', 'memory', 'cognitive'],
    lateBindings: [],
  };

  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._maxSchemas = cfg.maxSchemas || 200;
    this._relevanceThreshold = cfg.relevanceThreshold || 0.3;
    this._confidenceDecayRate = cfg.confidenceDecayRate || 0.005;
    this._confidenceDecayIntervalMs = cfg.confidenceDecayIntervalMs || 3600000; // 1h

    // ── Schema Database ──────────────────────────────────
    this._schemas = [];
    this._index = new Map(); // keyword → Set<schema.id>

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      stored: 0,
      matched: 0,
      merged: 0,
      pruned: 0,
      queries: 0,
    };

    this._lastDecayAt = Date.now();
    this._dirty = false;
  }



  /* c8 ignore stop */

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('schemas.json', null);
      if (data && Array.isArray(data.schemas)) {
        this._schemas = data.schemas;
        this._stats = data.stats || this._stats;
    this._rebuildIndex();
      }
    } catch (err) {
      _log.warn('[SCHEMA-STORE] Failed to load schemas:', err.message);
    }
  }

  start() {
    // Periodic confidence decay — schemas that are never matched lose confidence
    this.bus.on('idle:thought-complete', () => {
    this._maybeDecay();
    }, { source: 'SchemaStore' });
  }

  stop() {
    // FIX D-1: Sync write on shutdown.
    this._saveSync();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Store a new schema. Deduplicates by checking similarity.
   *
   * @param {object} schema - { name, description, trigger, successModifier,
   *                            recommendation, confidence, sourcePattern,
   *                            occurrences }
   * @returns {object} The stored schema (possibly merged with existing)
   */
  store(schema) {
    if (!schema || !schema.name) return null;

    // Ensure required fields
    const normalized = {
      id: schema.id || `schema_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: schema.name,
      description: schema.description || '',
      trigger: schema.trigger || '',
      successModifier: typeof schema.successModifier === 'number'
        ? Math.max(-1, Math.min(1, schema.successModifier))
        : 0,
      recommendation: schema.recommendation || '',
      confidence: typeof schema.confidence === 'number'
        ? Math.max(0, Math.min(1, schema.confidence))
        : 0.5,
      sourcePattern: schema.sourcePattern || 'unknown',
      occurrences: schema.occurrences || 1,
      createdAt: schema.createdAt || Date.now(),
      lastUpdated: Date.now(),
      lastMatchedAt: null,
      matchCount: 0,
    };

    // Check for duplicate / merge candidate
    const existing =
    // @ts-ignore — genuine TS error, fix requires type widening
    this._findSimilar(normalized);
    if (existing) {
      existing.occurrences += normalized.occurrences;
      existing.confidence = Math.min(
        existing.confidence + normalized.confidence * 0.2,
        0.99
      );
      existing.lastUpdated = Date.now();
      // Prefer newer description if confidence is higher
      if (normalized.confidence > existing.confidence * 0.8) {
        existing.description = normalized.description || existing.description;
        existing.recommendation = normalized.recommendation || existing.recommendation;
      }
      this._stats.merged++;
      this._dirty = true;
      this._scheduleSave();

      this.bus.emit('schema:merged', {
        id: existing.id,
        name: existing.name,
        occurrences: existing.occurrences,
        confidence: existing.confidence,
      }, { source: 'SchemaStore' });

      return existing;
    }

    // Store new schema
    this._schemas.push(normalized);
    // @ts-ignore — genuine TS error, fix requires type widening
    this._addToIndex(normalized);
    this._stats.stored++;
    this._dirty = true;

    // Prune if over capacity
    if (this._schemas.length > this._maxSchemas) {
    this._prune();
    }

    this._scheduleSave();

    this.bus.emit('schema:stored', {
      id: normalized.id,
      name: normalized.name,
      confidence: normalized.confidence,
      sourcePattern: normalized.sourcePattern,
    }, { source: 'SchemaStore' });

    return normalized;
  }

  /**
   * Find schemas relevant to a given action + context.
   * Used by ExpectationEngine to adjust predictions.
   *
   * @param {object} action - { type, description, target }
   * @param {object} context - { recentActions, emotionalState }
   * @returns {Array<object>} Matching schemas, sorted by relevance
   */
  match(action, context = {}) {
    this._stats.queries++;

    if (!action || this._schemas.length === 0) return [];

    const actionType = (action.type || '').toLowerCase();
    const description = (action.description || '').toLowerCase();
    const target = (action.target || '').toLowerCase();

    // Collect candidate schemas via index
    const candidateIds = new Set();
    const searchTerms = [actionType, ...description.split(/\s+/).filter(w => w.length > 3)];

    for (const term of searchTerms) {
      const ids = this._index.get(term);
      if (ids) {
        for (const id of ids) candidateIds.add(id);
      }
    }

    // Score each candidate
    const results = [];
    const candidates = candidateIds.size > 0
      ? this._schemas.filter(s => candidateIds.has(s.id))
      : this._schemas; // Fallback: scan all (slow but complete)

    for (const schema of candidates) {
      const relevance =
    // @ts-ignore — genuine TS error, fix requires type widening
    this._scoreRelevance(schema, actionType, description, target, context);
      if (relevance >= this._relevanceThreshold) {
        results.push({ ...schema, _relevance: relevance });

        // Update match stats (non-blocking)
        schema.lastMatchedAt = Date.now();
        schema.matchCount = (schema.matchCount || 0) + 1;
        this._stats.matched++;
        this._dirty = true;
      }
    }

    if (results.length > 0) {
      this._scheduleSave();
    }

    return results
      .sort((a, b) => b._relevance - a._relevance)
      .slice(0, 5);
  }

  /**
   * Get a schema by ID.
   */
  get(id) {
    return this._schemas.find(s => s.id === id) || null;
  }

  /**
   * Get all schemas (for DreamCycle insight generation).
   */
  getAll() {
    return [...this._schemas];
  }

  /**
   * Get schemas by minimum confidence.
   * @param {number} minConfidence - 0.0 to 1.0
   */
  getConfident(minConfidence = 0.6) {
    return this._schemas.filter(s => s.confidence >= minConfidence);
  }

  /**
   * Get schemas by source pattern type.
   */
  getBySource(sourcePattern) {
    return this._schemas.filter(s => s.sourcePattern === sourcePattern);
  }

  /**
   * Remove a schema by ID.
   */
  remove(id) {
    const idx = this._schemas.findIndex(s => s.id === id);
    if (idx === -1) return false;

    const removed = this._schemas.splice(idx, 1)[0];
    // @ts-ignore — genuine TS error, fix requires type widening
    this._removeFromIndex(removed);
    this._dirty = true;
    this._scheduleSave();

    this.bus.emit('schema:removed', {
      id: removed.id, name: removed.name,
    }, { source: 'SchemaStore' });

    return true;
  }

  /**
   * Get store statistics.
   */
  getStats() {
    return {
      ...this._stats,
      totalSchemas: this._schemas.length,
      avgConfidence: this._schemas.length > 0
        ? this._schemas.reduce((s, x) => s + x.confidence, 0) / this._schemas.length
        : 0,
      topSchemas: this._schemas
        .sort((a, b) => (b.matchCount || 0) - (a.matchCount || 0))
        .slice(0, 5)
        .map(s => ({ name: s.name, matchCount: s.matchCount, confidence: s.confidence })),
    };
  }









  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  // ── Index/Scoring → SchemaStoreIndex.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._save();
    }, 5000);
  }

  _save() {
    if (!this.storage || !this._dirty) return;
    try {
      this.storage.writeJSONDebounced('schemas.json', this._saveData(), 2000);
      this._dirty = false;
    } catch (err) {
      _log.warn('[SCHEMA-STORE] Save failed:', err.message);
    }
  }

  /** FIX D-1: Sync write for shutdown path. */
  _saveSync() {
    if (!this.storage || !this._dirty) return;
    try {
      this.storage.writeJSON('schemas.json', this._saveData());
      this._dirty = false;
    } catch (err) {
      _log.warn('[SCHEMA-STORE] Sync save failed:', err.message);
    }
  }

  /** @private Shared payload for both save paths. */
  _saveData() {
    return {
      schemas: this._schemas,
      stats: this._stats,
      savedAt: Date.now(),
    };
  }
}

module.exports = { SchemaStore };

const { indexMethods } = require('./SchemaStoreIndex');
Object.assign(SchemaStore.prototype, indexMethods);
