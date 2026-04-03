// @ts-checked-v5.6
// ============================================================
// GENESIS — CognitiveWorkspace.js (v5.2.0 — SA-P6)
//
// Transient working memory for active reasoning.
//
// PROBLEM: Genesis has 5 persistent memory stores (Conversation,
// Episodic, Vector, Unified, KnowledgeGraph) but no transient
// scratchpad. During multi-step reasoning, intermediate results
// either get lost between steps or pollute long-term memory.

/**
 * @typedef {{ key: string, value: *, salience: number, accessCount: number, createdAt: number, updatedAt: number }} WorkspaceSlot
 */
//
// SOLUTION: A capacity-limited workspace (inspired by Baddeley's
// working memory model) that lives for the duration of a goal.
// Items have salience scores that decay over time. When the goal
// completes, high-salience items can be consolidated to episodic
// memory via DreamCycle — everything else is discarded.
//
// Architecture:
//   - Slots: 9 max (7±2, configurable) — forces prioritization
//   - Each slot: { key, value, salience, accessCount, createdAt, updatedAt }
//   - Salience decays by 0.05 per step — unused items fade
//   - Access boosts salience by 0.1 — frequently used items persist
//   - When full, lowest-salience item is evicted
//   - Goal lifecycle: create → populate → reason → consolidate → clear
//
// Integration points:
//   - AgentLoop.pursue()         → creates workspace
//   - AgentLoop._executeLoop()   → auto-stores step summaries
//   - AgentLoop._buildStepContext → includes workspace in prompt
//   - PromptBuilder._workspace() → optional prompt section
//   - DreamCycle                 → consolidation hook
//
// Pattern: Same lightweight service as CancellationToken —
//   instantiated per goal, not a singleton.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('CognitiveWorkspace');

const DEFAULT_CAPACITY = 9;    // 7±2 — cognitive capacity limit
const SALIENCE_DECAY = 0.05;   // Per-step decay
const ACCESS_BOOST = 0.1;      // Salience boost on access
const MIN_CONSOLIDATION_SALIENCE = 0.4; // Minimum salience for DreamCycle pickup

class CognitiveWorkspace {
  /**
   * @param {object} [options]
   * @param {number} [options.capacity=9] - Max slots (7±2)
   * @param {string} [options.goalId]     - Goal this workspace serves
   * @param {string} [options.goalTitle]  - Human-readable goal description
   * @param {function} [options.onEvict]  - Callback(key, slot) called before eviction (v5.9.8)
   */
  constructor(options = {}) {
    this.capacity = options.capacity || DEFAULT_CAPACITY;
    this.goalId = options.goalId || null;
    this.goalTitle = options.goalTitle || null;
    this._onEvict = options.onEvict || null;

    /** @type {Map<string, WorkspaceSlot>} */
    this._slots = new Map();
    this._stepCount = 0;
    this._totalStores = 0;
    this._totalEvictions = 0;
    this._createdAt = Date.now();
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Store an item in working memory.
   * If at capacity, evicts the lowest-salience item.
   *
   * @param {string} key       - Semantic key (e.g., 'file-analysis', 'user-intent', 'error-pattern')
   * @param {*}      value     - Any serializable value
   * @param {number} [salience=0.7] - Initial importance (0-1)
   * @returns {{ stored: boolean, evicted?: string|null, reason?: string }}
   */
  store(key, value, salience = 0.7) {
    // Update existing slot
    if (this._slots.has(key)) {
      const slot = this._slots.get(key);
      if (slot) {
        slot.value = value;
        slot.salience = Math.min(1, Math.max(salience, slot.salience)); // Keep higher salience
        slot.updatedAt = Date.now();
        slot.accessCount++;
      }
      return { stored: true };
    }

    let evicted = null;

    // Evict lowest-salience item if at capacity
    if (this._slots.size >= this.capacity) {
      let minKey = null, minSalience = Infinity;
      for (const [k, s] of this._slots) {
        if (s.salience < minSalience) {
          minSalience = s.salience;
          minKey = k;
        }
      }
      if (minKey && salience > minSalience) {
        const evictedSlot = this._slots.get(minKey);
        // v5.9.8: Notify before deletion so callers can summarize/persist
        if (this._onEvict && evictedSlot) {
          try { this._onEvict(minKey, evictedSlot); } catch (_e) { _log.debug('[catch] onEvict callback:', _e.message); }
        }
        this._slots.delete(minKey);
        // v5.9.8: Return full evicted slot (key + value + salience) instead of just key
        evicted = evictedSlot ? { key: minKey, value: evictedSlot.value, salience: minSalience } : minKey;
        this._totalEvictions++;
        _log.debug(`[WM] Evicted "${minKey}" (salience ${minSalience.toFixed(2)}) for "${key}" (${salience.toFixed(2)})`);
      } else {
        // New item has lower salience than all existing — reject
        return { stored: false, reason: 'below-capacity-threshold' };
      }
    }

    this._slots.set(key, {
      key,
      value,
      salience: Math.min(1, Math.max(0, salience)),
      accessCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    this._totalStores++;
    return { stored: true, evicted };
  }

  /**
   * Recall an item. Boosts its salience (access = importance signal).
   * @param {string} key
   * @returns {*|null} The value, or null if not found
   */
  recall(key) {
    const slot = this._slots.get(key);
    if (!slot) return null;

    slot.accessCount++;
    slot.salience = Math.min(1, slot.salience + ACCESS_BOOST);
    return slot.value;
  }

  /**
   * Check if a key exists without boosting salience.
   * @param {string} key
   * @returns {boolean}
   */
  has(key) {
    return this._slots.has(key);
  }

  /**
   * Remove an item explicitly.
   * @param {string} key
   * @returns {boolean}
   */
  remove(key) {
    return this._slots.delete(key);
  }

  /**
   * Get all items sorted by salience (highest first).
   * Does NOT boost salience — this is a read-only snapshot.
   * @returns {Array<{ key: string, value: *, salience: number, accessCount: number }>}
   */
  snapshot() {
    return [...this._slots.values()]
      .sort((a, b) => b.salience - a.salience)
      .map(s => ({ key: s.key, value: s.value, salience: s.salience, accessCount: s.accessCount }));
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  /**
   * Called after each step. Decays all salience values.
   * Items that drop below 0.05 are auto-removed.
   */
  tick() {
    this._stepCount++;
    const toRemove = [];

    for (const [key, slot] of this._slots) {
      slot.salience = Math.max(0, slot.salience - SALIENCE_DECAY);
      if (slot.salience < 0.05) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      // v5.9.8: Notify before deletion
      if (this._onEvict) {
        const slot = this._slots.get(key);
        if (slot) { try { this._onEvict(key, slot); } catch (_e) { /* best effort */ } }
      }
      this._slots.delete(key);
      this._totalEvictions++;
      _log.debug(`[WM] Auto-decayed "${key}" after ${this._stepCount} steps`);
    }
  }

  /**
   * Build a prompt-ready summary of working memory contents.
   * Used by PromptBuilder and AgentLoop._buildStepContext.
   * @param {number} [maxItems=5] - Max items to include
   * @returns {string} Formatted working memory context
   */
  buildContext(maxItems = 5) {
    const items = this.snapshot().slice(0, maxItems);
    if (items.length === 0) return '';

    const lines = items.map(item => {
      const val = typeof item.value === 'string'
        ? item.value.slice(0, 200)
        : JSON.stringify(item.value).slice(0, 200);
      return `  [${item.key}] (salience: ${item.salience.toFixed(2)}): ${val}`;
    });

    return `WORKING MEMORY (${items.length}/${this.capacity} slots):\n${lines.join('\n')}`;
  }

  /**
   * Get items eligible for consolidation into long-term memory.
   * Called by DreamCycle before workspace is cleared.
   * @returns {Array<{ key: string, value: *, salience: number, accessCount: number }>}
   */
  getConsolidationCandidates() {
    return this.snapshot()
      .filter(item => item.salience >= MIN_CONSOLIDATION_SALIENCE || item.accessCount >= 3);
  }

  /**
   * Clear all slots. Called when goal completes.
   * @returns {{ itemsCleared: number, consolidated: number }}
   */
  clear() {
    const candidates = this.getConsolidationCandidates();
    const count = this._slots.size;
    this._slots.clear();
    _log.debug(`[WM] Cleared ${count} items (${candidates.length} consolidation candidates)`);
    return { itemsCleared: count, consolidated: candidates.length };
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  getStats() {
    return {
      goalId: this.goalId,
      goalTitle: this.goalTitle,
      slots: this._slots.size,
      capacity: this.capacity,
      steps: this._stepCount,
      totalStores: this._totalStores,
      totalEvictions: this._totalEvictions,
      avgSalience: this._slots.size > 0
        ? [...this._slots.values()].reduce((s, sl) => s + sl.salience, 0) / this._slots.size
        : 0,
      ageMs: Date.now() - this._createdAt,
    };
  }

  /** A null-object workspace that accepts all writes but stores nothing. */
  static get NULL() {
    return new NullWorkspace();
  }
}

/**
 * Null-object pattern for when no workspace is active.
 * All operations are safe no-ops.
 */
class NullWorkspace {
  store() { return { stored: false, reason: 'null-workspace' }; }
  recall() { return null; }
  has() { return false; }
  remove() { return false; }
  snapshot() { return []; }
  tick() {}
  buildContext() { return ''; }
  getConsolidationCandidates() { return []; }
  clear() { return { itemsCleared: 0, consolidated: 0 }; }
  getStats() { return { goalId: null, slots: 0, capacity: 0, steps: 0 }; }
}

module.exports = { CognitiveWorkspace, NullWorkspace };
