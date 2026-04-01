// @ts-checked-v5.6
// ============================================================
// GENESIS — WriteLock.js (v3.5.0 — Timeout + Deadlock Safety)
//
// Lightweight async mutex for protecting flush/write operations.
// Prevents race conditions between normal writes and shutdown
// flush in ConversationMemory and KnowledgeGraph.
//
// v3.5.0 HARDENING:
// - acquire() accepts optional timeoutMs parameter
// - Deadlock prevention: queued acquire() rejects after timeout
// - withLock() propagates timeout
// - Stats tracking (acquires, releases, timeouts, peakQueue)
// - Dev-mode owner tracking for deadlock diagnosis
//
// Usage:
//   const lock = new WriteLock({ name: 'kg', defaultTimeoutMs: 10000 });
//   await lock.withLock(async () => { /* write data */ });
//
// BACKWARDS COMPATIBLE: All existing v3.5.0 usage works unchanged.
// The no-arg constructor defaults to 30s timeout.
// ============================================================

class WriteLock {
  /**
   * @param {object} [options]
   * @param {string} [options.name='unnamed'] - Lock name for diagnostics
   * @param {number} [options.defaultTimeoutMs=30000] - Default timeout. 0 = no timeout.
   */
  constructor(options) {
    // v3.5.0 backwards compat: no-arg constructor still works
    const opts = (typeof options === 'object' && options !== null) ? options : {};
    this._name = opts.name || 'unnamed';
    this._defaultTimeoutMs = opts.defaultTimeoutMs !== undefined ? opts.defaultTimeoutMs : 30000;
    this._locked = false;
    this._queue = [];   // { resolve, reject, timer }
    this._owner = null; // stack trace of current holder (dev mode only)
    this._devMode = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

    // Stats
    this._stats = { acquires: 0, releases: 0, timeouts: 0, peakQueue: 0 };
  }

  /**
   * Acquire the lock.
   * @param {number} [timeoutMs] - Max wait time. 0 = no timeout. Default: constructor default.
   * @returns {Promise<void>}
   * @throws {Error} If timeout expires while waiting (error.code === 'WRITELOCK_TIMEOUT')
   */
  async acquire(timeoutMs) {
    const timeout = timeoutMs !== undefined ? timeoutMs : this._defaultTimeoutMs;

    if (!this._locked) {
      this._locked = true;
      this._stats.acquires++;
      this._captureOwner();
      return;
    }

    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };

      // Timeout: reject if we wait too long
      if (timeout > 0) {
        entry.timer = /** @type {*} */ (setTimeout(() => {
          const idx = this._queue.indexOf(entry);
          if (idx !== -1) {
            this._queue.splice(idx, 1);
            this._stats.timeouts++;
            const err = /** @type {Error & {code: string}} */ (new Error(
              `[WriteLock:${this._name}] Timeout after ${timeout}ms. ` +
              `Queue: ${this._queue.length}.` +
              (this._owner ? ` Holder:\n${this._owner}` : '')
            ));
            err.code = 'WRITELOCK_TIMEOUT';
            reject(err);
          }
        }, timeout));
      }

      this._queue.push(entry);
      this._stats.peakQueue = Math.max(this._stats.peakQueue, this._queue.length);
    });
  }

  /**
   * Release the lock. Hands off to next waiter if any.
   */
  release() {
    this._stats.releases++;

    if (this._queue.length > 0) {
      const next = this._queue.shift();
      if (next.timer) clearTimeout(next.timer);
      this._stats.acquires++;
      this._captureOwner();
      next.resolve();
    } else {
      this._locked = false;
      this._owner = null;
    }
  }

  /**
   * Execute fn while holding the lock.
   * Automatically releases on completion or error.
   * @param {Function} fn - Async function to execute
   * @param {number} [timeoutMs] - Lock acquisition timeout
   */
  async withLock(fn, timeoutMs) {
    await this.acquire(timeoutMs);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  get isLocked() { return this._locked; }
  get queueLength() { return this._queue.length; }

  getStats() {
    return {
      ...this._stats,
      locked: this._locked,
      queueLength: this._queue.length,
      name: this._name,
    };
  }

  // ── Internal ────────────────────────────────────────────

  _captureOwner() {
    if (!this._devMode) { this._owner = null; return; }
    const e = {};
    Error.captureStackTrace(e);
    this._owner = e.stack.split('\n').slice(2, 6).join('\n');
  }
}

module.exports = { WriteLock };
