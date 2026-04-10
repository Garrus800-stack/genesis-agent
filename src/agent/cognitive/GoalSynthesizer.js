// @ts-check
// ============================================================
// GENESIS — GoalSynthesizer.js (v7.0.9 — Phase 4)
//
// Autonomous goal generation from self-observed weaknesses.
// Consumes CognitiveSelfModel, TaskOutcomeTracker, LessonsStore.
// Produces prioritized improvement goals for GoalStack.
//
// Key mechanisms:
//   1. Bootstrap Guard: NOOP if TaskOutcomeTracker.count() < 20
//   2. Priority = impact × (1 - lessonCoverage × lessonEffectiveness)
//   3. Self-Referential Loop Prevention:
//      a) PROTECTED_MODULES — cannot target own infrastructure
//      b) Improvement budget — max 1 goal per N user-tasks
//      c) Regression detection — rollback + pause after 3 regressions
//   4. selfAwareness trait controls frequency, not priority
//
// Integration:
//   NeedsSystem "competence" need → drives GoalSynthesizer
//   IdleMind "improve" activity → calls synthesize()
//   GoalStack → receives goals with source: "self-improvement"
//   CausalAnnotation → tags resulting edges with source tag
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalSynthesizer');

// Modules that GoalSynthesizer cannot target for self-modification
const PROTECTED_MODULES = new Set([
  'GoalSynthesizer', 'CausalAnnotation', 'InferenceEngine',
  'PatternMatcher', 'StructuralAbstraction',
  'ApprovalGate', 'TrustLevelSystem', 'CapabilityGuard',
  'Sandbox', 'CodeSafetyScanner',
]);

const BOOTSTRAP_THRESHOLD = 20;
const DEFAULT_MIN_CYCLES = 10;

class GoalSynthesizer {
  static containerConfig = {
    name: 'goalSynthesizer',
    phase: 9,
    deps: [],
    tags: ['cognitive', 'autonomy', 'goals'],
    lateBindings: [
      { prop: 'selfModel', service: 'cognitiveSelfModel', optional: true },
      { prop: 'tracker', service: 'taskOutcomeTracker', optional: true },
      { prop: 'lessonsStore', service: 'lessonsStore', optional: true },
      { prop: 'inferenceEngine', service: 'inferenceEngine', optional: true },
    ],
  };

  /**
   * @param {{ bus?: object, selfModel?: object, tracker?: object, lessonsStore?: object, config?: object, lessonCoverage?: object }} opts
   */
  constructor({ bus, selfModel, tracker, lessonsStore, config, lessonCoverage } = {}) {
    this.bus = bus || NullBus;
    this.selfModel = selfModel || null;
    this.tracker = tracker || null;
    this.lessonsStore = lessonsStore || null;
    this.inferenceEngine = null;

    const cfg = config || {};
    this._selfAwareness = cfg.selfAwareness ?? 0.5;
    this._minCycles = cfg.minCyclesBetweenGoals || Math.ceil(1 / (this._selfAwareness || 0.1));

    // Lesson coverage override (for testing)
    this._lessonCoverage = lessonCoverage || null;

    // ── Tracking state ────────────────────────────────
    this._cyclesSinceLastGoal = this._minCycles; // Allow first call to proceed
    this._goalsGenerated = 0;
    this._regressions = 0;
    this._paused = false;
    this._pauseUntilTasks = 0;
  }

  // ════════════════════════════════════════════════════════
  // CORE API
  // ════════════════════════════════════════════════════════

  /**
   * Generate improvement goals from self-observed weaknesses.
   * @returns {Array<{ title: string, weakness: string, priority: number, impact: number, source: string }>}
   */
  synthesize() {
    // ── Bootstrap Guard ──────────────────────────────
    const count = this.tracker?.count?.() || 0;
    if (count < BOOTSTRAP_THRESHOLD) {
      return [];
    }

    // ── Pause check (after regression circuit-breaker) ──
    if (this._paused && count < this._pauseUntilTasks) {
      return [];
    }
    this._paused = false;

    // ── Frequency check (selfAwareness controls) ──────
    this._cyclesSinceLastGoal++;
    if (this._cyclesSinceLastGoal < this._minCycles) {
      return [];
    }

    // ── Get capability profile ──────────────────────
    if (!this.selfModel) return [];
    const profile = this.selfModel.getCapabilityProfile();
    if (!profile || Object.keys(profile).length === 0) return [];

    // ── Find weaknesses ─────────────────────────────
    const goals = [];
    for (const [taskType, cap] of Object.entries(profile)) {
      if (!cap.isWeak) continue;
      if (PROTECTED_MODULES.has(taskType)) continue;

      const impact = 1 - (cap.successRate || 0); // Higher failure = higher impact

      // ── Lesson coverage check ─────────────────────
      let effectiveCoverage = 0;
      const coverage = this._lessonCoverage?.[taskType];
      if (coverage) {
        effectiveCoverage = (coverage.coverage || 0) * (coverage.effectiveness || 0);
      }

      // Priority = impact × (1 - lessonCoverage × lessonEffectiveness)
      const priority = Math.round(impact * (1 - effectiveCoverage) * 100) / 100;

      if (priority < 0.1) continue; // Not worth a goal

      const topError = cap.topErrors?.[0]?.category || 'unknown';
      goals.push({
        title: `Improve ${taskType}: ${topError} (${(cap.successRate * 100).toFixed(0)}% success)`,
        weakness: taskType,
        priority,
        impact: Math.round(impact * 100) / 100,
        source: 'self-improvement',
        topError,
        sampleSize: cap.sampleSize,
      });
    }

    // Sort by priority descending
    goals.sort((a, b) => b.priority - a.priority);

    // ── Improvement budget: max 1 goal per synthesis ──
    const result = goals.slice(0, 1);

    if (result.length > 0) {
      this._cyclesSinceLastGoal = 0;
      this._goalsGenerated++;

      _log.info(`[GOAL] Generated: "${result[0].title}" (priority: ${result[0].priority})`);
      this.bus.emit('goal:synthesized', {
        title: result[0].title,
        weakness: result[0].weakness,
        priority: result[0].priority,
      }, { source: 'GoalSynthesizer' });
    }

    return result;
  }

  // ════════════════════════════════════════════════════════
  // REGRESSION DETECTION
  // ════════════════════════════════════════════════════════

  /**
   * Report outcome of a self-improvement goal.
   * If regression detected, increments counter. After 3, pauses.
   * @param {{ goalId: string, improved: boolean, delta: number }} outcome
   */
  reportOutcome(outcome) {
    if (outcome.improved) {
      this._regressions = 0; // Reset on success
      return;
    }

    if (outcome.delta < -0.05) { // 5pp regression
      this._regressions++;
      _log.warn(`[GOAL] Regression detected (${this._regressions}/3): delta=${outcome.delta}`);

      if (this._regressions >= 3) {
        const currentCount = this.tracker?.count?.() || 0;
        this._paused = true;
        this._pauseUntilTasks = currentCount + 100;
        _log.warn(`[GOAL] Circuit breaker: pausing GoalSynthesizer until task count ${this._pauseUntilTasks}`);
        this.bus.emit('goal:circuit-breaker', {
          regressions: this._regressions,
          pauseUntil: this._pauseUntilTasks,
        }, { source: 'GoalSynthesizer' });
      }
    }
  }

  /** Get tracking statistics */
  getStats() {
    return {
      goalsGenerated: this._goalsGenerated,
      cyclesSinceLastGoal: this._cyclesSinceLastGoal,
      regressions: this._regressions,
      paused: this._paused,
    };
  }
}

module.exports = { GoalSynthesizer, PROTECTED_MODULES };
