// @ts-checked-v5.7
// ============================================================
// GENESIS — MetaLearning.js (v3.5.0 — Cognitive Agent)
//
// THE CLOSED LOOP: Genesis learns what works for its specific
// model. After 200 interactions, it knows: "json-schema output
// works 89% of the time for code-gen with gemma2:9b, but
// free-text only works 61%."
//
// What it tracks:
//   - Task category (code-gen, analysis, planning, etc.)
//   - Model used
//   - Prompt style (json-schema, xml-tags, free-text, few-shot)
//   - Temperature
//   - Success/failure (from VerificationEngine!)
//   - Latency
//   - Token counts
//
// What it produces:
//   - recommend(category, model) → best strategy
//   - Model ranking per category (feeds ModelRouter)
//   - Trend analysis (is quality improving or degrading?)
//
// No other open-source agent does this.
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('MetaLearning');

class MetaLearning {
  static containerConfig = {
    name: 'metaLearning',
    phase: 4,
    deps: ['storage'],
    tags: ['intelligence', 'learning'],
    lateBindings: [],
  };

  constructor({ bus, storage, intervals }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;
    this._intervals = intervals || null;

    // ── Strategy Database ─────────────────────────────────
    this._records = [];           // Raw outcome records
    this._maxRecords = 5000;      // Keep last 5000
    this._recommendations = {};   // Computed: { 'code-gen:gemma2:9b': { promptStyle, temp, ... } }
    this._modelRankings = {};     // Computed: { 'code-gen': [{ model, successRate, avgLatency }] }

    // ── Recalculation trigger ─────────────────────────────
    this._recalcEveryN = 50;      // Recalculate after every N recordings
    this._minSamples = 10;        // Minimum samples for a recommendation

    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this._load();
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Record the outcome of an LLM call.
   * Called by ModelBridge after every chat/chatStructured call.
   *
   * @param {object} outcome
   * @param {string} outcome.taskCategory - 'code-gen'|'analysis'|'planning'|'classification'|'chat'
   * @param {string} outcome.model - 'gemma2:9b'
   * @param {string} outcome.promptStyle - 'json-schema'|'xml-tags'|'free-text'|'few-shot'|'chain-of-thought'
   * @param {number} outcome.temperature
   * @param {string} outcome.outputFormat - 'json'|'text'|'code'
   * @param {boolean} outcome.success - Did verification pass?
   * @param {number} outcome.latencyMs
   * @param {number} outcome.inputTokens
   * @param {number} outcome.outputTokens
   * @param {string} outcome.verificationResult - 'pass'|'fail'|'ambiguous' (from VerificationEngine)
   * @param {number} outcome.retryCount
   */
  recordOutcome(outcome) {
    const record = {
      timestamp: Date.now(),
      taskCategory: outcome.taskCategory || 'unknown',
      model: outcome.model || 'unknown',
      promptStyle: outcome.promptStyle || 'free-text',
      temperature: outcome.temperature ?? 0.7,
      outputFormat: outcome.outputFormat || 'text',
      success: Boolean(outcome.success),
      latencyMs: outcome.latencyMs || 0,
      inputTokens: outcome.inputTokens || 0,
      outputTokens: outcome.outputTokens || 0,
      verificationResult: outcome.verificationResult || null,
      retryCount: outcome.retryCount || 0,
    };

    this._records.push(record);

    // Trim if over max
    if (this._records.length > this._maxRecords) {
      this._records = this._records.slice(-this._maxRecords);
    }

    // Periodic recalculation
    if (this._records.length % this._recalcEveryN === 0) {
      this._updateRecommendations();
      this._save();
    }

    this.bus.emit('meta:outcome-recorded', {
      category: record.taskCategory,
      model: record.model,
      success: record.success,
      total: this._records.length,
    }, { source: 'MetaLearning' });
  }

  /**
   * Get the best strategy for a task category + model.
   *
   * @param {string} taskCategory
   * @param {string} model - optional, uses active model if not specified
   * @returns {{ promptStyle, temperature, confidence, sampleSize, successRate } | null}
   */
  recommend(taskCategory, model) {
    const key = `${taskCategory}:${model || '*'}`;

    // Exact match
    if (this._recommendations[key]) {
      return { ...this._recommendations[key] };
    }

    // Category-only match (any model)
    const categoryKey = `${taskCategory}:*`;
    if (this._recommendations[categoryKey]) {
      return { ...this._recommendations[categoryKey] };
    }

    // No recommendation yet — return defaults
    return this._getDefaults(taskCategory);
  }

  /**
   * Get model rankings for a task category.
   * Used by ModelRouter to select the best model.
   *
   * @param {string} taskCategory
   * @returns {Array<{ model, successRate, avgLatency, sampleSize }>}
   */
  getModelRankings(taskCategory) {
    return this._modelRankings[taskCategory] || [];
  }

  /**
   * Get overall statistics.
   */
  getStats() {
    const total = this._records.length;
    const successes = this._records.filter(r => r.success).length;
    const categories = [...new Set(this._records.map(r => r.taskCategory))];
    const models = [...new Set(this._records.map(r => r.model))];

    return {
      totalRecords: total,
      successRate: total > 0 ? Math.round((successes / total) * 100) : 0,
      categories,
      models,
      recommendationCount: Object.keys(this._recommendations).length,
      oldestRecord: this._records[0]?.timestamp || null,
      newestRecord: this._records[this._records.length - 1]?.timestamp || null,
    };
  }

  /**
   * Get trend analysis: Is performance improving or degrading?
   * @param {string} taskCategory - optional filter
   * @returns {object}
   */
  getTrend(taskCategory) {
    const filtered = taskCategory
      ? this._records.filter(r => r.taskCategory === taskCategory)
      : this._records;

    if (filtered.length < 40) return { trend: 'stable', note: 'Insufficient data' };

    const midpoint = Math.floor(filtered.length / 2);
    const older = filtered.slice(0, midpoint);
    const recent = filtered.slice(midpoint);

    const olderRate = older.filter(r => r.success).length / older.length;
    const recentRate = recent.filter(r => r.success).length / recent.length;

    /** @type {'stable'|'improving'|'degrading'} */ let trend = 'stable';
    if (recentRate > olderRate + 0.05) trend = 'improving';
    else if (recentRate < olderRate - 0.05) trend = 'degrading';

    return {
      trend,
      recentRate: Math.round(recentRate * 100),
      olderRate: Math.round(olderRate * 100),
      sampleSize: filtered.length,
    };
  }

  // ════════════════════════════════════════════════════════
  // RECOMMENDATION COMPUTATION
  // ════════════════════════════════════════════════════════

  _updateRecommendations() {
    this._recommendations = {};
    this._modelRankings = {};

    // Group by (taskCategory, model, promptStyle)
    const groups = new Map();

    for (const record of this._records) {
      // Per model + category
      const key = `${record.taskCategory}:${record.model}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(record);

      // Per category only (any model)
      const catKey = `${record.taskCategory}:*`;
      if (!groups.has(catKey)) groups.set(catKey, []);
      groups.get(catKey).push(record);
    }

    // For each group, find best promptStyle
    for (const [key, records] of groups) {
      if (records.length < this._minSamples) continue;

      // Sub-group by promptStyle
      const byStyle = {};
      for (const r of records) {
        if (!byStyle[r.promptStyle]) byStyle[r.promptStyle] = [];
        byStyle[r.promptStyle].push(r);
      }

      // Find best style
      let bestStyle = null;
      let bestRate = 0;
      let bestTemp = 0.7;

      for (const [style, styleRecords] of Object.entries(byStyle)) {
        if (styleRecords.length < 5) continue; // Need at least 5 samples per style
        const rate = styleRecords.filter(r => r.success).length / styleRecords.length;
        if (rate > bestRate) {
          bestRate = rate;
          bestStyle = style;
          // Average temperature of successful calls
          const successfulTemps = styleRecords.filter(r => r.success).map(r => r.temperature);
          bestTemp = successfulTemps.length > 0
            ? successfulTemps.reduce((s, t) => s + t, 0) / successfulTemps.length
            : 0.7;
        }
      }

      if (bestStyle) {
        this._recommendations[key] = {
          promptStyle: bestStyle,
          temperature: Math.round(bestTemp * 100) / 100,
          successRate: Math.round(bestRate * 100),
          confidence: Math.min(1, records.length / 100), // Confidence grows with samples
          sampleSize: records.length,
        };
      }
    }

    // Compute model rankings per category
    const categories = [...new Set(this._records.map(r => r.taskCategory))];
    for (const category of categories) {
      const catRecords = this._records.filter(r => r.taskCategory === category);
      const byModel = {};
      for (const r of catRecords) {
        if (!byModel[r.model]) byModel[r.model] = [];
        byModel[r.model].push(r);
      }

      this._modelRankings[category] = Object.entries(byModel)
        .filter(([, records]) => records.length >= this._minSamples)
        .map(([model, records]) => ({
          model,
          successRate: Math.round((records.filter(r => r.success).length / records.length) * 100),
          avgLatency: Math.round(records.reduce((s, r) => s + r.latencyMs, 0) / records.length),
          sampleSize: records.length,
        }))
        .sort((a, b) => b.successRate - a.successRate || a.avgLatency - b.avgLatency);
    }

    this.bus.emit('meta:recommendations-updated', {
      count: Object.keys(this._recommendations).length,
      modelRankings: Object.keys(this._modelRankings).length,
    }, { source: 'MetaLearning' });
  }

  _getDefaults(taskCategory) {
    const defaults = {
      'code-gen':       { promptStyle: 'json-schema', temperature: 0.3 },
      'analysis':       { promptStyle: 'chain-of-thought', temperature: 0.5 },
      'planning':       { promptStyle: 'json-schema', temperature: 0.4 },
      'classification': { promptStyle: 'free-text', temperature: 0.1 },
      'chat':           { promptStyle: 'free-text', temperature: 0.7 },
      'creative':       { promptStyle: 'free-text', temperature: 0.9 },
    };

    const base = defaults[taskCategory] || { promptStyle: 'free-text', temperature: 0.7 };
    return { ...base, confidence: 0, sampleSize: 0, successRate: null, isDefault: true };
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  _save() {
    if (!this.storage) return;
    try {
      this.storage.writeJSONDebounced('meta-learning.json', {
        records: this._records.slice(-2000), // Save last 2000
        recommendations: this._recommendations,
        modelRankings: this._modelRankings,
      });
    } catch (err) { _log.debug('[META-LEARNING] Save error:', err.message); }
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   * Replaces sync this._load() that was previously in the constructor.
   */
  async asyncLoad() {
    this._load();

    // v4.0: Phase 9 — Surprise-amplified learning
    // When SurpriseAccumulator detects unexpected outcomes, it emits
    // 'surprise:amplified-learning' with a multiplier. We record
    // phantom outcomes to give surprising events more weight in
    // our rolling success-rate calculations.
    this.bus.on('surprise:amplified-learning', (data) => {
      if (!data || !data.actionType) return;
      const mult = Math.min(Math.round(data.multiplier || 1), 3);
      for (let i = 1; i < mult; i++) {
        // @ts-ignore — TS inference limitation (checkJs)
        this.recordOutcome({
          taskCategory: data.actionType,
          model: data.model || 'unknown',
          success: data.valence === 'positive',
          latencyMs: 0,
          promptStyle: 'surprise-weighted',
          verificationResult: data.valence === 'positive' ? 'pass' : 'fail',
        });
      }
    }, { source: 'MetaLearning:surprise' });
  }


  _load() {
    if (!this.storage) return;
    try {
      const data = this.storage.readJSON('meta-learning.json', null);
      if (!data) return;
      if (Array.isArray(data.records)) this._records = data.records;
      if (data.recommendations) this._recommendations = data.recommendations;
      if (data.modelRankings) this._modelRankings = data.modelRankings;
    } catch (err) { _log.debug('[META-LEARNING] Load error:', err.message); }
  }
}

module.exports = { MetaLearning };
