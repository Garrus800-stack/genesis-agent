// @ts-checked-v5.7 — unbound `this` in prototype-delegation object
// ============================================================
// GENESIS — planning/SchemaStoreIndex.js (v5.6.0)
// Extracted via prototype delegation.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('SchemaStore');



const indexMethods = {

  // ════════════════════════════════════════════════════════
  // RELEVANCE SCORING
  // ════════════════════════════════════════════════════════

  _scoreRelevance(schema, actionType, description, target, context) {
    let score = 0;

    // 1. Trigger keyword overlap with description
    const triggerWords = (schema.trigger || '').toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const descWords = description.split(/\s+/).filter(w => w.length > 2);
    if (triggerWords.length > 0 && descWords.length > 0) {
      const overlap = triggerWords.filter(w => descWords.includes(w)).length;
      score += (overlap / triggerWords.length) * 0.4;
    }

    // 2. Action type match (schema references this action type in trigger or key)
    const schemaTriggerLower = (schema.trigger || '').toLowerCase();
    if (actionType && schemaTriggerLower.includes(actionType.toLowerCase())) {
      score += 0.3;
    }

    // 3. Source pattern match (action-sequence schemas are more specific)
    if (schema.sourcePattern === 'action-sequence') {
      const key = (schema.key || '').toLowerCase();
      if (key.includes(actionType)) score += 0.2;
    }

    // 4. Recency boost (recently matched schemas may still be relevant)
    if (schema.lastMatchedAt) {
      const hoursSince = (Date.now() - schema.lastMatchedAt) / 3600000;
      if (hoursSince < 24) {
        score += Math.max(0, 0.15 - hoursSince * 0.006);
      }
    }

    // 5. Target path similarity (if schema has a key containing paths)
    if (target && schema.key && schema.key.includes('/')) {
      const keyParts = schema.key.split('/');
      const targetParts = target.split('/');
      const pathOverlap = keyParts.filter(p => targetParts.includes(p)).length;
      if (pathOverlap > 0) score += 0.1;
    }

    // Weight by confidence
    score *= Math.max(schema.confidence, 0.1);

    return score;
  },

  // ════════════════════════════════════════════════════════
  // DEDUPLICATION
  // ════════════════════════════════════════════════════════

  _findSimilar(newSchema) {
    // Exact name match
    const byName = this._schemas.find(s =>
      s.name === newSchema.name && s.sourcePattern === newSchema.sourcePattern
    );
    if (byName) return byName;

    // Fuzzy trigger match (>60% keyword overlap)
    const newWords = new Set((newSchema.trigger || '').toLowerCase().split(/\s+/).filter(w => w.length > 2));
    if (newWords.size === 0) return null;

    for (const existing of this._schemas) {
      if (existing.sourcePattern !== newSchema.sourcePattern) continue;
      const existingWords = new Set(
        (existing.trigger || '').toLowerCase().split(/\s+/).filter(w => w.length > 2)
      );
      if (existingWords.size === 0) continue;

      let overlap = 0;
      for (const w of newWords) {
        if (existingWords.has(w)) overlap++;
      }
      const similarity = overlap / Math.max(newWords.size, existingWords.size);
      if (similarity > 0.6) return existing;
    }

    return null;
  },

  // ════════════════════════════════════════════════════════
  // INDEX
  // ════════════════════════════════════════════════════════

  _rebuildIndex() {
    this._index.clear();
    for (const schema of this._schemas) {
      this._addToIndex(schema);
    }
  },

  _addToIndex(schema) {
    const words = this._extractKeywords(schema);
    for (const word of words) {
      if (!this._index.has(word)) this._index.set(word, new Set());
      this._index.get(word).add(schema.id);
    }
  },

  _removeFromIndex(schema) {
    const words = this._extractKeywords(schema);
    for (const word of words) {
      const ids = this._index.get(word);
      if (ids) {
        ids.delete(schema.id);
        if (ids.size === 0) this._index.delete(word);
      }
    }
  },

  _extractKeywords(schema) {
    const text = `${schema.trigger || ''} ${schema.name || ''} ${schema.sourcePattern || ''}`;
    return text.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  },

  // ════════════════════════════════════════════════════════
  // PRUNING & DECAY
  // ════════════════════════════════════════════════════════

  _prune() {
    if (this._schemas.length <= this._maxSchemas) return;

    // Score each schema: confidence × log(matchCount + 1) × recency
    const scored = this._schemas.map(s => {
      const matchScore = Math.log2((s.matchCount || 0) + 1);
      const daysSinceMatch = s.lastMatchedAt
        ? (Date.now() - s.lastMatchedAt) / 86400000
        : 30; // Never matched = treat as 30 days old
      const recency = Math.max(0, 1 - daysSinceMatch / 60);
      return {
        schema: s,
        score: s.confidence * (matchScore + 0.5) * (recency + 0.1),
      };
    });

    scored.sort((a, b) => a.score - b.score);

    // Remove the lowest-scoring schemas
    const toRemove = scored.slice(0, this._schemas.length - this._maxSchemas);
    for (const { schema } of toRemove) {
      const idx = this._schemas.indexOf(schema);
      if (idx >= 0) {
        this._schemas.splice(idx, 1);
        this._removeFromIndex(schema);
        this._stats.pruned++;
      }
    }

    this.bus.emit('schema:pruned', {
      removed: toRemove.length,
      remaining: this._schemas.length,
    }, { source: 'SchemaStore' });
  },

  _maybeDecay() {
    if (Date.now() - this._lastDecayAt < this._confidenceDecayIntervalMs) return;
    this._lastDecayAt = Date.now();

    for (const schema of this._schemas) {
      // Never-matched schemas decay faster
      const matchBonus = schema.matchCount > 0 ? 0.5 : 1.0;
      schema.confidence = Math.max(
        0.05,
        schema.confidence - this._confidenceDecayRate * matchBonus
      );
    }

    this._dirty = true;
    this._scheduleSave();
  },

};

module.exports = { indexMethods };
