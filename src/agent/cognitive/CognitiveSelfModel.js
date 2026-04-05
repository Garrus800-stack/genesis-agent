// @ts-checked-v5.9
// ============================================================
// GENESIS — CognitiveSelfModel.js (v5.9.8 — V6-11)
//
// The agent's continuously-updated model of its own
// capabilities, weaknesses, and failure patterns.
//
// No existing AI agent framework has this:
//   LangChain — no self-awareness
//   CrewAI    — no empirical capability tracking
//   AutoGen   — no bias detection
//   Devin     — no calibrated confidence
//
// Genesis is the only project with the cognitive substrate
// (TaskOutcomeTracker + ReasoningTracer + LessonsStore +
// PreservationInvariants) to implement this.
//
// Architecture:
//   TaskOutcomeTracker  ──→ raw outcome data
//   LessonsStore        ──→ historical patterns
//   ReasoningTracer     ──→ decision quality signals
//
//   CognitiveSelfModel computes:
//     CapabilityProfile  — per-task success + confidence intervals
//     CalibrationModel   — predicted vs actual cost/duration
//     BackendStrengthMap — which backend for which task type
//     BiasPatterns       — recurring failure signatures
//     ConfidenceReport   — before-task risk assessment
//
// Invariant (enforced by PreservationInvariants):
//   SelfModel MUST NOT overestimate capabilities.
//   Wilson lower-bound ensures pessimistic calibration.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');

const _log = createLogger('CognitiveSelfModel');

// ── Wilson score interval (lower bound) ─────────────────────
// Gives conservative confidence that accounts for small sample size.
// With 3 successes out of 3 tries, Wilson says ~56% confident,
// not 100%. This prevents overconfidence on small samples.
function wilsonLower(successes, total, z = 1.645) {
  if (total === 0) return 0;
  const p = successes / total;
  const denom = 1 + z * z / total;
  const center = p + z * z / (2 * total);
  const spread = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
  return Math.max(0, (center - spread) / denom);
}

// ── Bias pattern signatures ─────────────────────────────────
// Each pattern: { name, detect(outcomes) → { detected, evidence, severity } }
const BIAS_DETECTORS = [
  {
    id: 'scope-underestimate',
    description: 'Tends to underestimate multi-step task complexity',
    detect(outcomes) {
      const longTasks = outcomes.filter(o =>
        ['refactoring', 'code-gen', 'self-modify'].includes(o.taskType) && o.durationMs > 30_000
      );
      if (longTasks.length < 3) return null;
      const failRate = longTasks.filter(o => !o.success).length / longTasks.length;
      if (failRate > 0.4) {
        return {
          detected: true,
          severity: failRate > 0.6 ? 'high' : 'medium',
          evidence: `${Math.round(failRate * 100)}% failure on long tasks (n=${longTasks.length})`,
        };
      }
      return null;
    },
  },
  {
    id: 'token-overuse',
    description: 'Uses significantly more tokens than average for task type',
    detect(outcomes) {
      const byType = {};
      for (const o of outcomes) {
        if (!byType[o.taskType]) byType[o.taskType] = [];
        byType[o.taskType].push(o.tokenCost);
      }
      const flags = [];
      for (const [type, costs] of Object.entries(byType)) {
        if (costs.length < 5) continue;
        const sorted = [...costs].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        const recent = costs.slice(-3);
        const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
        if (median > 0 && recentAvg > median * 2) {
          flags.push(`${type}: recent avg ${Math.round(recentAvg)} vs median ${Math.round(median)}`);
        }
      }
      if (flags.length > 0) {
        return { detected: true, severity: 'low', evidence: flags.join('; ') };
      }
      return null;
    },
  },
  {
    id: 'error-repetition',
    description: 'Repeats the same error category multiple times',
    detect(outcomes) {
      const recentFails = outcomes.filter(o => !o.success && o.errorCategory).slice(-20);
      if (recentFails.length < 3) return null;
      const errorCounts = {};
      for (const o of recentFails) {
        errorCounts[o.errorCategory] = (errorCounts[o.errorCategory] || 0) + 1;
      }
      const repeated = Object.entries(errorCounts)
        .filter(([, c]) => c >= 3)
        .sort((a, b) => b[1] - a[1]);
      if (repeated.length > 0) {
        return {
          detected: true,
          severity: repeated[0][1] >= 5 ? 'high' : 'medium',
          evidence: repeated.map(([cat, n]) => `${cat} (${n}×)`).join(', '),
        };
      }
      return null;
    },
  },
  {
    id: 'backend-mismatch',
    description: 'Using a weak backend for a task type where another backend excels',
    detect(outcomes) {
      const matrix = {}; // { taskType: { backend: { success, total } } }
      for (const o of outcomes) {
        if (!matrix[o.taskType]) matrix[o.taskType] = {};
        if (!matrix[o.taskType][o.backend]) matrix[o.taskType][o.backend] = { success: 0, total: 0 };
        matrix[o.taskType][o.backend].total++;
        if (o.success) matrix[o.taskType][o.backend].success++;
      }
      const flags = [];
      for (const [type, backends] of Object.entries(matrix)) {
        const entries = Object.entries(backends).filter(([, s]) => s.total >= 3);
        if (entries.length < 2) continue;
        const rates = entries.map(([name, s]) => ({ name, rate: s.success / s.total, n: s.total }));
        rates.sort((a, b) => b.rate - a.rate);
        const best = rates[0];
        const worst = rates[rates.length - 1];
        if (best.rate - worst.rate > 0.25) {
          flags.push(`${type}: ${best.name} ${Math.round(best.rate * 100)}% vs ${worst.name} ${Math.round(worst.rate * 100)}%`);
        }
      }
      if (flags.length > 0) {
        return { detected: true, severity: 'medium', evidence: flags.join('; ') };
      }
      return null;
    },
  },
];

class CognitiveSelfModel {
  /**
   * @param {{ bus: *, config?: object }} deps
   */
  constructor({ bus, config }) {
    this.bus = bus;
    this._config = config || {};

    // Late-bound dependencies
    this.taskOutcomeTracker = null;
    this.lessonsStore = null;
    this.reasoningTracer = null;

    // Cached computations (invalidated on new outcomes)
    /** @type {{ profile: Record<string, CapabilityEntry>|null, calibration: *|null, biases: Array<BiasReport>|null, timestamp: number }} */
    this._cache = { profile: null, calibration: null, biases: null, timestamp: 0 };
    this._cacheMaxAge = (config && config.cacheMaxAgeMs) || 60_000; // 1 min

    /** @type {Array<Function>} */
    this._unsubs = [];

    this.stats = { profileBuilds: 0, confidenceQueries: 0, biasScans: 0 };
  }

  static containerConfig = {
    name: 'cognitiveSelfModel',
    phase: 9,
    deps: ['bus'],
    lateBindings: [
      { prop: 'taskOutcomeTracker', service: 'taskOutcomeTracker', optional: true },
      { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
      { prop: 'reasoningTracer', service: 'reasoningTracer', optional: true },
    ],
    tags: ['cognitive', 'selfmodel', 'v6-11'],
  };

  // ── Lifecycle ───────────────────────────────────────────

  boot() {
    this._unsubs.push(
      this.bus.on('task-outcome:recorded', () => this._invalidateCache()),
      this.bus.on('task-outcome:stats-updated', () => this._invalidateCache()),
    );
    _log.info('CognitiveSelfModel active — empirical self-awareness enabled');
  }

  stop() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Capability profile: per-task-type success rates with
   * Wilson lower-bound confidence intervals.
   *
   * @param {{ windowMs?: number }} [opts]
   * @returns {Record<string, CapabilityEntry>}
   */
  getCapabilityProfile(opts = {}) {
    if (this._cache.profile && !this._cacheExpired()) return this._cache.profile;
    if (!this.taskOutcomeTracker) return {};

    const stats = this.taskOutcomeTracker.getAggregateStats(opts);
    /** @type {Record<string, CapabilityEntry>} */
    const profile = {};

    for (const [type, s] of Object.entries(stats.byTaskType)) {
      const lower = wilsonLower(s.successes, s.count);
      const topErrors = Object.entries(s.errors)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cat, n]) => ({ category: cat, count: n }));

      profile[type] = {
        successRate: Math.round(s.successRate * 1000) / 1000,
        confidenceLower: Math.round(lower * 1000) / 1000,
        sampleSize: s.count,
        avgTokenCost: s.avgTokenCost,
        avgDurationMs: s.avgDurationMs,
        isWeak: lower < 0.6 && s.count >= 3,
        isStrong: lower > 0.8 && s.count >= 5,
        topErrors,
      };
    }

    // @ts-ignore — typed via JSDoc on _cache declaration
    this._cache.profile = profile;
    this._cache.timestamp = Date.now();
    this.stats.profileBuilds++;
    return profile;
  }

  /**
   * Backend strength map: which backend performs best for each task type.
   * Returns recommended backend per task type with empirical evidence.
   *
   * @param {{ windowMs?: number }} [opts]
   * @returns {Record<string, BackendRecommendation>}
   */
  getBackendStrengthMap(opts = {}) {
    if (!this.taskOutcomeTracker) return {};

    const outcomes = this.taskOutcomeTracker.getOutcomes({});
    const cutoff = opts.windowMs ? Date.now() - opts.windowMs : 0;
    const relevant = cutoff > 0 ? outcomes.filter(o => o.timestamp >= cutoff) : outcomes;

    // Build { taskType: { backend: { success, total, tokens } } }
    const matrix = {};
    for (const o of relevant) {
      if (!matrix[o.taskType]) matrix[o.taskType] = {};
      if (!matrix[o.taskType][o.backend]) matrix[o.taskType][o.backend] = { success: 0, total: 0, tokens: 0 };
      const cell = matrix[o.taskType][o.backend];
      cell.total++;
      if (o.success) cell.success++;
      cell.tokens += o.tokenCost;
    }

    /** @type {Record<string, BackendRecommendation>} */
    const map = {};
    for (const [type, backends] of Object.entries(matrix)) {
      const entries = Object.entries(backends)
        .filter(([, s]) => s.total >= 2)
        .map(([name, s]) => ({
          backend: name,
          successRate: s.total > 0 ? s.success / s.total : 0,
          confidence: wilsonLower(s.success, s.total),
          sampleSize: s.total,
          avgTokenCost: s.total > 0 ? Math.round(s.tokens / s.total) : 0,
        }))
        .sort((a, b) => b.confidence - a.confidence); // Sort by confidence, not raw rate

      if (entries.length > 0) {
        map[type] = {
          recommended: entries[0].backend,
          alternatives: entries.slice(1).map(e => e.backend),
          entries,
        };
      }
    }
    return map;
  }

  /**
   * Bias detection: scan recent outcomes for recurring failure patterns.
   *
   * @param {{ windowMs?: number }} [opts]
   * @returns {Array<BiasReport>}
   */
  getBiasPatterns(opts = {}) {
    if (this._cache.biases && !this._cacheExpired()) return this._cache.biases;
    if (!this.taskOutcomeTracker) return [];

    const outcomes = this.taskOutcomeTracker.getOutcomes({});
    const cutoff = opts.windowMs ? Date.now() - opts.windowMs : 0;
    const relevant = cutoff > 0 ? outcomes.filter(o => o.timestamp >= cutoff) : outcomes;

    /** @type {Array<BiasReport>} */
    const biases = [];
    for (const detector of BIAS_DETECTORS) {
      try {
        const result = detector.detect(relevant);
        if (result && result.detected) {
          biases.push({
            name: detector.id,
            description: detector.description,
            severity: result.severity,
            evidence: result.evidence,
          });
        }
      } catch (_e) {
        _log.debug(`[catch] bias detector ${detector.id}:`, _e.message);
      }
    }

    // @ts-ignore — typed via JSDoc on _cache declaration
    this._cache.biases = biases;
    this.stats.biasScans++;
    return biases;
  }

  /**
   * Confidence assessment for a specific task.
   * Returns pre-task risk report: confidence, known risks, recommendation.
   *
   * @param {string} taskType
   * @param {string} [backend]
   * @returns {ConfidenceReport}
   */
  getConfidence(taskType, backend) {
    this.stats.confidenceQueries++;
    const profile = this.getCapabilityProfile({ windowMs: 14 * 24 * 3600_000 }); // 14 days
    const entry = profile[taskType];

    if (!entry || entry.sampleSize < 3) {
      return {
        taskType,
        confidence: 'unknown',
        level: 0,
        risks: ['Insufficient data — fewer than 3 recorded outcomes for this task type'],
        recommendation: 'Proceed with caution. Monitor closely.',
      };
    }

    const risks = [];
    if (entry.isWeak) risks.push(`Low success rate: ${Math.round(entry.successRate * 100)}% (confidence floor: ${Math.round(entry.confidenceLower * 100)}%)`);
    if (entry.topErrors.length > 0) {
      risks.push(`Frequent error: ${entry.topErrors[0].category} (${entry.topErrors[0].count}× in last 14 days)`);
    }

    // Check biases relevant to this task type
    const biases = this.getBiasPatterns({ windowMs: 14 * 24 * 3600_000 });
    for (const bias of biases) {
      if (bias.evidence.toLowerCase().includes(taskType)) {
        risks.push(`Active bias: ${bias.name} — ${bias.evidence}`);
      }
    }

    // Backend-specific check
    if (backend) {
      const bsm = this.getBackendStrengthMap({ windowMs: 14 * 24 * 3600_000 });
      const rec = bsm[taskType];
      if (rec && rec.recommended !== backend && rec.entries.length > 1) {
        const recEntry = rec.entries.find(e => e.backend === rec.recommended);
        const curEntry = rec.entries.find(e => e.backend === backend);
        if (recEntry && curEntry && recEntry.confidence - curEntry.confidence > 0.15) {
          risks.push(`Suboptimal backend: ${rec.recommended} outperforms ${backend} for ${taskType} (${Math.round(recEntry.confidence * 100)}% vs ${Math.round(curEntry.confidence * 100)}% confidence)`);
        }
      }
    }

    // Determine confidence level
    const level = entry.confidenceLower; // Wilson lower bound = conservative confidence
    let confidence = 'medium';
    if (level > 0.8) confidence = 'high';
    else if (level < 0.5) confidence = 'low';

    let recommendation = 'Proceed normally.';
    if (confidence === 'low') recommendation = 'Allocate extra verification steps. Consider step-by-step breakdown.';
    else if (risks.length > 2) recommendation = 'Multiple risk factors — allocate extra care.';

    return { taskType, confidence, level: Math.round(level * 100) / 100, risks, recommendation };
  }

  /**
   * Build prompt-ready self-awareness context.
   * Called by PromptBuilder to inject empirical self-knowledge.
   *
   * @param {string} [currentIntent]
   * @returns {string}
   */
  buildPromptContext(currentIntent) {
    if (!this.taskOutcomeTracker) return '';

    try {
      const profile = this.getCapabilityProfile({ windowMs: 7 * 24 * 3600_000 });
      const entries = Object.entries(profile).filter(([, e]) => e.sampleSize >= 2);
      if (entries.length === 0) return '';

      const parts = [];

      // Overall capability summary
      const typeSummaries = entries
        .sort((a, b) => b[1].sampleSize - a[1].sampleSize)
        .slice(0, 6)
        .map(([type, e]) => `${type} ${Math.round(e.confidenceLower * 100)}%↑ (n=${e.sampleSize})`);
      parts.push('Capability floor (Wilson 90%): ' + typeSummaries.join(', ') + '.');

      // Weaknesses
      const weak = entries.filter(([, e]) => e.isWeak);
      if (weak.length > 0) {
        parts.push('Weakness: ' + weak.map(([type, e]) => {
          const err = e.topErrors[0];
          return type + (err ? ` (${err.category})` : '');
        }).join(', ') + '. Apply extra verification.');
      }

      // Current-task confidence (if intent provided)
      if (currentIntent) {
        const conf = this.getConfidence(currentIntent);
        if (conf.confidence !== 'unknown' && conf.risks.length > 0) {
          parts.push(`Current task (${currentIntent}): confidence=${conf.confidence}, risks: ${conf.risks[0]}.`);
        }
      }

      // Bias warnings
      const biases = this.getBiasPatterns({ windowMs: 7 * 24 * 3600_000 });
      const highBiases = biases.filter(b => b.severity === 'high');
      if (highBiases.length > 0) {
        parts.push('Active bias: ' + highBiases.map(b => b.name).join(', ') + '. Compensate actively.');
      }

      return '[Cognitive Self-Model] ' + parts.join(' ');
    } catch (_e) {
      _log.debug('[catch] buildPromptContext:', _e.message);
      return '';
    }
  }

  /**
   * Full diagnostic report for Dashboard and Colony sharing.
   * @returns {SelfModelReport}
   */
  getReport() {
    return {
      profile: this.getCapabilityProfile({ windowMs: 14 * 24 * 3600_000 }),
      backendMap: this.getBackendStrengthMap({ windowMs: 14 * 24 * 3600_000 }),
      biases: this.getBiasPatterns({ windowMs: 14 * 24 * 3600_000 }),
      stats: { ...this.stats },
      generatedAt: Date.now(),
    };
  }

  // ── Internal ────────────────────────────────────────────

  _invalidateCache() {
    this._cache.profile = null;
    this._cache.biases = null;
    this._cache.timestamp = 0;
  }

  _cacheExpired() {
    return Date.now() - this._cache.timestamp > this._cacheMaxAge;
  }
}

module.exports = { CognitiveSelfModel, wilsonLower, BIAS_DETECTORS };

// ── Type Definitions ──────────────────────────────────────

/**
 * @typedef {object} CapabilityEntry
 * @property {number} successRate       — Raw success rate (0-1)
 * @property {number} confidenceLower   — Wilson lower bound (conservative)
 * @property {number} sampleSize
 * @property {number} avgTokenCost
 * @property {number} avgDurationMs
 * @property {boolean} isWeak           — confidence < 60% with ≥3 samples
 * @property {boolean} isStrong         — confidence > 80% with ≥5 samples
 * @property {Array<{category: string, count: number}>} topErrors
 */

/**
 * @typedef {object} BackendRecommendation
 * @property {string} recommended
 * @property {string[]} alternatives
 * @property {Array<{backend: string, successRate: number, confidence: number, sampleSize: number, avgTokenCost: number}>} entries
 */

/**
 * @typedef {object} BiasReport
 * @property {string} name
 * @property {string} description
 * @property {string} severity   — 'low' | 'medium' | 'high'
 * @property {string} evidence
 */

/**
 * @typedef {object} ConfidenceReport
 * @property {string} taskType
 * @property {string} confidence — 'low' | 'medium' | 'high' | 'unknown'
 * @property {number} level      — Wilson lower bound (0-1)
 * @property {string[]} risks
 * @property {string} recommendation
 */

/**
 * @typedef {object} SelfModelReport
 * @property {Record<string, CapabilityEntry>} profile
 * @property {Record<string, BackendRecommendation>} backendMap
 * @property {Array<BiasReport>} biases
 * @property {object} stats
 * @property {number} generatedAt
 */
