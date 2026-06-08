// @ts-checked-v7.4.5
// ============================================================
// GENESIS — GoalDriver.js (v7.4.5 — "Durchhalten")
//
// Phase 10 service that orchestrates which goal gets pursued next.
//
// Replaces the implicit pursue-trigger pattern (DaemonController
// directly calling agentLoop.pursue, IdleMind triggering Improve.run)
// with a single event-driven driver.
//
// Listens to:
//   boot:complete           → load active goals, ask/resume per settings
//   goal:added              → check if newly added goal is pursueable
//   goal:unblocked          → pickup if user-source or sub-plan
//   agent-loop:complete     → look for next pursueable goal
//
// Decides:
//   - which goal next (priority desc, then age asc)
//   - boot-pickup logic for blocked-with-sub-goals (crash-mid-subgoal)
//   - skip if currently pursuing
//
// Calls:
//   agentLoop.pursue(goal)  — new object-based signature
//
// Watchdog: HealthMonitor probes isResponding(); on degradation,
//   ServiceRecovery handles restart via existing mechanism. Fallback:
//   DaemonController.handleStartTask() can still call agentLoop.pursue
//   directly (string-based, backward-compat path).
// ============================================================

'use strict';

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalDriver');

const _DEFAULTS = Object.freeze({
  // How often to scan for pursueable goals (ms)
  scanIntervalMs: 5_000,
  // Max time without pursuit activity before HealthMonitor flags us
  // (HealthMonitor itself decides when to emit health:degradation;
  // we just expose lastActivityAt for it to read)
  inactivityWarnMs: 5 * 60_000,
});


/**
 * Settings keys read by GoalDriver:
 *   agency.autoResumeGoals: 'always' | 'never' | 'ask'  (default 'ask')
 */

class GoalDriver {
  static containerConfig = {
    name: 'goalDriver',
    phase: 10,
    deps: ['bus', 'goalStack', 'goalPersistence', 'eventStore', 'settings'],
    tags: ['agency', 'driver'],
    lateBindings: [
      { prop: 'agentLoop', service: 'agentLoop', optional: true,
        expects: ['pursue', 'stop'],
        impact: 'No goal pursuits possible — driver is idle' },
      { prop: 'resourceRegistry', service: 'resourceRegistry',
        optional: true,
        impact: 'No resource pre-checks (default-allow)' },
    ],
  };

  /**
   * @param {{
   *   bus: *, goalStack: *, goalPersistence: *,
   *   eventStore: *, settings: *, intervals?: *,
   *   config?: { scanIntervalMs?: number, inactivityWarnMs?: number }
   * }} opts
   */
  constructor({ bus, goalStack, goalPersistence, eventStore, settings,
                intervals, config }) {
    this.bus = bus || NullBus;
    this.goalStack = goalStack;
    this.goalPersistence = goalPersistence;
    this.eventStore = eventStore;
    this.settings = settings;
    this._intervals = intervals || null;

    // Late-bound
    /** @type {*} */ this.agentLoop = null;
    /** @type {*} */ this.resourceRegistry = null;

    /** @type {Set<string>} Goals being actively pursued — never two at once */
    this._currentlyPursuing = new Set();

    /** @type {Array<Function>} Bus unsubscribers */
    this._unsubs = [];

    /** @type {boolean} */ this._running = false;
    /** @type {boolean} */ this._bootPickupHandled = false;

    /** @type {number} */ this.lastActivityAt = Date.now();

    this._cfg = { ..._DEFAULTS, ...(config || {}) };

    /** @type {string|null} Pending UI-prompt goalId during 'ask'-flow */
    this._pendingResumePrompt = null;

    // v7.6.5 (raw-settimeout phase 2): track fire-and-forget timers so
    // stop() can cancel pending callbacks before they fire against a
    // torn-down driver. Pre-fix the timers were closure-locals that
    // survived stop() and only no-op'd because they checked this._running
    // — clearing them at shutdown is faster and avoids a tiny window
    // where _running flips back to true (during a fast stop+start) and
    // a stale timer from the previous session triggers an unintended scan.
    /** @type {Map<string, NodeJS.Timeout>} keyed by goalId — shared with FailurePolicy mixin */
    this._failurePauseTimers = new Map();
    /** @type {NodeJS.Timeout|null} */
    this._pursuitSafetyTimer = null;
  }

  // ════════════════════════════════════════════════════════
  // LIFECYCLE
  // ════════════════════════════════════════════════════════

  async asyncLoad() {
    this._running = true;

    this._unsubs.push(
      this.bus.on('boot:complete', () => this._onBootComplete()),
      this.bus.on('goal:created', (data) => this._onGoalAdded(data)),
      this.bus.on('goal:unblocked', (data) => this._onGoalUnblocked(data)),
      this.bus.on('agent-loop:complete', (data) => this._onPursuitComplete(data)),
      // Resource-restore (only meaningful once Baustein C lands a registry,
      // but the listener is harmless without it)
      this.bus.on('resource:available', (data) => this._onResourceAvailable(data)),
      // Migration trigger: respond to user resume prompt
      this.bus.on('ui:resume-decision', (data) => this._onResumeDecision(data)),
      // v7.4.5.fix #20: when LLM budget is reset (auto or manual),
      // clear all pause entries that were set due to rate-limit so
      // goals can be picked up immediately. _failureBurst entries
      // for non-rate-limit failures are preserved (real failures).
      this.bus.on('llm:budget-auto-reset', () => this._onBudgetReset('auto')),
      this.bus.on('llm:budget-manual-reset', () => this._onBudgetReset('manual')),
    );

    // Periodic scan as a safety net (in case an event was missed)
    if (this._intervals) {
      this._intervals.register(
        'goaldriver-scan',
        () => this._scanAndMaybePursue(),
        this._cfg.scanIntervalMs
      );
    }

    _log.info('[DRIVER] active');
  }

  stop() {
    this._running = false;
    if (this._intervals) {
      try { this._intervals.clear('goaldriver-scan'); }
      catch (_e) { /* ok */ }
    }
    if (this._resumePromptTimer) {
      try { clearTimeout(this._resumePromptTimer); }
      catch (_e) { /* ok */ }
      this._resumePromptTimer = null;
    }
    // v7.6.5 (raw-settimeout phase 2): clear pending failure-pause and
    // pursuit-safety timers so their callbacks don't fire after stop().
    for (const t of this._failurePauseTimers.values()) {
      try { clearTimeout(t); } catch (_e) { /* ok */ }
    }
    this._failurePauseTimers.clear();
    if (this._pursuitSafetyTimer) {
      try { clearTimeout(this._pursuitSafetyTimer); }
      catch (_e) { /* ok */ }
      this._pursuitSafetyTimer = null;
    }
    for (const unsub of this._unsubs) {
      try { if (typeof unsub === 'function') unsub(); }
      catch (_e) { /* ok */ }
    }
    this._unsubs.length = 0;
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * External pursuit trigger. Replaces direct agentLoop.pursue() calls.
   * @param {string} goalId
   * @param {object} [options]
   * @returns {Promise<{accepted: boolean, reason?: string}>}
   */
  async requestPursuit(goalId, _options = {}) {
    if (!this._running) {
      return { accepted: false, reason: 'driver-not-running' };
    }
    const goal = this.goalStack.getById?.(goalId)
      || this.goalStack.goals?.find(g => g.id === goalId);
    if (!goal) {
      return { accepted: false, reason: 'goal-not-found' };
    }
    if (this._currentlyPursuing.has(goalId)) {
      return { accepted: false, reason: 'already-pursuing' };
    }
    if (goal.status !== 'active') {
      return { accepted: false, reason: `goal-status-${goal.status}` };
    }

    this._scanAndMaybePursue();
    return { accepted: true };
  }

  /**
   * Status & introspection — for Dashboard and IPC.
   * @returns {{
   *   running: boolean, currentlyPursuing: string[],
   *   lastActivityAt: number, pendingResumePrompt: string|null,
   *   queueDepth: number
   * }}
   */
  getStatus() {
    return {
      running: this._running,
      currentlyPursuing: Array.from(this._currentlyPursuing),
      lastActivityAt: this.lastActivityAt,
      pendingResumePrompt: this._pendingResumePrompt,
      queueDepth: this._listPursueable().length,
    };
  }

  /**
   * For HealthMonitor probe. Returns true if driver is alive
   * and either pursuing or has nothing to do (empty queue).
   * Returns false only if there are pursueable goals but nothing
   * has happened for inactivityWarnMs.
   * @returns {boolean}
   */
  isResponding() {
    if (!this._running) return false;
    const queueDepth = this._listPursueable().length;
    if (queueDepth === 0) return true;          // nothing to do — fine
    if (this._currentlyPursuing.size > 0) return true;  // working
    const idle = Date.now() - this.lastActivityAt;
    return idle < this._cfg.inactivityWarnMs;
  }

  /**
   * For Dashboard — full queue with reasons.
   * @returns {Array<{goalId, priority, source, status, blockReason}>}
   */
  getQueue() {
    const all = this.goalStack.goals || [];
    return all
      .filter(g => g.status === 'active' || g.status === 'blocked')
      .map(g => ({
        goalId: g.id,
        priority: g.priority,
        source: g.source,
        status: g.status,
        blockReason: g.blockReason || null,
      }));
  }

  // ════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ════════════════════════════════════════════════════════

  async _onBootComplete() {
    if (!this._running) return;
    // GoalPersistence.resume() was already called in its own asyncLoad
    // (Phase 10). We just inspect the loaded goals here.
    try {
      this._handleBootPickup();
    } finally {
      // v7.4.5.fix: signal scan-loop that boot-pickup ran (whether it
      // found candidates or not). Without this flag, _scanAndMaybePursue
      // would race ahead and pick up mid-pursuit goals before the
      // ask-mode resume-prompt could be fired.
      this._bootPickupHandled = true;
      // Trigger one scan now — covers cases where boot-pickup decided
      // 'always' or had no candidates and the next normal trigger is
      // still ~5s away.
      this._scanAndMaybePursue();
    }
  }

  _onGoalAdded(_data) {
    if (!this._running) return;
    this._scanAndMaybePursue();
  }

  _onGoalUnblocked(data) {
    if (!this._running) return;
    // Strict guard against race: never re-pursue a goal we're currently on.
    if (this._currentlyPursuing.has(data?.id)) return;
    this._scanAndMaybePursue();
  }

  _onPursuitComplete(data) {
    if (!this._running) return;
    // v7.4.5.fix #19: apply failure-pause SYNCHRONOUSLY here, before
    // re-scanning. Otherwise the scan would pick the same goal
    // again because the resolve-side pause in _beginPursuit hasn't
    // run yet — pursue() fires agent-loop:complete BEFORE its
    // `return { success: false }` resolves. Race fixed by moving
    // the decision into the event path. Resolve-side
    // _applyFailurePause is still called as fallback (idempotent).
    const goalId = data?.goalId;
    if (goalId && data?.success === false) {
      // Extract error from summary (set by AgentLoop._emitFailure
      // as "Failed: <e>") or from data.error / data.detail / bare summary.
      // v7.7.9 (post-burnin): verification-fail path emits summary WITHOUT
      // "Failed: " prefix (see AgentLoopPursuit._finalSummary). Treat any
      // non-empty summary as the error if no explicit error field exists,
      // otherwise we end up with empty errMsg → '<empty>' in the log.
      let errMsg = '';
      if (typeof data.summary === 'string' && data.summary.startsWith('Failed: ')) {
        errMsg = data.summary.slice('Failed: '.length);
      } else if (typeof data.error === 'string' && data.error) {
        errMsg = data.error;
      } else if (typeof data.detail === 'string' && data.detail) {
        errMsg = data.detail;
      } else if (typeof data.summary === 'string' && data.summary.trim()) {
        // Bare summary fallback — verification-fail path lands here.
        errMsg = data.summary;
      }
      const goal = this.goalStack.goals?.find(g => g.id === goalId);
      // Fire-and-forget — _applyFailurePause awaits internally for
      // setStatus/updateGoal. We don't await here because event
      // handlers should be sync; pause map is set synchronously
      // anyway, only the stalled-marking is async.
      this._applyFailurePause(goalId, errMsg, goal).catch(e =>
        _log.debug('[DRIVER] _applyFailurePause from event handler failed:', e.message));
    } else if (goalId && data?.success === true) {
      if (this._failureBurst) this._failureBurst.delete(goalId);
      if (this._goalPausedUntil) this._goalPausedUntil.delete(goalId);
    }
    if (goalId) this._currentlyPursuing.delete(goalId);
    this.lastActivityAt = Date.now();
    // result.blocked === true means agent loop voluntarily stopped
    // (e.g. obstacle → sub-goal spawned). The newly-active sub-goal
    // will be picked up by the next scan.
    this._scanAndMaybePursue();
  }


  _onResourceAvailable(data) {
    if (!this._running) return;
    // v7.4.5 Baustein C: actively unblock goals waiting on this token.
    // GoalStack.unblockOnResource flips matching blocked goals back to
    // 'active' (and emits goal:resumed-from-resource-block per goal).
    const token = data?.token;
    if (token && this.goalStack && this.goalStack.unblockOnResource) {
      try { this.goalStack.unblockOnResource(token); }
      catch (err) { _log.debug('[DRIVER] unblockOnResource failed:', err.message); }
    }
    this._scanAndMaybePursue();
  }

  /**
   * v7.4.5.fix #20: clear rate-limit pauses on budget reset.
   * @param {'auto'|'manual'} kind
   */
  _onBudgetReset(kind) {
    if (!this._running) return;
    if (!this._goalPausedUntil || this._goalPausedUntil.size === 0) return;
    // Iterate goals: any pause that exists because of rate-limit
    // (kind: rate-limit isn't tracked separately; we use a heuristic:
    //  if pause was for ~60s, it was rate-limit; otherwise it was
    //  generic backoff and shouldn't be cleared by budget reset).
    // Simpler: clear all pauses, since after a budget reset there's
    // no harm in re-attempting any paused goal — if it still fails,
    // the failureBurst counter (NOT cleared here) will progress.
    const cleared = [];
    for (const goalId of this._goalPausedUntil.keys()) {
      cleared.push(goalId);
    }
    this._goalPausedUntil.clear();
    if (cleared.length > 0) {
      _log.info(`[DRIVER] budget ${kind}-reset — clearing ${cleared.length} paused goal(s) for retry`);
      this._scanAndMaybePursue();
    }
  }

  /**
   * UI sends a resume decision back via this event after the boot prompt.
   * @param {{goalId: string, decision: 'continue'|'discard'|'pause',
   *           rememberAs?: 'always'|'never'}} data
   */
  async _onResumeDecision(data) {
    if (!this._running || !data?.goalId) return;
    if (data.goalId !== this._pendingResumePrompt) return;

    this._pendingResumePrompt = null;
    if (this._resumePromptTimer) {
      clearTimeout(this._resumePromptTimer);
      this._resumePromptTimer = null;
    }

    if (data.rememberAs) {
      try {
        await this.settings.set('agency.autoResumeGoals', data.rememberAs);
      } catch (err) {
        _log.warn('[DRIVER] failed to persist autoResumeGoals:', err.message);
      }
    }

    if (data.decision === 'discard') {
      await this._discardGoalAndSubgoals(data.goalId);
      this._scanAndMaybePursue();
      return;
    }
    if (data.decision === 'pause') {
      // Goal stays active but driver does not pick it up automatically
      // until next user request. We do nothing here.
      return;
    }
    // 'continue' → just trigger a scan; the goal is already active.
    this._scanAndMaybePursue();
  }



  // ════════════════════════════════════════════════════════
  // CORE LOOP — select-and-pursue
  // ════════════════════════════════════════════════════════

  _scanAndMaybePursue() {
    if (!this._running) return;
    if (!this.agentLoop) return;
    // v7.4.5.fix: don't race the boot-pickup logic. _scanAndMaybePursue
    // is triggered by goal:created, goal:unblocked, intervals etc.,
    // some of which fire before boot:complete (e.g. GoalPersistence
    // emitting goal:created for restored goals during phase 4 load).
    // Without this gate, a 'mid-pursuit' user-goal would be picked up
    // immediately, bypassing the ask-mode resume-prompt entirely.
    if (!this._bootPickupHandled) return;
    if (this._currentlyPursuing.size > 0) return;
    // Don't auto-pursue while waiting on a UI resume decision
    if (this._pendingResumePrompt) return;

    const next = this._selectNext();
    if (!next) return;

    // Pre-checks (resource, hash-validation, pre-existence) come in
    // Baustein C. For Baustein A we just call pursue.
    this._beginPursuit(next);
  }

  /**
   * Returns the goalId that should be pursued next, or null.
   * @returns {string|null}
   */
  _selectNext() {
    const candidates = this._listPursueable();
    if (candidates.length === 0) return null;

    // Sort: priority desc (high > medium > low), then age asc.
    const priorityRank = { high: 3, medium: 2, low: 1 };
    candidates.sort((a, b) => {
      const pa = priorityRank[a.priority] || 0;
      const pb = priorityRank[b.priority] || 0;
      if (pb !== pa) return pb - pa;
      const ta = new Date(a.created || 0).getTime();
      const tb = new Date(b.created || 0).getTime();
      return ta - tb;
    });

    return candidates[0].id;
  }

  /**
   * @returns {Array<{id, priority, source, created, status}>}
   */
  _listPursueable() {
    const all = this.goalStack.goals || [];
    const _now = Date.now();
    // v7.4.5.fix: clean up expired pause entries lazily on each scan
    if (this._goalPausedUntil) {
      for (const [gid, until] of this._goalPausedUntil) {
        if (until <= _now) this._goalPausedUntil.delete(gid);
      }
    }
    return all.filter(g =>
      g.status === 'active'
      && !this._currentlyPursuing.has(g.id)
      // v7.4.5.fix: skip goals that are temporarily paused due to
      // recent failures (rate-limit, planner errors). The pause
      // expires on its own; another scan will pick them up.
      && !(this._goalPausedUntil && this._goalPausedUntil.has(g.id))
      // Sub-goals (source='subplan') are pursued aggressively
      // because their completion unblocks a user-goal. They never
      // hit the user-source filter that gates auto-resume — they
      // are already 'active' in the stack via spawnSubgoal().
      // Boot-Pickup-Sonderlogik already surfaced them.
    );
  }

  async _beginPursuit(goalId) {
    const goal = this.goalStack.goals?.find(g => g.id === goalId);
    if (!goal) {
      _log.warn(`[DRIVER] goal ${goalId} disappeared between select and pursue`);
      return;
    }

    this._currentlyPursuing.add(goalId);
    this.lastActivityAt = Date.now();

    _log.info(`[DRIVER] picking up goal ${goalId} — "${(goal.description || '').slice(0, 80)}" (priority=${goal.priority}, source=${goal.source})`);

    this.bus.fire('goal:driver-pickup', {
      goalId, priority: goal.priority, source: goal.source,
    }, { source: 'GoalDriver' });

    // v7.4.5.fix #21: use keepLock flag + finally block. Previously,
    // the success-path forgot to delete _currentlyPursuing (relied
    // on the event), AND the "weird result" case (result undefined
    // or no success field) silently fell through without cleanup.
    // Now: ALWAYS clean up unless we explicitly bounced.
    let keepLock = false;
    let needsScan = false;
    let result;
    try {
      result = await this.agentLoop.pursue(goal, () => { /* progress drains via bus */ });

      if (result && result.success === false) {
        const errMsg = (result.error || '').slice(0, 120);
        if (errMsg.startsWith('Agent loop already running')) {
          _log.debug(`[DRIVER] pursuit of ${goalId} bounced (already running) — keeping lock, scheduling safety scan`);
          keepLock = true;
          // v7.6.5 (raw-settimeout phase 2): capture timer on this so stop() can clear it.
          if (this._pursuitSafetyTimer) clearTimeout(this._pursuitSafetyTimer);
          this._pursuitSafetyTimer = setTimeout(() => {
            this._pursuitSafetyTimer = null;
            if (this._running && this._currentlyPursuing.has(goalId)
                && this.agentLoop && !this.agentLoop.running) {
              _log.warn(`[DRIVER] safety scan: pursue not running but ${goalId} still locked — releasing`);
              this._currentlyPursuing.delete(goalId);
              this._scanAndMaybePursue();
            }
          }, 60_000);
          return;
        }
        await this._applyFailurePause(goalId, errMsg, goal);
        _log.debug(`[DRIVER] pursuit of ${goalId} returned failure: ${errMsg}`);
        needsScan = true;
      } else if (result && result.success === true) {
        // v7.4.5.fix #22 (corrected): On successful pursuit, AgentLoop
        // does NOT mark the goal as completed (architectural gap —
        // AgentLoop uses its own plan.steps, not goal.steps; the
        // currentStep mechanism is only used by the legacy
        // GoalStack.executeNextStep path). We mark it here so the
        // periodic 5s scan doesn't keep re-picking a goal that was
        // already successfully accomplished. completeGoal() exists
        // on GoalStack as of v7.4.5.fix #22.
        if (typeof this.goalStack.completeGoal === 'function') {
          // v7.9.21: pass the pursuit summary as the outcome so a completed
          // goal records what it accomplished (carried on the goal and the
          // goal:completed event), not a bare status flip. `result` is the
          // pursue() return; verifyGoal sets `summary` on every success branch.
          this.goalStack.completeGoal(goalId, result.summary || null);
        } else if (typeof this.goalStack.setStatus === 'function') {
          // Fallback for older GoalStack versions
          this.goalStack.setStatus(goalId, 'completed');
        }
        if (this._failureBurst) this._failureBurst.delete(goalId);
        if (this._goalPausedUntil) this._goalPausedUntil.delete(goalId);
        _log.info(`[DRIVER] goal ${goalId} marked as completed after successful pursuit`);
      } else {
        // result undefined OR has neither success:true nor success:false.
        // This is the "blocked" case: _executeLoop returns
        // { ok: false, blocked: true, ... } when a step is blocked
        // on resources or a sub-goal was spawned. Treat as transient
        // (don't fail/backoff hard) — the resource:available or
        // goal:unblocked event will re-trigger the goal.
        if (result && result.blocked) {
          _log.debug(`[DRIVER] pursuit of ${goalId} blocked — waiting for unblock event`);
          // No backoff, no scan — the unblock-event will trigger pickup
        } else {
          _log.warn(`[DRIVER] pursuit of ${goalId} returned without success/failure marker — treating as failure`);
          await this._applyFailurePause(goalId, '', goal);
          needsScan = true;
        }
      }
    } catch (err) {
      _log.warn(`[DRIVER] pursuit of ${goalId} threw:`, err.message);
      needsScan = true;
    } finally {
      if (!keepLock) {
        this._currentlyPursuing.delete(goalId);
        if (needsScan) this._scanAndMaybePursue();
      }
    }
  }
}

// v7.6.2 Track A continuation: failure-pause policy mixin.
// _applyFailurePause (~118 LOC: rate-limit, user-rejection, exponential
// backoff, stall-threshold) extracted to GoalDriverFailurePolicy.js as
// a prototype mixin. Methods read/write shared state via `this` (the
// GoalDriver instance) — see GoalDriverFailurePolicy.js header for the
// state-coupling note and ARCHITECTURE.md § 5.8 for the canonical
// mixin convention.
const { failurePolicyMixin } = require('./GoalDriverFailurePolicy');
Object.assign(GoalDriver.prototype, failurePolicyMixin);

// v7.6.2 Track A continuation: boot-pickup + discard-cascade mixin.
// _handleBootPickup (~111 LOC: 24h-window resume detection, ask/always/
// never modes, ui:resume-prompt with auto-decline timer) and
// _discardGoalAndSubgoals (~25 LOC: parent + blocking-subgoals cascade)
// extracted to GoalDriverBootRecovery.js as a prototype mixin. Plus the
// RESUME_PROMPT_TIMEOUT_MS constant moved with them. Mixin reads/writes
// this._pendingResumePrompt and this._resumePromptTimer which the main
// class also touches in stop() and _onResumeDecision().
const { bootRecoveryMixin } = require('./GoalDriverBootRecovery');
Object.assign(GoalDriver.prototype, bootRecoveryMixin);

module.exports = { GoalDriver };
