/**
 * EchoicMemory.js
 * ───────────────
 * Sliding-window perception smoother with adaptive alpha.
 *
 * Instead of discrete 2-second snapshots, this module maintains a
 * continuously blended "gestalt" — the system's current phenomenal
 * experience. The blend rate (alpha) adapts to surprise: high surprise
 * → sharp, reactive perception; low surprise → smooth, dreamy flow.
 *
 * Memory cost: O(1) — only the current gestalt is stored.
 *
 * @version 1.0.0
 */

'use strict';

const DEFAULT_CONFIG = {
  baseAlpha:      0.4,    // Default blend rate for new frames
  minAlpha:       0.05,   // Minimum alpha (dreamy, smooth)
  maxAlpha:       0.8,    // Maximum alpha (hypervigilant, sharp)
  reactivityGain: 1.5,    // How strongly surprise modulates alpha
  decayRate:      0.02,   // Gestalt decay toward neutral per tick (unused channels)
};

class EchoicMemory {

  /**
   * @param {Object} config
   */
  constructor(config = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    /** @type {Object|null} Current blended gestalt */
    this._gestalt = null;

    /** @type {number|null} Alpha override (set by state machine) */
    this._alphaOverride = null;

    /** @type {number} Last blend timestamp */
    this._lastBlendTime = Date.now();

    /** @type {number} Running frame count */
    this._frameCount = 0;
  }

  // ═══════════════════════════════════════════════════════════════
  // CORE
  // ═══════════════════════════════════════════════════════════════

  /**
   * Compute the adaptive alpha based on current surprise level.
   *
   * @param {number} aggregateSurprise - 0..∞, typically 0..5
   * @returns {number} alpha in [minAlpha, maxAlpha]
   */
  computeAdaptiveAlpha(aggregateSurprise) {
    if (this._alphaOverride !== null) {
      return this._alphaOverride;
    }

    const { baseAlpha, minAlpha, maxAlpha, reactivityGain } = this.config;
    const raw = baseAlpha * (1 + aggregateSurprise * reactivityGain);
    return Math.max(minAlpha, Math.min(maxAlpha, raw));
  }

  /**
   * Blend a new raw frame into the gestalt using lerp.
   *
   * @param {Object} rawFrame - { channels: { key: value, ... }, timestamp }
   * @param {number} alpha    - Blend factor [0..1]
   * @returns {Object} The updated gestalt (same shape as rawFrame)
   */
  blend(rawFrame, alpha) {
    const now = rawFrame.timestamp || Date.now();

    if (!this._gestalt) {
      // First frame: initialize directly
      this._gestalt = {
        channels:  { ...(rawFrame.channels || {}) },
        timestamp: now,
      };
      this._frameCount = 1;
      this._lastBlendTime = now;
      return this._copyGestalt();
    }

    const channels = rawFrame.channels || {};
    const gestaltChannels = this._gestalt.channels;

    // Lerp each channel
    for (const key of Object.keys(channels)) {
      if (gestaltChannels[key] === undefined) {
        // New channel: adopt directly
        gestaltChannels[key] = channels[key];
      } else {
        // Exponential moving average blend
        gestaltChannels[key] = this._lerp(gestaltChannels[key], channels[key], alpha);
      }
    }

    // Decay channels that are in gestalt but NOT in new frame
    for (const key of Object.keys(gestaltChannels)) {
      if (channels[key] === undefined) {
        gestaltChannels[key] *= (1 - this.config.decayRate);
        if (Math.abs(gestaltChannels[key]) < 1e-6) {
          delete gestaltChannels[key];
        }
      }
    }

    this._gestalt.timestamp = now;
    this._frameCount++;
    this._lastBlendTime = now;

    return this._copyGestalt();
  }

  // ═══════════════════════════════════════════════════════════════
  // STATE MACHINE HOOKS
  // ═══════════════════════════════════════════════════════════════

  /**
   * Override alpha (used by consciousness state machine).
   * @param {number} alpha
   */
  setAlphaOverride(alpha) {
    this._alphaOverride = Math.max(this.config.minAlpha, Math.min(this.config.maxAlpha, alpha));
  }

  /**
   * Clear alpha override, return to adaptive mode.
   */
  resetAlphaOverride() {
    this._alphaOverride = null;
  }

  // ═══════════════════════════════════════════════════════════════
  // ACCESSORS
  // ═══════════════════════════════════════════════════════════════

  /**
   * @returns {Object|null} Copy of current gestalt
   */
  getCurrentGestalt() {
    return this._copyGestalt();
  }

  /**
   * @returns {number} Total frames blended
   */
  getFrameCount() {
    return this._frameCount;
  }

  // ═══════════════════════════════════════════════════════════════
  // SERIALIZATION
  // ═══════════════════════════════════════════════════════════════

  serialize() {
    return {
      gestalt:       this._gestalt ? { ...this._gestalt, channels: { ...this._gestalt.channels } } : null,
      alphaOverride: this._alphaOverride,
      frameCount:    this._frameCount,
      lastBlendTime: this._lastBlendTime,
    };
  }

  deserialize(data) {
    if (!data) return;
    this._gestalt       = data.gestalt || null;
    this._alphaOverride = data.alphaOverride ?? null;
    this._frameCount    = data.frameCount || 0;
    this._lastBlendTime = data.lastBlendTime || Date.now();
  }

  // ═══════════════════════════════════════════════════════════════
  // PRIVATE
  // ═══════════════════════════════════════════════════════════════

  /** @private */
  _lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /** @private */
  _copyGestalt() {
    if (!this._gestalt) return null;
    return {
      channels:  { ...this._gestalt.channels },
      timestamp: this._gestalt.timestamp,
    };
  }
}

module.exports = EchoicMemory;
