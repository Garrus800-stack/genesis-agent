// @ts-checked-v5.7
// ============================================================
// GENESIS — FitnessEvaluator.js (v5.0.0 — Adaptive Evaluation)
//
// v5.0.0 improvements over v5.0.0:
//
// PROBLEM 1 — 7-day time window is too slow for a desktop app.
// A single-user instance that runs 2 hours/day would wait weeks
// before the first meaningful evaluation. Evolution was stalled.
//
// SOLUTION: Dual-trigger evaluation.
//   - Time trigger:       evaluate every evalPeriodMs (now 3 days default)
//   - Activity trigger:   evaluate when N significant events accumulate
//                         (default: 25 goal completions OR 100 interactions)
//   The first trigger to fire wins. After evaluation, the activity
//   counter resets regardless of which trigger fired.
//
// PROBLEM 2 — _getPeerMedian() returns null for solo instances.
// With 0–1 peers, belowMedianCount never increments, selection
// pressure is zero, and evolution never happens.
//
// SOLUTION: Self-baseline comparison.
//   When fewer than 2 peer scores are available, compare against
//   own historical median (last SELF_BASELINE_WINDOW evaluations).
//   This allows directional selection even without a peer network.
//   The self-baseline is clearly marked in events/logs so it's
//   distinguishable from peer-based selection.
//
// Architecture (unchanged):
//   EventStore → FitnessEvaluator.evaluate() → fitness score
//   FitnessEvaluator → PeerConsensus (score propagation)
//   FitnessEvaluator → CloneFactory (parent selection)
//   FitnessEvaluator → Storage (fitness-history.json)
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { EVENT_STORE_BUS_MAP: EM } = require('../core/EventTypes');
const _log = createLogger('FitnessEvaluator');

// ── Metric Weights ───────────────────────────────────────
const DEFAULT_WEIGHTS = {
  taskCompletion:   0.30,
  energyEfficiency: 0.20,
  errorRate:        0.20,
  userSatisfaction: 0.20,
  selfRepair:       0.10,
};

// ── Timing ────────────────────────────────────────────────
// 3 days default instead of 7 — more responsive for daily use.
// Still configurable via settings.organism.fitness.evalPeriodMs.
const DEFAULT_EVAL_PERIOD_MS = 3 * 24 * 60 * 60 * 1000;
const GRACE_PERIODS          = 2;

// ── Activity Milestones ───────────────────────────────────
// Evaluate early when enough meaningful activity has accumulated.
// Both thresholds are checked independently; either one fires.
const DEFAULT_MILESTONE_GOALS         = 25;   // completed goals
const DEFAULT_MILESTONE_INTERACTIONS  = 100;  // total chat completions

// ── Self-Baseline ─────────────────────────────────────────
// When fewer than MIN_PEERS_FOR_MEDIAN peers are available,
// compare against the agent's own recent history.
const MIN_PEERS_FOR_MEDIAN    = 2;
const SELF_BASELINE_WINDOW    = 5;   // last N evaluations
const SELF_BASELINE_THRESHOLD = 0.85; // below 85% of own median = weak


class FitnessEvaluator {
  static containerConfig = {
    name:  'fitnessEvaluator',
    phase: 10,
    deps:  ['eventStore', 'storage'],
    tags:  ['organism', 'evolution', 'fitness'],
    lateBindings: [
      { prop: 'genome',       service: 'genome',       optional: true },
      { prop: 'metabolism',   service: 'metabolism',   optional: true },
      { prop: 'immuneSystem', service: 'immuneSystem', optional: true },
    ],
  };

  constructor({ bus, eventStore, storage, intervals, config }) {
    this.bus        = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.eventStore = eventStore || null;
    this.storage    = storage    || null;
    this._intervals = intervals  || null;

    // Late-bound
    this.genome       = null;
    this.metabolism   = null;
    this.immuneSystem = null;

    // Config
    const cfg = config || {};
    this._weights       = { ...DEFAULT_WEIGHTS,            ...(cfg.weights || {}) };
    this._evalPeriodMs  = cfg.evalPeriodMs   ?? DEFAULT_EVAL_PERIOD_MS;
    this._gracePeriods  = cfg.gracePeriods   ?? GRACE_PERIODS;
    this._milestoneGoals         = cfg.milestoneGoals        ?? DEFAULT_MILESTONE_GOALS;
    this._milestoneInteractions  = cfg.milestoneInteractions ?? DEFAULT_MILESTONE_INTERACTIONS;

    // ── State ────────────────────────────────────────────
    this._fitnessHistory   = [];        // [{ timestamp, score, metrics, genomeHash, trigger }]
    this._maxHistory       = 100;
    this._peerScores       = new Map(); // genomeHash → { score, timestamp }
    this._belowMedianCount = 0;
    this._lastEvaluation   = null;

    // Activity milestone counters (reset after each evaluation)
    this._activityCounters = {
      goalCompletions: 0,
      interactions:    0,
    };

    // Track last evaluation timestamp for time trigger
    this._lastEvalTimestamp = 0;
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    if (!this.storage) return;
    try {
      const saved = await this.storage.readJSONAsync('fitness-history.json');
      if (saved?.history) {
        this._fitnessHistory = saved.history.slice(-this._maxHistory);
      }
      if (saved?.belowMedianCount !== undefined) {
        this._belowMedianCount = saved.belowMedianCount;
      }
      if (saved?.peerScores) {
        for (const [k, v] of Object.entries(saved.peerScores)) {
          this._peerScores.set(k, v);
        }
      }
      // Restore activity counters from last save (avoids double-counting on restart)
      if (saved?.activityCounters) {
        this._activityCounters = { ...this._activityCounters, ...saved.activityCounters };
      }
      if (saved?.lastEvalTimestamp) {
        this._lastEvalTimestamp = saved.lastEvalTimestamp;
      }
    } catch { /* first boot */ }
  }

  start() {
    // ── Time trigger ──────────────────────────────────────
    // Still registered via IntervalManager, but now at 3d not 7d.
    // Acts as a guaranteed fallback if activity is very low.
    if (this._intervals) {
      this._intervals.register('fitness-eval-time', () => {
        _log.debug('[FITNESS] Time trigger fired');
        this.evaluate('time');
      }, this._evalPeriodMs, { immediate: false });
    }

    // ── Activity triggers ─────────────────────────────────
    // goal:completed — count each successful AgentLoop goal
    this._sub('agent-loop:complete', (data) => {
      if (data?.success !== false) {
        this._activityCounters.goalCompletions++;
        this._checkActivityMilestone();
      }
    }, { source: 'FitnessEvaluator' });

    // chat:completed — count all user interactions
    this._sub('chat:completed', () => {
      this._activityCounters.interactions++;
      this._checkActivityMilestone();
    }, { source: 'FitnessEvaluator' });

    // ── Peer fitness broadcasts ───────────────────────────
    this._sub('peer:fitness-score', (data) => {
      if (data.genomeHash && data.score !== undefined) {
        this._peerScores.set(data.genomeHash, {
          score:     data.score,
          timestamp: Date.now(),
        });
      }
    }, { source: 'FitnessEvaluator' });

    _log.info(
      `[FITNESS] Active — time trigger ${Math.round(this._evalPeriodMs / 86400000)}d,` +
      ` activity triggers: ${this._milestoneGoals} goals OR ${this._milestoneInteractions} interactions,` +
      ` grace ${this._gracePeriods} periods`
    );
  }


  /** @private Subscribe to bus event with auto-cleanup in stop() */
  _sub(event, handler, opts) {
    const unsub = this.bus.on(event, handler, opts);
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
    return unsub;
  }

  stop() {
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) { /* best effort */ } }
    this._unsubs = [];
    if (this._intervals) this._intervals.clear('fitness-eval-time');
    // FIX D-1: Use sync write on shutdown. writeJSONDebounced() queues a 2s timer
    // that will never fire if the process exits immediately after stop().
    this._persistSync();
  }

  // ════════════════════════════════════════════════════════
  // ACTIVITY MILESTONE CHECK
  // ════════════════════════════════════════════════════════

  /** @private — called after each activity event */
  _checkActivityMilestone() {
    const goalsHit   = this._activityCounters.goalCompletions  >= this._milestoneGoals;
    const chatHit    = this._activityCounters.interactions      >= this._milestoneInteractions;
    // Also enforce a minimum time gap (10 min) between evaluations
    // to prevent rapid-fire evaluations when multiple triggers near-simultaneously fire.
    const gapOk      = Date.now() - this._lastEvalTimestamp > 10 * 60 * 1000;

    if ((goalsHit || chatHit) && gapOk) {
      const trigger = goalsHit ? 'milestone:goals' : 'milestone:interactions';
      _log.info(`[FITNESS] Activity milestone reached — ${trigger} (goals: ${this._activityCounters.goalCompletions}, interactions: ${this._activityCounters.interactions})`);
      this.evaluate(trigger);
    }
  }

  // ════════════════════════════════════════════════════════
  // CORE: FITNESS EVALUATION
  // ════════════════════════════════════════════════════════

  /**
   * Compute the composite fitness score from accumulated metrics.
   * @param {'time'|'milestone:goals'|'milestone:interactions'|'manual'} [trigger='manual']
   * @returns {object} Evaluation result with score, metrics, genomeHash, trigger, belowMedian, selfBaselineUsed, archivalRecommended
   */
  evaluate(trigger = 'manual') {
    const metrics    = this._collectMetrics();
    const score      = this._computeScore(metrics);
    const genomeHash = this.genome?.hash() || 'unknown';

    const result = {
      score:      Math.round(score * 1000) / 1000,
      metrics,
      genomeHash,
      timestamp:  Date.now(),
      generation: this.genome?.generation || 0,
      trigger,
    };

    // ── Comparison: peer median (preferred) or self-baseline ──
    // FIX v5.0.0: Compute self-baseline BEFORE pushing current result to history.
    // Previously, the current score was included in its own baseline (20% bias
    // with window size 5), making it harder to detect regression.
    const peerMedian = this._getPeerMedian();
    const hasPeers   = peerMedian !== null;

    if (hasPeers) {
      result.peerMedian       = peerMedian;
      result.selfBaselineUsed = false;
      result.belowMedian      = score < peerMedian;
    } else {
      // Solo mode: compare against own historical median
      const selfBaseline = this._getSelfBaseline();
      result.peerMedian       = null;
      result.selfBaseline     = selfBaseline;
      result.selfBaselineUsed = selfBaseline !== null;
      // Below own baseline × threshold = regressing relative to self
      result.belowMedian = selfBaseline !== null && score < selfBaseline * SELF_BASELINE_THRESHOLD;
    }

    // Store in history (after baseline comparison)
    this._fitnessHistory.push(result);
    if (this._fitnessHistory.length > this._maxHistory) this._fitnessHistory.shift();

    if (result.belowMedian) {
      this._belowMedianCount++;
      const ref = hasPeers
        ? `peer median ${result.peerMedian.toFixed(3)}`
        : `self baseline ${(result.selfBaseline * SELF_BASELINE_THRESHOLD).toFixed(3)}`;
      _log.warn(`[FITNESS] Below ${ref} (score: ${score.toFixed(3)}), count: ${this._belowMedianCount}/${this._gracePeriods}`);
    } else {
      this._belowMedianCount = 0;
    }

    result.archivalRecommended = this._belowMedianCount >= this._gracePeriods;
    if (result.archivalRecommended) {
      _log.warn(`[FITNESS] Archival recommended — below threshold for ${this._belowMedianCount} consecutive evaluations`);
    }

    this._lastEvaluation  = result;
    this._lastEvalTimestamp = Date.now();

    // Reset activity counters after evaluation
    this._activityCounters = { goalCompletions: 0, interactions: 0 };

    // FIX v5.0.0: Reset Metabolism period counter so energyEfficiency reflects
    // only the current eval period rather than the entire lifetime.
    this.metabolism?.resetPeriod?.();

    // Broadcast
    this.bus.emit('fitness:evaluated', result, { source: 'FitnessEvaluator' });
    this.bus.fire('peer:fitness-score', {
      genomeHash,
      score:      result.score,
      generation: result.generation,
    }, { source: 'FitnessEvaluator' });

    this._persist();
    _log.info(
      `[FITNESS] Score: ${result.score.toFixed(3)}` +
      ` (gen ${result.generation}, trigger: ${trigger}, genome: ${genomeHash.slice(0, 8)},` +
      ` ${result.selfBaselineUsed ? 'self-baseline' : 'peer-based'})`
    );
    return result;
  }

  // ════════════════════════════════════════════════════════
  // METRICS COLLECTION
  // ════════════════════════════════════════════════════════

  /** @private */
  _collectMetrics() {
    const since  = Date.now() - this._evalPeriodMs;
    const events = this._getEventsSince(since);

    // Task completion rate
    // FIX v5.0.0: Derive type filters from EVENT_STORE_BUS_MAP (single source of truth).
    const goalsStarted   = events.filter(e => e.type === EM.AGENT_LOOP_STARTED.store || e.type === EM.AGENT_LOOP_STARTED.bus).length;
    const goalsCompleted = events.filter(e =>
      (e.type === EM.AGENT_LOOP_COMPLETE.store || e.type === EM.AGENT_LOOP_COMPLETE.bus) && (e.payload ?? e.data)?.success !== false
    ).length;
    const taskCompletion = goalsStarted > 0 ? goalsCompleted / goalsStarted : 0.5;

    // Energy efficiency (tasks per energy unit within this eval period)
    // FIX v5.0.0: Use period-scoped energy spend so the metric doesn't degrade
    // monotonically across restarts. Falls back to lifetime spend if unavailable.
    const metabolismReport  = this.metabolism?.getReport();
    const totalSpent        = metabolismReport?.periodEnergySpent ?? metabolismReport?.totalEnergySpent ?? 1;
    const energyEfficiency  = totalSpent > 0 ? Math.min(1, goalsCompleted / (totalSpent / 100)) : 0.5;

    // Error rate (inverse)
    const errors     = events.filter(e => e.type === EM.ERROR_OCCURRED.store || e.type === EM.ERROR_OCCURRED.bus).length;
    const totalEvents = Math.max(events.length, 1);
    const errorRate  = 1 - Math.min(1, errors / (totalEvents * 0.1));

    // User satisfaction
    // FIX v5.0.0: Use EM.CHAT_MESSAGE for consistent type matching.
    const chatEvents     = events.filter(e => e.type === EM.CHAT_MESSAGE.store || e.type === EM.CHAT_MESSAGE.bus);
    const positive       = chatEvents.filter(e => (e.payload ?? e.data)?.feedback === 'positive' || (e.payload ?? e.data)?.success === true).length;
    const negative       = chatEvents.filter(e => (e.payload ?? e.data)?.feedback === 'negative' || (e.payload ?? e.data)?.success === false).length;
    const totalFeedback  = positive + negative;
    const userSatisfaction = totalFeedback > 0 ? positive / totalFeedback : 0.5;

    // Self-repair success
    let selfRepair = 0.5;
    if (this.immuneSystem) {
      try {
        const stats   = this.immuneSystem.getStats();
        const total   = stats.totalInterventions || 0;
        const resolved= stats.resolved            || 0;
        selfRepair    = total > 0 ? resolved / total : 0.5;
      } catch (err) { _log.debug('[FITNESS] immuneSystem.getStats failed:', err.message); }
    }

    return {
      taskCompletion:   Math.round(taskCompletion   * 1000) / 1000,
      energyEfficiency: Math.round(energyEfficiency * 1000) / 1000,
      errorRate:        Math.round(errorRate        * 1000) / 1000,
      userSatisfaction: Math.round(userSatisfaction * 1000) / 1000,
      selfRepair:       Math.round(selfRepair       * 1000) / 1000,
    };
  }

  /** @private */
  _computeScore(metrics) {
    let score = 0;
    for (const [key, weight] of Object.entries(this._weights)) {
      score += (metrics[key] ?? 0.5) * weight;
    }
    return Math.max(0, Math.min(1, score));
  }

  /** @private */
  _getEventsSince(since) {
    if (!this.eventStore) return [];
    try {
      if (typeof this.eventStore.query === 'function') {
        return this.eventStore.query({ since }).slice(-1000);
      }
      if (typeof this.eventStore.getRecent === 'function') {
        return this.eventStore.getRecent(500).filter(e => (e.timestamp || 0) >= since);
      }
      return [];
    } catch (err) { _log.warn('[FITNESS] EventStore query failed — metrics will use defaults:', err.message); return []; }
  }

  // ── Peer comparison ───────────────────────────────────

  /** @private — returns null when peer count < MIN_PEERS_FOR_MEDIAN */
  _getPeerMedian() {
    const scores = [...this._peerScores.values()]
      .filter(s => Date.now() - s.timestamp < this._evalPeriodMs * 3)
      .map(s => s.score)
      .sort((a, b) => a - b);

    if (scores.length < MIN_PEERS_FOR_MEDIAN) return null;
    const mid = Math.floor(scores.length / 2);
    return scores.length % 2 === 0
      ? (scores[mid - 1] + scores[mid]) / 2
      : scores[mid];
  }

  // ── Self-baseline ──────────────────────────────────────

  /**
   * Compute own historical median over the last SELF_BASELINE_WINDOW evaluations.
   * Returns null if fewer than 2 prior evaluations exist (can't form a baseline yet).
   * @private
   */
  _getSelfBaseline() {
    const recent = this._fitnessHistory
      .filter(h => h.score !== undefined)
      .slice(-SELF_BASELINE_WINDOW)
      .map(h => h.score)
      .sort((a, b) => a - b);

    if (recent.length < 2) return null;
    const mid = Math.floor(recent.length / 2);
    return recent.length % 2 === 0
      ? (recent[mid - 1] + recent[mid]) / 2
      : recent[mid];
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  getLastEvaluation() { return this._lastEvaluation; }
  getHistory()        { return [...this._fitnessHistory]; }

  /** Get the best genome hash from peer scores (for CloneFactory inheritance) */
  getBestPeerGenome() {
    let best = null, bestScore = -1;
    for (const [hash, data] of this._peerScores) {
      if (data.score > bestScore && Date.now() - data.timestamp < this._evalPeriodMs * 3) {
        best = hash; bestScore = data.score;
      }
    }
    return best ? { genomeHash: best, score: bestScore } : null;
  }

  /** Register a peer's fitness score (called by PeerNetwork) */
  registerPeerScore(genomeHash, score) {
    this._peerScores.set(genomeHash, { score, timestamp: Date.now() });
  }

  getStats() {
    return {
      evaluations:        this._fitnessHistory.length,
      lastScore:          this._lastEvaluation?.score  ?? null,
      lastTrigger:        this._lastEvaluation?.trigger ?? null,
      belowMedianCount:   this._belowMedianCount,
      peerCount:          this._peerScores.size,
      archivalRecommended:this._belowMedianCount >= this._gracePeriods,
      activityCounters:   { ...this._activityCounters },
      selfBaselineWindow: SELF_BASELINE_WINDOW,
    };
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  _persist() {
    if (!this.storage) return;
    try {
      // FIX v5.0.0: Debounced write to avoid sync fsync during active chat sessions.
      // Activity-triggered evaluations can fire during heavy interaction periods.
      this.storage.writeJSONDebounced('fitness-history.json', this._persistData(), 2000);
    } catch (err) {
      _log.warn('[FITNESS] Persist failed:', err.message);
    }
  }

  /** FIX D-1: Sync write for shutdown path — guarantees data reaches disk before exit. */
  _persistSync() {
    if (!this.storage) return;
    try {
      this.storage.writeJSON('fitness-history.json', this._persistData());
    } catch (err) {
      _log.warn('[FITNESS] Sync persist failed:', err.message);
    }
  }

  /** @private Shared payload for both persist paths. */
  _persistData() {
    return {
      history:            this._fitnessHistory.slice(-20),
      belowMedianCount:   this._belowMedianCount,
      peerScores:         Object.fromEntries(this._peerScores),
      activityCounters:   this._activityCounters,
      lastEvalTimestamp:  this._lastEvalTimestamp,
    };
  }
}

module.exports = { FitnessEvaluator };
