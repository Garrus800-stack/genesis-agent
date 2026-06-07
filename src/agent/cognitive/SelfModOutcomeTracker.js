// @ts-checked
// ============================================================
// GENESIS — cognitive/SelfModOutcomeTracker.js (v7.9.20)
// Watches the outcome of self-modifications. It subscribes to the EXISTING
// selfmod:success bus event (the bus side of the CODE_MODIFIED store event —
// no new event type is introduced) and tracks how often each file is changed
// within a rolling window. When a file churns past the threshold — a strong
// signal that automatic changes to it are not sticking — it records a
// 'self-modification' lesson so ProposeImprovements/buildProposals stops
// proposing further automatic changes to that file.
//
// It does NOT roll anything back. The human-in-the-loop stays in control; the
// tracker only contributes a lesson. Bus subscriptions are tracked in _unsubs
// for a clean shutdown (the SurpriseAccumulator cognitive pattern).
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('SelfModOutcome');

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
const CHURN_THRESHOLD = 3;                   // changes within the window

class SelfModOutcomeTracker {
  constructor({ bus, lessonsStore, config = {} } = {}) {
    this.bus = bus || null;
    this.lessonsStore = lessonsStore || null;
    this._windowMs = config.windowMs || WINDOW_MS;
    this._churnThreshold = config.churnThreshold || CHURN_THRESHOLD;
    this._history = new Map(); // file -> number[] (modification timestamps, pruned to window)
    this._flagged = new Set(); // files already lessoned (avoid duplicate records)
    this._unsubs = [];
  }

  start() {
    if (!this.bus || typeof this.bus.on !== 'function') return;
    const off = this.bus.on('selfmod:success', (payload) => {
      try { this._record(payload); } catch (e) { _log.debug('[catch] selfmod outcome:', e.message); }
    });
    if (typeof off === 'function') this._unsubs.push(off);
    _log.info('[SELFMOD-OUTCOME] tracking self-modification outcomes');
  }

  // payload from selfmod:success carries { file }; CODE_MODIFIED may carry { files: [...] }.
  _record(payload, now = Date.now()) {
    const files = [];
    if (payload && payload.file) files.push(payload.file);
    if (payload && Array.isArray(payload.files)) files.push(...payload.files);
    for (const file of files) {
      if (!file) continue;
      const arr = (this._history.get(file) || []).filter(t => now - t <= this._windowMs);
      arr.push(now);
      this._history.set(file, arr);
      if (arr.length >= this._churnThreshold && !this._flagged.has(file)) {
        this._flagLesson(file, arr.length);
      }
    }
  }

  // Record a 'self-modification' lesson (NO rollback). The strategy.file field
  // is what the harm filter in improvement-proposals.buildProposals reads.
  _flagLesson(file, count) {
    this._flagged.add(file);
    if (!this.lessonsStore || typeof this.lessonsStore.record !== 'function') return;
    try {
      this.lessonsStore.record({
        category: 'self-modification',
        insight: `Repeated self-modification of ${file} (${count} changes within the window) is not converging — stop proposing further automatic changes to it.`,
        strategy: { file },
        evidence: { sampleSize: count, confidence: Math.min(1, 0.5 + 0.1 * count) },
        tags: ['self-modification', 'churn'],
        source: 'self-mod-outcome',
      });
      _log.info(`[SELFMOD-OUTCOME] flagged ${file} after ${count} changes within the window`);
    } catch (e) { _log.debug('[catch] flag lesson:', e.message); }
  }

  getReport() {
    return { trackedFiles: this._history.size, flagged: Array.from(this._flagged) };
  }

  stop() {
    for (const off of this._unsubs) { try { off(); } catch (_e) { /* best-effort */ } }
    this._unsubs = [];
  }
}

module.exports = { SelfModOutcomeTracker };
