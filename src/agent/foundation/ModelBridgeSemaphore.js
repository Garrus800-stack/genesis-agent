// ============================================================
// GENESIS — src/agent/foundation/ModelBridgeSemaphore.js
//
// v7.9.29 (hygiene #2): the internal LLM concurrency semaphore,
// extracted verbatim from ModelBridge to keep that file under the
// 700-LOC guard. A self-contained class; ModelBridge imports and
// instantiates it exactly as before. No behaviour change.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('ModelBridge');

class _LLMSemaphore {
  constructor(maxConcurrent = 2, starvationMs = 5 * 60 * 1000) {
    this.max = maxConcurrent;
    this.active = 0;
    this.queue = [];     // { resolve, reject, priority, enqueueTime }
    this._starvationMs = starvationMs;
    this._stats = { acquired: 0, queued: 0, peakActive: 0, peakQueued: 0, timedOut: 0 };
  }

  async acquire(priority = 0) {
    if (this.active < this.max) {
      this.active++;
      this._stats.acquired++;
      this._stats.peakActive = Math.max(this._stats.peakActive, this.active);
      return;
    }
    this._stats.queued++;
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, priority, enqueueTime: Date.now() };
      let i = this.queue.findIndex(e => e.priority < priority);
      if (i === -1) i = this.queue.length;
      this.queue.splice(i, 0, entry);
      this._stats.peakQueued = Math.max(this._stats.peakQueued, this.queue.length);

      entry._timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx !== -1) {
          this.queue.splice(idx, 1);
          this._stats.timedOut++;
          reject(new Error(`LLM semaphore starvation: waited ${Math.round(this._starvationMs / 1000)}s at priority ${priority}`));
        }
      }, this._starvationMs);
    });
  }

  release() {
    if (this.active <= 0) {
      const trace = new Error('Double-release origin').stack;
      _log.warn('[LLM-SEMAPHORE] release() called with active=0 — possible double-release\n', trace);
      this._stats.doubleReleases = (this._stats.doubleReleases || 0) + 1;
      return;
    }
    this.active--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next._timer) clearTimeout(next._timer);
      this.active++;
      this._stats.acquired++;
      next.resolve();
    }
  }

  getStats() {
    return { ...this._stats, active: this.active, queued: this.queue.length };
  }
}


module.exports = { _LLMSemaphore };
