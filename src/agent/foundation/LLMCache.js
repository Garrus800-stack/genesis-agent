// ============================================================
// GENESIS — LLMCache.js (v3.5.0)
//
// Simple LRU cache for LLM responses. Keyed on a hash of
// (systemPrompt + messages + taskType). Particularly useful for
// IntentRouter.classify() which often sees identical inputs.
//
// Features:
// - Configurable max size (default 100)
// - TTL-based expiry (default 5 minutes)
// - Stats tracking (hits, misses, evictions)
// - Selective bypass (e.g., never cache 'creative' tasks)
//
// Usage:
//   const cache = new LLMCache({ maxSize: 100, ttlMs: 300000 });
//   const key = cache.buildKey(systemPrompt, messages, taskType);
//   const cached = cache.get(key);
//   if (cached) return cached;
//   const result = await model.chat(...);
//   cache.set(key, result);
// ============================================================

const crypto = require('crypto');

class LLMCache {
  /** @param {{ maxSize?: number, ttlMs?: number, noCacheTaskTypes?: string[] }} [opts] */
  constructor({ maxSize = 100, ttlMs = 5 * 60 * 1000, noCacheTaskTypes = [] } = {}) {
    this._maxSize = maxSize;
    this._ttlMs = ttlMs;
    this._noCacheTaskTypes = new Set(noCacheTaskTypes);
    this._cache = new Map(); // key → { value, timestamp, accessOrder }
    this._accessCounter = 0;
    this._stats = { hits: 0, misses: 0, evictions: 0, sets: 0 };
  }

  /**
   * Build a cache key from prompt inputs.
   * @param {string} systemPrompt
   * @param {Array} messages - [{role, content}]
   * @param {string} taskType
   * @returns {string|null} Key, or null if this taskType is uncacheable
   */
  buildKey(systemPrompt, messages, taskType) {
    if (this._noCacheTaskTypes.has(taskType)) return null;

    const hash = crypto.createHash('sha256');
    hash.update(systemPrompt || '');
    hash.update('||');
    // Only hash the last 3 messages to keep context-sensitive but not too broad
    const recentMsgs = (messages || []).slice(-3);
    for (const msg of recentMsgs) {
      hash.update(msg.role || '');
      hash.update(':');
      hash.update((msg.content || '').slice(0, 500));
      hash.update('|');
    }
    hash.update('||');
    hash.update(taskType || '');
    return hash.digest('hex').slice(0, 24); // 24 chars is enough for collision avoidance
  }

  /**
   * Get a cached response.
   * @param {string} key
   * @returns {string|null} Cached response, or null
   */
  get(key) {
    if (!key) return null;
    const entry = this._cache.get(key);
    if (!entry) {
      this._stats.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.timestamp > this._ttlMs) {
      this._cache.delete(key);
      this._stats.misses++;
      return null;
    }

    entry.accessOrder = ++this._accessCounter;
    this._stats.hits++;
    return entry.value;
  }

  /**
   * Store a response.
   * @param {string} key
   * @param {string} value
   */
  set(key, value) {
    if (!key || !value) return;

    // Evict if at capacity
    if (this._cache.size >= this._maxSize && !this._cache.has(key)) {
      this._evictLRU();
    }

    this._cache.set(key, {
      value,
      timestamp: Date.now(),
      accessOrder: ++this._accessCounter,
    });
    this._stats.sets++;
  }

  /** Clear all entries */
  clear() {
    this._cache.clear();
  }

  /** Get stats */
  getStats() {
    return {
      ...this._stats,
      size: this._cache.size,
      maxSize: this._maxSize,
      hitRate: this._stats.hits + this._stats.misses > 0
        ? (this._stats.hits / (this._stats.hits + this._stats.misses) * 100).toFixed(1) + '%'
        : '0%',
    };
  }

  // ── Internal ────────────────────────────────────────────

  _evictLRU() {
    let oldestKey = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this._cache) {
      if (entry.accessOrder < oldestAccess) {
        oldestAccess = entry.accessOrder;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this._cache.delete(oldestKey);
      this._stats.evictions++;
    }
  }
}

module.exports = { LLMCache };
