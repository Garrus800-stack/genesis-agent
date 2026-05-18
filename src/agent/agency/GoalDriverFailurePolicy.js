// ============================================================
// GENESIS — agency/GoalDriverFailurePolicy.js (v7.6.2)
//
// Failure-pause policy mixin extracted from GoalDriver.js in
// the v7.6.2 Track A continuation. Holds the failure-burst /
// backoff / stall logic that decides what to do when a pursuit
// fails (rate-limit, user-rejection, or generic error):
//
//   _applyFailurePause(goalId, errMsg, goal)
//
// Why split: GoalDriver.js was 841 LOC (>700 soft-guard) and
// _applyFailurePause alone was ~118 LOC — a coherent backoff
// schedule + stall-threshold + idempotency guard with no need
// for the rest of the driver's lifecycle / event-wiring.
//
// Coupling note: the method reads/writes
//   this._failureBurst        Map<goalId, {count, firstAt, kind}>
//   this._goalPausedUntil     Map<goalId, untilTimestampMs>
//   this._lastPausedAt        Map<goalId, lastPausedTimestampMs>
//   this._running             boolean (for setTimeout-rescan guard)
//   this.goalStack.{setStatus, updateGoal, goals}
//   this.bus.fire('goal:stalled', ...)
//   this._scanAndMaybePursue() — staying in main file
// All three Maps are late-init inside the method (safe even if
// _applyFailurePause runs before any other map-using path) —
// the same Maps are also touched by _onPursuitComplete /
// _listPursueable / _beginPursuit which stay on the main class,
// works seamlessly via shared `this`-instance state.
//
// Mixed onto GoalDriver.prototype at module-load via Object.assign
// — see GoalDriver.js bottom + the canonical Mixin Convention in
// ARCHITECTURE.md § 5.8.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalDriver');

const failurePolicyMixin = {

  /**
   * v7.4.5.fix #19: idempotent failure-pause helper.
   * Called from BOTH the event-handler path (_onPursuitComplete,
   * fires inside pursue's bus.fire BEFORE pursue returns) AND the
   * resolve-side path (_beginPursuit, after await pursue() resolves
   * with success:false). Whichever reaches it first sets the
   * pause; the second call is a no-op for that failure because
   * the same `errMsg` produces the same _failureBurst entry update
   * — but the count would double if we don't guard. Solution:
   * track "just paused this goal at timestamp X" via _lastPausedAt
   * and skip duplicate calls within 500ms of each other (raised
   * from 50ms in v7.5.1 — see body comment for rationale).
   *
   * @param {string} goalId
   * @param {string} errMsg  - may be empty (generic-backoff applies)
   * @param {object} [goal]  - goalStack entry, optional
   */
  async _applyFailurePause(goalId, errMsg, goal) {
    if (!goalId) return;

    // v7.9.1: Skip synthetic loop_early_<ts> goal-ids. These are emitted
    // by AgentLoopPursuit when a plan fails before currentGoalId is set
    // (e.g. dry-run validation failure, plan-generation rejection). They
    // have no GoalStack entry, so setStatus would silently do nothing
    // and we would just log a misleading "stalled" warning and burn a
    // burst-counter slot. Drop them immediately — the real goal-id (if
    // any) is handled by a second _applyFailurePause call.
    if (goalId.startsWith('loop_early_')) return;

    const _now = Date.now();
    this._failureBurst = this._failureBurst || new Map();
    this._goalPausedUntil = this._goalPausedUntil || new Map();
    this._lastPausedAt = this._lastPausedAt || new Map();

    // Idempotency guard: if we paused this goal in the last 500ms,
    // a second call (event-side + resolve-side for the same
    // failure) would double-count. Skip the second one.
    //
    // v7.5.1 (was 50ms, raised to 500ms): on loaded systems the gap
    // between event-handler emit and resolve-side await can exceed
    // 50ms (observed 91ms in CI containers; production under GC/IO
    // pressure can spike higher). With 50ms the second call slipped
    // through and goals were prematurely stalled (count→stalled
    // after 3 real failures instead of 6). The real race is always
    // within the same pursue() execution — anything beyond 500ms is
    // a different failure event.
    const lastPaused = this._lastPausedAt.get(goalId) || 0;
    if (_now - lastPaused < 500) return;
    this._lastPausedAt.set(goalId, _now);

    const _isRateLimit = /rate limit|rate.limited|budget exhausted/i.test(errMsg || '');
    const _isUserRejection = (errMsg || '').startsWith('User rejected');

    if (!goal) {
      goal = this.goalStack.goals?.find(g => g.id === goalId);
    }

    if (_isRateLimit) {
      const pauseMs = 60_000;
      this._goalPausedUntil.set(goalId, _now + pauseMs);
      // v7.6.5 (raw-settimeout phase 2): per-goalId on this._failurePauseTimers
      // (initialised in GoalDriver constructor); stop() cancels all pending.
      const _existing1 = this._failurePauseTimers.get(goalId);
      if (_existing1) clearTimeout(_existing1);
      const _t1 = setTimeout(() => {
        this._failurePauseTimers.delete(goalId);
        if (this._running) this._scanAndMaybePursue();
      }, pauseMs + 100);
      this._failurePauseTimers.set(goalId, _t1);
      _log.warn(`[DRIVER] pursuit of ${goalId} hit LLM rate limit — pausing this goal for ${Math.round(pauseMs/1000)}s`);
    } else if (_isUserRejection) {
      const entry = this._failureBurst.get(goalId) || { count: 0, firstAt: _now, kind: 'reject' };
      if (_now - entry.firstAt > 60_000) {
        entry.count = 0;
        entry.firstAt = _now;
      }
      entry.count++;
      this._failureBurst.set(goalId, entry);
      // v7.4.5.fix #19: short pause between rejection attempts (1s).
      // Without this, the scan loop re-picks the goal in <1ms after
      // each rejection, generating 1000+ pickup logs/second before
      // the 3-strike stall kicks in.
      const pauseMs = 1_000;
      this._goalPausedUntil.set(goalId, _now + pauseMs);
      // v7.6.5 (raw-settimeout phase 2): tracked per-goalId.
      const _existing2 = this._failurePauseTimers.get(goalId);
      if (_existing2) clearTimeout(_existing2);
      const _t2 = setTimeout(() => {
        this._failurePauseTimers.delete(goalId);
        if (this._running) this._scanAndMaybePursue();
      }, pauseMs + 100);
      this._failurePauseTimers.set(goalId, _t2);
      // v7.5.8 hotfix: stall on FIRST user-rejection, not after 3 strikes.
      // Live-Befund (Garrus-Win, 2026-05-03): a goal was re-picked 4×
      // after explicit user rejection because the threshold was 3 and
      // the goal-driver scan loop kept retrying. When the user explicitly
      // rejects a plan ("Failed: User rejected plan with blockers"), the
      // goal should not be re-attempted from the same plan — stall it
      // immediately so user can either rewrite the plan or close the goal.
      const REJECTION_STALL_THRESHOLD = 1;
      if (entry.count >= REJECTION_STALL_THRESHOLD) {
        _log.warn(`[DRIVER] goal ${goalId} rejected by user — marking as stalled (no further auto-pickup)`);
        try {
          if (typeof this.goalStack.setStatus === 'function') {
            this.goalStack.setStatus(goalId, 'stalled');
          } else if (typeof this.goalStack.updateGoal === 'function') {
            await this.goalStack.updateGoal(goalId, { status: 'stalled' });
          }
          this.bus.fire('goal:stalled', {
            id: goalId,
            description: goal?.description,
            reason: `${entry.count} consecutive plan rejections`,
          }, { source: 'GoalDriver' });
        } catch (e) {
          _log.warn('[DRIVER] failed to mark goal stalled:', e.message);
        }
        // v7.9.1: Belt-and-suspenders cooldown. Live-Befund (Garrus-Win,
        // 2026-05-17): even after setStatus('stalled') the goal was
        // re-picked ~25× over 30 minutes by the next scan-tick because
        // either (a) the status update raced with _scanAndMaybePursue,
        // or (b) IdleMind / GoalSynthesizer re-armed the goal back to
        // 'active'. The 24h cooldown in _goalRejectedCooldown is checked
        // by GoalDriver._listPursueable() and survives both races and
        // re-arming attempts. If the user really wants to retry the
        // same goal sooner, they can do so explicitly via the chat
        // ("/goal resume <id>" or similar) which bypasses the cooldown.
        this._goalRejectedCooldown = this._goalRejectedCooldown || new Map();
        const COOLDOWN_MS = 24 * 60 * 60 * 1000;
        this._goalRejectedCooldown.set(goalId, _now + COOLDOWN_MS);
        this._failureBurst.delete(goalId);
        this._goalPausedUntil.delete(goalId); // cleared by stall
      }
    } else {
      // Generic failure (incl. empty errMsg) → exponential backoff.
      const entry = this._failureBurst.get(goalId) || { count: 0, firstAt: _now, kind: 'generic' };
      if (_now - entry.firstAt > 10 * 60_000) {
        entry.count = 0;
        entry.firstAt = _now;
      }
      entry.count++;
      this._failureBurst.set(goalId, entry);

      // v7.7.9 (post-burnin P5): detect plan-hallucination failures —
      // implausible paths, unknown step types, "Unexpected token" in
      // verification. These never resolve by retry; the LLM keeps
      // emitting the same plan. Fast-track to obsolete after 2 hits.
      const _isHallucination = /implausible path|unknown step type|Unexpected token|missing required|file not found|ENOENT/i.test(errMsg || '');
      const _failureCap = _isHallucination ? 2 : 3;
      const backoffSchedule = _isHallucination
        ? [10_000, 60_000]                                  // hallucination — 2 quick retries then obsolete
        : [10_000, 60_000, 300_000];                        // generic — 3 retries
      const _terminalStatus = _isHallucination ? 'obsolete' : 'stalled';

      if (entry.count > _failureCap) {
        _log.warn(`[DRIVER] goal ${goalId} failed ${entry.count}× (${_terminalStatus}) — reason: ${(errMsg || '<empty>').slice(0, 80)}`);
        try {
          if (typeof this.goalStack.setStatus === 'function') {
            this.goalStack.setStatus(goalId, _terminalStatus);
          } else if (typeof this.goalStack.updateGoal === 'function') {
            await this.goalStack.updateGoal(goalId, { status: _terminalStatus });
          }
          // Fire stalled OR obsolete event accordingly.
          const _evtName = _terminalStatus === 'obsolete' ? 'goal:obsolete' : 'goal:stalled';
          this.bus.fire(_evtName, {
            id: goalId,
            description: goal?.description || '(no description)',
            reason: `${entry.count} consecutive failures: ${(errMsg || '<empty>').slice(0, 100)}`,
          }, { source: 'GoalDriver' });
        } catch (e) {
          _log.warn('[DRIVER] failed to mark goal ' + _terminalStatus + ':', e.message);
        }
        this._failureBurst.delete(goalId);
      } else {
        const backoffMs = backoffSchedule[entry.count - 1];
        this._goalPausedUntil.set(goalId, _now + backoffMs);
        // v7.6.5 (raw-settimeout phase 2): tracked per-goalId.
        const _existing3 = this._failurePauseTimers.get(goalId);
        if (_existing3) clearTimeout(_existing3);
        const _t3 = setTimeout(() => {
          this._failurePauseTimers.delete(goalId);
          if (this._running) this._scanAndMaybePursue();
        }, backoffMs + 100);
        this._failurePauseTimers.set(goalId, _t3);
        _log.warn(`[DRIVER] pursuit of ${goalId} failed (${entry.count}/${_failureCap + 1}) — backing off ${Math.round(backoffMs/1000)}s: ${(errMsg || '<empty>').slice(0, 80)}`);
      }
    }
  },

};

module.exports = { failurePolicyMixin };
