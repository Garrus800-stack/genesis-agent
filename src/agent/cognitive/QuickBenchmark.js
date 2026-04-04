// @ts-checked-v6.0
// ============================================================
// GENESIS — QuickBenchmark.js (v6.0.2 — V6-12)
//
// In-process validation benchmark for the AdaptiveStrategy
// feedback loop. Wraps the existing benchmark-agent.js suite
// in --quick mode (3 tasks) for fast adaptation validation.
//
// PROBLEM: AdaptiveStrategy applies changes (prompt mutations,
// backend routing, temperature tuning) but has no way to
// verify whether the change helped or hurt. Without validation,
// adaptations are blind guesses.
//
// SOLUTION: Run a quick 3-task benchmark before and after each
// adaptation. Compare success rates. Confirm if no regression,
// rollback if significant regression.
//
// Cost: ~3 LLM calls per benchmark run (one per quick task).
// Respects CostGuard budget — defers validation if budget < 20%.
//
// Integration:
//   - AdaptiveStrategy calls run() + compare()
//   - CostGuard integration via late-binding
//   - Baseline cached and reused across cycles
//   - No child process — direct function import
//
// Pattern: Phase 9 cognitive service. Minimal deps.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { NullBus } = require('../core/EventBus');

const _log = createLogger('QuickBenchmark');

// ── Decision thresholds ─────────────────────────────────────

const THRESHOLDS = {
  regressionFloor: -0.05,   // 5pp regression → rollback
  noiseMargin:     0.02,    // 2pp noise margin → confirm
  budgetFloor:     0.20,    // 20% CostGuard budget floor
  baselineMaxAge:  4 * 3600_000, // 4 hours — baseline expires
};

class QuickBenchmark {
  /**
   * @param {{ bus: *, storage: * }} deps
   */
  constructor({ bus, storage }) {
    this.bus = bus || NullBus;
    this.storage = storage;

    // Late-bound
    /** @type {*} */ this.costGuard = null;

    // ── State ─────────────────────────────────────────────
    /** @type {BenchmarkResult|null} */
    this._cachedBaseline = null;
    this._baselineTimestamp = 0;

    this.stats = { runs: 0, comparisons: 0 };
  }

  static containerConfig = {
    name: 'quickBenchmark',
    phase: 9,
    deps: ['bus', 'storage'],
    tags: ['cognitive', 'benchmark', 'v6-0-2'],
    lateBindings: [
      { prop: 'costGuard', service: 'costGuard', optional: true },
    ],
  };

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Check if enough LLM budget remains for a benchmark run.
   * @returns {boolean}
   */
  hasBudget() {
    if (!this.costGuard) return true; // No guard → assume available
    try {
      const status = this.costGuard.getStatus();
      return status.sessionRemaining > status.sessionLimit * THRESHOLDS.budgetFloor;
    } catch (_e) {
      return true; // If CostGuard fails, allow benchmark
    }
  }

  /**
   * Run the quick benchmark (3 tasks).
   * @returns {Promise<BenchmarkResult>}
   */
  async run() {
    this.stats.runs++;
    _log.info('[BENCH] Running quick benchmark (3 tasks)...');

    try {
      const { runBenchmark } = this._loadBenchmarkModule();

      // Capture results — runBenchmark prints to console and returns result
      const result = runBenchmark({ quick: true, json: true, silent: true });

      const parsed = this._parseResult(result);
      _log.info(`[BENCH] Quick benchmark complete: ${this._pct(parsed.successRate)} success (${parsed.passed}/${parsed.total})`);

      return parsed;
    } catch (err) {
      _log.warn(`[BENCH] Benchmark failed: ${err.message}`);
      throw err;
    }
  }

  /**
   * Get existing baseline or run a new one.
   * Caches baseline for 4 hours to avoid redundant LLM calls.
   * @returns {Promise<BenchmarkResult>}
   */
  async getOrRunBaseline() {
    // Return cached baseline if fresh
    if (this._cachedBaseline && (Date.now() - this._baselineTimestamp) < THRESHOLDS.baselineMaxAge) {
      _log.debug('[BENCH] Using cached baseline');
      return this._cachedBaseline;
    }

    // Try loading from disk
    try {
      const stored = await this.storage?.readJSON('benchmark-baseline.json');
      if (stored && (Date.now() - stored.timestamp) < THRESHOLDS.baselineMaxAge) {
        this._cachedBaseline = stored.result;
        this._baselineTimestamp = stored.timestamp;
        _log.debug('[BENCH] Loaded baseline from disk');
        return this._cachedBaseline;
      }
    } catch (_e) { /* no stored baseline */ }

    // Run fresh baseline
    _log.info('[BENCH] Running fresh baseline...');
    const result = await this.run();
    this._cachedBaseline = result;
    this._baselineTimestamp = Date.now();

    // Persist
    this.storage?.writeJSONDebounced('benchmark-baseline.json', {
      result,
      timestamp: Date.now(),
    });

    return result;
  }

  /**
   * Compare baseline and post-adaptation results.
   * Returns a verdict: confirm, rollback, or inconclusive.
   *
   * @param {BenchmarkResult} baseline
   * @param {BenchmarkResult} post
   * @returns {ValidationVerdict}
   */
  compare(baseline, post) {
    this.stats.comparisons++;

    const delta = post.successRate - baseline.successRate;

    // Significant regression → rollback
    if (delta < THRESHOLDS.regressionFloor) {
      return {
        decision: 'rollback',
        delta,
        confidence: Math.abs(delta) > 0.10 ? 'high' : 'low',
        reason: `Regression: ${this._pct(baseline.successRate)} → ${this._pct(post.successRate)} (${this._pctDelta(delta)})`,
      };
    }

    // Within noise or improved → confirm
    if (delta >= -THRESHOLDS.noiseMargin) {
      return {
        decision: 'confirm',
        delta,
        confidence: delta > 0.05 ? 'high' : 'low',
        reason: delta > 0 ?
          `Improvement: ${this._pct(baseline.successRate)} → ${this._pct(post.successRate)} (${this._pctDelta(delta)})` :
          `Stable: ${this._pct(baseline.successRate)} → ${this._pct(post.successRate)} (within noise)`,
      };
    }

    // Edge case: moderate regression but not definitive
    return {
      decision: 'inconclusive',
      delta,
      confidence: 'low',
      reason: `Ambiguous: ${this._pct(baseline.successRate)} → ${this._pct(post.successRate)} (${this._pctDelta(delta)})`,
    };
  }

  /**
   * Invalidate cached baseline.
   * Called when conditions change significantly (e.g. model switch).
   */
  invalidateBaseline() {
    this._cachedBaseline = null;
    this._baselineTimestamp = 0;
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  /** @private */
  _loadBenchmarkModule() {
    try {
      // benchmark-agent.js exports { runBenchmark, TASKS }
      return require('../../scripts/benchmark-agent');
    } catch (err) {
      // Fallback: try relative to project root
      try {
        return require('../../../scripts/benchmark-agent');
      } catch (_e) {
        throw new Error(`Cannot load benchmark-agent.js: ${err.message}`);
      }
    }
  }

  /**
   * @private
   * Parse benchmark result into structured format.
   * Handles both object results (when json:true) and legacy string output.
   * @param {*} raw
   * @returns {BenchmarkResult}
   */
  _parseResult(raw) {
    // If runBenchmark returns structured result
    if (raw && typeof raw === 'object') {
      const tasks = raw.tasks || raw.results || [];
      const total = tasks.length || raw.total || 3;
      const passed = typeof raw.passed === 'number' ? raw.passed :
        tasks.filter(t => t.success || t.passed).length;

      return {
        successRate: total > 0 ? passed / total : 0,
        passed,
        total,
        tasks: tasks.map(t => ({
          name: t.name || t.task || 'unknown',
          success: !!(t.success || t.passed),
          latencyMs: t.latencyMs || t.latency || 0,
          tokenEstimate: t.tokenEstimate || t.tokens || 0,
        })),
        timestamp: Date.now(),
      };
    }

    // Fallback: could not parse
    _log.warn('[BENCH] Could not parse benchmark result — using defaults');
    return { successRate: 0, passed: 0, total: 0, tasks: [], timestamp: Date.now() };
  }

  /** @private */
  _pct(value) {
    return value != null ? `${Math.round(value * 100)}%` : 'n/a';
  }

  /** @private */
  _pctDelta(value) {
    if (value == null) return 'n/a';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${Math.round(value * 100)}pp`;
  }
}

module.exports = { QuickBenchmark, THRESHOLDS };

// ── Type Definitions ──────────────────────────────────────

/**
 * @typedef {object} BenchmarkResult
 * @property {number} successRate    — 0-1
 * @property {number} passed
 * @property {number} total
 * @property {Array<{name: string, success: boolean, latencyMs: number, tokenEstimate: number}>} tasks
 * @property {number} timestamp
 */

/**
 * @typedef {object} ValidationVerdict
 * @property {'confirm'|'rollback'|'inconclusive'} decision
 * @property {number} delta           — Percentage point change
 * @property {'high'|'low'} confidence
 * @property {string} reason
 */
