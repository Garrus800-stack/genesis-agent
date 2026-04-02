// @ts-checked-v5.7
/**
 * PredictiveCoder.js
 * ──────────────────
 * Predictive coding engine that maintains per-channel expectations
 * and computes surprise (prediction error) signals.
 *
 * Key insight: The learning rate adapts to emotional valence.
 * Positive mood → higher LR (exploratory, fast adaptation).
 * Negative mood → lower LR (conservative, cautious expectations).
 *
 * Each channel maintains an exponentially smoothed prediction.
 * Surprise = |actual - predicted| / (|predicted| + epsilon)
 *
 * @version 1.0.0
 */

'use strict';

const DEFAULT_CONFIG = {
  baseLearningRate:   0.1,       // Base rate for prediction updates
  explorationGain:    0.5,       // How much valence modulates LR
  minLearningRate:    0.01,      // Floor LR (very cautious)
  maxLearningRate:    0.5,       // Ceiling LR (very exploratory)
  surpriseMultiplier: 2.0,       // Scales raw surprise into effective priority
  epsilon:            0.001,     // Avoid division by zero
  smoothingFactor:    0.9,       // EMA factor for predictions (0.9 = slow tracking)
  habituation:        0.995,     // Per-tick multiplier that reduces baseline surprise
};

class PredictiveCoder {

  /**
   * @param {Object} config
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    /**
     * Per-channel prediction state.
     * @type {Map<string, object>}
     */
    this._channels = new Map();

    /** @type {number} Last computed aggregate surprise */
    this._aggregateSurprise = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute the adaptive learning rate based on emotional valence.
   *
   * @param {number} valence - Emotional valence [-1..1]
   * @returns {number} Effective learning rate
   */
  computeAdaptiveLR(valence) {
    const { baseLearningRate, explorationGain, minLearningRate, maxLearningRate } = this.config;
    // Positive valence → higher LR (exploratory)
    // Negative valence → lower LR (conservative)
    const raw = baseLearningRate * (1 + valence * explorationGain);
    return Math.max(minLearningRate, Math.min(maxLearningRate, raw));
  }

  /**
   * Update predictions with new channel data and compute surprise.
   *
   * @param {Object} channels    - { channelName: currentValue, ... }
   * @param {number} dt          - Delta time in ms since last update
   * @param {number} learningRate - Adaptive learning rate from computeAdaptiveLR
   * @returns {Object} Result with per-channel surprise and aggregate
   */
  update(channels, dt, learningRate) {
    const results = {};
    let totalSurprise = 0;
    let channelCount  = 0;

    for (const [name, currentValue] of Object.entries(channels)) {
      let pred = this._channels.get(name);

      if (!pred) {
        // New channel: initialize prediction to current value
        pred = {
          predicted:        currentValue,
          lastSurprise:     0,
          baselineSurprise: 0,
          habituationLevel: 1.0,
        };
        this._channels.set(name, pred);
      }

      // ── Compute raw surprise ─────────────────────────
      const rawSurprise = Math.abs(currentValue - pred.predicted)
                          / (Math.abs(pred.predicted) + this.config.epsilon);

      // ── Apply habituation (reduces surprise for persistent patterns) ──
      pred.baselineSurprise = pred.baselineSurprise * this.config.habituation
                              + rawSurprise * (1 - this.config.habituation);

      // Effective surprise is raw minus what we've habituated to
      const effectiveSurprise = Math.max(0, rawSurprise - pred.baselineSurprise * 0.5);

      // ── Scale to priority-ready value ────────────────
      const scaledSurprise = effectiveSurprise * this.config.surpriseMultiplier;

      // ── Update prediction (EMA with adaptive LR) ─────
      const blendFactor = 1 - Math.pow(1 - learningRate, dt / 500);  // normalize to ~500ms tick
      pred.predicted = pred.predicted * (1 - blendFactor) + currentValue * blendFactor;
      pred.lastSurprise = scaledSurprise;

      results[name] = {
        current:   currentValue,
        predicted: pred.predicted,
        surprise:  scaledSurprise,
        raw:       rawSurprise,
        habituated: pred.baselineSurprise,
      };

      totalSurprise += scaledSurprise;
      channelCount++;
    }

    this._aggregateSurprise = channelCount > 0 ? totalSurprise / channelCount : 0;

    return {
      channels:          results,
      aggregateSurprise: this._aggregateSurprise,
      channelCount,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCESSORS
  // ═══════════════════════════════════════════════════════════════

  /**
   * @returns {number} Last computed aggregate surprise
   */
  getAggregateSurprise() {
    return this._aggregateSurprise;
  }

  /**
   * Get surprise for a specific channel.
   * @param {string} channelName
   * @returns {number}
   */
  getChannelSurprise(channelName) {
    const pred = this._channels.get(channelName);
    return pred ? pred.lastSurprise : 0;
  }

  /**
   * Get a full snapshot of all predictions.
   * @returns {Object}
   */
  getSnapshot() {
    const snap = {};
    for (const [name, pred] of this._channels) {
      snap[name] = {
        predicted:        pred.predicted,
        lastSurprise:     pred.lastSurprise,
        baselineSurprise: pred.baselineSurprise,
      };
    }
    return {
      channels:          snap,
      aggregateSurprise: this._aggregateSurprise,
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ═══════════════════════════════════════════════════════════════

  serialize() {
    const channels = {};
    for (const [name, pred] of this._channels) {
      channels[name] = { ...pred };
    }
    return {
      channels,
      aggregateSurprise: this._aggregateSurprise,
    };
  }

  deserialize(data) {
    if (!data) return;
    this._channels.clear();
    if (data.channels) {
      for (const [name, pred] of Object.entries(data.channels)) {
        this._channels.set(name, { ...pred });
      }
    }
    this._aggregateSurprise = data.aggregateSurprise || 0;
  }
}

module.exports = PredictiveCoder;
