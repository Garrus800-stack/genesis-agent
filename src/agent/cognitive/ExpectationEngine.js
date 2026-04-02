// @ts-checked-v5.6
// ============================================================
// GENESIS — ExpectationEngine.js (Phase 9 — Cognitive Architecture)
//
// The prediction machine. Before every autonomous action, Genesis
// forms a quantitative expectation about the outcome. After the
// action, reality is compared to prediction. The delta is the
// surprise signal — the driver of all Phase 9 learning.
//
// Two prediction modes:
//   1. Statistical (fast, no LLM) — when MetaLearning has ≥N samples
//      for this action type + model combination. Uses success rates,
//      latency averages, and SchemaStore modifiers.
//   2. Heuristic fallback — for novel actions with insufficient data.
//      Uses action-type base rates. NO LLM call — we don't want
//      expectation formation to be expensive or slow.
//
// The compare() method is the heart: it produces a SurpriseSignal
// using information-theoretic surprise (−log₂P) for boolean outcomes
// and normalized deviation for continuous values.
//
// Integration:
//   AgentLoopCognition.preExecute()  → expect(step) per plan step
//   AgentLoopCognition.postStep()    → compare(expectation, outcome)
//   compare() emits 'expectation:compared' → SurpriseAccumulator
//   SchemaStore.match()              → modifies success probability
//   MetaLearning.recommend()         → provides base success rates
// ============================================================

const { NullBus } = require('../core/EventBus');

// Default success rate estimates when no MetaLearning data exists
const BASE_RATES = {
  'ANALYZE':       { successRate: 0.90, avgLatencyMs: 3000 },
  'CODE_GENERATE': { successRate: 0.65, avgLatencyMs: 8000 },
  'WRITE_FILE':    { successRate: 0.95, avgLatencyMs: 500 },
  'RUN_TESTS':     { successRate: 0.60, avgLatencyMs: 15000 },
  'SHELL_EXEC':    { successRate: 0.75, avgLatencyMs: 5000 },
  'SEARCH':        { successRate: 0.85, avgLatencyMs: 4000 },
  'ASK_USER':      { successRate: 0.99, avgLatencyMs: 30000 },
  'DELEGATE':      { successRate: 0.50, avgLatencyMs: 20000 },
  'GIT_SNAPSHOT':  { successRate: 0.95, avgLatencyMs: 2000 },
  'SELF_MODIFY':   { successRate: 0.45, avgLatencyMs: 12000 },
};

const DEFAULT_BASE_RATE = { successRate: 0.60, avgLatencyMs: 5000 };

class ExpectationEngine {
  static containerConfig = {
    name: 'expectationEngine',
    phase: 9,
    deps: ['metaLearning', 'schemaStore', 'worldState', 'storage'],
    tags: ['cognitive', 'prediction'],
    lateBindings: [],
  };

  constructor({ bus, metaLearning, schemaStore, worldState, storage, config }) {
    this.bus = bus || NullBus;
    this.metaLearning = metaLearning || null;
    this.schemaStore = schemaStore || null;
    this.worldState = worldState || null;
    this.storage = storage || null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._minSamplesForStatistical = cfg.minSamples || 10;
    this._confidenceCap = cfg.confidenceCap || 0.95;

    // ── Calibration Tracking ─────────────────────────────
    // How accurate are our predictions? Updated per compare() call.
    this._calibration = {
      totalPredictions: 0,
      correctPredictions: 0,  // predicted success matched actual success
      booleanErrors: /** @type {number[]} */ ([]),      // rolling window of |predicted - actual|
      score: 0.5,             // 0.0 = terrible, 1.0 = perfect
    };
    this._maxCalibrationWindow = 200;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      expectations: 0,
      comparisons: 0,
      statisticalExpectations: 0,
      heuristicExpectations: 0,
    };
  }

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('expectation-calibration.json', null);
      if (data && data.calibration) {
        this._calibration = data.calibration;
        this._stats = data.stats || this._stats;
      }
    } catch (_e) { console.debug('[catch] expectation history load:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Form an expectation for a planned action.
   * Fast — no LLM calls. Uses statistics + schemas.
   *
   * @param {object} action - FormalPlanner typed step { type, description, target, ... }
   * @param {object} context - { model, worldState }
   * @returns {object} Expectation
   */
  expect(action, context = {}) {
    this._stats.expectations++;

    const actionType = (action.type || 'ANALYZE').toUpperCase();
    const model = context.model || null;

    // 1. Get base rate from MetaLearning or defaults
    const meta = this._getMetaRate(actionType, model);

    // 2. Get schema modifiers
    const schemas = this.schemaStore
      ? this.schemaStore.match(action, context)
      : [];

    // 3. Build expectation
    let successProb = meta.successRate;
    let durationMs = meta.avgLatencyMs;
    let confidence = meta.confidence;
    let source = meta.source;

    // Apply schema modifiers
    for (const schema of schemas) {
      const mod = schema.successModifier || 0;
      successProb = successProb * (1 + mod);
    }

    // Clamp
    successProb = Math.max(0.01, Math.min(this._confidenceCap, successProb));

    const expectation = {
      id: `exp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      actionType,
      target: action.target || null,
      description: (action.description || '').slice(0, 200),
      successProb,
      durationMs,
      qualityScore: successProb * 0.85, // rough proxy
      confidence,
      source,
      schemaIds: schemas.map(s => s.id),
      schemaCount: schemas.length,
      model: model || 'unknown',
      timestamp: Date.now(),
    };

    this.bus.emit('expectation:formed', {
      actionType: expectation.actionType,
      successProb: expectation.successProb,
      confidence: expectation.confidence,
      source: expectation.source,
      schemaCount: expectation.schemaCount,
    }, { source: 'ExpectationEngine' });

    return expectation;
  }

  /**
   * Compare actual outcome against expectation.
   * Produces a SurpriseSignal with information-theoretic surprise.
   *
   * @param {object} expectation
   * @param {object} outcome - { success, duration, qualityScore, verificationResult }
   * @returns {object|null} SurpriseSignal
   */
  compare(expectation, outcome) {
    if (!expectation || !outcome) return null;

    this._stats.comparisons++;

    const signal = {
      id: `sur_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      expectationId: expectation.id,
      timestamp: Date.now(),

      // ── Core surprise dimensions ───────────────────────
      // Information-theoretic: −log₂(P(observed outcome))
      // High surprise = the outcome was unlikely given our expectation
      successSurprise: this._booleanSurprise(
        expectation.successProb,
        outcome.success
      ),

      // Normalized deviation for continuous values
      durationSurprise: this._continuousSurprise(
        expectation.durationMs,
        outcome.duration
      ),

      qualitySurprise: this._continuousSurprise(
        expectation.qualityScore,
        outcome.qualityScore
      ),

      // ── Composite score ────────────────────────────────
      // 0.0 = exactly as expected, higher = more surprising
      totalSurprise: 0,

      // ── Metadata ───────────────────────────────────────
      valence: outcome.success ? 'positive' : 'negative',
      isNovel: expectation.confidence < 0.3,
      actionType: expectation.actionType,
      model: expectation.model,

      expected: {
        successProb: expectation.successProb,
        durationMs: expectation.durationMs,
        qualityScore: expectation.qualityScore,
        confidence: expectation.confidence,
      },

      actual: {
        success: outcome.success,
        duration: outcome.duration,
        qualityScore: outcome.qualityScore || null,
      },
    };

    // Weighted composite
    signal.totalSurprise = this._compositeSurprise(signal);

    // Update calibration
    this._updateCalibration(expectation, outcome);

    this.bus.emit('expectation:compared', signal, { source: 'ExpectationEngine' });

    // Periodic save
    if (this._stats.comparisons % 20 === 0) {
      this._save();
    }

    return signal;
  }

  /**
   * Get current calibration score.
   * 0.0 = predictions are terrible, 1.0 = predictions are perfect.
   */
  getCalibration() {
    return this._calibration.score;
  }

  /**
   * Get expectation engine statistics.
   */
  getStats() {
    return {
      ...this._stats,
      calibration: this._calibration.score,
      totalPredictions: this._calibration.totalPredictions,
    };
  }

  // ════════════════════════════════════════════════════════
  // PREDICTION SOURCES
  // ════════════════════════════════════════════════════════

  _getMetaRate(actionType, model) {
    // Try MetaLearning first (real data)
    if (this.metaLearning) {
      const rec = this.metaLearning.recommend(actionType.toLowerCase(), model);
      if (rec && rec.samples >= this._minSamplesForStatistical) {
        this._stats.statisticalExpectations++;
        return {
          successRate: rec.successRate ?? 0.6,
          avgLatencyMs: rec.avgLatency ?? 5000,
          confidence: Math.min(rec.samples / 100, this._confidenceCap),
          source: 'statistical',
          samples: rec.samples,
        };
      }
    }

    // Fallback: base rates
    this._stats.heuristicExpectations++;
    const base = BASE_RATES[actionType] || DEFAULT_BASE_RATE;
    return {
      ...base,
      confidence: 0.2, // Low confidence — we're guessing
      source: 'heuristic',
      samples: 0,
    };
  }

  // ════════════════════════════════════════════════════════
  // SURPRISE CALCULATIONS
  // ════════════════════════════════════════════════════════

  /**
   * Information-theoretic surprise for boolean outcomes.
   * −log₂(P(observed)) where P is the expected probability of what actually happened.
   *
   * Examples:
   *   expected 90% success, got success → −log₂(0.9) ≈ 0.15 (low surprise)
   *   expected 90% success, got failure → −log₂(0.1) ≈ 3.32 (high surprise)
   *   expected 50% success, got either  → −log₂(0.5) ≈ 1.00 (moderate)
   */
  _booleanSurprise(expectedProb, actualBool) {
    const p = actualBool ? expectedProb : (1 - expectedProb);
    // Cap at 0.01 to prevent infinity (max surprise ≈ 6.6 bits)
    return -Math.log2(Math.max(p, 0.01));
  }

  /**
   * Surprise for continuous values.
   * Normalized absolute deviation: |actual - expected| / max(|expected|, 1)
   * Capped at 3.0 to prevent outliers from dominating.
   */
  _continuousSurprise(expected, actual) {
    if (expected == null || actual == null) return 0;
    const denom = Math.max(Math.abs(expected), 1);
    return Math.min(Math.abs(actual - expected) / denom, 3.0);
  }

  /**
   * Weighted composite surprise score.
   * Success matters most (0.5), then quality (0.3), then duration (0.2).
   */
  _compositeSurprise(signal) {
    return (
      signal.successSurprise * 0.5 +
      signal.qualitySurprise * 0.3 +
      signal.durationSurprise * 0.2
    );
  }

  // ════════════════════════════════════════════════════════
  // CALIBRATION
  // ════════════════════════════════════════════════════════

  _updateCalibration(expectation, outcome) {
    this._calibration.totalPredictions++;

    // Boolean accuracy: did we predict the right direction?
    const predictedSuccess = expectation.successProb >= 0.5;
    const actualSuccess = !!outcome.success;
    if (predictedSuccess === actualSuccess) {
      this._calibration.correctPredictions++;
    }

    // Track prediction error for rolling EMA
    const error = Math.abs(expectation.successProb - (outcome.success ? 1 : 0));
    this._calibration.booleanErrors.push(error);
    if (this._calibration.booleanErrors.length > this._maxCalibrationWindow) {
      this._calibration.booleanErrors = this._calibration.booleanErrors.slice(-this._maxCalibrationWindow);
    }

    // Calibration score = 1 - average error (0=bad, 1=perfect)
    const avgError = this._calibration.booleanErrors.reduce((s, e) => s + e, 0) /
                     this._calibration.booleanErrors.length;
    this._calibration.score = 1 - avgError;

    // Periodic calibration event
    if (this._calibration.totalPredictions % 50 === 0) {
      this.bus.emit('expectation:calibrated', {
        score: this._calibration.score,
        totalPredictions: this._calibration.totalPredictions,
        accuracy: this._calibration.correctPredictions / this._calibration.totalPredictions,
      }, { source: 'ExpectationEngine' });
    }
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('expectation-calibration.json', {
        calibration: this._calibration,
        stats: this._stats,
        savedAt: Date.now(),
      }, 5000);
    } catch (_e) { console.debug('[catch] expectation persist:', _e.message); }
  }
}

module.exports = { ExpectationEngine, BASE_RATES };
