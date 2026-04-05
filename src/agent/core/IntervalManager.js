// @ts-checked-v5.6
// ============================================================
// GENESIS — IntervalManager.js
//
// Consolidates all periodic timers/intervals into one place.
// Extracted from AgentCore to:
// 1. Prevent timer leaks (all timers tracked + cleared)
// 2. Allow pause/resume of all background work
// 3. Make timer lifecycle testable
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('IntervalManager');
class IntervalManager {
  constructor() {
    /** @type {Map<string, {handle: ReturnType<typeof setInterval>, ms: number, fn: Function, paused: boolean}>} */
    this._intervals = new Map();
    this._stopped = false;
  }

  /**
   * Register and start a named interval
   * @param {string} name - Unique identifier
   * @param {Function} fn - Callback
   * @param {number} ms - Interval in milliseconds
   * @param {object} [opts] - Options
   * @param {boolean} [opts.immediate=false] - Run immediately on register
   */
  register(name, fn, ms, opts = {}) {
    if (this._stopped) return;
    // Clear existing if re-registering
    this.clear(name);

    const wrappedFn = async () => {
      try { await fn(); } catch (err) {
        // FIX v4.12.4 (N-02): Elevated from debug to warn — interval failures
        // were invisible at production log level 'info'.
        _log.warn(`[INTERVAL] ${name} failed:`, err.message);
      }
    };

    const handle = setInterval(wrappedFn, ms);
    this._intervals.set(name, { handle, ms, fn: wrappedFn, paused: false });

    if (opts.immediate) wrappedFn();
  }

  /** Clear a single named interval */
  clear(name) {
    const entry = this._intervals.get(name);
    if (entry) {
      clearInterval(entry.handle);
      this._intervals.delete(name);
    }
  }

  /** Pause a single interval (keeps registration for resume) */
  pause(name) {
    const entry = this._intervals.get(name);
    if (entry && !entry.paused) {
      clearInterval(entry.handle);
      entry.paused = true;
    }
  }

  /** Resume a paused interval */
  resume(name) {
    const entry = this._intervals.get(name);
    if (entry && entry.paused) {
      entry.handle = /** @type {*} */ (setInterval(entry.fn, entry.ms));
      entry.paused = false;
    }
  }

  /** Pause all intervals */
  pauseAll() {
    for (const name of this._intervals.keys()) this.pause(name);
  }

  /** Resume all paused intervals */
  resumeAll() {
    for (const name of this._intervals.keys()) this.resume(name);
  }

  /** Clear all intervals and prevent new registrations */
  shutdown() {
    this._stopped = true;
    for (const [name, entry] of this._intervals) {
      clearInterval(entry.handle);
    }
    this._intervals.clear();
  }

  /**
   * FIX v3.5.0: Reset after shutdown — allows re-boot after rollback.
   * Was permanently stopped after first shutdown() call.
   */
  reset() {
    this._stopped = false;
  }

  /** Get status of all intervals */
  getStatus() {
    return [...this._intervals.entries()].map(([name, entry]) => ({
      name,
      intervalMs: entry.ms,
      paused: entry.paused,
    }));
  }
}

module.exports = { IntervalManager };
