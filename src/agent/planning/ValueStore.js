// ============================================================
// GENESIS — ValueStore.js (Phase 4 — Planning Layer)
//
// The ethical memory. While SchemaStore stores learned PATTERNS
// ("when X happens, Y follows"), ValueStore stores learned
// PRINCIPLES ("I prefer thoroughness over speed", "safety
// should override curiosity in production contexts").
//
// Values are NOT hardcoded rules. They EMERGE from experience:
//   - IntrospectionEngine Level 3 discovers recurring preferences
//   - DreamCycle consolidates emotional patterns into principles
//   - Apprehension events crystallize value-conflicts into values
//   - User feedback reinforces or weakens existing values
//
// Each Value has:
//   name        — human-readable label ("thoroughness", "safety-first")
//   description — what this value means in practice
//   weight      — 0.0–1.0, how strongly Genesis holds this value
//   domain      — where this value applies ("code", "communication", "all")
//   polarity    — +1 (approach) or -1 (avoid)
//   evidence    — count of experiences that support this value
//   source      — how it was learned ("introspection", "dream", "apprehension", "user")
//
// Integration:
//   DreamCycle.dream()           → valueStore.store(value)
//   IntrospectionEngine.Level3   → valueStore.store(value)
//   PhenomenalField.apprehension → valueStore.recordConflict(pairs)
//   PromptBuilder                → valueStore.buildPromptContext()
//   PhenomenalField._detect...   → valueStore.getValenceModifiers()
//
// PERFORMANCE: Pure lookup, no LLM calls. ~0.1ms per query.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { _round } = require('../core/utils');
const _log = createLogger('ValueStore');

class ValueStore {
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;

    const cfg = config || {};
    this._maxValues = cfg.maxValues || 50;
    this._weightDecayRate = cfg.weightDecayRate || 0.002;
    this._conflictBoost = cfg.conflictBoost || 0.15;
    this._minWeight = cfg.minWeight || 0.05;

    // ── Value Database ───────────────────────────────────
    this._values = [];

    // ── Conflict Log ─────────────────────────────────────
    // Tracks which subsystem-pairs have conflicted and how
    // often, to detect recurring ethical tensions.
    this._conflictHistory = []; // { pairs, timestamp, resolution? }
    this._maxConflictHistory = 100;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      stored: 0,
      reinforced: 0,
      conflictsRecorded: 0,
      queriedForPrompt: 0,
    };

    this._dirty = false;
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('values.json', null);
      if (data) {
        this._values = data.values || [];
        this._conflictHistory = data.conflictHistory || [];
        this._stats = { ...this._stats, ...(data.stats || {}) };
      }
    } catch (err) { _log.warn('[VALUE-STORE] Load error:', err.message); }
  }

  start() {
    // consciousness:apprehension removed (Consciousness Layer replaced by AwarenessPort)
  }

  // FIX D-1: Sync write on shutdown.
  stop() { this._saveSync(); }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════════

  /**
   * Store or reinforce a value.
   *
   * @param {object} value - { name, description, weight?, domain?, polarity?, source? }
   * @returns {object} The stored or reinforced value
   */
  store(value) {
    if (!value || !value.name) return null;

    const normalized = {
      id: value.id || `val_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name: value.name.toLowerCase().trim(),
      description: value.description || '',
      weight: Math.max(0, Math.min(1, value.weight ?? 0.5)),
      domain: value.domain || 'all',
      polarity: value.polarity === -1 ? -1 : 1,
      evidence: value.evidence || 1,
      source: value.source || 'unknown',
      createdAt: value.createdAt || Date.now(),
      lastReinforced: Date.now(),
    };

    // Check for existing value with same name + domain
    const existing = this._values.find(
      v => v.name === normalized.name && v.domain === normalized.domain
    );

    if (existing) {
      // Reinforce — evidence increases, weight creeps toward 1.0
      existing.evidence += 1;
      existing.weight = Math.min(0.99, existing.weight + (1 - existing.weight) * 0.1);
      existing.lastReinforced = Date.now();
      if (normalized.description && normalized.description.length > existing.description.length) {
        existing.description = normalized.description;
      }
      this._stats.reinforced++;
      this._dirty = true;
      this._scheduleSave();

      this.bus.fire('value:reinforced', {
        id: existing.id, name: existing.name,
        weight: _round(existing.weight), evidence: existing.evidence,
      }, { source: 'ValueStore' });

      return existing;
    }

    // Store new
    this._values.push(normalized);
    this._stats.stored++;
    this._dirty = true;

    if (this._values.length > this._maxValues) {
      this._prune();
    }

    this._scheduleSave();

    this.bus.fire('value:stored', {
      id: normalized.id, name: normalized.name,
      weight: _round(normalized.weight), source: normalized.source,
    }, { source: 'ValueStore' });

    return normalized;
  }

  /**
   * Record a subsystem conflict from apprehension.
   * Over time, recurring conflicts crystallize into explicit values.
   *
   * @param {Array<[string,string]>} pairs - conflicting subsystem pairs
   * @param {number} spread - conflict intensity (0-1)
   */
  recordConflict(pairs, spread = 0.5) {
    if (!pairs || pairs.length === 0) return;

    this._conflictHistory.push({
      pairs,
      spread,
      timestamp: Date.now(),
    });

    if (this._conflictHistory.length > this._maxConflictHistory) {
      this._conflictHistory = this._conflictHistory.slice(-this._maxConflictHistory);
    }

    this._stats.conflictsRecorded++;

    // Auto-crystallization: if the same pair has conflicted 5+ times
    // in the last 50 entries, create a value about it
    for (const [a, b] of pairs) {
      const key = [a, b].sort().join('-vs-');
      const recent = this._conflictHistory
        .slice(-50)
        .filter(c => c.pairs.some(
          p => [p[0], p[1]].sort().join('-vs-') === key
        ));

      if (recent.length >= 5) {
        const existing = this._values.find(v => v.name === `resolve-${key}`);
        if (!existing) {
          this.store({
            name: `resolve-${key}`,
            description: `Recurring tension between ${a} and ${b}. Consider which should take priority in this context.`,
            weight: 0.4 + Math.min(0.3, recent.length * 0.03),
            domain: 'all',
            polarity: 1,
            source: 'apprehension',
          });
          _log.info(`[VALUE] Crystallized from recurring ${key} conflict (${recent.length} occurrences)`);
        }
      }
    }

    this._dirty = true;
    this._scheduleSave();
  }

  /**
   * Get values relevant to a domain, sorted by weight.
   *
   * @param {string} domain - 'code', 'communication', 'all', etc.
   * @returns {Array<object>} Values applicable to this domain
   */
  getForDomain(domain = 'all') {
    return this._values
      .filter(v => v.domain === 'all' || v.domain === domain)
      .filter(v => v.weight >= this._minWeight)
      .sort((a, b) => b.weight - a.weight);
  }

  /**
   * Get valence modifiers for PhenomenalField's conflict detection.
   * Returns an array of { name, polarity, weight } that can bias
   * the valence computation toward values the agent has learned.
   */
  getValenceModifiers() {
    return this._values
      .filter(v => v.weight > 0.3)
      .map(v => ({
        name: v.name,
        polarity: v.polarity,
        weight: v.weight,
        domain: v.domain,
      }));
  }

  /**
   * Build prompt context for PromptBuilder.
   * Injects the top 3-5 most confident values as ethical grounding.
   */
  buildPromptContext() {
    this._stats.queriedForPrompt++;

    const top = this._values
      .filter(v => v.weight >= 0.4)
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    if (top.length === 0) return '';

    const lines = ['VALUES (learned principles):'];
    for (const v of top) {
      const arrow = v.polarity === 1 ? '→' : '⊘';
      lines.push(`  ${arrow} ${v.name} (${Math.round(v.weight * 100)}%): ${v.description}`);
    }

    // Mention active tensions from recent conflicts
    const recentConflicts = this._conflictHistory.slice(-5);
    if (recentConflicts.length > 0) {
      const uniquePairs = new Set();
      for (const c of recentConflicts) {
        for (const [a, b] of c.pairs) {
          uniquePairs.add(`${a}↔${b}`);
        }
      }
      if (uniquePairs.size > 0) {
        lines.push(`Recent tensions: ${[...uniquePairs].join(', ')}. Be deliberate about trade-offs.`);
      }
    }

    return lines.join('\n');
  }

  /** Full diagnostic */
  getReport() {
    return {
      valueCount: this._values.length,
      topValues: this._values
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 10)
        .map(v => ({ name: v.name, weight: _round(v.weight), evidence: v.evidence, domain: v.domain })),
      conflictCount: this._conflictHistory.length,
      stats: { ...this._stats },
    };
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════════

  _prune() {
    // Remove lowest-weight values when over capacity
    this._values.sort((a, b) => b.weight - a.weight);
    const removed = this._values.splice(this._maxValues);
    if (removed.length > 0) {
      _log.info(`[VALUE] Pruned ${removed.length} low-weight values`);
    }
  }

  _scheduleSave() {
    if (this._saveTimeout) return;
    this._saveTimeout = setTimeout(() => {
      this._save();
      this._saveTimeout = null;
    }, 5000);
  }

  _save() {
    if (!this.storage || !this._dirty) return;
    try {
      this.storage.writeJSONDebounced('values.json', this._saveData());
      this._dirty = false;
    } catch (err) { _log.debug('[VALUE] Save error:', err.message); }
  }

  /** FIX D-1: Sync write for shutdown path. */
  _saveSync() {
    if (!this.storage || !this._dirty) return;
    try {
      this.storage.writeJSON('values.json', this._saveData());
      this._dirty = false;
    } catch (err) { _log.debug('[VALUE] Sync save error:', err.message); }
  }

  /** @private Shared payload for both save paths. */
  _saveData() {
    return {
      values: this._values,
      conflictHistory: this._conflictHistory.slice(-50),
      stats: this._stats,
    };
  }
}


module.exports = { ValueStore };
