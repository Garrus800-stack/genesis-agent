/**
 * NeuroModulatorSystem.js
 * ───────────────────────
 * Biologically-inspired dual-process emotion system.
 *
 * Two layers per modulator:
 *   - Phasic: Fast, reactive. Responds to immediate events. t½ ≈ 30s.
 *   - Tonic:  Slow, accumulative. The "mood". t½ ≈ 15min.
 *
 * Opponent Process: After a strong phasic reaction decays, a proportional
 * rebound in the opposite direction occurs. This creates:
 *   - Post-joy "comedown"
 *   - Post-frustration "relief"
 *   - Natural chapter transitions
 *
 * Modulators:
 *   - valence:     Overall positive/negative feeling [-1..1]
 *   - arousal:     Activation level [0..1]
 *   - frustration: Accumulated negative friction [0..1]
 *   - curiosity:   Exploratory drive [0..1]
 *   - confidence:  Self-efficacy signal [0..1]
 *
 * @version 1.0.0
 */

'use strict';

const DEFAULT_CONFIG = {
  modulators: {
    valence: {
      halfLifePhasicMs:  30_000,     // 30 seconds
      halfLifeTonicMs:   900_000,    // 15 minutes
      reboundStrength:   0.3,
      leakRate:          0.0001,     // Phasic → Tonic leak per ms
      clampMin:          -1,
      clampMax:          1,
    },
    arousal: {
      halfLifePhasicMs:  15_000,     // 15 seconds (arousal fades faster)
      halfLifeTonicMs:   600_000,    // 10 minutes
      reboundStrength:   0.2,
      leakRate:          0.00005,
      clampMin:          0,
      clampMax:          1,
    },
    frustration: {
      halfLifePhasicMs:  45_000,     // 45 seconds (frustration lingers)
      halfLifeTonicMs:   1_200_000,  // 20 minutes (grudge-holding)
      reboundStrength:   0.25,
      leakRate:          0.00015,
      clampMin:          0,
      clampMax:          1,
    },
    curiosity: {
      halfLifePhasicMs:  20_000,
      halfLifeTonicMs:   600_000,
      reboundStrength:   0.15,
      leakRate:          0.0001,
      clampMin:          0,
      clampMax:          1,
    },
    confidence: {
      halfLifePhasicMs:  60_000,     // 1 minute (confidence is slower to build)
      halfLifeTonicMs:   1_800_000,  // 30 minutes (and slower to fade)
      reboundStrength:   0.2,
      leakRate:          0.00008,
      clampMin:          0,
      clampMax:          1,
    },
  },
  // Map incoming signals to modulators
  signalMapping: {
    surprise:   { arousal: 0.5, curiosity: 0.3 },
    valence:    { valence: 1.0 },
    arousal:    { arousal: 0.8 },
    error:      { frustration: 0.6, valence: -0.3, confidence: -0.2 },
    success:    { valence: 0.5, confidence: 0.4, frustration: -0.2 },
    novelty:    { curiosity: 0.6, arousal: 0.3 },
  },
};

class NeuroModulator {
  /**
   * @param {Object} config - Modulator-specific configuration
   */
  constructor(config) {
    this.config = config;
    this.phasic  = 0;
    this.tonic   = 0;
    this.rebound = 0;

    // Precompute decay constants
    this._decayPhasic = Math.LN2 / config.halfLifePhasicMs;
    this._decayTonic  = Math.LN2 / config.halfLifeTonicMs;
    this._decayRebound = Math.LN2 / (config.halfLifePhasicMs * 2);
  }

  /**
   * Inject a signal and advance time.
   *
   * @param {number} amount - Signal strength (can be negative)
   * @param {number} dt     - Delta time in ms
   */
  tick(amount, dt) {
    // ── Compute rebound from decaying phasic signal ────────
    const phasicBefore = this.phasic;

    // Decay phasic
    this.phasic *= Math.exp(-this._decayPhasic * dt);

    // The amount that decayed generates opponent rebound
    const decayedAmount = phasicBefore - this.phasic;
    this.rebound += decayedAmount * this.config.reboundStrength;

    // Decay rebound (slower than phasic)
    this.rebound *= Math.exp(-this._decayRebound * dt);

    // ── Inject new signal into phasic ──────────────────────
    if (amount !== 0) {
      this.phasic += amount;
    }

    // ── Leak from phasic to tonic (the mood accumulator) ───
    const netPhasic = this.phasic - this.rebound;
    this.tonic += netPhasic * this.config.leakRate * dt;

    // Decay tonic
    this.tonic *= Math.exp(-this._decayTonic * dt);

    // ── Clamp ──────────────────────────────────────────────
    this.phasic  = this._clamp(this.phasic);
    this.tonic   = this._clamp(this.tonic);
  }

  /**
   * Get the effective level combining both layers.
   * @returns {number}
   */
  get effectiveLevel() {
    return this._clamp(this.phasic - this.rebound + this.tonic);
  }

  /**
   * Get detailed state.
   * @returns {Object}
   */
  getState() {
    return {
      phasic:    Math.round(this.phasic * 10000) / 10000,
      tonic:     Math.round(this.tonic * 10000) / 10000,
      rebound:   Math.round(this.rebound * 10000) / 10000,
      effective: Math.round(this.effectiveLevel * 10000) / 10000,
    };
  }

  /**
   * Reset tonic toward baseline by a given factor.
   * @param {number} factor - 0..1, how much to reduce tonic (0.7 = reduce by 70%)
   */
  resetTonicToBaseline(factor) {
    this.tonic *= (1 - factor);
    this.rebound *= (1 - factor * 0.5);
  }

  /** @private */
  _clamp(v) {
    return Math.max(this.config.clampMin, Math.min(this.config.clampMax, v));
  }

  serialize() {
    return { phasic: this.phasic, tonic: this.tonic, rebound: this.rebound };
  }

  deserialize(data) {
    if (!data) return;
    this.phasic  = data.phasic  || 0;
    this.tonic   = data.tonic   || 0;
    this.rebound = data.rebound || 0;
  }
}


class NeuroModulatorSystem {

  /**
   * @param {Object} config
   */
  constructor(config = {}) {
    const mergedConfig = this._mergeConfig(DEFAULT_CONFIG, config);
    this.config = mergedConfig;

    /** @type {Map<string, NeuroModulator>} */
    this._modulators = new Map();

    // Initialize modulators
    for (const [name, modConfig] of Object.entries(mergedConfig.modulators)) {
      this._modulators.set(name, new NeuroModulator(modConfig));
    }

    /** @type {Array<Object>} Recent emotional trajectory (for slope detection) */
    this._trajectory = [];
    this._maxTrajectory = 60;  // ~30 seconds at 500ms tick
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Advance the emotion system by dt milliseconds.
   *
   * @param {number} dt       - Delta time in ms
   * @param {Object|null} signals - Incoming signals to distribute
   *   e.g. { surprise: 0.5, valence: -0.2 }
   */
  tick(dt, signals) {
    // Distribute signals to modulators
    const injections = this._mapSignals(signals);

    // Tick each modulator
    for (const [name, mod] of this._modulators) {
      const amount = injections[name] || 0;
      mod.tick(amount, dt);
    }

    // Record trajectory point
    this._recordTrajectory();
  }

  /**
   * Boost arousal directly (used by HYPERVIGILANT state).
   * @param {number} amount
   */
  boostArousal(amount) {
    const arousal = this._modulators.get('arousal');
    if (arousal) {
      arousal.phasic += amount;
    }
  }

  /**
   * Reset tonic levels toward baseline (used after dream sleep).
   * @param {number} factor - 0..1
   */
  resetTonicToBaseline(factor) {
    for (const mod of this._modulators.values()) {
      mod.resetTonicToBaseline(factor);
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Get the full emotional state.
   * @returns {Object}
   */
  getState() {
    const state = {};
    for (const [name, mod] of this._modulators) {
      state[name] = mod.getState();
    }

    // Compute composite metrics
    state.valenceEffective     = this._modulators.get('valence')?.effectiveLevel ?? 0;
    state.arousalEffective     = this._modulators.get('arousal')?.effectiveLevel ?? 0;
    state.frustrationEffective = this._modulators.get('frustration')?.effectiveLevel ?? 0;
    state.moodLabel            = this._computeMoodLabel(state);
    state.moodSlope            = this._computeMoodSlope();

    return state;
  }

  /**
   * Get just the effective valence (for cross-modulation).
   * @returns {number}
   */
  getEffectiveValence() {
    return this._modulators.get('valence')?.effectiveLevel ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // MOOD ANALYSIS (for Life Chapter detection)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Detect if a mood shift boundary has occurred.
   * Returns the shift info if the tonic slope changed sign significantly.
   *
   * @returns {Object|null} { from, to, magnitude } or null
   */
  detectMoodShift() {
    if (this._trajectory.length < 20) return null;

    const recent = this._trajectory.slice(-10);
    const older  = this._trajectory.slice(-20, -10);

    const recentAvgValence = this._avg(recent.map(t => t.valence));
    const olderAvgValence  = this._avg(older.map(t => t.valence));

    const shift = recentAvgValence - olderAvgValence;

    if (Math.abs(shift) > 0.15) {
      return {
        from:      olderAvgValence > 0 ? 'positive' : 'negative',
        to:        recentAvgValence > 0 ? 'positive' : 'negative',
        magnitude: shift,
        timestamp: Date.now(),
      };
    }

    return null;
  }

  // ═══════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ═══════════════════════════════════════════════════════════════

  serialize() {
    const modulators = {};
    for (const [name, mod] of this._modulators) {
      modulators[name] = mod.serialize();
    }
    return { modulators, trajectory: this._trajectory.slice(-30) };
  }

  deserialize(data) {
    if (!data) return;
    if (data.modulators) {
      for (const [name, modData] of Object.entries(data.modulators)) {
        const mod = this._modulators.get(name);
        if (mod) mod.deserialize(modData);
      }
    }
    if (data.trajectory) {
      this._trajectory = data.trajectory;
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _mapSignals(signals) {
    const injections = {};

    if (!signals) return injections;

    for (const [signalName, strength] of Object.entries(signals)) {
      const mapping = this.config.signalMapping[signalName];
      if (!mapping) continue;

      for (const [modName, weight] of Object.entries(mapping)) {
        if (!injections[modName]) injections[modName] = 0;
        injections[modName] += strength * weight;
      }
    }

    return injections;
  }

  /** @private */
  _recordTrajectory() {
    const valence = this._modulators.get('valence');
    const arousal = this._modulators.get('arousal');

    this._trajectory.push({
      timestamp: Date.now(),
      valence:   valence ? valence.effectiveLevel : 0,
      arousal:   arousal ? arousal.effectiveLevel : 0,
    });

    if (this._trajectory.length > this._maxTrajectory) {
      this._trajectory.shift();
    }
  }

  /** @private */
  _computeMoodLabel(state) {
    const v = state.valenceEffective;
    const a = state.arousalEffective;
    const f = state.frustrationEffective;

    // Circumplex model quadrants
    if (f > 0.5)                     return 'frustrated';
    if (v > 0.3 && a > 0.5)         return 'excited';
    if (v > 0.3 && a <= 0.5)        return 'content';
    if (v < -0.3 && a > 0.5)        return 'anxious';
    if (v < -0.3 && a <= 0.5)       return 'melancholic';
    if (Math.abs(v) <= 0.3 && a > 0.6) return 'alert';
    return 'neutral';
  }

  /** @private */
  _computeMoodSlope() {
    if (this._trajectory.length < 4) return 0;
    const recent = this._trajectory.slice(-4);
    const first  = recent[0].valence;
    const last   = recent[recent.length - 1].valence;
    return last - first;
  }

  /** @private */
  _avg(arr) {
    if (arr.length === 0) return 0;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  /** @private */
  _mergeConfig(defaults, overrides) {
    const result = { ...defaults };
    if (overrides.modulators) {
      result.modulators = { ...defaults.modulators };
      for (const [key, val] of Object.entries(overrides.modulators)) {
        result.modulators[key] = { ...defaults.modulators[key], ...val };
      }
    }
    if (overrides.signalMapping) {
      result.signalMapping = { ...defaults.signalMapping, ...overrides.signalMapping };
    }
    return result;
  }
}

module.exports = NeuroModulatorSystem;
