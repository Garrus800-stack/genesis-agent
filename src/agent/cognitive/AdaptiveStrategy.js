// @ts-checked-v6.0
// ============================================================
// GENESIS — AdaptiveStrategy.js (v6.0.2 — V6-12)
//
// The meta-cognitive feedback loop: SelfModel detects weaknesses,
// AdaptiveStrategy proposes compensating adaptations, QuickBenchmark
// validates them, and results feed back into SelfModel.
//
// PROBLEM: CognitiveSelfModel (V6-11) detects biases and backend
// mismatches, but no system acts on those findings. PromptEvolution
// can evolve prompt sections, but nobody tells it WHAT to improve.
// ModelRouter routes by heuristic, ignoring empirical evidence.
// Genesis diagnoses but never prescribes.
//
// SOLUTION: A reactive bridge with three adaptation strategies:
//
//   1. PROMPT MUTATION — bias pattern → hypothesis → experiment
//      Trigger: SelfModel.getBiasPatterns() returns severity >= medium
//      Action:  PromptEvolution.startExperiment(section, text, hypothesis)
//
//   2. BACKEND ROUTING — strength map → ModelRouter injection
//      Trigger: SelfModel.getBackendStrengthMap() confidence delta > 15%
//      Action:  ModelRouter.injectEmpiricalStrength(strengthMap)
//
//   3. TEMPERATURE SIGNAL — capability profile → OnlineLearner
//      Trigger: SelfModel.getCapabilityProfile() isWeak/isStrong flags
//      Action:  OnlineLearner.receiveWeaknessSignal(taskType, isWeak)
//
// Every adaptation follows: PROPOSED → APPLIED → VALIDATED → CONFIRMED | ROLLED_BACK
// Every hypothesis is tested. Every test has a rollback.
//
// Integration:
//   - Registered in phase9 manifest, late-bound to all targets
//   - IdleMind 'calibrate' activity triggers runCycle()
//   - CLI: /adapt, /adaptations
//   - Events: adaptation:proposed, :applied, :validated, :rolled-back
//   - LessonsStore: every confirmed/rolled-back adaptation stored as lesson
//
// Principle: Diagnose → Prescribe → Measure → Learn. Repeat.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { NullBus } = require('../core/EventBus');

const _log = createLogger('AdaptiveStrategy');

// ── Adaptation cooldowns and thresholds ─────────────────────

const DEFAULTS = {
  cooldownMs:          30 * 60 * 1000,  // 30 min between same-type adaptations
  minOutcomes:         10,              // Minimum SelfModel outcomes before adapting
  regressionThreshold: -0.05,           // 5pp regression triggers rollback
  noiseMargin:         0.02,            // 2pp noise margin for confirm
  budgetFloor:         0.20,            // 20% CostGuard budget floor for validation
  maxHistory:          200,             // Max stored adaptation records
  maxActiveAdaptations: 1,              // Max concurrent adaptations
  empiricalStrengthMinDelta: 0.15,      // 15% confidence delta for backend injection
  dataMaxAgeMs:        7 * 24 * 3600_000, // 7 days
};

// ── Bias → Prompt Section mapping ───────────────────────────
// Each bias pattern maps to a prompt section and a compensation hypothesis.
// These are deterministic (no LLM) — the LLM only generates the variant text.

const BIAS_HYPOTHESES = {
  'scope-underestimate': {
    section: 'solutions',
    hypothesis: 'Break complex tasks into explicit sub-steps before executing. Estimate 2× the steps you think are needed.',
  },
  'token-overuse': {
    section: 'formatting',
    hypothesis: 'Be concise. Prefer direct answers over exploratory reasoning. Target 50% fewer tokens.',
  },
  'error-repetition': {
    section: 'metacognition',
    // {topError} replaced at runtime with actual top error category
    hypothesis: 'Before executing, check if this error category has occurred before: {topError}. Apply the inverse strategy.',
  },
  'backend-mismatch': {
    section: 'optimizer',
    // {taskType}, {recommendedBackend}, {confidence} replaced at runtime
    hypothesis: 'For {taskType} tasks, prefer {recommendedBackend} which has {confidence}% empirical confidence.',
  },
};

// ── Adaptation states ───────────────────────────────────────

const STATUS = {
  PROPOSED:           'proposed',
  APPLIED:            'applied',
  VALIDATING:         'validating',
  CONFIRMED:          'confirmed',
  ROLLED_BACK:        'rolled-back',
  APPLIED_UNVALIDATED: 'applied-unvalidated',
};

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
  }

  static containerConfig = {
    name: 'adaptiveStrategy',
    phase: 9,
    deps: ['bus', 'storage'],
    tags: ['cognitive', 'metacognition', 'v6-0-2'],
    lateBindings: [
      { prop: 'cognitiveSelfModel', service: 'cognitiveSelfModel', optional: true },
      { prop: 'promptEvolution',    service: 'promptEvolution',    optional: true },
      { prop: 'modelRouter',        service: 'modelRouter',        optional: true },
      { prop: 'onlineLearner',      service: 'onlineLearner',      optional: true },
      { prop: 'quickBenchmark',     service: 'quickBenchmark',     optional: true },
    ],
  };

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
    this._unsubs.push(
      this.bus.on('task-outcome:recorded', () => this._onNewOutcome()),
    );
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
    const diagnosis = this._diagnose();
    if (!diagnosis) {
      _log.info('[ADAPT] No actionable findings — all metrics stable');
      this.bus.emit('adaptation:cycle-complete', {
        outcome: 'no-action', cyclesRun: this.stats.cyclesRun,
      }, { source: 'AdaptiveStrategy' });
      return null;
    }

    // Step 2: Propose — select best adaptation
    const proposal = this._propose(diagnosis);
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
  // STEP 1: DIAGNOSE
  // ════════════════════════════════════════════════════════

  /** @private */
  _diagnose() {
    if (!this.cognitiveSelfModel) return null; // TSC null-narrowing
    const windowMs = this._config.dataMaxAgeMs;

    // Check minimum data threshold
    const profile = this.cognitiveSelfModel.getCapabilityProfile({ windowMs });
    const totalSamples = Object.values(profile).reduce((s, e) => s + e.sampleSize, 0);
    if (totalSamples < this._config.minOutcomes) {
      _log.debug(`[ADAPT] Insufficient data: ${totalSamples} < ${this._config.minOutcomes} outcomes`);
      return null;
    }

    // Gather all signals
    const biases = this.cognitiveSelfModel.getBiasPatterns({ windowMs });
    const backendMap = this.cognitiveSelfModel.getBackendStrengthMap({ windowMs });
    const weaknesses = Object.entries(profile).filter(([, e]) => e.isWeak);
    const strengths = Object.entries(profile).filter(([, e]) => e.isStrong);

    // Any actionable signal?
    const hasActionableBias = biases.some(b => b.severity === 'high' || b.severity === 'medium');
    const hasBackendMismatch = this._hasSignificantBackendDelta(backendMap);
    const hasWeakness = weaknesses.length > 0;

    if (!hasActionableBias && !hasBackendMismatch && !hasWeakness) {
      return null;
    }

    return { biases, backendMap, profile, weaknesses, strengths };
  }

  // ════════════════════════════════════════════════════════
  // STEP 2: PROPOSE
  // ════════════════════════════════════════════════════════

  /** @private */
  _propose(diagnosis) {
    const candidates = [];

    // A) Prompt mutations from bias patterns
    for (const bias of diagnosis.biases) {
      if (bias.severity !== 'high' && bias.severity !== 'medium') continue;
      const mapping = BIAS_HYPOTHESES[bias.name];
      if (!mapping) continue;
      if (this._isOnCooldown(`prompt-mutation:${bias.name}`)) continue;
      if (!this.promptEvolution) continue;

      let hypothesis = mapping.hypothesis;

      // Substitute runtime values into hypothesis template
      if (bias.name === 'error-repetition') {
        const topError = bias.evidence.split('(')[0]?.trim() || 'unknown';
        hypothesis = hypothesis.replace('{topError}', topError);
      } else if (bias.name === 'backend-mismatch') {
        const parts = bias.evidence.split(':');
        const taskType = parts[0]?.trim() || 'unknown';
        const backends = parts[1]?.trim() || '';
        const recommended = backends.split(' ')[0] || 'unknown';
        hypothesis = hypothesis
          .replace('{taskType}', taskType)
          .replace('{recommendedBackend}', recommended)
          .replace('{confidence}', '');
      }

      candidates.push({
        type: 'prompt-mutation',
        priority: bias.severity === 'high' ? 3 : 2,
        bias: bias.name,
        section: mapping.section,
        hypothesis,
        evidence: bias.evidence,
      });
    }

    // B) Backend routing injection
    if (this.modelRouter && this._hasSignificantBackendDelta(diagnosis.backendMap)) {
      if (!this._isOnCooldown('backend-routing')) {
        candidates.push({
          type: 'backend-routing',
          priority: 2,
          backendMap: diagnosis.backendMap,
          evidence: this._summarizeBackendMap(diagnosis.backendMap),
        });
      }
    }

    // C) Temperature signals for weak task types
    if (this.onlineLearner && diagnosis.weaknesses.length > 0) {
      for (const [taskType] of diagnosis.weaknesses) {
        if (this._isOnCooldown(`temp-signal:${taskType}`)) continue;

        candidates.push({
          type: 'temp-signal',
          priority: 1,
          taskType,
          isWeak: true,
          evidence: `${taskType} isWeak (Wilson floor < 60%)`,
        });
      }
    }

    if (candidates.length === 0) return null;

    // Select highest-priority candidate
    candidates.sort((a, b) => b.priority - a.priority);

    // Skip if the top candidate was recently tried and failed
    const top = candidates[0];
    if (this._wasRecentlyRolledBack(top)) {
      _log.debug(`[ADAPT] Top candidate "${top.type}:${top.bias || top.taskType}" was recently rolled back — trying next`);
      return candidates[1] || null;
    }

    return top;
  }

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
      revert: null, // not persisted — runtime only
    };

    this.stats.proposed++;
    this.bus.emit('adaptation:proposed', {
      id, type: record.type, bias: record.bias,
      section: record.section, hypothesis: record.hypothesis,
    }, { source: 'AdaptiveStrategy' });

    _log.info(`[ADAPT] Proposed: ${record.type} — ${record.evidence}`);

    // Apply based on type
    try {
      switch (proposal.type) {
        case 'prompt-mutation':
          record.revert = await this._applyPromptMutation(proposal);
          break;
        case 'backend-routing':
          record.revert = this._applyBackendRouting(proposal);
          break;
        case 'temp-signal':
          record.revert = this._applyTempSignal(proposal);
          break;
        default:
          _log.warn(`[ADAPT] Unknown adaptation type: ${proposal.type}`);
          return null;
      }
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

    // Set cooldown
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

  // ── Apply helpers ─────────────────────────────────────

  /**
   * @private
   * @returns {Promise<Function|null>} Revert function
   */
  async _applyPromptMutation(proposal) {
    if (!this.promptEvolution) return null;

    // Get current section text from PromptEvolution
    const current = this.promptEvolution.getSection(proposal.section, '');
    if (!current || !current.text) {
      _log.debug(`[ADAPT] No current text for section "${proposal.section}"`);
      return null;
    }

    const result = await this.promptEvolution.startExperiment(
      proposal.section, current.text, proposal.hypothesis
    );

    if (!result) {
      _log.debug('[ADAPT] PromptEvolution did not start experiment');
      return null;
    }

    _log.info(`[ADAPT] PromptEvolution experiment started: ${result.variantId}`);

    // Revert: abort the experiment
    return () => {
      try {
        if (this.promptEvolution._experiments?.[proposal.section]) {
          this.promptEvolution._experiments[proposal.section].status = 'aborted';
          _log.info(`[ADAPT] Reverted prompt mutation for "${proposal.section}"`);
        }
      } catch (err) {
        _log.warn(`[ADAPT] Revert failed: ${err.message}`);
      }
    };
  }

  /** @private */
  _applyBackendRouting(proposal) {
    if (!this.modelRouter) return null;

    // Inject empirical strength data
    this.modelRouter.injectEmpiricalStrength(proposal.backendMap);

    _log.info('[ADAPT] Backend strength map injected into ModelRouter');

    // Revert: clear empirical data
    return () => {
      if (this.modelRouter) {
        this.modelRouter._empiricalStrength = null;
        this.modelRouter._empiricalStrengthAt = 0;
        _log.info('[ADAPT] Reverted backend routing injection');
      }
    };
  }

  /** @private */
  _applyTempSignal(proposal) {
    if (!this.onlineLearner) return null;

    this.onlineLearner.receiveWeaknessSignal(proposal.taskType, proposal.isWeak);

    _log.info(`[ADAPT] Weakness signal sent for "${proposal.taskType}"`);

    // Revert: send inverse signal
    return () => {
      if (this.onlineLearner) {
        this.onlineLearner.receiveWeaknessSignal(proposal.taskType, false);
        _log.info(`[ADAPT] Reverted weakness signal for "${proposal.taskType}"`);
      }
    };
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

  /** @private */
  _hasSignificantBackendDelta(backendMap) {
    for (const rec of Object.values(backendMap)) {
      if (rec.entries.length < 2) continue;
      const best = rec.entries[0]?.confidence || 0;
      const worst = rec.entries[rec.entries.length - 1]?.confidence || 0;
      if (best - worst > this._config.empiricalStrengthMinDelta) return true;
    }
    return false;
  }

  /** @private */
  _summarizeBackendMap(backendMap) {
    const parts = [];
    for (const [type, rec] of Object.entries(backendMap)) {
      if (rec.entries.length >= 2) {
        const best = rec.entries[0];
        parts.push(`${type}: ${best.backend} ${Math.round(best.confidence * 100)}%`);
      }
    }
    return parts.join(', ') || 'no significant deltas';
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

module.exports = { AdaptiveStrategy, BIAS_HYPOTHESES, STATUS, DEFAULTS };

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
