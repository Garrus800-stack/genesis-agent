// @ts-checked-v5.7
// ============================================================
// GENESIS — StalledGoalWatchdog.js (v7.7.9 Phase 3)
//
// Background service that detects goals stuck in the `blocked`
// state for longer than `stalledTimeoutMs` and converts them
// into a proper failure-reflection pathway.
//
// Why this exists:
// Before Phase 3, AgentLoopSteps could return blocked=true for
// any missing resource. The goal would be parked in `status:
// 'blocked'`, and the GoalDriver would re-pick it up — only to
// find the same step still blocked, again and again. There was
// no timeout, no escalation path. Goals where the resource would
// never come (hallucinated paths, missing services, network
// outages without recovery) sat indefinitely. The PSE pipeline
// never received a `plan-failure-reflection` for them because
// `_emitFailure` was never called.
//
// Phase 3 introduces a stalled-state lifecycle. When a goal has
// been blocked for too long, this watchdog:
//   1. Transitions its GoalStack status from 'blocked' to 'stalled'
//   2. Fires the `goal:stalled` telemetry event
//   3. Calls `recordReflection` directly with a synthetic failure
//      payload, classification='external' (resource-blocked).
//
// Step 3 is the key one for PSE: it produces an InnerSpeech
// `plan-failure-reflection` thought, which then runs through the
// proactive-self-expression pipeline normally. Genesis can
// reflect on what's stuck, even when no exception was thrown.
//
// Design boundaries:
//   - Resource-blocks shorter than `stalledTimeoutMs` are
//     legitimate waits (e.g. for a download to finish). We don't
//     interfere with those.
//   - A goal is only stall-flagged ONCE. Subsequent ticks ignore
//     goals already in 'stalled' status.
//   - The watchdog never modifies goals directly via fs writes —
//     it goes through goalStack.setStatus / updateGoal so the
//     usual persistence path runs.
//   - Failures inside the watchdog (e.g. goalStack write error)
//     are logged but never propagated. The cognitive layer must
//     not be blocked by the watchdog's housekeeping.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('StalledGoalWatchdog');

const DEFAULT_TICK_INTERVAL_MS = 60_000;       // scan every minute
const DEFAULT_STALLED_TIMEOUT_MS = 15 * 60_000; // 15 min default

class StalledGoalWatchdog {
  /**
   * @param {{
   *   bus: any,
   *   goalStack?: any,
   *   settings?: any,
   *   eventStore?: any,
   *   intervals?: any,
   * }} services
   */
  constructor({ bus, goalStack = null, settings = null, eventStore = null, intervals = null } = {}) {
    this.bus = bus;
    this.goalStack = goalStack;
    this.settings = settings;
    this.eventStore = eventStore;
    this._intervals = intervals;  // optional IntervalManager for coordinated shutdown

    // Late-bound (set after manifest wiring):
    /** @type {*} */ this.innerSpeech = null;
    /** @type {*} */ this.selfStatementLog = null;
    /** @type {*} */ this.lessonsStore = null;

    this._timer = null;
    this._running = false;
    this._flagged = new Set();  // goalIds already stall-flagged this session
  }

  start() {
    if (this._running) return;
    this._running = true;
    const interval = this._getTickInterval();
    // v7.7.9 Phase 3: prefer IntervalManager.register when available
    // (coordinated shutdown). Fall back to raw setInterval if not wired —
    // tests run in isolation without IntervalManager, and stop() handles both.
    if (this._intervals && typeof this._intervals.register === 'function') {
      this._intervals.register(
        'stalled-goal-watchdog',
        () => { this._tick().catch(err => _log.debug('[STALL-WATCHDOG] tick error (ignored):', err && err.message)); },
        interval
      );
      this._timer = 'managed';
    } else {
      this._timer = setInterval(() => {
        this._tick().catch(err => _log.debug('[STALL-WATCHDOG] tick error (ignored):', err && err.message));
      }, interval);
      if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    }
    _log.info(`[STALL-WATCHDOG] active — tick every ${Math.round(interval / 1000)}s, stalledTimeoutMs=${this._getStalledTimeoutMs()}`);
  }

  stop() {
    if (!this._timer) { this._running = false; return; }
    if (this._timer === 'managed' && this._intervals && typeof this._intervals.clear === 'function') {
      try { this._intervals.clear('stalled-goal-watchdog'); } catch (_e) { /* */ }
    } else if (this._timer !== 'managed') {
      clearInterval(this._timer);
    }
    this._timer = null;
    this._running = false;
  }

  _getTickInterval() {
    const v = this.settings?.get?.('goals.stalledWatchdogTickMs');
    return (typeof v === 'number' && v >= 5000 && v <= 600_000) ? v : DEFAULT_TICK_INTERVAL_MS;
  }

  _getStalledTimeoutMs() {
    const v = this.settings?.get?.('goals.stalledTimeoutMs');
    return (typeof v === 'number' && v >= 60_000) ? v : DEFAULT_STALLED_TIMEOUT_MS;
  }

  /**
   * Scan all goals for stalled candidates. Triggered by setInterval.
   * Public so tests can drive it deterministically.
   */
  async _tick() {
    if (!this.goalStack || !Array.isArray(this.goalStack.goals)) return;
    const now = Date.now();
    const timeoutMs = this._getStalledTimeoutMs();
    const candidates = [];
    for (const g of this.goalStack.goals) {
      if (!g || g.status !== 'blocked') continue;
      if (this._flagged.has(g.id)) continue;
      const blockedAt = g.blockedAt ? Date.parse(g.blockedAt) : null;
      if (!blockedAt || isNaN(blockedAt)) continue;
      if (now - blockedAt < timeoutMs) continue;  // not stalled long enough
      candidates.push(g);
    }
    for (const g of candidates) {
      await this._flagStalled(g, now);
    }
  }

  /**
   * Transition a goal to 'stalled' and emit the reflection trigger.
   * Idempotent: once a goal is in this._flagged it won't be re-flagged.
   *
   * @param {*} goal - GoalStack entry
   * @param {number} now - timestamp for reproducibility in tests
   */
  async _flagStalled(goal, now) {
    if (!goal || !goal.id) return;
    if (this._flagged.has(goal.id)) return;
    this._flagged.add(goal.id);

    const blockedAt = goal.blockedAt ? Date.parse(goal.blockedAt) : now;
    const stalledMinutes = Math.round((now - blockedAt) / 60_000);
    const resources = Array.isArray(goal.blockedByResources)
      ? goal.blockedByResources.join(', ') : '(unknown)';
    const errorMessage = `Goal stalled — step blocked for ${stalledMinutes} min on missing resource(s): ${resources}`;

    // Step 1: GoalStack status transition.
    try {
      if (typeof this.goalStack.setStatus === 'function') {
        this.goalStack.setStatus(goal.id, 'stalled');
      } else if (typeof this.goalStack.updateGoal === 'function') {
        await this.goalStack.updateGoal(goal.id, { status: 'stalled' });
      }
    } catch (e) {
      _log.warn('[STALL-WATCHDOG] failed to set goal status to stalled:', e.message);
    }

    // Step 2: Telemetry — goal:stalled.
    try {
      if (this.bus && this.bus.fire) {
        this.bus.fire('goal:stalled', {
          id: goal.id,
          description: goal.description || null,
          reason: errorMessage,
          blockedAt: goal.blockedAt || null,
          stalledMinutes,
        }, { source: 'StalledGoalWatchdog' });
      }
    } catch (e) {
      _log.debug('[STALL-WATCHDOG] goal:stalled emit error (ignored):', e.message);
    }

    // Step 3: Synthetic plan-failure-reflection.
    // We call AgentLoopPursuitReflection.recordReflection directly with
    // classification='external' — same shape a real pursuit-failure would
    // produce. InnerSpeech.emit fires inside recordReflection, the PSE
    // pipeline then runs HardGates → Score → Generate → Sanity normally.
    //
    // Argument shape matches reflectOnFailure → recordReflection contract:
    // services dict in arg 0, payload (with innerSpeech inline) in arg 1.
    try {
      // Lazy require: keeps this module decoupled in tests that don't
      // need the reflection pathway.
      const { recordReflection } = require('../revolution/AgentLoopPursuitReflection');
      recordReflection({
        bus: this.bus,
        lessonsStore: this.lessonsStore,
        selfStatementLog: this.selfStatementLog,
      }, {
        goalId: goal.id,
        goalDescription: goal.description || null,
        errorMessage,
        classification: 'external',
        stepsExecuted: typeof goal.stepCount === 'number' ? goal.stepCount : 0,
        // InnerSpeech is read from payload.innerSpeech inside recordReflection
        // (see AgentLoopPursuitReflection.js, line 127). Pass it here so the
        // reflection emit fires when InnerSpeech is wired.
        innerSpeech: this.innerSpeech,
      });
    } catch (e) {
      _log.debug('[STALL-WATCHDOG] reflection emit error (ignored):', e.message);
    }

    _log.warn(`[STALL-WATCHDOG] goal ${goal.id} marked stalled (${stalledMinutes} min blocked on ${resources})`);
  }

  /**
   * For tests / introspection only: peek the flagged set.
   */
  _getFlaggedIds() {
    return [...this._flagged];
  }
}

module.exports = { StalledGoalWatchdog };
