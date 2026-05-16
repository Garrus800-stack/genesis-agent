// ============================================================
// GENESIS — KoennenCandidateLog.js (Phase 9 — Cognitive Architecture)
//
// v7.8.9 — Affect-Encoding bei AgentLoop-Boundaries.
//
// Foundation layer for the Können-Konzept (procedural-memory
// crystallization). At every AgentLoop task start, snapshot the
// 5-dimensional emotional state. During the trajectory, track
// frustration and curiosity peaks via emotion:shift events. At
// task end, snapshot affect again, sum surprise signals from
// SurpriseAccumulator between start and end, and evaluate a
// baseline-relative triage gate.
//
// Both passing AND failing boundaries are persisted to
// .genesis/koennen/candidates.jsonl — v7.9.0 (Crystallization)
// needs the full distribution to calibrate θ from real data.
//
// Triage gate (baseline-relative, permissive):
//   PASS if: outcome.success === true
//        AND step_count > 0
//        AND satisfaction_end > satisfaction_baseline + 0.15
//        AND frustration_peak  < frustration_baseline + 0.4
//        AND (surprise_sum / step_count) > θ
//
//   θ = 0.6 - (genome.consolidation * 0.3), range [0.315, 0.585]
//   Higher consolidation → lower θ → more candidates pass
//
// Integration (event-based, no direct coupling):
//   'agent-loop:started'  → _onTaskStart()     (input)
//   'emotion:shift'       → _onEmotionShift()  (peak tracking)
//   'agent-loop:complete' → _onTaskComplete()  (evaluate + persist)
//   'koennen:candidate-recorded' (output, fired on gatePass=true)
//
// Cleanup: 30-min TTL tick removes stale _activeTaskStarts entries
// (crash-recovery for tasks where :started fired but :complete never came).
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('KoennenCandidateLog');

// Constants
const RECENT_RING_SIZE       = 50;       // in-memory boundaries for /affect-trail
const JSONL_FILE             = 'koennen/candidates.jsonl';
const STALE_TASK_TTL_MS      = 2 * 60 * 60 * 1000;   // 2h — drop if :complete never came
const CLEANUP_INTERVAL_MS    = 30 * 60 * 1000;       // 30 min
const ROTATION_THRESHOLD     = 5000;                 // archive jsonl after N lines
const ROTATION_CHECK_EVERY_N = 100;                  // size-check cadence

class KoennenCandidateLog {
  /**
   * @param {{ bus: *, storage?: *, emotionalState?: *,
   *          surpriseAccumulator?: *, genome?: *, intervals?: * }} deps
   */
  constructor({ bus, storage, emotionalState, surpriseAccumulator, genome, intervals }) {
    this.bus                  = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.storage              = storage || null;
    this.emotionalState       = emotionalState || null;
    this.surpriseAccumulator  = surpriseAccumulator || null;
    this.genome               = genome || null;
    this._intervals           = intervals || null;

    /** @type {Map<string, {goalId: string, title: string, startTs: number, startState: object, peaks: {frustration: number, curiosity: number}}>} */
    this._activeTaskStarts = new Map();

    /** @type {Array<object>} Ring-buffer for /affect-trail */
    this._recentBoundaries = [];

    this._stats = {
      totalEvaluated: 0,
      gatePassed: 0,
      missedStarts: 0,
      writesSinceCheck: 0,
    };

    /** @type {{ts: number, candidates: Array<object>} | null} */
    this._candidateCache = null;
    this._cacheTtlMs = 60 * 1000;  // 60s

    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;

    this._sub('agent-loop:started', (data) => this._onTaskStart(data));
    this._sub('emotion:shift',      (data) => this._onEmotionShift(data));
    this._sub('agent-loop:complete', (data) => this._onTaskComplete(data));

    if (this._intervals && typeof this._intervals.register === 'function') {
      this._intervals.register(
        'koennen-cleanup',
        () => this._cleanupStaleStarts(),
        CLEANUP_INTERVAL_MS
      );
    }

    _log.info('[KOENNEN] CandidateLog active — listening agent-loop boundaries');
  }

  stop() {
    this._unsubAll();
    if (this._intervals && typeof this._intervals.clear === 'function') {
      try { this._intervals.clear('koennen-cleanup'); } catch (_e) { /* */ }
    }
    this._started = false;
  }

  // ════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ════════════════════════════════════════════════════════

  _onTaskStart(data) {
    if (!data || !data.goalId) return;
    if (!this.emotionalState) return;

    const startState = this.emotionalState.getState();
    this._activeTaskStarts.set(data.goalId, {
      goalId: data.goalId,
      title: data.title || '',
      startTs: Date.now(),
      startState,
      peaks: {
        frustration: startState.frustration,
        curiosity:   startState.curiosity,
      },
    });
  }

  _onEmotionShift(data) {
    if (!data || !data.dimension) return;
    if (this._activeTaskStarts.size === 0) return;

    // Only track frustration and curiosity peaks — these are the
    // gate-relevant dimensions for candidate evaluation.
    if (data.dimension !== 'frustration' && data.dimension !== 'curiosity') return;
    const newValue = data.to;
    if (typeof newValue !== 'number') return;

    for (const start of this._activeTaskStarts.values()) {
      if (newValue > start.peaks[data.dimension]) {
        start.peaks[data.dimension] = newValue;
      }
    }
  }

  _onTaskComplete(data) {
    if (!data || !data.goalId) return;

    const start = this._activeTaskStarts.get(data.goalId);
    if (!start) {
      // :complete without prior :started — happens for synthesized
      // loop_early_<ts> goalIds on very-early failures. Defensive return.
      this._stats.missedStarts++;
      return;
    }

    try {
      const endState = this.emotionalState ? this.emotionalState.getState() : start.startState;
      const stepCount = typeof data.steps === 'number' ? data.steps : 0;
      const success = data.success === true;

      // Sum surprise across the trajectory
      let surpriseSum = 0;
      let surpriseCount = 0;
      if (this.surpriseAccumulator && typeof this.surpriseAccumulator.getSignalsSince === 'function') {
        const signals = this.surpriseAccumulator.getSignalsSince(start.startTs);
        for (const s of signals) {
          if (typeof s.totalSurprise === 'number') {
            surpriseSum += s.totalSurprise;
            surpriseCount++;
          }
        }
      }

      const affect = {
        // Start-Snapshot
        curiosity_start:    start.startState.curiosity,
        satisfaction_start: start.startState.satisfaction,
        frustration_start:  start.startState.frustration,
        energy_start:       start.startState.energy,
        loneliness_start:   start.startState.loneliness,
        // End-Snapshot
        curiosity_end:    endState.curiosity,
        satisfaction_end: endState.satisfaction,
        frustration_end:  endState.frustration,
        energy_end:       endState.energy,
        loneliness_end:   endState.loneliness,
        // Peaks
        frustration_peak: start.peaks.frustration,
        curiosity_peak:   start.peaks.curiosity,
        // Surprise integral
        surprise_sum: Math.round(surpriseSum * 100) / 100,
        surprise_count: surpriseCount,
        // Metadata
        task_duration_ms: Date.now() - start.startTs,
        step_count: stepCount,
        snapshot_version: 1,
      };

      const gate = this.evaluateGate(affect, { success, step_count: stepCount });

      const candidateId = `cand_${Date.now()}_${data.goalId.slice(-8)}`;
      const record = {
        candidateId,
        goalId: data.goalId,
        taskTitle: data.title || start.title || '',
        outcome: success ? 'success' : 'failure',
        affect,
        gatePass: gate.pass,
        gateDetails: gate.details,
        recordedAt: Date.now(),
      };

      // Persist
      this._persist(record);

      // In-memory ring
      this._recentBoundaries.push(record);
      if (this._recentBoundaries.length > RECENT_RING_SIZE) {
        this._recentBoundaries = this._recentBoundaries.slice(-RECENT_RING_SIZE);
      }

      // Stats
      this._stats.totalEvaluated++;
      if (gate.pass) this._stats.gatePassed++;

      // Event (only on pass — keeps subscriber load low)
      if (gate.pass) {
        this.bus.fire('koennen:candidate-recorded', {
          candidateId,
          goalId: data.goalId,
          gatePass: true,
        }, { source: 'KoennenCandidateLog' });
      }
    } catch (err) {
      _log.warn(`[KOENNEN] _onTaskComplete failed for goalId=${data.goalId}:`, err.message);
    } finally {
      // Always clear so the Map doesn't leak even on persist failure
      this._activeTaskStarts.delete(data.goalId);
    }
  }

  // ════════════════════════════════════════════════════════
  // GATE EVALUATION (pure function)
  // ════════════════════════════════════════════════════════

  /**
   * Evaluate triage gate. Pure — no side effects, no this-state reads
   * beyond emotionalState.dimensions baselines and genome.consolidation.
   *
   * @param {object} affect - Full affect record (10 dimensions + peaks + surprise)
   * @param {{success: boolean, step_count: number}} outcome
   * @returns {{pass: boolean, details: object}}
   */
  evaluateGate(affect, outcome) {
    const details = { theta: this._computeTheta() };

    if (!outcome.success) {
      details.success_check = 'failed';
      return { pass: false, details };
    }
    details.success_check = 'passed';

    if (outcome.step_count === 0) {
      details.skip_reason = 'no-steps';
      return { pass: false, details };
    }

    const baselines = this._getBaselines();
    const satTarget = baselines.satisfaction + 0.15;
    const fruLimit  = baselines.frustration + 0.4;
    const surpriseAvg = affect.surprise_sum / Math.max(1, affect.step_count);

    const satPass = affect.satisfaction_end > satTarget;
    const fruPass = affect.frustration_peak < fruLimit;
    const surPass = surpriseAvg > details.theta;

    details.satisfaction_check = satPass
      ? `passed (${affect.satisfaction_end.toFixed(2)} > ${satTarget.toFixed(2)})`
      : `failed (${affect.satisfaction_end.toFixed(2)} <= ${satTarget.toFixed(2)})`;
    details.frustration_check = fruPass
      ? `passed (${affect.frustration_peak.toFixed(2)} < ${fruLimit.toFixed(2)})`
      : `failed (${affect.frustration_peak.toFixed(2)} >= ${fruLimit.toFixed(2)})`;
    details.surprise_check = surPass
      ? `passed (${surpriseAvg.toFixed(2)} > ${details.theta.toFixed(2)})`
      : `failed (${surpriseAvg.toFixed(2)} <= ${details.theta.toFixed(2)})`;

    return { pass: satPass && fruPass && surPass, details };
  }

  _computeTheta() {
    const consolidation = (this.genome && typeof this.genome.trait === 'function')
      ? this.genome.trait('consolidation')
      : 0.5;
    return 0.6 - (consolidation * 0.3);
  }

  _getBaselines() {
    if (this.emotionalState && this.emotionalState.dimensions) {
      return {
        satisfaction: this.emotionalState.dimensions.satisfaction?.baseline ?? 0.5,
        frustration:  this.emotionalState.dimensions.frustration?.baseline  ?? 0.1,
      };
    }
    return { satisfaction: 0.5, frustration: 0.1 };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  getRecentBoundaries(limit = 20) {
    const n = Math.max(1, Math.min(RECENT_RING_SIZE, limit));
    return this._recentBoundaries.slice(-n);
  }

  /**
   * Read candidates from JSONL file filtered by timestamp.
   * 60s in-memory cache to avoid repeated file reads.
   */
  getCandidatesSince(timestamp) {
    if (typeof timestamp !== 'number') return [];

    // Cache hit
    const now = Date.now();
    if (this._candidateCache && (now - this._candidateCache.ts) < this._cacheTtlMs) {
      return this._candidateCache.candidates.filter(c => c.recordedAt >= timestamp);
    }

    if (!this.storage) return [];

    let raw;
    try {
      raw = this.storage.readText(JSONL_FILE, '');
    } catch (_e) {
      return [];
    }
    if (!raw) return [];

    const candidates = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        candidates.push(JSON.parse(trimmed));
      } catch (_e) {
        // Skip malformed line (defensive — JSONL append is fsync'd per line)
      }
    }

    this._candidateCache = { ts: now, candidates };
    return candidates.filter(c => c.recordedAt >= timestamp);
  }

  getStats() {
    const gatePassRate = this._stats.totalEvaluated > 0
      ? this._stats.gatePassed / this._stats.totalEvaluated
      : 0;
    return {
      totalEvaluated: this._stats.totalEvaluated,
      gatePassed: this._stats.gatePassed,
      gatePassRate,
      activeTasksTracked: this._activeTaskStarts.size,
      missedStarts: this._stats.missedStarts,
      currentTheta: this._computeTheta(),
    };
  }

  // ════════════════════════════════════════════════════════
  // PERSISTENCE
  // ════════════════════════════════════════════════════════

  _persist(record) {
    if (!this.storage) return;
    try {
      this.storage.appendText(JSONL_FILE, JSON.stringify(record) + '\n');
      this._stats.writesSinceCheck++;
      if (this._stats.writesSinceCheck >= ROTATION_CHECK_EVERY_N) {
        this._stats.writesSinceCheck = 0;
        this._maybeRotate();
      }
      // Invalidate cache on write
      this._candidateCache = null;
    } catch (err) {
      _log.warn('[KOENNEN] persist failed:', err.message);
    }
  }

  _maybeRotate() {
    if (!this.storage) return;
    try {
      const raw = this.storage.readText(JSONL_FILE, '');
      if (!raw) return;
      // Cheap line count by counting newlines
      let lines = 0;
      for (let i = 0; i < raw.length; i++) if (raw.charCodeAt(i) === 10) lines++;
      if (lines < ROTATION_THRESHOLD) return;

      const date = new Date().toISOString().slice(0, 10);
      const archivePath = `koennen/candidates-archive-${date}.jsonl`;
      this.storage.appendText(archivePath, raw);
      this.storage.writeText(JSONL_FILE, '');
      _log.info(`[KOENNEN] Rotated candidates.jsonl → archive ${archivePath} (${lines} lines)`);
    } catch (err) {
      _log.warn('[KOENNEN] rotation failed:', err.message);
    }
  }

  // ════════════════════════════════════════════════════════
  // TTL CLEANUP
  // ════════════════════════════════════════════════════════

  _cleanupStaleStarts() {
    const now = Date.now();
    let removed = 0;
    for (const [goalId, start] of this._activeTaskStarts.entries()) {
      if ((now - start.startTs) > STALE_TASK_TTL_MS) {
        this._activeTaskStarts.delete(goalId);
        removed++;
      }
    }
    if (removed > 0) {
      _log.debug(`[KOENNEN] Cleanup removed ${removed} stale task start(s)`);
    }
  }
}

// v7.3.4 mixin — adds _sub/_unsubAll, auto-tags subscriptions
applySubscriptionHelper(KoennenCandidateLog, { defaultSource: 'KoennenCandidateLog' });

module.exports = { KoennenCandidateLog };
