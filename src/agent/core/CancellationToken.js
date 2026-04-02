// @ts-checked-v5.6
// ============================================================
// GENESIS — CancellationToken.js (v4.12.2)
//
// Structured concurrency primitive for cooperative cancellation.
// Replaces ad-hoc abortSignal.aborted checks with a chainable,
// event-emitting token that integrates with the EventBus.
//
// Usage:
//   const token = new CancellationToken();
//   await longTask(token);     // task checks token.isCancelled
//   token.cancel('user abort');
//
// Chaining:
//   const child = token.child();  // cancelled when parent cancels
//   child.cancel();               // does NOT cancel parent
//
// Timeout:
//   const token = CancellationToken.withTimeout(30000);
// ============================================================

class CancellationToken {
  constructor() {
    this._cancelled = false;
    this._reason = null;
    this._callbacks = [];
    this._children = [];
  }

  /** @returns {boolean} */
  get isCancelled() { return this._cancelled; }

  /** @returns {string|null} */
  get reason() { return this._reason; }

  /**
   * Cancel this token and all children.
   * @param {string} [reason]
   */
  cancel(reason = 'cancelled') {
    if (this._cancelled) return;
    this._cancelled = true;
    this._reason = reason;

    // Notify listeners
    for (const cb of this._callbacks) {
      try { cb(reason); } catch (_e) { /* swallow callback errors */ }
    }
    this._callbacks = [];

    // Propagate to children
    for (const child of this._children) {
      child.cancel(`parent: ${reason}`);
    }
  }

  /**
   * Register a callback for when this token is cancelled.
   * If already cancelled, fires immediately.
   * @param {Function} callback - (reason) => void
   * @returns {Function} unsubscribe
   */
  onCancel(callback) {
    if (this._cancelled) {
      callback(this._reason);
      return () => {};
    }
    this._callbacks.push(callback);
    return () => {
      const idx = this._callbacks.indexOf(callback);
      if (idx >= 0) this._callbacks.splice(idx, 1);
    };
  }

  /**
   * Create a child token. Cancelled when parent cancels.
   * Child cancellation does NOT propagate to parent.
   * @returns {CancellationToken}
   */
  child() {
    const c = new CancellationToken();
    if (this._cancelled) {
      c.cancel(`parent: ${this._reason}`);
    } else {
      this._children.push(c);
    }
    return c;
  }

  /**
   * Throw if cancelled. Use as guard in async loops.
   * @throws {Error} if cancelled
   */
  throwIfCancelled() {
    if (this._cancelled) {
      const err = /** @type {Error & {cancelled: boolean}} */ (new Error(`CancellationToken: ${this._reason}`));
      err.cancelled = true;
      throw err;
    }
  }

  /**
   * Promise that rejects when cancelled. Race with work promises.
   * @returns {Promise<never>}
   */
  toPromise() {
    if (this._cancelled) return Promise.reject(new Error(`CancellationToken: ${this._reason}`));
    return new Promise((_, reject) => {
      this.onCancel((reason) => reject(new Error(`CancellationToken: ${reason}`)));
    });
  }

  /**
   * AbortSignal compatibility layer for fetch/child_process.
   * @returns {{ aborted: boolean }}
   */
  toAbortSignal() {
    const token = this;
    return { get aborted() { return token._cancelled; } };
  }

  // ── Static factories ──────────────────────────────────

  /**
   * Create a token that auto-cancels after timeoutMs.
   * @param {number} timeoutMs
   * @returns {CancellationToken}
   */
  static withTimeout(timeoutMs) {
    const token = new CancellationToken();
    const timer = setTimeout(() => token.cancel('timeout'), timeoutMs);
    token.onCancel(() => clearTimeout(timer));
    return token;
  }

  /** A token that is already cancelled. */
  static get CANCELLED() {
    const t = new CancellationToken();
    t.cancel('pre-cancelled');
    return t;
  }

  /** A token that never cancels (for optional parameters). */
  static get NONE() {
    return new CancellationToken();
  }
}

module.exports = { CancellationToken };
