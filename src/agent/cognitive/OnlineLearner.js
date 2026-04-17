// ============================================================
// GENESIS - OnlineLearner.js (v5.3.0 - SA-P5)
//
// Real-time learning from every action outcome.
//
// PROBLEM: Genesis has all the learning pieces - ExpectationEngine
// predicts, SurpriseAccumulator measures, MetaLearning records,
// PromptEvolution experiments - but they only connect in batch
// via DreamCycle during idle time. A failure at step 2 of 6
// doesn't change behavior until the next dream session.
//
// SOLUTION: A reactive bridge that listens to surprise signals
// and takes immediate corrective action:
//
//   1. STREAK DETECTION - 3+ same-type failures → switch strategy
//   2. MODEL ESCALATION - high negative surprise → signal larger model
//   3. PROMPT FEEDBACK - every outcome → feed PromptEvolution scores
//   4. CALIBRATION WATCH - prediction accuracy drop → recalibrate
//   5. TEMPERATURE TUNING - sliding window success rate → adjust temp
//
// This is NOT a new learning engine. It's a reactive connector
// that wires existing events to immediate behavioral responses.
// Every component already exists - OnlineLearner just makes them
// respond in real-time instead of waiting for DreamCycle.
//
// Integration:
//   - Registered in phase9 manifest, late-bound to optional services
//   - Listens to: expectation:compared, surprise:processed,
//                 meta:outcome-recorded, agent-loop:step-complete
//   - Emits to: online-learning:*, model escalation, prompt feedback
//   - Pure event-driven, no polling, no timers
//
// Principle: Learn from every step, not just every dream.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const { NullBus } = require('../core/EventBus');
const _log = createLogger('OnlineLearner');

// ── Thresholds ──────────────────────────────────────────────

const DEFAULTS = {
  streakThreshold: 3,           // Consecutive same-type failures to trigger switch
  escalationSurprise: 0.7,     // totalSurprise above this → model escalation signal
  calibrationFloor: 0.3,       // Below this → recalibration alert
  windowSize: 10,              // Sliding window for micro-adjustments
  tempAdjustStep: 0.05,        // Temperature adjustment per signal
  tempMin: 0.1,                // Temperature floor
  tempMax: 1.2,                // Temperature ceiling
  cooldownMs: 5000,            // Minimum time between same-type signals
};

class OnlineLearner {
  /**
   * @param {object} deps
   * @param {object} deps.bus           - EventBus (required)
   * @param {object} [deps.config]      - Override thresholds
   */
  constructor({ bus, config = {} }) {
    this.bus = bus || NullBus;
    this._config = { ...DEFAULTS, ...config };

    // ── State ────────────────────────────────────────────
    this._recentOutcomes = [];         // Sliding window of recent outcomes
    this._streaks = new Map(); // DA-1: bounded by action type count (~20), cap 100         // actionType → { count, lastResult }
    this._escalationCooldowns = {};    // actionType → lastEscalationMs
    this._adaptations = [];            // Log of all adaptations made
    this._stats = {
      signalsProcessed: 0,
      adaptationsMade: 0,
      streakTriggered: 0,
      escalationsSignaled: 0,
      tempAdjustments: 0,
      calibrationAlerts: 0,
      promptFeedbacks: 0,
    };

    // ── Late-bound services ──────────────────────────────
    this.metaLearning = null;      // MetaLearning - for recommendations
    this.promptEvolution = null;   // PromptEvolution - for variant feedback
    this.modelRouter = null;       // ModelRouter - for escalation signals
    this.emotionalState = null;    // EmotionalState - for frustration signals
    // v6.0.7: Reactive prescription bridge
    this.adaptiveStrategy = null;  // AdaptiveStrategy - for immediate adaptation cycles
  }

  // v7.2.6: containerConfig removed — authoritative registration in phase9-cognitive.js manifest

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  start() {
    // ── 1. Listen to expectation comparisons (primary signal) ──
    this._unsub1 = this.bus.on('expectation:compared', (signal) => {
      this._onExpectationCompared(signal);
    }, { source: 'OnlineLearner' });

    // ── 2. Listen to processed surprise (secondary enrichment) ──
    this._unsub2 = this.bus.on('surprise:processed', (data) => {
      this._onSurpriseProcessed(data);
    }, { source: 'OnlineLearner' });

    _log.info('[ONLINE-LEARN] Active - real-time learning from every step');
  }

  stop() {
    this._unsub1?.();
    this._unsub2?.();
    _log.info(`[ONLINE-LEARN] Stopped - ${this._stats.adaptationsMade} adaptations made`);
  }

  // ════════════════════════════════════════════════════════
  // CORE: React to every expectation comparison
  // ════════════════════════════════════════════════════════

  _onExpectationCompared(signal) {
    if (!signal || typeof signal.totalSurprise !== 'number') return;
    this._stats.signalsProcessed++;

    const outcome = {
      actionType: signal.actionType || 'unknown',
      model: signal.model || 'unknown',
      success: signal.valence === 'positive',
      surprise: signal.totalSurprise,
      valence: signal.valence,
      timestamp: signal.timestamp || Date.now(),
      expected: signal.expected,
      actual: signal.actual,
    };

    // Add to sliding window
    this._recentOutcomes.push(outcome);
    if (this._recentOutcomes.length > this._config.windowSize * 3) {
      this._recentOutcomes = this._recentOutcomes.slice(-this._config.windowSize * 3);
    }

    // ── Run all reactive checks ──────────────────────────
    this._checkStreak(outcome);
    this._checkEscalation(outcome, signal);
    this._feedPromptEvolution(outcome);
    this._checkCalibration(signal);
    this._adjustTemperature(outcome);
  }

  // ════════════════════════════════════════════════════════
  // 1. STREAK DETECTION
  //    3+ consecutive failures of same type → switch strategy
  // ════════════════════════════════════════════════════════

  _checkStreak(outcome) {
    const type = outcome.actionType;
    let streak = this._streaks.get(type);

    if (!streak) {
      streak = { count: 0, lastResult: null };
      this._streaks.set(type, streak);
    if (this._streaks.size > 100) { const k = this._streaks.keys().next().value; this._streaks.delete(k); }
    }

    if (outcome.success) {
      // Success resets the failure streak
      if (streak.count > 0) {
        streak.count = 0;
        streak.lastResult = 'success';
      }
      return;
    }

    // Failure - increment streak
    streak.count++;
    streak.lastResult = 'failure';

    if (streak.count >= this._config.streakThreshold) {
      this._stats.streakTriggered++;

      // Get current recommendation to suggest alternative
      const currentRec = this.metaLearning?.recommend(type, outcome.model);
      const alternative = this._suggestAlternative(type, outcome.model, currentRec);

      const adaptation = {
        type: 'streak-switch',
        actionType: type,
        failureCount: streak.count,
        currentStrategy: currentRec?.promptStyle || 'unknown',
        suggestedStrategy: alternative.promptStyle,
        suggestedTemp: alternative.temperature,
        timestamp: Date.now(),
      };

      this._recordAdaptation(adaptation);

      this.bus.emit('online-learning:streak-detected', {
        actionType: type,
        consecutiveFailures: streak.count,
        suggestion: alternative,
      }, { source: 'OnlineLearner' });

      // v6.0.7: Reactive prescription — trigger immediate adaptation cycle
      // Closes the gap from hours (wait for IdleMind calibrate) to seconds.
      if (this.adaptiveStrategy?.runCycle) {
        this.adaptiveStrategy.runCycle().catch((err) => {
          _log.debug('[ONLINE-LEARN] Reactive adaptation failed:', err.message);
        });
      }

      _log.info(`[ONLINE-LEARN] Streak: ${streak.count}× ${type} failures → suggesting ${alternative.promptStyle} @ temp ${alternative.temperature}`);

      // Reset streak counter (don't fire again immediately)
      streak.count = 0;
    }
  }

  // ════════════════════════════════════════════════════════
  // 2. MODEL ESCALATION
  //    High surprise + negative → signal to try larger model
  // ════════════════════════════════════════════════════════

  _checkEscalation(outcome, signal) {
    if (outcome.success) return;
    if (signal.totalSurprise < this._config.escalationSurprise) return;

    // Cooldown - don't spam escalation signals
    const now = Date.now();
    const lastEscalation = this._escalationCooldowns[outcome.actionType] || 0;
    if (now - lastEscalation < this._config.cooldownMs) return;

    this._escalationCooldowns[outcome.actionType] = now;
    this._stats.escalationsSignaled++;

    const adaptation = {
      type: 'model-escalation',
      actionType: outcome.actionType,
      currentModel: outcome.model,
      surprise: signal.totalSurprise,
      reason: `High surprise (${signal.totalSurprise.toFixed(2)}) + failure → current model may be insufficient`,
      timestamp: now,
    };

    this._recordAdaptation(adaptation);

    this.bus.emit('online-learning:escalation-needed', {
      actionType: outcome.actionType,
      currentModel: outcome.model,
      surprise: signal.totalSurprise,
      confidence: signal.expected?.confidence || 0,
    }, { source: 'OnlineLearner' });

    // Also nudge emotions - high surprise failure should increase frustration
    if (this.emotionalState) {
      try {
        this.emotionalState.nudge?.('frustration', 0.1);
        this.emotionalState.nudge?.('curiosity', 0.05); // Failure is also interesting
      } catch (_) { /* graceful */ }
    }

    _log.info(`[ONLINE-LEARN] Escalation signal: ${outcome.actionType} on ${outcome.model} (surprise=${signal.totalSurprise.toFixed(2)})`);
  }

  // ════════════════════════════════════════════════════════
  // 3. PROMPT EVOLUTION FEEDBACK
  //    Every outcome → feed variant scores to PromptEvolution
  // ════════════════════════════════════════════════════════

  _feedPromptEvolution(outcome) {
    if (!this.promptEvolution) return;

    try {
      // PromptEvolution tracks which variant was active and feeds outcome
      const experiment = this.promptEvolution.getActiveExperiment?.();
      if (!experiment) return;

      // Score: 1.0 for success, 0.0 for failure, weighted by surprise
      // Low surprise success = expected, modest score (0.7)
      // High surprise success = unexpectedly good, high score (1.0)
      // Low surprise failure = expected failure, already known (0.3)
      // High surprise failure = unexpectedly bad, low score (0.0)
      let score;
      if (outcome.success) {
        score = 0.6 + outcome.surprise * 0.4; // 0.6–1.0
      } else {
        score = 0.4 - outcome.surprise * 0.4; // 0.4–0.0
      }

      this.promptEvolution.recordOutcome?.(score);
      this._stats.promptFeedbacks++;
    } catch (err) {
      _log.debug('[ONLINE-LEARN] Prompt feedback error:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════
  // 4. CALIBRATION MONITORING
  //    Watch ExpectationEngine accuracy - alert on drift
  // ════════════════════════════════════════════════════════

  _checkCalibration(signal) {
    // Only check every 10 signals
    if (this._stats.signalsProcessed % 10 !== 0) return;

    const calibration = signal.expected?.confidence;
    if (typeof calibration !== 'number') return;

    // Check if recent predictions are systematically wrong
    const recent = this._recentOutcomes.slice(-this._config.windowSize);
    if (recent.length < 5) return;

    const avgSurprise = recent.reduce((s, o) => s + o.surprise, 0) / recent.length;

    if (avgSurprise > this._config.escalationSurprise) {
      this._stats.calibrationAlerts++;

      this.bus.emit('online-learning:calibration-drift', {
        avgSurprise,
        windowSize: recent.length,
        suggestion: 'Predictions are systematically off - consider resetting calibration baseline',
      }, { source: 'OnlineLearner' });

      _log.warn(`[ONLINE-LEARN] Calibration drift: avg surprise ${avgSurprise.toFixed(2)} over ${recent.length} signals`);
    }
  }

  // ════════════════════════════════════════════════════════
  // 5. TEMPERATURE MICRO-TUNING
  //    Sliding window success → nudge temperature
  // ════════════════════════════════════════════════════════

  _adjustTemperature(outcome) {
    // Only adjust for action types with enough data
    const typeOutcomes = this._recentOutcomes
      .filter(o => o.actionType === outcome.actionType)
      .slice(-this._config.windowSize);

    if (typeOutcomes.length < 5) return;

    const successRate = typeOutcomes.filter(o => o.success).length / typeOutcomes.length;

    // Get current recommendation
    const rec = this.metaLearning?.recommend(outcome.actionType, outcome.model);
    if (!rec) return;

    const currentTemp = rec.temperature ?? 0.7;
    let newTemp = currentTemp;

    if (successRate < 0.4 && currentTemp > this._config.tempMin) {
      // Low success → lower temperature (more deterministic)
      newTemp = Math.max(this._config.tempMin, currentTemp - this._config.tempAdjustStep);
    } else if (successRate > 0.85 && currentTemp < this._config.tempMax) {
      // High success → slightly higher temperature (more creative)
      newTemp = Math.min(this._config.tempMax, currentTemp + this._config.tempAdjustStep);
    } else {
      return; // No adjustment needed
    }

    // v6.0.2: Apply weakness signal multiplier from AdaptiveStrategy
    if (this._weaknessSignals?.[outcome.actionType]) {
      const signal = this._weaknessSignals[outcome.actionType];
      // Expire signals after 4 hours
      if (Date.now() - signal.receivedAt < 4 * 3600_000) {
        newTemp *= signal.multiplier;
        newTemp = Math.max(this._config.tempMin, Math.min(this._config.tempMax, newTemp));
      }
    }

    if (Math.abs(newTemp - currentTemp) < 0.01) return;

    this._stats.tempAdjustments++;

    this.bus.emit('online-learning:temp-adjusted', {
      actionType: outcome.actionType,
      model: outcome.model,
      oldTemp: currentTemp,
      newTemp,
      successRate,
      windowSize: typeOutcomes.length,
    }, { source: 'OnlineLearner' });

    _log.debug(`[ONLINE-LEARN] Temp adjust: ${outcome.actionType} ${currentTemp.toFixed(2)}→${newTemp.toFixed(2)} (success=${(successRate * 100).toFixed(0)}%)`);
  }

  // ════════════════════════════════════════════════════════
  // SECONDARY: Enrichment from processed surprise
  // ════════════════════════════════════════════════════════

  _onSurpriseProcessed(data) {
    if (!data) return;

    // Track trend changes - if surprise trend shifts from 'stable' to 'increasing',
    // that means Genesis is entering unfamiliar territory
    if (data.trend === 'increasing' && this._lastTrend !== 'increasing') {
      this.bus.emit('online-learning:novelty-shift', {
        trend: data.trend,
        avgSurprise: data.totalSurprise,
        suggestion: 'Entering unfamiliar territory - consider more conservative strategies',
      }, { source: 'OnlineLearner' });

      _log.info('[ONLINE-LEARN] Novelty shift detected - surprise trend increasing');
    }

    this._lastTrend = data.trend;
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  /**
   * Suggest an alternative strategy when current one is failing.
   * Uses MetaLearning data if available, otherwise heuristic fallbacks.
   */
  _suggestAlternative(actionType, currentModel, currentRec) {
    const currentStyle = currentRec?.promptStyle || 'free-text';
    const currentTemp = currentRec?.temperature ?? 0.7;

    // Strategy rotation: try a different prompt style
    const styles = ['json-schema', 'step-by-step', 'free-text', 'chain-of-thought', 'few-shot'];
    const currentIdx = styles.indexOf(currentStyle);
    const nextStyle = styles[(currentIdx + 1) % styles.length];

    // Lower temperature on failure (more deterministic)
    const nextTemp = Math.max(this._config.tempMin, currentTemp - 0.15);

    return {
      promptStyle: nextStyle,
      temperature: nextTemp,
      reason: `${currentStyle} @ ${currentTemp} failed ${this._config.streakThreshold}× - rotating strategy`,
    };
  }

  _recordAdaptation(adaptation) {
    this._adaptations.push(adaptation);
    if (this._adaptations.length > 100) {
      this._adaptations = this._adaptations.slice(-100);
    }
    this._stats.adaptationsMade++;
  }

  // ════════════════════════════════════════════════════════
  // v6.0.2: WEAKNESS SIGNALS FROM ADAPTIVE STRATEGY
  // ════════════════════════════════════════════════════════

  /**
   * Receive weakness signal from CognitiveSelfModel via AdaptiveStrategy.
   * Adjusts temperature for weak/strong task types.
   *
   * @param {string} taskType - e.g. 'code-gen', 'analysis'
   * @param {boolean} isWeak  - true = lower temp (conservative), false = reset
   */
  receiveWeaknessSignal(taskType, isWeak) {
    if (!taskType) return;
    if (!this._weaknessSignals) this._weaknessSignals = {};
    this._weaknessSignals[taskType] = {
      multiplier: isWeak ? 0.85 : 1.10,
      receivedAt: Date.now(),
    };
    this._stats.weaknessSignalsReceived = (this._stats.weaknessSignalsReceived || 0) + 1;
    _log.debug(`[ONLINE-LEARN] Weakness signal: ${taskType} isWeak=${isWeak}`);
  }

  // ════════════════════════════════════════════════════════
  // DIAGNOSTICS
  // ════════════════════════════════════════════════════════

  getStats() {
    const recent = this._recentOutcomes.slice(-this._config.windowSize);
    const recentSuccessRate = recent.length > 0
      ? recent.filter(o => o.success).length / recent.length
      : null;

    return {
      ...this._stats,
      recentOutcomes: recent.length,
      recentSuccessRate,
      activeStreaks: Object.fromEntries(
        [...this._streaks.entries()].filter(([, v]) => v.count > 0)
      ),
      lastAdaptation: this._adaptations[this._adaptations.length - 1] || null,
      config: { ...this._config },
    };
  }

  getAdaptationLog() {
    return [...this._adaptations];
  }
}

module.exports = { OnlineLearner };
