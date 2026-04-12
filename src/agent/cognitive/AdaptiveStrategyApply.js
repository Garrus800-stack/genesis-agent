// @ts-check
// ============================================================
// GENESIS — AdaptiveStrategyApply.js (v7.1.2 — Composition Extract)
//
// Delegate for adaptation proposal generation and application.
// Extracted from AdaptiveStrategy.js to reduce file size.
//
// Contains:
//   - _diagnose() — gather SelfModel signals
//   - _propose()  — select best adaptation candidate
//   - _apply*()   — execute each strategy type
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('AdaptiveStrategyApply');

// ── Bias → Prompt Section mapping ───────────────────────────

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
    hypothesis: 'Before executing, check if this error category has occurred before: {topError}. Apply the inverse strategy.',
  },
  'backend-mismatch': {
    section: 'optimizer',
    hypothesis: 'For {taskType} tasks, prefer {recommendedBackend} which has {confidence}% empirical confidence.',
  },
};

const STATUS = {
  PROPOSED:           'proposed',
  APPLIED:            'applied',
  VALIDATING:         'validating',
  CONFIRMED:          'confirmed',
  ROLLED_BACK:        'rolled-back',
  APPLIED_UNVALIDATED: 'applied-unvalidated',
};

class AdaptiveStrategyApplyDelegate {
  /**
   * @param {import('./AdaptiveStrategy').AdaptiveStrategy} parent
   */
  constructor(parent) {
    this._p = parent;
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSE
  // ════════════════════════════════════════════════════════

  diagnose() {
    if (!this._p.cognitiveSelfModel) return null;
    const windowMs = this._p._config.dataMaxAgeMs;

    const profile = this._p.cognitiveSelfModel.getCapabilityProfile({ windowMs });
    const totalSamples = Object.values(profile).reduce((s, e) => s + e.sampleSize, 0);
    if (totalSamples < this._p._config.minOutcomes) {
      _log.debug(`[ADAPT] Insufficient data: ${totalSamples} < ${this._p._config.minOutcomes} outcomes`);
      return null;
    }

    const biases = this._p.cognitiveSelfModel.getBiasPatterns({ windowMs });
    const backendMap = this._p.cognitiveSelfModel.getBackendStrengthMap({ windowMs });
    const weaknesses = Object.entries(profile).filter(([, e]) => e.isWeak);
    const strengths = Object.entries(profile).filter(([, e]) => e.isStrong);

    const hasActionableBias = biases.some(b => b.severity === 'high' || b.severity === 'medium');
    const hasBackendMismatch = this._hasSignificantBackendDelta(backendMap);
    const hasWeakness = weaknesses.length > 0;

    if (!hasActionableBias && !hasBackendMismatch && !hasWeakness) {
      return null;
    }

    return { biases, backendMap, profile, weaknesses, strengths };
  }

  // ════════════════════════════════════════════════════════
  // PROPOSE
  // ════════════════════════════════════════════════════════

  propose(diagnosis) {
    const candidates = [];

    // A) Prompt mutations from bias patterns
    for (const bias of diagnosis.biases) {
      if (bias.severity !== 'high' && bias.severity !== 'medium') continue;
      const mapping = BIAS_HYPOTHESES[bias.name];
      if (!mapping) continue;
      if (this._p._isOnCooldown(`prompt-mutation:${bias.name}`)) continue;
      if (!this._p.promptEvolution) continue;

      let hypothesis = mapping.hypothesis;

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
    if (this._p.modelRouter && this._hasSignificantBackendDelta(diagnosis.backendMap)) {
      if (!this._p._isOnCooldown('backend-routing')) {
        candidates.push({
          type: 'backend-routing',
          priority: 2,
          backendMap: diagnosis.backendMap,
          evidence: this._summarizeBackendMap(diagnosis.backendMap),
        });
      }
    }

    // C) Temperature signals for weak task types
    if (this._p.onlineLearner && diagnosis.weaknesses.length > 0) {
      for (const [taskType] of diagnosis.weaknesses) {
        if (this._p._isOnCooldown(`temp-signal:${taskType}`)) continue;

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

    candidates.sort((a, b) => b.priority - a.priority);

    const top = candidates[0];
    if (this._p._wasRecentlyRolledBack(top)) {
      _log.debug(`[ADAPT] Top candidate "${top.type}:${top.bias || top.taskType}" was recently rolled back — trying next`);
      return candidates[1] || null;
    }

    return top;
  }

  // ════════════════════════════════════════════════════════
  // APPLY
  // ════════════════════════════════════════════════════════

  /**
   * @param {object} proposal
   * @returns {Promise<Function|null>} revert function
   */
  async applyStrategy(proposal) {
    switch (proposal.type) {
      case 'prompt-mutation':
        return this._applyPromptMutation(proposal);
      case 'backend-routing':
        return this._applyBackendRouting(proposal);
      case 'temp-signal':
        return this._applyTempSignal(proposal);
      default:
        _log.warn(`[ADAPT] Unknown adaptation type: ${proposal.type}`);
        return null;
    }
  }

  /** @private */
  async _applyPromptMutation(proposal) {
    if (!this._p.promptEvolution) return null;

    const current = this._p.promptEvolution.getSection(proposal.section, '');
    if (!current || !current.text) {
      _log.debug(`[ADAPT] No current text for section "${proposal.section}"`);
      return null;
    }

    const result = await this._p.promptEvolution.startExperiment(
      proposal.section, current.text, proposal.hypothesis
    );

    if (!result) {
      _log.debug('[ADAPT] PromptEvolution did not start experiment');
      return null;
    }

    _log.info(`[ADAPT] PromptEvolution experiment started: ${result.variantId}`);

    return () => {
      try {
        if (this._p.promptEvolution?._experiments?.[proposal.section]) {
          this._p.promptEvolution._experiments[proposal.section].status = 'aborted';
          _log.info(`[ADAPT] Reverted prompt mutation for "${proposal.section}"`);
        }
      } catch (err) {
        _log.warn(`[ADAPT] Revert failed: ${err.message}`);
      }
    };
  }

  /** @private */
  _applyBackendRouting(proposal) {
    if (!this._p.modelRouter) return null;

    this._p.modelRouter.injectEmpiricalStrength(proposal.backendMap);
    _log.info('[ADAPT] Backend strength map injected into ModelRouter');

    return () => {
      if (this._p.modelRouter) {
        this._p.modelRouter._empiricalStrength = null;
        this._p.modelRouter._empiricalStrengthAt = 0;
        _log.info('[ADAPT] Reverted backend routing injection');
      }
    };
  }

  /** @private */
  _applyTempSignal(proposal) {
    if (!this._p.onlineLearner) return null;

    this._p.onlineLearner.receiveWeaknessSignal(proposal.taskType, proposal.isWeak);
    _log.info(`[ADAPT] Weakness signal sent for "${proposal.taskType}"`);

    return () => {
      if (this._p.onlineLearner) {
        this._p.onlineLearner.receiveWeaknessSignal(proposal.taskType, false);
        _log.info(`[ADAPT] Reverted weakness signal for "${proposal.taskType}"`);
      }
    };
  }

  // ── Helpers ────────────────────────────────────────────

  /** @private */
  _hasSignificantBackendDelta(backendMap) {
    for (const rec of Object.values(backendMap)) {
      if (rec.entries.length < 2) continue;
      const best = rec.entries[0]?.confidence || 0;
      const worst = rec.entries[rec.entries.length - 1]?.confidence || 0;
      if (best - worst > this._p._config.empiricalStrengthMinDelta) return true;
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
}

module.exports = { AdaptiveStrategyApplyDelegate, BIAS_HYPOTHESES, STATUS };
