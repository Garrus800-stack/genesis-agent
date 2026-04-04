// @ts-checked-v5.7
// ============================================================
// GENESIS — AdaptiveMemory.js (Phase 12 — Symbolic+Neural Hybrid)
//
// @deprecated v6.0.1 — Scheduled for removal. Only 3 external
// references remain. Use UnifiedMemory for retrieval and
// MemoryConsolidator for decay/pruning. See SELF-ANALYSIS-AUDIT.md
// Claim 2 for rationale.
//
// PROBLEM: VectorMemory has uniform decay (500 entries, FIFO).
// ConversationMemory stores everything linearly. DreamCycle
// uses a single decay rate. But memories are NOT equal:
//
//   - A moment of high surprise should be remembered forever
//   - A routine chat should decay quickly
//   - An emotionally charged failure should strengthen learning
//   - Repeated patterns should consolidate into schemas
//
// SOLUTION: Each memory gets a "retention score" computed from:
//   1. Emotional valence at time of storage
//   2. Surprise signal (from SurpriseAccumulator)
//   3. Retrieval frequency (memories accessed often persist)
//   4. Semantic importance (scored by simple heuristics)
//   5. Recency (exponential decay, modulated by above)
//
// High-retention memories decay slowly. Low-retention memories
// are compressed or deleted during consolidation.
//
// Integration:
//   EpisodicMemory.store()     → AdaptiveMemory.score(episode)
//   DreamCycle.consolidate()   → AdaptiveMemory.consolidate()
//   VectorMemory.add()         → AdaptiveMemory.prioritize()
//   ConversationMemory.prune() → AdaptiveMemory.selectForPruning()
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('AdaptiveMemory');

// ── Retention Score Weights ──────────────────────────────
const WEIGHTS = {
  surprise: 0.30,        // High surprise = memorable
  emotionalIntensity: 0.25, // Strong emotions = memorable
  retrievalCount: 0.20,  // Frequently accessed = important
  importance: 0.15,      // Semantic importance
  recency: 0.10,         // Recent = slightly more retained
};

// ── Importance Keywords ──────────────────────────────────
const HIGH_IMPORTANCE_PATTERNS = [
  /error|fehler|bug|crash|fail/i,
  /learned|gelernt|insight|erkenntnis/i,
  /user.*prefer|benutzer.*bevorzug/i,
  /success|erfolg|achieved|erreicht/i,
  /decision|entscheidung|chose|gewählt/i,
  /schema|pattern|muster/i,
  /self-modif|self-repair|self-optim/i,
];

const LOW_IMPORTANCE_PATTERNS = [
  /greeting|begrüßung|hello|hallo/i,
  /acknowledged|bestätigt/i,
  /how are you|wie geht/i,
];

class AdaptiveMemory {
  static containerConfig = {
    name: 'adaptiveMemory',
    phase: 5,
    deps: ['storage', 'eventStore'],
    tags: ['memory', 'intelligence'],
    lateBindings: [
      { prop: 'emotionalState', service: 'emotionalState', optional: true },
      { prop: 'surpriseAccumulator', service: 'surpriseAccumulator', optional: true },
      { prop: 'episodicMemory', service: 'episodicMemory', optional: true },
      { prop: 'vectorMemory', service: 'vectorMemory', optional: true },
    ],
  };

  constructor({ bus, storage, eventStore, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.eventStore = eventStore || null;
    this.emotionalState = null;  // lateBinding
    this.surpriseAccumulator = null; // lateBinding
    this.episodicMemory = null;  // lateBinding
    this.vectorMemory = null;    // lateBinding

    const cfg = config || {};
    this._weights = { ...WEIGHTS, ...cfg.weights };
    this._pruneThreshold = cfg.pruneThreshold || 0.15; // Below this → prune
    this._compressThreshold = cfg.compressThreshold || 0.30; // Below this → compress
    this._maxRetentionEntries = cfg.maxEntries || 5000;
    this._decayRatePerHour = cfg.decayRate || 0.01; // Base decay per hour

    // ── Retention Scores ─────────────────────────────────
    this._retentionScores = new Map(); // memoryId → { score, lastUpdated, accessCount }
    this._loaded = false;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      scored: 0,
      pruned: 0,
      compressed: 0,
      consolidated: 0,
    };
  }

  async asyncLoad() {
    try {
      const saved = await this.storage?.readJSON('adaptive-memory.json');
      if (saved?.scores) {
        this._retentionScores = new Map(Object.entries(saved.scores));
        this._stats = { ...this._stats, ...saved.stats };
      }
    } catch (_e) { _log.debug('[catch] no saved data:', _e.message); }
    this._loaded = true;
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Score a memory's retention priority.
   *
   * @param {object} memory — { id, text, type, timestamp, metadata }
   * @param {object} context — { surprise, emotion, importance }
   * @returns {number} retention score 0.0–1.0
   */
  score(memory, context = {}) {
    this._stats.scored++;

    const surprise = context.surprise ?? this._getCurrentSurprise();
    const emotion = context.emotion ?? this._getCurrentEmotionalIntensity();
    const importance = context.importance ?? this._assessImportance(memory.text || '');
    const recency = this._recencyScore(memory.timestamp || Date.now());

    // Check if this memory has been accessed before
    const existing = this._retentionScores.get(memory.id);
    const accessCount = existing ? existing.accessCount : 0;
    const retrievalScore = Math.min(1.0, accessCount / 10); // Caps at 10 accesses

    const score = (
      this._weights.surprise * surprise +
      this._weights.emotionalIntensity * emotion +
      this._weights.retrievalCount * retrievalScore +
      this._weights.importance * importance +
      this._weights.recency * recency
    );

    const clamped = Math.max(0, Math.min(1.0, score));

    this._retentionScores.set(memory.id, {
      score: clamped,
      lastUpdated: Date.now(),
      accessCount: accessCount,
      surprise,
      emotion,
      importance,
    });

    // Trim retention map
    if (this._retentionScores.size > this._maxRetentionEntries) {
      this._trimRetentionMap();
    }

    return clamped;
  }

  /**
   * Record that a memory was accessed (boosts retention).
   * @param {string} memoryId
   */
  recordAccess(memoryId) {
    const entry = this._retentionScores.get(memoryId);
    if (entry) {
      entry.accessCount++;
      entry.lastUpdated = Date.now();
      // Recalculate score with boosted retrieval
      const retrievalScore = Math.min(1.0, entry.accessCount / 10);
      entry.score = Math.min(1.0, entry.score + this._weights.retrievalCount * retrievalScore * 0.1);
    }
  }

  /**
   * Get retention score for a memory.
   * @param {string} memoryId
   * @returns {number|null}
   */
  getScore(memoryId) {
    const entry = this._retentionScores.get(memoryId);
    return entry ? entry.score : null;
  }

  /**
   * Select memories for pruning (low retention).
   * @param {Array} memories — [{ id, text, timestamp }]
   * @returns {{ keep: Array, prune: Array, compress: Array }}
   */
  selectForPruning(memories) {
    const keep = [];
    const prune = [];
    const compress = [];

    for (const mem of memories) {
      const entry = this._retentionScores.get(mem.id);
      const score = entry ? this._applyDecay(entry) : this.score(mem);

      if (score < this._pruneThreshold) {
        prune.push({ ...mem, retentionScore: score });
      } else if (score < this._compressThreshold) {
        compress.push({ ...mem, retentionScore: score });
      } else {
        keep.push({ ...mem, retentionScore: score });
      }
    }

    this._stats.pruned += prune.length;
    this._stats.compressed += compress.length;

    return { keep, prune, compress };
  }

  /**
   * Run consolidation: decay all scores and clean up.
   * Call during DreamCycle or periodic maintenance.
   * @returns {Promise<{ decayed: any, pruned: any, total: any }>}
   */
  async consolidate() {
    this._stats.consolidated++;
    let decayed = 0;
    const toDelete = [];

    for (const [id, entry] of this._retentionScores) {
      const newScore = this._applyDecay(entry);
      if (newScore < this._pruneThreshold * 0.5) {
        toDelete.push(id); // Score decayed to negligible
      } else if (newScore !== entry.score) {
        entry.score = newScore;
        entry.lastUpdated = Date.now();
        decayed++;
      }
    }

    for (const id of toDelete) {
      this._retentionScores.delete(id);
    }

    // Save periodically
    await this._save();

    this.bus.emit('memory:consolidated', {
      decayed,
      pruned: toDelete.length,
      total: this._retentionScores.size,
    }, { source: 'AdaptiveMemory' });

    return { decayed, pruned: toDelete.length, total: this._retentionScores.size };
  }

  /**
   * Get memory statistics.
   */
  getStats() {
    const scores = [...this._retentionScores.values()].map(e => e.score);
    return {
      ...this._stats,
      totalTracked: this._retentionScores.size,
      avgScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 100) / 100 : 0,
      highRetention: scores.filter(s => s > 0.7).length,
      lowRetention: scores.filter(s => s < 0.3).length,
    };
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  _getCurrentSurprise() {
    if (!this.surpriseAccumulator) return 0.5;
    const recent = this.surpriseAccumulator.getRecentSignals?.(1);
    if (recent?.length > 0) {
      return Math.min(1.0, recent[0].magnitude || 0.5);
    }
    return 0.3; // Default: low surprise
  }

  _getCurrentEmotionalIntensity() {
    if (!this.emotionalState?.dimensions) return 0.5;
    const d = this.emotionalState.dimensions;
    // Intensity = average deviation from baseline
    let totalDeviation = 0;
    let count = 0;
    for (const [, dim] of Object.entries(d)) {
      totalDeviation += Math.abs(dim.value - dim.baseline);
      count++;
    }
    return count > 0 ? Math.min(1.0, totalDeviation / count * 3) : 0.5;
  }

  _assessImportance(text) {
    if (!text) return 0.5;

    let score = 0.5;

    for (const pattern of HIGH_IMPORTANCE_PATTERNS) {
      if (pattern.test(text)) score += 0.1;
    }

    for (const pattern of LOW_IMPORTANCE_PATTERNS) {
      if (pattern.test(text)) score -= 0.15;
    }

    // Longer content tends to be more important
    if (text.length > 500) score += 0.05;
    if (text.length > 2000) score += 0.05;

    // Contains code → likely important
    if (/```|function\s|class\s|const\s|let\s|import\s/i.test(text)) score += 0.1;

    return Math.max(0, Math.min(1.0, score));
  }

  _recencyScore(timestamp) {
    const ageMs = Date.now() - timestamp;
    const ageHours = ageMs / (1000 * 60 * 60);
    // Exponential decay: half-life of 24 hours
    return Math.exp(-ageHours / 24 * Math.LN2);
  }

  _applyDecay(entry) {
    const ageMs = Date.now() - entry.lastUpdated;
    const ageHours = ageMs / (1000 * 60 * 60);

    // High-surprise memories decay 5x slower
    const surpriseModifier = entry.surprise > 0.7 ? 0.2 : entry.surprise > 0.4 ? 0.5 : 1.0;
    // High-emotion memories decay 3x slower
    const emotionModifier = entry.emotion > 0.7 ? 0.33 : entry.emotion > 0.4 ? 0.6 : 1.0;
    // High-access memories decay 2x slower
    const accessModifier = entry.accessCount > 5 ? 0.5 : entry.accessCount > 2 ? 0.75 : 1.0;

    const effectiveDecay = this._decayRatePerHour * surpriseModifier * emotionModifier * accessModifier;
    const decayAmount = effectiveDecay * ageHours;

    return Math.max(0, entry.score - decayAmount);
  }

  _trimRetentionMap() {
    // Remove lowest-scored entries
    const entries = [...this._retentionScores.entries()]
      .sort((a, b) => a[1].score - b[1].score);

    const toRemove = entries.slice(0, Math.floor(entries.length * 0.2)); // Remove bottom 20%
    for (const [id] of toRemove) {
      this._retentionScores.delete(id);
    }
  }

  async _save() {
    try {
      const scores = Object.fromEntries(this._retentionScores);
      await this.storage?.writeJSON('adaptive-memory.json', { scores, stats: this._stats });
    } catch (err) {
      _log.warn('[ADAPTIVE-MEMORY] Save failed:', err.message);
    }
  }
}

module.exports = { AdaptiveMemory };
