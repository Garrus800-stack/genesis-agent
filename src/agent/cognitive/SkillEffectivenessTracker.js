// @ts-checked-v5.7
// ============================================================
// GENESIS — SkillEffectivenessTracker.js
// v7.9.0 Phase 2 — Können-Konzept skill effectiveness tracking
//
// PURPOSE:
//   Tracks per-skill invocation outcomes and computes Wilson-LB
//   confidence. Phase 2 (v7.9.0) provides the public API and
//   persistence layer. Phase 3 (v7.9.1) HabitatOutpost will call
//   recordInvocation() and consume getWilsonLB() for promotion /
//   quarantine decisions.
//
// PUBLIC API:
//   • recordInvocation(skillName, success, opts)  — register an outcome
//   • getWilsonLB(skillName)                      — Wilson lower bound
//   • getStats(skillName)                         — full per-skill stats
//   • getAll()                                    — shallow snapshot
//   • applyDecay()                                — decay unused skills
//   • forget(skillName)                           — drop from tracking
//
// PERSISTENCE:
//   .genesis/koennen/skill-effectiveness.json — { [skillName]: {
//     successes, total, wilsonLB,
//     lastInvocation, lastSuccess,
//     invocations: [{ ts, success, latencyMs?, source? }]   (max 50)
//   } }
//
// Wilson math: imported from CognitiveSelfModel — single source of
// truth, no math drift.
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { wilsonLower } = require('./CognitiveSelfModel');
const _log = createLogger('SkillEffectivenessTracker');

const FILE = 'koennen/skill-effectiveness.json';
const MAX_INVOCATION_HISTORY = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

class SkillEffectivenessTracker {
  /**
   * @param {{
   *   bus?: any,
   *   storage?: any,
   *   settings?: any,
   *   clock?: () => number
   * }} deps
   */
  constructor({ bus, storage, settings, clock } = {}) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this.settings = settings || null;
    this._clock = clock || (() => Date.now());

    /** @type {Record<string, {
     *    successes: number, total: number, wilsonLB: number,
     *    lastInvocation: number, lastSuccess: number,
     *    invocations: Array<{ts:number,success:boolean,latencyMs?:number,source?:string}>
     *  }>}
     */
    this._data = this._load();
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    // Phase 2 (v7.9.0): no bus subscriptions yet.
    // Phase 3 (v7.9.1) HabitatOutpost will call recordInvocation()
    // directly when it runs rehearsals or observes production invokes.
  }

  stop() {
    this._started = false;
    // Final persist on shutdown (state is also written after each
    // recordInvocation, so this is mostly a no-op safety net).
    this._persist();
  }

  // ── core API ─────────────────────────────────────────────

  /**
   * Record an invocation outcome. Updates successes/total and
   * recomputes Wilson-LB.
   *
   * @param {string} skillName
   * @param {boolean} success
   * @param {{ latencyMs?: number, source?: string }} [opts]
   */
  recordInvocation(skillName, success, opts = {}) {
    if (!skillName || typeof skillName !== 'string') return;

    let entry = this._data[skillName];
    if (!entry) {
      const seed = this._setting('cognitive.koennen.effectiveness.initialEvidence', 1);
      entry = {
        successes: seed,
        total: seed,
        wilsonLB: wilsonLower(seed, seed),
        lastInvocation: 0,
        lastSuccess: 0,
        invocations: [],
      };
      this._data[skillName] = entry;
    }

    const now = this._clock();
    entry.total++;
    if (success) {
      entry.successes++;
      entry.lastSuccess = now;
    }
    entry.lastInvocation = now;

    const inv = { ts: now, success };
    if (opts.latencyMs != null) inv.latencyMs = opts.latencyMs;
    if (opts.source) inv.source = opts.source;
    entry.invocations.push(inv);
    if (entry.invocations.length > MAX_INVOCATION_HISTORY) {
      entry.invocations = entry.invocations.slice(-MAX_INVOCATION_HISTORY);
    }

    entry.wilsonLB = wilsonLower(entry.successes, entry.total);
    this._persist();
  }

  /** Wilson-LB for a skill. Returns 0.5 fallback for untracked skills. */
  getWilsonLB(skillName) {
    const entry = this._data[skillName];
    if (!entry) return 0.5;
    return entry.wilsonLB;
  }

  /** Full stats for one skill (or null if untracked). */
  getStats(skillName) {
    const entry = this._data[skillName];
    if (!entry) return null;
    return {
      successes: entry.successes,
      total: entry.total,
      wilsonLB: entry.wilsonLB,
      lastInvocation: entry.lastInvocation,
      lastSuccess: entry.lastSuccess,
      runs: entry.invocations.length,
    };
  }

  /** Shallow snapshot of all tracked skills. */
  getAll() {
    const out = {};
    for (const [name, entry] of Object.entries(this._data)) {
      out[name] = {
        successes: entry.successes,
        total: entry.total,
        wilsonLB: entry.wilsonLB,
        lastInvocation: entry.lastInvocation,
      };
    }
    return out;
  }

  /**
   * Linear decay for skills unused for ≥1 week.
   * Phase 3 (v7.9.1) DreamCyclePhases will call this before
   * promotion evaluation so regressed promoted skills can be
   * re-quarantined.
   *
   * @returns {number} number of skills affected
   */
  applyDecay() {
    const decayRate = this._setting('cognitive.koennen.effectiveness.decayPerWeek', 0.05);
    if (decayRate <= 0) return 0;
    const now = this._clock();
    let decayed = 0;
    for (const entry of Object.values(this._data)) {
      if (entry.lastInvocation === 0) continue;
      const weeksUnused = (now - entry.lastInvocation) / WEEK_MS;
      if (weeksUnused > 1) {
        const before = entry.wilsonLB;
        entry.wilsonLB = Math.max(0, entry.wilsonLB - decayRate * weeksUnused);
        if (entry.wilsonLB !== before) decayed++;
      }
    }
    if (decayed > 0) this._persist();
    return decayed;
  }

  /** Drop a skill from tracking. */
  forget(skillName) {
    if (this._data[skillName]) {
      delete this._data[skillName];
      this._persist();
    }
  }

  // ── internals ────────────────────────────────────────────

  _load() {
    if (!this.storage) return {};
    try {
      return this.storage.readJSON(FILE, {}) || {};
    } catch (err) {
      _log.warn(`[TRACKER] _load failed (${err.message}) — starting empty`);
      return {};
    }
  }

  _persist() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON(FILE, this._data);
    } catch (err) {
      _log.warn(`[TRACKER] _persist failed: ${err.message}`);
    }
  }

  _setting(p, fallback) {
    if (!this.settings || typeof this.settings.get !== 'function') return fallback;
    try {
      const v = this.settings.get(p);
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }
}

module.exports = { SkillEffectivenessTracker };
