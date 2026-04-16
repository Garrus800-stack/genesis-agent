// ============================================================
// GENESIS — Genome.js (v5.0.0 — Digital Organism)
//
// The heritable identity. Settings describes how the system is
// configured; Genome describes WHO the organism IS. The distinction
// matters because CloneFactory now produces offspring with variation,
// not exact copies. Over generations, trait distributions shift
// under selection pressure — this is evolution.
//
// Traits are continuous values [0, 1] that influence runtime
// behavior across multiple modules:
//
//   curiosity       → IdleMind exploration weight
//   caution         → Sandbox timeout, approval thresholds
//   verbosity       → PromptBuilder response length guidance
//   riskTolerance   → SelfMod circuit breaker sensitivity
//   socialDrive     → NeedsSystem social need growth rate
//   consolidation   → DreamCycle vs exploration ratio
//
// Traits are NOT parameters — they are tendencies. A high-curiosity
// Genesis doesn't explore more because a config says so; it explores
// more because its nature drives it to. This is the organism metaphor
// made real.
//
// Architecture:
//   Genome.traits     → IdleMind, Sandbox, PromptBuilder, SelfMod
//   Genome.reproduce() → CloneFactory (offspring with mutations)
//   FitnessEvaluator  → Genome (selection pressure on traits)
//   Genome            → Storage (persisted to genome.json)
// ============================================================

const crypto = require('crypto');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { ORGANISM } = require('../core/Constants');
const _log = createLogger('Genome');

// ── Default Trait Values ──────────────────────────────────
// These define the "wild type" — a Genesis with no evolutionary
// history. Each trait is a [0, 1] continuous value.
const DEFAULT_TRAITS = {
  curiosity:       0.6,   // Moderate exploration drive
  caution:         0.5,   // Balanced safety threshold
  verbosity:       0.5,   // Average response length
  riskTolerance:   0.3,   // Conservative self-modification
  socialDrive:     0.5,   // Moderate interaction seeking
  consolidation:   0.6,   // Slight preference for consolidation over exploration
  selfAwareness:   0.5,   // v7.0.9: Controls GoalSynthesizer frequency (higher = more self-improvement)
};

const TRAIT_BOUNDS = { min: 0.05, max: 0.95 };
const MAX_DELTA_PER_ADJUSTMENT = 0.05;
const GENOME_FILE = 'genome.json';

class Genome {
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;

    const cfg = config || {};
    this._mutationRate = cfg.mutationRate ?? 0.15;  // Per-trait probability on reproduce()
    this._mutationStrength = cfg.mutationStrength ?? 0.08; // Gaussian sigma

    // ── Core genome data ───────────────────────────────
    this.traits = { ...DEFAULT_TRAITS };
    this.generation = 1;
    this.lineage = ['genesis-root'];
    this.parentGenomeHash = null;
    this.birthTimestamp = Date.now();

    // ── Trait adjustment history (for IntrospectionEngine) ──
    this._adjustmentLog = [];  // { trait, delta, reason, timestamp }
    this._maxAdjustmentLog = ORGANISM.GENOME_MAX_ADJUSTMENT_LOG;
  }

  // ════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const saved = await this.storage.readJSONAsync(GENOME_FILE);
      if (saved && saved.traits) {
        // Merge saved traits with defaults (handles new traits added in upgrades)
        for (const [key, val] of Object.entries(saved.traits)) {
          if (key in DEFAULT_TRAITS) {
            this.traits[key] = this._clamp(val);
          }
        }
        this.generation = saved.generation || 1;
        this.lineage = saved.lineage || ['genesis-root'];
        this.parentGenomeHash = saved.parentGenomeHash || null;
        this.birthTimestamp = saved.birthTimestamp || Date.now();
        _log.info(`[GENOME] Loaded — generation ${this.generation}, ${Object.keys(this.traits).length} traits`);
      } else {
        _log.info('[GENOME] No saved genome — using wild-type defaults');
        this._persist();
      }
    } catch (err) {
      _log.warn('[GENOME] Failed to load, using defaults:', err.message);
    }
  }

  start() {
    _log.info(`[GENOME] Active — generation ${this.generation}, lineage depth ${this.lineage.length}`);
    this.bus.emit('genome:loaded', {
      generation: this.generation,
      traits: { ...this.traits },
      lineageDepth: this.lineage.length,
    }, { source: 'Genome' });
  }

  stop() {
    // FIX D-1: Sync write on shutdown — writeJSONDebounced() queues a 2s timer
    // that will never fire if the process exits immediately after stop().
    this._persistSync();
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API — TRAIT ACCESS
  // ════════════════════════════════════════════════════════════

  /** Get a single trait value */
  trait(name) {
    return this.traits[name] ?? DEFAULT_TRAITS[name] ?? 0.5;
  }

  /** Get all traits as a frozen snapshot */
  getTraits() {
    return Object.freeze({ ...this.traits });
  }

  /** Get full genome data for serialization or display */
  getFullGenome() {
    return {
      traits: { ...this.traits },
      generation: this.generation,
      lineage: [...this.lineage],
      parentGenomeHash: this.parentGenomeHash,
      birthTimestamp: this.birthTimestamp,
      mutationRate: this._mutationRate,
      hash: this.hash(),
    };
  }

  // ════════════════════════════════════════════════════════════
  // PUBLIC API — TRAIT MODIFICATION
  // ════════════════════════════════════════════════════════════

  /**
   * Adjust a trait based on experience. Capped to prevent runaway drift.
   * @param {string} traitName - Which trait
   * @param {number} delta - Adjustment (-0.05 to +0.05)
   * @param {string} reason - Why (for audit trail)
   * @returns {{ applied: boolean, before: number, after: number }}
   */
  adjustTrait(traitName, delta, reason = 'unknown') {
    if (!(traitName in this.traits)) {
      _log.warn(`[GENOME] Unknown trait: ${traitName}`);
      return { applied: false, before: 0, after: 0 };
    }

    // Cap delta
    const capped = Math.max(-MAX_DELTA_PER_ADJUSTMENT, Math.min(MAX_DELTA_PER_ADJUSTMENT, delta));
    const before = this.traits[traitName];
    const after = this._clamp(before + capped);
    this.traits[traitName] = after;

    // Log
    this._adjustmentLog.push({
      trait: traitName, delta: capped, reason,
      before: Math.round(before * 1000) / 1000,
      after: Math.round(after * 1000) / 1000,
      timestamp: Date.now(),
    });
    if (this._adjustmentLog.length > this._maxAdjustmentLog) {
      this._adjustmentLog.shift();
    }

    _log.info(`[GENOME] Trait ${traitName}: ${before.toFixed(3)} → ${after.toFixed(3)} (${reason})`);
    this.bus.emit('genome:trait-adjusted', {
      trait: traitName, before, after, delta: capped, reason,
    }, { source: 'Genome' });

    // Debounced persist
    this._persist();

    return { applied: true, before, after };
  }

  /** Get the trait adjustment history (for IntrospectionEngine) */
  getAdjustmentHistory() {
    return [...this._adjustmentLog];
  }

  // ════════════════════════════════════════════════════════════
  // REPRODUCTION — produces offspring genome with mutations
  // ════════════════════════════════════════════════════════════

  /**
   * Create an offspring genome with mutations.
   * Called by CloneFactory during clone creation.
   *
   * @returns {object} Offspring genome data (ready for new Genome constructor)
   */
  reproduce() {
    const childTraits = {};
    const mutations = [];

    for (const [key, val] of Object.entries(this.traits)) {
      if (Math.random() < this._mutationRate) {
        // Gaussian-ish noise using Box-Muller
        const u1 = Math.random();
        const u2 = Math.random();
        const noise = Math.sqrt(-2 * Math.log(u1 || 0.001)) * Math.cos(2 * Math.PI * u2);
        const delta = noise * this._mutationStrength;
        childTraits[key] = this._clamp(val + delta);
        mutations.push({ trait: key, parent: val, child: childTraits[key], delta });
      } else {
        childTraits[key] = val;
      }
    }

    const offspring = {
      traits: childTraits,
      generation: this.generation + 1,
      lineage: [...this.lineage, this.hash()],
      parentGenomeHash: this.hash(),
      birthTimestamp: Date.now(),
      mutationRate: this._mutationRate,
    };

    _log.info(`[GENOME] Reproduction: generation ${this.generation} → ${offspring.generation}, ${mutations.length} mutations`);
    this.bus.emit('genome:reproduced', {
      parentHash: this.hash(),
      childGeneration: offspring.generation,
      mutations,
    }, { source: 'Genome' });

    return offspring;
  }

  // ════════════════════════════════════════════════════════════
  // IDENTITY HASH
  // ════════════════════════════════════════════════════════════

  /** SHA-256 hash of the trait values — uniquely identifies this genome */
  hash() {
    const data = JSON.stringify({
      traits: this.traits,
      generation: this.generation,
    });
    return crypto.createHash('sha256').update(data).digest('hex').slice(0, ORGANISM.GENOME_HASH_LENGTH);
  }

  // ════════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════════

  _clamp(val) {
    return Math.max(TRAIT_BOUNDS.min, Math.min(TRAIT_BOUNDS.max, val));
  }

  _persist() {
    if (!this.storage) return;
    // FIX v5.0.0: Use writeJSONDebounced to avoid sync fsync storm on
    // rapid adjustTrait() calls. Previously used sync writeJSON.
    this.storage.writeJSONDebounced(GENOME_FILE, this._persistData(), ORGANISM.GENOME_PERSIST_DEBOUNCE_MS);
  }

  /** FIX D-1: Sync write for shutdown path — guarantees data reaches disk before exit. */
  _persistSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON(GENOME_FILE, this._persistData());
    } catch (err) {
      _log.warn('[GENOME] Sync persist failed:', err.message);
    }
  }

  /** @private Shared payload for both persist paths. */
  _persistData() {
    return {
      traits: this.traits,
      generation: this.generation,
      lineage: this.lineage,
      parentGenomeHash: this.parentGenomeHash,
      birthTimestamp: this.birthTimestamp,
      mutationRate: this._mutationRate,
    };
  }
}

module.exports = { Genome, DEFAULT_TRAITS };
