// ============================================================
// GENESIS — EarnedAutonomy.js (v6.0.7 — Earned Autonomy)
//
// PROBLEM: TrustLevelSystem has 4 coarse levels but no mechanism
// to build trust from evidence. The checkAutoUpgrades() method
// exists but depends on MetaLearning.getActionTypeStats() which
// may not have sufficient data granularity.
//
// SOLUTION: Per-action-type Wilson score confidence intervals.
// The same algorithm Reddit uses for ranking — handles small
// samples correctly. A naive 5/5 = 100% won't auto-promote,
// but 45/50 = 90% with Wilson lower bound > 0.85 will.
//
// Genesis can't game its own trust system with a lucky streak.
// It has to *consistently* succeed before gaining autonomy.
//
// Integration:
//   agent-loop:step-complete → EarnedAutonomy.record()
//   EarnedAutonomy → TrustLevelSystem.acceptUpgrade()
//   CLI: /autonomy
//   Dashboard: autonomy panel (future)
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('EarnedAutonomy');

// ── Configuration ────────────────────────────────────────────
const DEFAULTS = Object.freeze({
  /** Minimum samples before promotion is possible */
  minSamples: 30,
  /** Wilson lower bound threshold for promotion (95% CI) */
  promotionThreshold: 0.85,
  /** Wilson lower bound below which trust is revoked */
  revocationThreshold: 0.70,
  /** Z-score for 95% confidence interval */
  zScore: 1.96,
  /** Maximum outcomes to retain per action type */
  maxOutcomesPerType: 200,
  /** How often to re-evaluate (every N recordings) */
  evaluateEvery: 5,
});

// ── Wilson Score ──────────────────────────────────────────────
/**
 * Compute Wilson score lower bound.
 * @param {number} successes
 * @param {number} total
 * @param {number} z - z-score (1.96 = 95% CI)
 * @returns {number} lower bound of confidence interval
 */
function wilsonLower(successes, total, z = 1.96) {
  if (total === 0) return 0;
  const p = successes / total;
  const z2 = z * z;
  const numerator = p + z2 / (2 * total)
    - z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  const denominator = 1 + z2 / total;
  return Math.max(0, numerator / denominator);
}

const { applySubscriptionHelper } = require('../core/subscription-helper');

class EarnedAutonomy {
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage = storage || null;
    this.trustLevelSystem = null; // late-bound
    this._config = { ...DEFAULTS, ...config };

    /**
     * Per-action-type outcome log.
     * @type {Map<string, { outcomes: boolean[], promoted: boolean }>}
     */
    this._actions = new Map();

    /** @type {number} */ this._recordCount = 0;

    this._stats = {
      recorded: 0,
      promotions: 0,
      revocations: 0,
      evaluations: 0,
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────

  async asyncLoad() {
    try {
      const saved = await this.storage?.readJSON('earned-autonomy.json');
      if (saved?.actions) {
        for (const [type, data] of Object.entries(saved.actions)) {
          this._actions.set(type, {
            outcomes: Array.isArray(data.outcomes) ? data.outcomes : [],
            promoted: !!data.promoted,
          });
        }
      }
      if (saved?.stats) Object.assign(this._stats, saved.stats);
    } catch (_e) { _log.debug('[catch] use defaults:', _e.message); }
  }

  start() {
    // Listen to AgentLoop step outcomes
    this._sub('agent-loop:step-complete', (payload) => {
      if (payload && typeof payload.type === 'string') {
        this.record(payload.type, payload.success !== false);
      }
    }, { source: 'EarnedAutonomy' });

    // Listen to step failures explicitly
    this._sub('agent-loop:step-failed', (payload) => {
      if (payload && typeof payload.type === 'string') {
        this.record(payload.type, false);
      }
    }, { source: 'EarnedAutonomy' });

    _log.info(`[EARNED] Active — tracking ${this._actions.size} action types`);
  }

  stop() {
    this._unsubAll();
    this._save();
    _log.info(`[EARNED] Stopped — ${this._stats.promotions} promotions, ${this._stats.revocations} revocations`);
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Record an action outcome.
   * @param {string} actionType - e.g. 'CODE_GENERATE', 'SHELL_EXEC'
   * @param {boolean} success
   */
  record(actionType, success) {
    let entry = this._actions.get(actionType);
    if (!entry) {
      entry = { outcomes: [], promoted: false };
      this._actions.set(actionType, entry);
    }

    entry.outcomes.push(success);
    if (entry.outcomes.length > this._config.maxOutcomesPerType) {
      entry.outcomes = entry.outcomes.slice(-this._config.maxOutcomesPerType);
    }

    this._stats.recorded++;
    this._recordCount++;

    // Periodic evaluation (not every record — batch for efficiency)
    if (this._recordCount % this._config.evaluateEvery === 0) {
      this._evaluate(actionType, entry);
    }
  }

  /**
   * Get confidence report for all tracked action types.
   * @returns {Array<{ actionType: string, samples: number, successes: number, successRate: number, wilsonLower: number, promoted: boolean }>}
   */
  getReport() {
    const report = [];
    for (const [actionType, entry] of this._actions) {
      const total = entry.outcomes.length;
      const successes = entry.outcomes.filter(Boolean).length;
      report.push({
        actionType,
        samples: total,
        successes,
        successRate: total > 0 ? Math.round((successes / total) * 100) : 0,
        wilsonLower: Math.round(wilsonLower(successes, total, this._config.zScore) * 100),
        promoted: entry.promoted,
      });
    }
    return report.sort((a, b) => b.wilsonLower - a.wilsonLower);
  }

  getStats() { return { ...this._stats }; }

  // ── Internal ───────────────────────────────────────────────

  /** @private */
  _evaluate(actionType, entry) {
    this._stats.evaluations++;
    const total = entry.outcomes.length;
    const successes = entry.outcomes.filter(Boolean).length;
    const wLower = wilsonLower(successes, total, this._config.zScore);

    // Check for promotion
    if (!entry.promoted
        && total >= this._config.minSamples
        && wLower >= this._config.promotionThreshold) {
      entry.promoted = true;
      this._stats.promotions++;
      _log.info(`[EARNED] ✓ PROMOTED "${actionType}" — wilson_lower=${(wLower * 100).toFixed(1)}% (${successes}/${total})`);

      this.bus.emit('autonomy:earned', {
        actionType,
        wilsonLower: Math.round(wLower * 100),
        samples: total,
        successes,
      }, { source: 'EarnedAutonomy' });

      // Write promotion to TrustLevelSystem
      if (this.trustLevelSystem) {
        // Add as pending upgrade, then auto-accept at current level
        this.trustLevelSystem._pendingUpgrades.push({
          actionType,
          successRate: Math.round((successes / total) * 100),
          samples: total,
          suggestedLevel: this.trustLevelSystem.getLevel(),
          timestamp: Date.now(),
          source: 'EarnedAutonomy',
        });
        this.trustLevelSystem.acceptUpgrade(actionType);
      }

      this._save();
    }

    // Check for revocation (performance degradation)
    if (entry.promoted
        && total >= this._config.minSamples
        && wLower < this._config.revocationThreshold) {
      entry.promoted = false;
      this._stats.revocations++;
      _log.warn(`[EARNED] ✗ REVOKED "${actionType}" — wilson_lower=${(wLower * 100).toFixed(1)}% below ${this._config.revocationThreshold * 100}%`);

      this.bus.emit('autonomy:revoked', {
        actionType,
        wilsonLower: Math.round(wLower * 100),
        samples: total,
        successes,
        reason: 'performance_degradation',
      }, { source: 'EarnedAutonomy' });

      // Remove override from TrustLevelSystem
      if (this.trustLevelSystem?._actionOverrides) {
        delete this.trustLevelSystem._actionOverrides[actionType];
        this.trustLevelSystem._save?.();
      }

      this._save();
    }
  }

  /** @private */
  async _save() {
    try {
      const actions = {};
      for (const [type, entry] of this._actions) {
        actions[type] = {
          outcomes: entry.outcomes,
          promoted: entry.promoted,
        };
      }
      await this.storage?.writeJSON('earned-autonomy.json', {
        actions,
        stats: this._stats,
        savedAt: Date.now(),
      });
    } catch (err) {
      _log.warn('[EARNED] Save failed:', err.message);
    }
  }
}

applySubscriptionHelper(EarnedAutonomy);

module.exports = { EarnedAutonomy, wilsonLower };
