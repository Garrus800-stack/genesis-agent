// @ts-checked-v6.0
// ============================================================
// GENESIS — AdaptiveStrategy.js (v7.1.2 — Composition Refactor)
//
// v7.1.2: Diagnose/propose/apply logic extracted to
// AdaptiveStrategyApply.js delegate. This file retains the
// orchestration loop, validation, confirm/rollback, lifecycle,
// and public API.
//
// The meta-cognitive feedback loop: SelfModel detects weaknesses,
// AdaptiveStrategy proposes compensating adaptations, QuickBenchmark
// validates them, and results feed back into SelfModel.
//
// Principle: Diagnose → Prescribe → Measure → Learn. Repeat.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { NullBus } = require('../core/EventBus');
// v7.1.2: Composition delegate
const { AdaptiveStrategyApplyDelegate, STATUS } = require('./AdaptiveStrategyApply');

const _log = createLogger('AdaptiveStrategy');

// ── Adaptation cooldowns and thresholds ─────────────────────

const DEFAULTS = {
  cooldownMs:          30 * 60 * 1000,
  minOutcomes:         10,
  regressionThreshold: -0.05,
  noiseMargin:         0.02,
  budgetFloor:         0.20,
  maxHistory:          200,
  maxActiveAdaptations: 1,
  empiricalStrengthMinDelta: 0.15,
  dataMaxAgeMs:        7 * 24 * 3600_000,
};

const { applySubscriptionHelper } = require('../core/subscription-helper');

class AdaptiveStrategy {
  /**
   * @param {{ bus: *, storage: * }} deps
   */
  constructor({ bus, storage }) {
    this.bus = bus || NullBus;
    this.storage = storage;

    // Late-bound dependencies (all optional)
    /** @type {import('./CognitiveSelfModel').CognitiveSelfModel|null} */
    this.cognitiveSelfModel = null;
    /** @type {*} */ this.promptEvolution = null;
    /** @type {*} */ this.modelRouter = null;
    /** @type {*} */ this.onlineLearner = null;
    /** @type {*} */ this.quickBenchmark = null;

    // ── State ─────────────────────────────────────────────
    /** @type {Array<AdaptationRecord>} */
    this._history = [];
    /** @type {Array<AdaptationRecord>} */
    this._active = [];
    /** @type {Record<string, number>} */
    this._cooldowns = {};  // adaptationType → lastAppliedMs
    /** @type {Object} */
    this._config = { ...DEFAULTS };

    this.stats = {
      proposed: 0,
      applied: 0,
      confirmed: 0,
      rolledBack: 0,
      cyclesRun: 0,
      validationDeferred: 0,
    };

    /** @type {Array<Function>} */
    this._unsubs = [];

    // v7.1.2: Composition delegate for diagnose/propose/apply
    this._applyDelegate = new AdaptiveStrategyApplyDelegate(this);
  }
  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    try {
      const data = await this.storage?.readJSON('adaptive-strategy.json');
      if (data) {
        this._history = data.history || [];
        this._cooldowns = data.cooldowns || {};
        this.stats = { ...this.stats, ...(data.stats || {}) };
        _log.info(`[ADAPT] Loaded: ${this._history.length} historical adaptations, ` +
          `${this.stats.confirmed} confirmed, ${this.stats.rolledBack} rolled back`);
      }
    } catch (_e) { /* first run */ }
  }

  boot() {
    // Listen for task outcomes to check if active adaptations need validation
    this._sub('task-outcome:recorded', () => this._onNewOutcome());
    _log.info('[ADAPT] AdaptiveStrategy active — meta-cognitive feedback loop enabled');
  }

  stop() {
    for (const unsub of this._unsubs) unsub();
    this._unsubs.length = 0;
    this._saveSync();
  }

  _save() {
    this.storage?.writeJSONDebounced('adaptive-strategy.json', {
      history: this._history.slice(-this._config.maxHistory),
      cooldowns: this._cooldowns,
      stats: this.stats,
    });
  }

  _saveSync() {
    this.storage?.writeJSON('adaptive-strategy.json', {
      history: this._history.slice(-this._config.maxHistory),
      cooldowns: this._cooldowns,
      stats: this.stats,
    });
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Run one complete adaptation cycle: diagnose → propose → apply → validate.
   * Called by IdleMind 'calibrate' activity or CLI '/adapt'.
   *
   * @returns {Promise<AdaptationRecord|null>} The adaptation record, or null if no adaptation needed
   */
  async runCycle() {
    this.stats.cyclesRun++;
    _log.info('[ADAPT] Starting adaptation cycle...');

    // Guard: need SelfModel
    if (!this.cognitiveSelfModel) {
      _log.debug('[ADAPT] CognitiveSelfModel not available — skipping cycle');
      return null;
    }

    // Guard: max concurrent adaptations
    if (this._active.length >= this._config.maxActiveAdaptations) {
      _log.debug(`[ADAPT] Max active adaptations (${this._config.maxActiveAdaptations}) — skipping`);
      // Try to validate existing active adaptations instead
      await this._validateActive();
      return null;
    }

    // Step 1: Diagnose — gather SelfModel data
    const diagnosis = this._applyDelegate.diagnose();
    if (!diagnosis) {
      _log.info('[ADAPT] No actionable findings — all metrics stable');
      this.bus.emit('adaptation:cycle-complete', {
        outcome: 'no-action', cyclesRun: this.stats.cyclesRun,
      }, { source: 'AdaptiveStrategy' });
      return null;
    }

    // Step 2: Propose — select best adaptation
    const proposal = this._applyDelegate.propose(diagnosis);
    if (!proposal) {
      _log.info('[ADAPT] No viable adaptation — all options on cooldown or unavailable');
      return null;
    }

    // Step 3: Apply
    const record = await this._apply(proposal);
    if (!record) {
      _log.info('[ADAPT] Adaptation application failed — skipping');
      return null;
    }

    // Step 4: Validate (if QuickBenchmark available and budget allows)
    await this._tryValidate(record);

    return record;
  }

  /**
   * Get adaptation history and current state for Dashboard/CLI.
   * @returns {AdaptationReport}
   */
  getReport() {
    return {
      active: [...this._active],
      history: this._history.slice(-20),
      stats: { ...this.stats },
      cooldowns: { ...this._cooldowns },
      generatedAt: Date.now(),
    };
  }

  // ════════════════════════════════════════════════════════
  // STEP 1-2: DIAGNOSE + PROPOSE — delegated to AdaptiveStrategyApplyDelegate
  // ════════════════════════════════════════════════════════

  // ════════════════════════════════════════════════════════
  // STEP 3: APPLY
  // ════════════════════════════════════════════════════════

  /**
   * @private
   * @param {object} proposal
   * @returns {Promise<AdaptationRecord|null>}
   */
  async _apply(proposal) {
    const id = `adapt_${Date.now()}`;
    /** @type {AdaptationRecord} */
    const record = {
      id,
      type: proposal.type,
      bias: proposal.bias || null,
      section: proposal.section || null,
      taskType: proposal.taskType || null,
      hypothesis: proposal.hypothesis || null,
      evidence: proposal.evidence || null,
      status: STATUS.PROPOSED,
      proposedAt: Date.now(),
      appliedAt: null,
      validatedAt: null,
      baselineScore: null,
      postScore: null,
      delta: null,
      revert: null,
    };

    this.stats.proposed++;
    this.bus.emit('adaptation:proposed', {
      id, type: record.type, bias: record.bias,
      section: record.section, hypothesis: record.hypothesis,
    }, { source: 'AdaptiveStrategy' });

    _log.info(`[ADAPT] Proposed: ${record.type} — ${record.evidence}`);

    // v7.1.2: Strategy application delegated
    try {
      record.revert = await this._applyDelegate.applyStrategy(proposal);
    } catch (err) {
      _log.warn(`[ADAPT] Application failed: ${err.message}`);
      return null;
    }

    if (!record.revert) {
      _log.debug('[ADAPT] No revert function — adaptation not applied');
      return null;
    }

    record.status = STATUS.APPLIED;
    record.appliedAt = Date.now();
    this.stats.applied++;

    const cooldownKey = record.bias
      ? `${record.type}:${record.bias}`
      : record.taskType
        ? `${record.type}:${record.taskType}`
        : record.type;
    this._cooldowns[cooldownKey] = Date.now();

    this._active.push(record);
    this._save();

    this.bus.emit('adaptation:applied', {
      id, type: record.type, revertAvailable: true,
    }, { source: 'AdaptiveStrategy' });

    _log.info(`[ADAPT] Applied: ${record.type} — ${record.evidence}`);
    return record;
  }

  // ════════════════════════════════════════════════════════
  // STEP 4: VALIDATE
  // ════════════════════════════════════════════════════════

  /** @private */
  async _tryValidate(record) {
    if (!this.quickBenchmark) {
      record.status = STATUS.APPLIED_UNVALIDATED;
      _log.info('[ADAPT] QuickBenchmark not available — adaptation unvalidated');
      return;
    }

    // Check CostGuard budget
    if (!this.quickBenchmark.hasBudget()) {
      record.status = STATUS.APPLIED_UNVALIDATED;
      this.stats.validationDeferred++;
      this.bus.emit('adaptation:validation-deferred', {
        id: record.id, reason: 'Insufficient LLM budget for validation',
      }, { source: 'AdaptiveStrategy' });
      _log.info('[ADAPT] Validation deferred — budget floor reached');
      return;
    }

    record.status = STATUS.VALIDATING;

    try {
      // Capture baseline (pre-adaptation) if not already available
      const baseline = await this.quickBenchmark.getOrRunBaseline();
      record.baselineScore = baseline.successRate;

      // Run post-adaptation benchmark
      const post = await this.quickBenchmark.run();
      record.postScore = post.successRate;

      // Compare
      const verdict = this.quickBenchmark.compare(baseline, post);
      record.delta = verdict.delta;
      record.validatedAt = Date.now();

      if (verdict.decision === 'rollback') {
        this._rollback(record, `Regression: ${verdict.reason}`);
      } else {
        this._confirm(record);
      }
    } catch (err) {
      _log.warn(`[ADAPT] Validation failed: ${err.message}`);
      record.status = STATUS.APPLIED_UNVALIDATED;
    }
  }

  /** @private Validate any existing active adaptations */
  async _validateActive() {
    for (const record of this._active) {
      if (record.status === STATUS.APPLIED_UNVALIDATED || record.status === STATUS.APPLIED) {
        await this._tryValidate(record);
      }
    }
  }

  /** @private */
  _confirm(record) {
    record.status = STATUS.CONFIRMED;
    this.stats.confirmed++;

    // Move from active to history
    this._active = this._active.filter(r => r.id !== record.id);
    this._history.push(this._serializableRecord(record));
    this._save();

    this.bus.emit('adaptation:validated', {
      id: record.id, type: record.type,
      baselineScore: record.baselineScore, postScore: record.postScore,
      delta: record.delta, decision: 'confirmed',
    }, { source: 'AdaptiveStrategy' });

    // Store lesson
    this.bus.emit('lesson:learned', {
      category: 'meta-adaptation',
      title: `${record.type} adaptation confirmed: ${record.bias || record.taskType || 'general'}`,
      content: `Applied ${record.type} for "${record.evidence}". ` +
        `Baseline: ${this._pct(record.baselineScore)}, Post: ${this._pct(record.postScore)}, ` +
        `Delta: ${this._pctDelta(record.delta)}. Decision: confirmed.`,
      tags: ['adaptation', record.type, 'confirmed'],
    }, { source: 'AdaptiveStrategy' });

    _log.info(`[ADAPT] ✓ Confirmed: ${record.type} — delta ${this._pctDelta(record.delta)}`);
  }

  /** @private */
  _rollback(record, reason) {
    // Execute revert function
    if (typeof record.revert === 'function') {
      try { record.revert(); } catch (err) {
        _log.warn(`[ADAPT] Revert execution failed: ${err.message}`);
      }
    }

    record.status = STATUS.ROLLED_BACK;
    this.stats.rolledBack++;

    // Move from active to history
    this._active = this._active.filter(r => r.id !== record.id);
    this._history.push(this._serializableRecord(record));
    this._save();

    this.bus.emit('adaptation:rolled-back', {
      id: record.id, type: record.type, reason, lessonStored: true,
    }, { source: 'AdaptiveStrategy' });

    // Store lesson
    this.bus.emit('lesson:learned', {
      category: 'meta-adaptation',
      title: `${record.type} adaptation rolled back: ${record.bias || record.taskType || 'general'}`,
      content: `Applied ${record.type} for "${record.evidence}". ` +
        `Baseline: ${this._pct(record.baselineScore)}, Post: ${this._pct(record.postScore)}, ` +
        `Delta: ${this._pctDelta(record.delta)}. Rolled back: ${reason}.`,
      tags: ['adaptation', record.type, 'rolled-back'],
    }, { source: 'AdaptiveStrategy' });

    _log.info(`[ADAPT] ✗ Rolled back: ${record.type} — ${reason}`);
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL HELPERS
  // ════════════════════════════════════════════════════════

  /** @private */
  _onNewOutcome() {
    // When a new task outcome arrives, check if any active adaptations
    // that were unvalidated can now be validated
    if (this._active.some(r => r.status === STATUS.APPLIED_UNVALIDATED)) {
      // Debounce: don't validate on every single outcome
      if (!this._validateTimer) {
        this._validateTimer = setTimeout(() => {
          this._validateTimer = null;
          this._validateActive().catch(err => {
            _log.debug(`[catch] deferred validation: ${err.message}`);
          });
        }, 60_000); // Wait 1 min for more outcomes to accumulate
      }
    }
  }

  /** @private */
  _isOnCooldown(key) {
    const lastApplied = this._cooldowns[key] || 0;
    return (Date.now() - lastApplied) < this._config.cooldownMs;
  }

  /** @private */
  _wasRecentlyRolledBack(proposal) {
    const key = proposal.bias || proposal.taskType || proposal.type;
    const recent = this._history.slice(-10);
    return recent.some(r =>
      r.status === STATUS.ROLLED_BACK &&
      (r.bias === key || r.taskType === key) &&
      (Date.now() - (r.validatedAt || r.appliedAt || 0)) < this._config.cooldownMs * 2
    );
  }

  /** @private Strip non-serializable fields */
  _serializableRecord(record) {
    const { revert, ...rest } = record;
    return rest;
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

applySubscriptionHelper(AdaptiveStrategy);

module.exports = { AdaptiveStrategy, BIAS_HYPOTHESES: require('./AdaptiveStrategyApply').BIAS_HYPOTHESES, STATUS, DEFAULTS };

// ── Type Definitions ──────────────────────────────────────

/**
 * @typedef {object} AdaptationRecord
 * @property {string} id              — Unique ID (adapt_<timestamp>)
 * @property {string} type            — 'prompt-mutation' | 'backend-routing' | 'temp-signal'
 * @property {string|null} bias       — Bias ID if prompt-mutation
 * @property {string|null} section    — Prompt section if prompt-mutation
 * @property {string|null} taskType   — Task type if temp-signal
 * @property {string|null} hypothesis — Prompt hypothesis if prompt-mutation
 * @property {string|null} evidence   — Human-readable evidence string
 * @property {string} status          — proposed | applied | validating | confirmed | rolled-back | applied-unvalidated
 * @property {number} proposedAt
 * @property {number|null} appliedAt
 * @property {number|null} validatedAt
 * @property {number|null} baselineScore
 * @property {number|null} postScore
 * @property {number|null} delta
 * @property {Function|null} revert   — Runtime-only revert function (not persisted)
 */

/**
 * @typedef {object} AdaptationReport
 * @property {Array<AdaptationRecord>} active
 * @property {Array<AdaptationRecord>} history
 * @property {object} stats
 * @property {object} cooldowns
 * @property {number} generatedAt
 */
