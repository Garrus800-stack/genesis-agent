// ============================================================
// GENESIS AGENT — EventBus.js (v3.5.0 — Dev-Mode Validation)
//
// ⚠️  FEATURE-FREEZE (v7.0.1): 84 methods — do not add new methods.
//     If new functionality is needed, extract into a companion module
//     (e.g. EventStats, EventReplay). See ARCHITECTURE.md §6.
//
// v3.5.0: Added event name validation in dev mode.
// When NODE_ENV !== 'production', every emit() checks the event
// name against the EventTypes catalog. Unknown events produce a
// warning with a stack trace — catches typos immediately.
//
// Also: fire() errors no longer silently swallowed — logged to
// console.warn so they show up in dev console.
// ============================================================

// @ts-check

const { CorrelationContext } = require('./CorrelationContext');

// Build a flat Set of all known event names from EventTypes
let _knownEvents = null;
let _unknownWarned = new Set(); // Only warn once per unknown event

function _loadKnownEvents() {
  if (_knownEvents) return _knownEvents;
  try {
    const { EVENTS } = require('./EventTypes');
    _knownEvents = new Set();
    const walk = (obj) => {
      for (const val of Object.values(obj)) {
        if (typeof val === 'string') _knownEvents.add(val);
        else if (typeof val === 'object' && val !== null) walk(val);
      }
    };
    walk(EVENTS);
  } catch { /* EventTypes not available — skip validation */
    _knownEvents = new Set();
  }
  return _knownEvents;
}

class EventBus {
  constructor() {
    this.listeners = new Map();   // event → Set<{ handler, once, priority, source }>
    this.history = [];            // Last N events for debugging (ring buffer)
    this._historyIdx = 0;          // FIX v4.0.0: Ring buffer write position
    this.historyLimit = (() => { try { return require('./Constants').LIMITS.EVENTBUS_HISTORY; } catch { return 500; } })();
    this.middlewares = [];        // Transform/filter events before delivery
    this.paused = new Set();      // Paused event types
    this.stats = new Map();       // event → { emitCount, lastEmit }
    this._maxStats = (() => { try { return require('./Constants').LIMITS.EVENTBUS_MAX_STATS; } catch { return 500; } })();

    // v3.5.0: Dev-mode event validation
    this._devMode = typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production';

    // FIX v3.8.0: Wildcard prefix cache — avoids O(n) iteration over all
    // listeners on every emit(). Wildcards like 'agent:*' are stored in a
    // separate Map keyed by their prefix ('agent:'). On emit, only matching
    // prefixes are checked instead of scanning all registered patterns.
    this._wildcardPrefixes = new Map(); // prefix → Set of pattern keys
  }

  /**
   * Subscribe to an event
   * @param {string} event - Event name (supports wildcards: 'agent:*')
   * @param {Function} handler - Callback(data, meta)
   * @param {object} options - { once, priority, source, key }
   *
   * FIX v5.1.0 (W-1): `key` option for listener deduplication.
   *   If `key` is provided and a listener with the same key already exists
   *   on this event, the old listener is **replaced** instead of accumulated.
   *   This prevents listener leaks during hot-reload or re-subscription.
   *
   *   Usage:
   *     bus.on('chat:message', handler, { source: 'IdleMind', key: 'idle-chat' });
   *     // Later (hot-reload / re-init):
   *     bus.on('chat:message', newHandler, { source: 'IdleMind', key: 'idle-chat' });
   *     // → replaces, not accumulates
   *
   * @returns {Function} Unsubscribe function
   */
  on(event, handler, options = {}) {
    const { once = false, priority = 0, source = 'unknown', key = null } = options;

    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }

    const set = this.listeners.get(event);

    // FIX v5.1.0 (W-1): Key-based dedup — replace existing listener with same key
    if (key) {
      if (!this._keyedEntries) this._keyedEntries = new Map(); // lazy init for backward compat
      const compositeKey = `${event}::${key}`;
      const existing = this._keyedEntries.get(compositeKey);
      if (existing) {
        set.delete(existing);
      }
      const entry = { handler, once, priority, source, event, key };
      set.add(entry);
      this._keyedEntries.set(compositeKey, entry);

      this._maintainWildcardCache(event);
      return this._createUnsub(event, entry, compositeKey);
    }

    const entry = { handler, once, priority, source, event };
    set.add(entry);

    // FIX v5.1.0 (W-1): Dev-mode accumulation warning
    if (this._devMode && set.size > 25) {
      const msg = `[EVENT:DEV] Listener accumulation on "${event}": ${set.size} listeners. ` +
        `Use { key } option to deduplicate, or verify no re-subscription loop exists.`;
      if (!this._accumWarned) this._accumWarned = new Set();
      if (!this._accumWarned.has(event)) {
        this._accumWarned.add(event);
        console.warn(msg);
      }
    }

    this._maintainWildcardCache(event);
    return this._createUnsub(event, entry, null);
  }

  /** @private Extract wildcard cache maintenance */
  _maintainWildcardCache(event) {
    // FIX v3.8.0: Maintain wildcard prefix cache
    if (event.endsWith('*')) {
      const prefix = event.slice(0, -1);
      if (!this._wildcardPrefixes.has(prefix)) {
        this._wildcardPrefixes.set(prefix, new Set());
      }
      this._wildcardPrefixes.get(prefix).add(event);
    }
  }

  /** @private Create unsubscribe function */
  _createUnsub(event, entry, compositeKey) {
    return () => {
      const set = this.listeners.get(event);
      if (set) {
        set.delete(entry);
        if (set.size === 0) {
          this.listeners.delete(event);
          if (event.endsWith('*')) {
            const prefix = event.slice(0, -1);
            const prefixSet = this._wildcardPrefixes.get(prefix);
            if (prefixSet) {
              prefixSet.delete(event);
              if (prefixSet.size === 0) this._wildcardPrefixes.delete(prefix);
            }
          }
        }
      }
      if (compositeKey && this._keyedEntries) {
        this._keyedEntries.delete(compositeKey);
      }
    };
  }

  /** Subscribe for a single emission */
  once(event, handler, options = {}) {
    return this.on(event, handler, { ...options, once: true });
  }

  /**
   * Emit an event to all subscribers
   * @param {string} event
   * @param {*} [data]
   * @param {object} [meta]
   * @returns {Promise<any[]>}
   */
  async emit(event, data = null, meta = {}) {
    if (this.paused.has(event)) return [];

    // v3.5.0: Dev-mode validation
    if (this._devMode) this._validateEventName(event, meta.source);

    const correlationId = CorrelationContext.getId();
    const fullMeta = {
      event,
      timestamp: Date.now(),
      source: meta.source || 'system',
      ...(correlationId && !meta.correlationId ? { correlationId } : {}),
      ...meta,
    };

    // Run through middlewares
    let processedData = data;
    for (const mw of this.middlewares) {
      const result = mw(event, processedData, fullMeta);
      if (result === false) return [];
      if (result !== undefined && result !== true) processedData = result;
    }

    this._recordHistory(event, processedData, fullMeta);

    // Collect matching listeners (exact + wildcard)
    const handlers = this._getMatchingHandlers(event);
    handlers.sort((a, b) => b.priority - a.priority);

    const results = [];
    const toRemove = [];

    let i = 0;
    while (i < handlers.length) {
      const currentPriority = handlers[i].priority;
      const batch = [];
      while (i < handlers.length && handlers[i].priority === currentPriority) {
        batch.push(handlers[i]);
        i++;
      }

      const batchResults = await Promise.allSettled(
        batch.map(entry => {
          try { return Promise.resolve(entry.handler(processedData, fullMeta)); }
          catch (err) { return Promise.reject(err); }
        })
      );

      for (let j = 0; j < batch.length; j++) {
        const entry = batch[j];
        const result = batchResults[j];
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          console.error(`[EVENT] Handler error for "${event}" from ${entry.source}:`, result.reason?.message || result.reason);
          results.push({ error: result.reason?.message || 'Unknown error' });
        }
        if (entry.once) toRemove.push(entry);
      }
    }

    for (const entry of toRemove) {
      const set = this.listeners.get(entry.event);
      if (set) set.delete(entry);
    }

    this._updateStats(event);
    return results;
  }

  /**
   * Fire-and-forget emit.
   * v3.5.0: Errors now logged to console.warn (not silently swallowed)
   * @param {string} event
   * @param {*} [data]
   * @param {object} [meta]
   */
  fire(event, data = null, meta = {}) {
    this.emit(event, data, meta).catch(err => {
      console.warn(`[EVENT] fire() error for "${event}":`, err.message);
    });
  }

  /**
   * Emit and wait for the FIRST handler to respond
   * @param {string} event
   * @param {*} [data]
   * @param {object} [meta]
   * @returns {Promise<*>}
   */
  async request(event, data = null, meta = {}) {
    const results = await this.emit(event, data, meta);
    return results.find(r => r !== undefined && r !== null && !r?.error) ?? null;
  }

  /** Add a middleware */
  use(fn) { this.middlewares.push(fn); }

  /** Pause/resume event types */
  pause(event) { this.paused.add(event); }
  resume(event) { this.paused.delete(event); }

  /**
   * Remove a handler
   * FIX v4.0.0: Collect-then-delete to avoid Set mutation during iteration.
   */
  off(event, handlerOrSource) {
    const set = this.listeners.get(event);
    if (!set) return false;

    let removed = false;
    const toDelete = [];
    for (const entry of set) {
      if (typeof handlerOrSource === 'function' && entry.handler === handlerOrSource) {
        toDelete.push(entry);
        removed = true;
        break;
      }
      if (typeof handlerOrSource === 'string' && entry.source === handlerOrSource) {
        toDelete.push(entry);
        removed = true;
      }
    }
    for (const entry of toDelete) set.delete(entry);

    if (set.size === 0) {
      this.listeners.delete(event);
      this._cleanupWildcardPrefix(event);
    }
    return removed;
  }

  /**
   * Remove all listeners for a source.
   * FIX v4.0.0: Collect-then-delete to avoid Map/Set mutation during iteration.
   * Previous version deleted from Map during outer for..of which could skip entries.
   */
  removeBySource(source) {
    let removed = 0;
    const emptyEvents = [];

    for (const [event, set] of this.listeners) {
      const toDelete = [];
      for (const entry of set) {
        if (entry.source === source) { toDelete.push(entry); }
      }
      for (const entry of toDelete) { set.delete(entry); removed++; }
      if (set.size === 0) emptyEvents.push(event);
    }

    for (const event of emptyEvents) {
      this.listeners.delete(event);
      this._cleanupWildcardPrefix(event);
    }

    return removed;
  }

  getListenerCount() {
    let count = 0;
    for (const set of this.listeners.values()) count += set.size;
    return count;
  }

  getRegisteredEvents() { return Array.from(this.listeners.keys()); }

  getStats() {
    const result = {};
    for (const [event, stat] of this.stats) {
      result[event] = { ...stat, listenerCount: this.listeners.get(event)?.size || 0 };
    }
    return result;
  }

  /**
   * v3.8.0: Listener health report — detects potential leaks.
   *
   * Returns per-event listener counts with source breakdown.
   * Events with > warnThreshold listeners are flagged as suspects.
   * Use after Container.replace() / hot-reload to verify cleanup.
   *
   * @param {{ warnThreshold?: number }} options
   * @returns {{ total: number, events: number, suspects: Array, breakdown: object }}
   */
  getListenerReport(options = {}) {
    const warnThreshold = options.warnThreshold || 10;
    let total = 0;
    const breakdown = {};
    const suspects = [];

    for (const [event, entries] of this.listeners) {
      const sources = {};
      for (const entry of entries) {
        const src = entry.source || 'unknown';
        sources[src] = (sources[src] || 0) + 1;
        total++;
      }
      breakdown[event] = { count: entries.size, sources };
      if (entries.size > warnThreshold) {
        suspects.push({ event, count: entries.size, sources });
      }
    }

    // FIX v4.10.0: Deduplicate console warnings. Dashboard polls this method
    // every few seconds — logging the same suspects repeatedly floods stdout.
    // Only warn when the suspect set changes (new event or count change).
    if (this._devMode && suspects.length > 0) {
      const key = suspects.map(s => `${s.event}:${s.count}`).join(',');
      if (key !== this._lastSuspectKey) {
        this._lastSuspectKey = key;
        console.warn(`[EVENT:HEALTH] ${suspects.length} event(s) exceed ${warnThreshold} listeners:`);
        for (const s of suspects) {
          console.warn(`  ⚠ "${s.event}": ${s.count} listeners — sources: ${Object.entries(s.sources).map(([k, v]) => `${k}(${v})`).join(', ')}`);
        }
      }
    } else if (suspects.length === 0) {
      this._lastSuspectKey = null;
    }

    return { total, events: this.listeners.size, suspects, breakdown };
  }

  // FIX v4.0.0: Ring buffer aware — returns entries in chronological order
  getHistory(limit = 50) {
    if (this.history.length < this.historyLimit) {
      return this.history.slice(-limit);
    }
    // Ring buffer is full: oldest entry is at _historyIdx, newest at _historyIdx-1
    const ordered = [...this.history.slice(this._historyIdx), ...this.history.slice(0, this._historyIdx)];
    return ordered.slice(-limit);
  }

  // ── v3.5.0: Dev-Mode Validation ────────────────────────

  /**
   * Validate event name against EventTypes catalog.
   * Only warns once per unknown event to avoid log spam.
   */
  _validateEventName(event, source) {
    // Skip wildcard subscriptions and internal events
    if (event.endsWith('*')) return;

    const known = _loadKnownEvents();
    if (known.size === 0) return; // Catalog not loaded

    if (!known.has(event) && !_unknownWarned.has(event)) {
      _unknownWarned.add(event);
      const suggestion = this._suggestEvent(event, known);
      const msg = suggestion
        ? `[EVENT:DEV] Unknown event "${event}" from ${source || '?'}. Did you mean "${suggestion}"?`
        : `[EVENT:DEV] Unknown event "${event}" from ${source || '?'}. Not in EventTypes catalog.`;
      console.warn(msg);
      // In dev mode, also log a short stack for quick navigation
      if (typeof Error.captureStackTrace === 'function') {
        const e = {};
        Error.captureStackTrace(e);
        const frames = e.stack.split('\n').slice(2, 5).join('\n');
        console.warn(frames);
      }
    }
  }

  /**
   * Suggest closest matching event name (Levenshtein distance ≤ 3)
   */
  _suggestEvent(unknown, knownSet) {
    let best = null;
    let bestDist = 4; // Only suggest if distance ≤ 3
    for (const candidate of knownSet) {
      const d = _levenshtein(unknown, candidate);
      if (d < bestDist) {
        bestDist = d;
        best = candidate;
      }
    }
    return best;
  }

  // ── Internal ─────────────────────────────────────────────

  // FIX v3.8.0: Prefix-map lookup replaces O(n) linear scan.
  // Instead of iterating ALL registered patterns on every emit,
  // we check only wildcard prefixes that could match the event.
  // With 154 event types this reduces wildcard matching from ~154
  // comparisons to ~10 prefix checks per emit.
  _getMatchingHandlers(event) {
    const handlers = [];
    const exact = this.listeners.get(event);
    if (exact) handlers.push(...exact);

    // Check wildcard prefixes that match this event
    for (const [prefix, patterns] of this._wildcardPrefixes) {
      if (event.startsWith(prefix)) {
        for (const pattern of patterns) {
          const set = this.listeners.get(pattern);
          if (set) handlers.push(...set);
        }
      }
    }
    return handlers;
  }

  /** FIX v3.8.0: Remove wildcard prefix entry when last listener is removed */
  _cleanupWildcardPrefix(event) {
    if (event.endsWith('*')) {
      const prefix = event.slice(0, -1);
      const prefixSet = this._wildcardPrefixes.get(prefix);
      if (prefixSet) {
        prefixSet.delete(event);
        if (prefixSet.size === 0) this._wildcardPrefixes.delete(prefix);
      }
    }
  }

  _recordHistory(event, data, meta) {
    let summary;
    if (data === null || data === undefined) {
      summary = String(data);
    } else if (typeof data === 'object') {
      const keys = Object.keys(data);
      summary = `{${keys.slice(0, 6).join(', ')}${keys.length > 6 ? ', ...' + keys.length : ''}}`;
    } else {
      summary = String(data).slice(0, 120);
    }

    // FIX v4.0.0: Ring buffer instead of push+slice — O(1) instead of O(n).
    // Eliminates GC pressure from repeated array reallocation under high event rates.
    if (this.history.length >= this.historyLimit) {
      this.history[this._historyIdx] = { event, data: summary, timestamp: meta.timestamp, source: meta.source, correlationId: meta.correlationId };
      this._historyIdx = (this._historyIdx + 1) % this.historyLimit;
    } else {
      this.history.push({ event, data: summary, timestamp: meta.timestamp, source: meta.source, correlationId: meta.correlationId });
    }
  }

  _updateStats(event) {
    const existing = this.stats.get(event) || { emitCount: 0 };
    this.stats.set(event, { emitCount: existing.emitCount + 1, lastEmit: Date.now() });

    // FIX v3.5.0: Evict oldest stats entries beyond limit to prevent unbounded growth
    if (this.stats.size > this._maxStats) {
      let oldestEvent = null;
      let oldestTime = Infinity;
      for (const [evt, stat] of this.stats) {
        if (stat.lastEmit < oldestTime) {
          oldestTime = stat.lastEmit;
          oldestEvent = evt;
        }
      }
      if (oldestEvent) this.stats.delete(oldestEvent);
    }
  }
}

// ── Levenshtein distance (optimized) ─────────────────────
// FIX v4.0.0: Single-row + early-exit. O(min(n,m)) space instead of O(n*m).
// Aborts early if minimum possible distance exceeds maxDist threshold.
function _levenshtein(a, b, maxDist = 4) {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  // Early exit: length difference alone exceeds threshold
  if (Math.abs(a.length - b.length) >= maxDist) return maxDist;
  // Ensure a is the shorter string (single-row optimization)
  if (a.length > b.length) { const t = a; a = b; b = t; }
  const lenA = a.length, lenB = b.length;
  let prev = new Array(lenA + 1);
  let curr = new Array(lenA + 1);
  for (let j = 0; j <= lenA; j++) prev[j] = j;
  for (let i = 1; i <= lenB; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lenA; j++) {
      const cost = b[i - 1] === a[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    // Early exit: if entire row exceeds threshold, no need to continue
    if (rowMin >= maxDist) return maxDist;
    const t = prev; prev = curr; curr = t;
  }
  return prev[lenA];
}

// Singleton
const NullBus = Object.freeze({
  emit() { return []; },
  fire() {},
  on() { return () => {}; },
  once() { return () => {}; },
  off() { return false; },
  request() { return null; },
  use() {},
  pause() {},
  resume() {},
  removeBySource() { return 0; },
  getStats() { return {}; },
  getHistory() { return []; },
  getListenerCount() { return 0; },
  getRegisteredEvents() { return []; },
  getListenerReport() { return { total: 0, events: 0, suspects: [], breakdown: {} }; },
});

// FIX v4.0.0: Added createBus() factory for test isolation.
// Tests should use createBus() instead of the shared singleton to prevent
// cross-test event contamination. Production code continues using the singleton.
const createBus = () => new EventBus();

module.exports = { EventBus, bus: new EventBus(), NullBus, createBus };
