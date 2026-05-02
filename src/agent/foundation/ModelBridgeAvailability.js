// ============================================================
// GENESIS — ModelBridgeAvailability.js (v7.5.6)
//
// Model-availability tracking with TTL — extracted from ModelBridge
// to keep the parent file under the architectural-fitness LOC limit.
//
// When a model fails with auth/rate-limit/timeout, we mark it as
// unavailable for a configured TTL. Failover and boot-time selection
// skip marked models. Closes the loop where Genesis would retry the
// same dead model every IdleMind tick (live-observed: 9h with 403).
//
// Wired into ModelBridge.prototype via Object.assign at the bottom of
// ModelBridge.js (same pattern as CommandHandlers + helper mixins).
// ============================================================

'use strict';

const fs = require('fs');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ModelBridge');

const availability = {
  /**
   * Mark a model as unavailable for `ttlMs` milliseconds.
   * @param {string} modelName
   * @param {number} ttlMs
   * @param {string} reason — from _classifyFailoverReason
   */
  markUnavailable(modelName, ttlMs, reason) {
    if (!modelName || !ttlMs) return;
    const until = Date.now() + ttlMs;
    this._unavailableUntil.set(modelName, { until, reason, ttlMs });
    this._persistUnavailable();
    this.bus.fire('model:marked-unavailable',
      { modelName, reason, ttlMs },
      { source: 'ModelBridge' });
  },

  /**
   * Check whether a model is currently marked unavailable. Lazy-clears
   * expired markers and fires `model:unavailable-cleared` with
   * `automatic: true` when an entry expires.
   * @param {string} modelName
   * @returns {boolean}
   */
  isMarkedUnavailable(modelName) {
    if (!modelName) return false;
    const entry = this._unavailableUntil.get(modelName);
    if (!entry) return false;
    if (Date.now() >= entry.until) {
      this._unavailableUntil.delete(modelName);
      this._persistUnavailable();
      this.bus.fire('model:unavailable-cleared',
        { modelName, automatic: true },
        { source: 'ModelBridge' });
      return false;
    }
    return true;
  },

  /**
   * Clear unavailable-marker for a specific model, or for all models if
   * called without argument.
   * @param {string} [modelName]
   */
  clearUnavailable(modelName) {
    if (modelName) {
      if (this._unavailableUntil.delete(modelName)) {
        this._persistUnavailable();
        this.bus.fire('model:unavailable-cleared',
          { modelName, automatic: false },
          { source: 'ModelBridge' });
      }
    } else {
      const all = [...this._unavailableUntil.keys()];
      this._unavailableUntil.clear();
      this._persistUnavailable();
      for (const name of all) {
        this.bus.fire('model:unavailable-cleared',
          { modelName: name, automatic: false },
          { source: 'ModelBridge' });
      }
    }
  },

  /**
   * Load persisted markers from disk. Best-effort — corrupt or missing
   * file → empty map + warn-log. Filters expired entries on load.
   * @private
   */
  _loadUnavailable() {
    if (!this._unavailableFile) return;
    if (!fs.existsSync(this._unavailableFile)) return;
    try {
      const raw = fs.readFileSync(this._unavailableFile, 'utf-8');
      const data = safeJsonParse(raw, {}, 'ModelBridge');
      const now = Date.now();
      for (const [name, entry] of Object.entries(data || {})) {
        if (entry && typeof entry.until === 'number' && entry.until > now) {
          this._unavailableUntil.set(name, entry);
        }
      }
      // Persist immediately so file reflects post-prune state
      this._persistUnavailable();
    } catch (err) {
      _log.warn(`[MODEL] _loadUnavailable failed: ${err.message}`);
    }
  },

  /**
   * Persist current markers to disk atomically.
   * @private
   */
  _persistUnavailable() {
    if (!this._unavailableFile) return;
    try {
      const obj = Object.fromEntries(this._unavailableUntil);
      atomicWriteFileSync(
        this._unavailableFile,
        JSON.stringify(obj, null, 2),
        'utf-8'
      );
    } catch (err) {
      _log.warn(`[MODEL] _persistUnavailable failed: ${err.message}`);
    }
  },
};

module.exports = { availability };
