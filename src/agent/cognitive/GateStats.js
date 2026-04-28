// ============================================================
// GENESIS — cognitive/GateStats.js (v7.3.6)
//
// Central telemetry for all deliberate "gate" code paths:
// places where Genesis decides to pass, warn, or block an action.
// Each gate calls gateStats.recordGate(name, verdict) once per
// decision. The service aggregates counts and exposes a summary()
// for dashboards, audits, and health reporting.
//
// ── Why a central service? ──
// v7.3.5 had gate counters scattered across 3 places (CognitiveSelfModel,
// TaskOutcomeTracker, SelfModificationPipeline). Without aggregation
// it was invisible which gates fire often, which never fire (dead
// gates), which block disproportionately (potentially too restrictive).
// Central recording makes those patterns visible.
//
// ── Sampling for hot-path gates ──
// Some gates (EventPayloadSchemas validation, per-chunk filters)
// fire thousands of times per turn. Recording every call would
// generate noise. For such gates the caller can configure a
// sample rate: e.g. sampleRates: { 'event-schema-validation': 100 }
// means record 1 out of every 100 calls, with the total multiplied
// back in reporting.
//
// ── No-op contract ──
// If gateStats is not injected into a service (e.g. in tests),
// callers use `this.gateStats?.recordGate(...)` — optional chaining
// ensures zero overhead when absent. This is intentional so
// instrumentation can be added without breaking mocks.
// ============================================================

'use strict';

const VALID_VERDICTS = new Set(['pass', 'block', 'warn']);

class GateStats {
  /**
   * @param {object} [opts]
   * @param {Object<string, number>} [opts.sampleRates] - gate name → 1/N sampling
   * @param {Function} [opts.nowFn] - injectable clock for tests
   */
  constructor(opts = {}) {
    this._counters = new Map();
    this._sampleRates = opts.sampleRates || {};
    this._sampleCounters = new Map();
    this._nowFn = opts.nowFn || (() => Date.now());
    this._createdAt = this._nowFn();
  }

  /**
   * Record one gate decision.
   * @param {string} name - stable identifier, e.g. 'injection-gate', 'self-mod:safety'
   * @param {'pass'|'block'|'warn'} verdict
   * @param {object} [meta] - optional details (not stored, used for future hooks)
   */
  recordGate(name, verdict, _meta) {
    if (typeof name !== 'string' || name.length === 0) return;
    if (!VALID_VERDICTS.has(verdict)) return;

    // Sampling: drop N-1 out of every N calls, count the one that lands.
    const rate = this._sampleRates[name];
    if (rate && rate > 1) {
      const n = (this._sampleCounters.get(name) || 0) + 1;
      this._sampleCounters.set(name, n);
      if (n % rate !== 0) return;
    }

    let c = this._counters.get(name);
    if (!c) {
      c = {
        pass: 0, block: 0, warn: 0, total: 0,
        firstSeen: this._nowFn(),
        lastSeen: this._nowFn(),
        sampled: (rate && rate > 1) ? rate : 1,
      };
      this._counters.set(name, c);
    }
    c.total++;
    c.lastSeen = this._nowFn();
    c[verdict]++;
  }

  /**
   * Aggregated view of all recorded gates.
   * @returns {Array<{name: string, pass: number, block: number, warn: number,
   *                   total: number, blockRate: number, firstSeen: number,
   *                   lastSeen: number, sampled: number}>}
   */
  summary() {
    const out = [];
    for (const [name, c] of this._counters.entries()) {
      // If the gate was sampled (rate > 1), multiply counts back for estimate.
      const multiplier = c.sampled || 1;
      out.push({
        name,
        pass: c.pass * multiplier,
        block: c.block * multiplier,
        warn: c.warn * multiplier,
        total: c.total * multiplier,
        blockRate: c.total > 0 ? Math.round((c.block / c.total) * 10000) / 10000 : 0,
        firstSeen: c.firstSeen,
        lastSeen: c.lastSeen,
        sampled: c.sampled,
      });
    }
    // Sort by total desc, so hottest gates are visible first
    out.sort((a, b) => b.total - a.total);
    return out;
  }

  /** Returns only the gates that have actually fired at least once. */
  active() {
    return this.summary().filter(g => g.total > 0);
  }

  /** Returns gate names that have a recorded entry. */
  knownGates() {
    return Array.from(this._counters.keys()).sort();
  }

  /** Reset all counters (for tests or periodic rollovers). */
  reset() {
    this._counters.clear();
    this._sampleCounters.clear();
    this._createdAt = this._nowFn();
  }

  /** Age of the tracker in ms — useful for rate calculations. */
  age() {
    return this._nowFn() - this._createdAt;
  }
}

module.exports = { GateStats };
