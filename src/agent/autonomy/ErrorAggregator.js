// @ts-checked-v5.7
// ============================================================
// GENESIS — ErrorAggregator.js (v4.12.2)
//
// Central error stream aggregation and trend detection.
// Listens to all error events on the EventBus and categorizes
// them by source, type, and frequency. Detects rising error
// trends and emits warnings before they become critical.
//
// Problem solved:
//   476 try/catch blocks across the codebase all handle errors
//   locally. No module sees the global picture. ErrorAggregator
//   provides that bird's-eye view.
//
// Features:
//   - Sliding-window error rate tracking (per category)
//   - Trend detection: rising, falling, spike
//   - Configurable alert thresholds
//   - Error deduplication (same error within dedup window)
//   - Periodic health summary via EventBus
//
// Architecture:
//   EventBus (error events) → ErrorAggregator → trend analysis
//   ErrorAggregator → bus.emit('error:trend') for UI/logging
//   ErrorAggregator → getReport() for diagnostics
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ErrorAggregator');

const DEFAULT_CONFIG = {
  windowMs:         300_000,    // 5 min sliding window
  trendWindowMs:    60_000,     // 1 min for trend calculation
  spikeThreshold:   5,          // errors per trendWindow to trigger spike
  risingThreshold:  3,          // consecutive windows with increasing rate
  dedupWindowMs:    5_000,      // suppress identical errors within 5s
  maxCategories:    100,        // max tracked categories (prevent unbounded growth)
  maxErrorsPerCat:  500,        // max stored errors per category (ring buffer)
  healthIntervalMs: 60_000,     // emit health summary every 60s
};

class ErrorAggregator {
  static containerConfig = {
    name: 'errorAggregator',
    phase: 1,
    deps: [],
    tags: ['core', 'monitoring'],
    lateBindings: [],
  };

  /** @param {{ bus?: object, config?: object }} [opts] */
  constructor({ bus, config } = {}) {
    this.bus = bus || NullBus;
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Category → { errors: [{ts, msg, source}], windowRates: [rate1, rate2, ...] }
    this._categories = new Map();

    // Dedup: "category:message" → last timestamp
    this._dedup = new Map();

    // Unsub functions for cleanup
    this._unsubs = [];
    this._healthInterval = null;

    // Trend state
    this._trendHistory = new Map(); // category → [rate1, rate2, ...] per trendWindow
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    // Listen to all error-like events
    const errorPatterns = [
      'error:*', 'agent:error', 'safety:degraded',
      'model:error', 'sandbox:error', 'shell:error',
      'loop:error', 'mcp:error', 'network:error',
    ];

    for (const pattern of errorPatterns) {
      this._unsubs.push(
        this.bus.on(pattern, (data, meta) => this.record(meta?.event || pattern, data, meta), { source: 'ErrorAggregator' })
      );
    }

    // Periodic health summary
    // FIX v4.12.7 (Audit-02): Guard against double-start timer leak
    if (this._healthInterval) clearInterval(this._healthInterval);
    this._healthInterval = setInterval(() => this._emitHealthSummary(), this.config.healthIntervalMs);
    _log.info(`[ErrorAggregator] Started — tracking ${errorPatterns.length} patterns`);
  }

  stop() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs = [];
    if (this._healthInterval) {
      clearInterval(this._healthInterval);
      this._healthInterval = null;
    }
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Record an error occurrence.
   * @param {string} category - Error category (event name or custom)
   * @param {object} data - Error data payload
   * @param {object} meta - Event metadata
   */
  record(category, data = {}, meta = {}) {
    const now = Date.now();
    const msg = data?.error || data?.message || data?.reason || data?.detail || String(data).slice(0, 200);

    // Dedup check
    const dedupKey = `${category}:${msg}`;
    const lastSeen = this._dedup.get(dedupKey);
    if (lastSeen && (now - lastSeen) < this.config.dedupWindowMs) {
      return; // Suppress duplicate
    }
    this._dedup.set(dedupKey, now);

    // Prune dedup map periodically
    if (this._dedup.size > this.config.maxCategories * 10) {
      const cutoff = now - this.config.dedupWindowMs * 2;
      for (const [k, ts] of this._dedup) {
        if (ts < cutoff) this._dedup.delete(k);
      }
    }

    // Get or create category
    if (!this._categories.has(category)) {
      if (this._categories.size >= this.config.maxCategories) {
        this._evictOldestCategory();
      }
      this._categories.set(category, { errors: [], windowRates: [] });
    }
    const cat = this._categories.get(category);

    // Ring buffer per category
    cat.errors.push({ ts: now, msg, source: meta?.source || 'unknown' });
    if (cat.errors.length > this.config.maxErrorsPerCat) {
      cat.errors.shift();
    }

    // Check for trends after recording
    this._checkTrends(category, now);
  }

  /**
   * Get a comprehensive error report.
   * @returns {object}
   */
  getReport() {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    const categories = {};
    let totalErrors = 0;
    let activeCategories = 0;

    for (const [name, cat] of this._categories) {
      const recent = cat.errors.filter(e => e.ts >= windowStart);
      if (recent.length === 0) continue;

      activeCategories++;
      totalErrors += recent.length;
      categories[name] = {
        count: recent.length,
        ratePerMin: (recent.length / (this.config.windowMs / 60_000)).toFixed(1),
        lastError: recent[recent.length - 1],
        trend: this._getTrend(name),
      };
    }

    return {
      categories,
      summary: {
        totalErrors,
        activeCategories,
        windowMs: this.config.windowMs,
        timestamp: now,
      },
    };
  }

  /**
   * Get error rate for a specific category.
   * @param {string} category
   * @param {number} windowMs - Custom window (default: config.trendWindowMs)
   * @returns {number} Errors per minute
   */
  getRate(category, windowMs) {
    const window = windowMs || this.config.trendWindowMs;
    const cat = this._categories.get(category);
    if (!cat) return 0;
    const now = Date.now();
    const recent = cat.errors.filter(e => e.ts >= now - window);
    return recent.length / (window / 60_000);
  }

  // ════════════════════════════════════════════════════════
  // TREND DETECTION
  // ════════════════════════════════════════════════════════

  _checkTrends(category, now) {
    const cat = this._categories.get(category);
    if (!cat) return;

    const windowStart = now - this.config.trendWindowMs;
    const recentCount = cat.errors.filter(e => e.ts >= windowStart).length;

    // Track rate history for trend detection
    if (!this._trendHistory.has(category)) {
      this._trendHistory.set(category, []);
    }
    const history = this._trendHistory.get(category);
    history.push({ ts: now, rate: recentCount });

    // Keep only last 10 data points
    while (history.length > 10) history.shift();

    // Spike detection
    if (recentCount >= this.config.spikeThreshold) {
      this.bus.fire('error:trend', {
        category,
        type: 'spike',
        rate: recentCount,
        threshold: this.config.spikeThreshold,
        windowMs: this.config.trendWindowMs,
      }, { source: 'ErrorAggregator' });
      _log.warn(`[ErrorAggregator] SPIKE: "${category}" — ${recentCount} errors in ${this.config.trendWindowMs / 1000}s`);
    }

    // Rising trend detection
    if (history.length >= this.config.risingThreshold) {
      const recent = history.slice(-this.config.risingThreshold);
      const isRising = recent.every((p, i) => i === 0 || p.rate > recent[i - 1].rate);
      if (isRising && recent[recent.length - 1].rate > 1) {
        this.bus.fire('error:trend', {
          category,
          type: 'rising',
          rates: recent.map(p => p.rate),
          windows: this.config.risingThreshold,
        }, { source: 'ErrorAggregator' });
        _log.warn(`[ErrorAggregator] RISING: "${category}" — ${recent.map(p => p.rate).join(' → ')}`);
      }
    }
  }

  _getTrend(category) {
    const history = this._trendHistory.get(category);
    if (!history || history.length < 2) return 'stable';
    const last = history[history.length - 1].rate;
    const prev = history[history.length - 2].rate;
    if (last > prev * 1.5) return 'rising';
    if (last < prev * 0.5) return 'falling';
    return 'stable';
  }

  /**
   * v4.12.8: Convenience summary for PromptBuilder + IntrospectionEngine.
   * Returns rising trends and recent spikes in a flat format.
   * @returns {{ trending: Array<{category, rate}>, spikes: Array<{category, rate}> }}
   */
  getSummary() {
    const report = this.getReport();
    const trending = [];
    const spikes = [];

    for (const [name, data] of Object.entries(report.categories)) {
      const rate = parseFloat(data.ratePerMin) || 0;
      if (data.trend === 'rising') {
        trending.push({ category: name, rate });
      }
      if (rate >= this.config.spikeThreshold) {
        spikes.push({ category: name, rate });
      }
    }

    return { trending, spikes };
  }

  _evictOldestCategory() {
    let oldest = Infinity;
    let oldestKey = null;
    for (const [key, cat] of this._categories) {
      const lastTs = cat.errors.length > 0 ? cat.errors[cat.errors.length - 1].ts : 0;
      if (lastTs < oldest) {
        oldest = lastTs;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      this._categories.delete(oldestKey);
      this._trendHistory.delete(oldestKey);
    }
  }

  _emitHealthSummary() {
    const report = this.getReport();
    if (report.summary.totalErrors > 0) {
      this.bus.fire('error:health-summary', report, { source: 'ErrorAggregator' });
    }
  }
}

module.exports = { ErrorAggregator };
