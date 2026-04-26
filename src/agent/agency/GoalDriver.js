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

// Stuck-prompt safety: if the UI doesn't render or answer the
// resume-prompt within this window, the driver auto-declines so
// freshly-created goals can still be picked up. Without this the
// dashboard hangs at "Idle — no active goal" forever.
const RESUME_PROMPT_TIMEOUT_MS = 60_000;

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
      this.bus.on('permission:granted', (data) => this._onPermissionGranted(data)),
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
      // as "Failed: <e>") or from data.error / data.detail.
      // Empty error → handled by generic-backoff branch.
      let errMsg = '';
      if (typeof data.summary === 'string' && data.summary.startsWith('Failed: ')) {
        errMsg = data.summary.slice('Failed: '.length);
      } else if (typeof data.error === 'string') {
        errMsg = data.error;
      } else if (typeof data.detail === 'string') {
        errMsg = data.detail;
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
   * and skip duplicate calls within 50ms of each other.
   *
   * @param {string} goalId
   * @param {string} errMsg  — may be empty (generic-backoff applies)
   * @param {object} [goal]  — goalStack entry, optional
   */
  async _applyFailurePause(goalId, errMsg, goal) {
    if (!goalId) return;
    const _now = Date.now();
    this._failureBurst = this._failureBurst || new Map();
    this._goalPausedUntil = this._goalPausedUntil || new Map();
    this._lastPausedAt = this._lastPausedAt || new Map();

    // Idempotency guard: if we paused this goal in the last 50ms,
    // a second call (event-side + resolve-side for the same
    // failure) would double-count. Skip the second one.
    const lastPaused = this._lastPausedAt.get(goalId) || 0;
    if (_now - lastPaused < 50) return;
    this._lastPausedAt.set(goalId, _now);

    const _isRateLimit = /rate limit|rate.limited|budget exhausted/i.test(errMsg || '');
    const _isUserRejection = (errMsg || '').startsWith('User rejected');

    if (!goal) {
      goal = this.goalStack.goals?.find(g => g.id === goalId);
    }

    if (_isRateLimit) {
      const pauseMs = 60_000;
      this._goalPausedUntil.set(goalId, _now + pauseMs);
      setTimeout(() => {
        if (this._running) this._scanAndMaybePursue();
      }, pauseMs + 100);
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
      setTimeout(() => {
        if (this._running) this._scanAndMaybePursue();
      }, pauseMs + 100);
      if (entry.count >= 3) {
        _log.warn(`[DRIVER] goal ${goalId} rejected ${entry.count}× — marking as stalled`);
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
      const backoffSchedule = [5_000, 30_000, 120_000, 600_000, 1_800_000];
      if (entry.count > backoffSchedule.length) {
        _log.warn(`[DRIVER] goal ${goalId} failed ${entry.count}× — marking as stalled`);
        try {
          if (typeof this.goalStack.setStatus === 'function') {
            this.goalStack.setStatus(goalId, 'stalled');
          } else if (typeof this.goalStack.updateGoal === 'function') {
            await this.goalStack.updateGoal(goalId, { status: 'stalled' });
          }
          this.bus.fire('goal:stalled', {
            id: goalId,
            description: goal?.description,
            reason: `${entry.count} consecutive failures: ${(errMsg || '<empty>').slice(0, 100)}`,
          }, { source: 'GoalDriver' });
        } catch (e) {
          _log.warn('[DRIVER] failed to mark goal stalled:', e.message);
        }
        this._failureBurst.delete(goalId);
      } else {
        const backoffMs = backoffSchedule[entry.count - 1];
        this._goalPausedUntil.set(goalId, _now + backoffMs);
        setTimeout(() => {
          if (this._running) this._scanAndMaybePursue();
        }, backoffMs + 100);
        _log.warn(`[DRIVER] pursuit of ${goalId} failed (${entry.count}/${backoffSchedule.length+1}) — backing off ${Math.round(backoffMs/1000)}s: ${(errMsg || '<empty>').slice(0, 80)}`);
      }
    }
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

  _onPermissionGranted(_data) {
    if (!this._running) return;
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
  // BOOT PICKUP — handles regular resume + crash-mid-subgoal case
  // ════════════════════════════════════════════════════════

  _handleBootPickup() {
    const all = this.goalStack.goals || [];

    // (A) Regular candidates: user-goals that should be resumed.
    // v7.4.5.1: A user-goal counts as a resume candidate when it is
    // 'active' AND either:
    //   - has begun execution (currentStep > 0), OR
    //   - was created in the last 24h but hasn't started yet (so a
    //     fresh goal that crashed before its first step still gets
    //     picked up — exactly the case we just hit on Garrus's box).
    // The 24h cutoff prevents zombiehaft hochzuholen alte Goals
    // die seit Wochen im Stack vergessen lagen.
    const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;  // 24h
    const now = Date.now();
    const isRecent = (g) => {
      const created = new Date(g.created || 0).getTime();
      return Number.isFinite(created) && (now - created) < RESUME_WINDOW_MS;
    };
    const regular = all.filter(g =>
      g.source === 'user'
      && g.status === 'active'
      && ((g.currentStep || 0) > 0 || isRecent(g))
    );

    // (B) Blocked-with-subgoals: crash mid-sub-goal scenario
    const blockedWithSubs = all.filter(g =>
      g.source === 'user'
      && g.status === 'blocked'
      && Array.isArray(g.blockedBy)
      && g.blockedBy.length > 0
    );

    if (regular.length === 0 && blockedWithSubs.length === 0) {
      _log.info('[DRIVER] boot-pickup: no resume candidates found');
      return;
    }

    const mode = this.settings.get('agency.autoResumeGoals') || 'ask';

    // For each blocked user-goal, surface its sub-goals as
    // implicit resume candidates (they will be picked first by
    // priority desc).
    // We do NOT prompt for sub-goals separately — the parent's
    // accept covers them.
    for (const parent of blockedWithSubs) {
      // Sanity: nothing to do here at startup; the sub-goals are
      // already 'active' in the stack. We just need to make sure the
      // parent's resume decision implicitly triggers their pursuit.
      // (Sub-goal source !== 'user', so they won't be picked by
      // _selectNext otherwise, but priority='high' will surface
      // them as soon as we scan.)
    }

    // Pick the first user-goal to prompt for
    const candidates = [...regular, ...blockedWithSubs];
    if (candidates.length === 0) {
      _log.info('[DRIVER] boot-pickup: no candidates after filter');
      return;
    }

    _log.info(`[DRIVER] boot-pickup: ${candidates.length} candidate(s), mode='${mode}'`);

    const first = candidates[0];

    if (mode === 'never') {
      _log.info(`[DRIVER] autoResumeGoals='never' — ${candidates.length} goal(s) not resumed`);
      return;
    }
    if (mode === 'always') {
      _log.info(`[DRIVER] auto-resuming ${candidates.length} goal(s)`);
      this.bus.fire('goal:resumed-auto', {
        goalIds: candidates.map(g => g.id),
        mode,
      }, { source: 'GoalDriver' });
      this._scanAndMaybePursue();
      return;
    }

    // 'ask' — emit a UI prompt for the first user-goal.
    // (Handling multiple in sequence is left to the UI's choice.)
    this._pendingResumePrompt = first.id;
    let reason;
    if (first.status === 'blocked') reason = 'blocked-with-subgoals';
    else if ((first.currentStep || 0) > 0) reason = 'mid-pursuit';
    else reason = 'fresh-not-started';
    _log.info(`[DRIVER] firing ui:resume-prompt for ${first.id} (reason=${reason}) — auto-decline in ${RESUME_PROMPT_TIMEOUT_MS / 1000}s if no UI answer`);
    this.bus.fire('ui:resume-prompt', {
      goalId: first.id,
      title: first.description?.slice(0, 100),
      currentStep: first.currentStep || 0,
      totalSteps: first.steps?.length || 0,
      lastUpdated: first.updated,
      reason,
    }, { source: 'GoalDriver' });

    // Stuck-prompt safety: if no UI answers within RESUME_PROMPT_TIMEOUT_MS,
    // auto-decline so the driver can pursue freshly-created goals after the
    // user took action via /add etc. This prevents the dashboard's
    // "Idle — no active goal" deadlock when the UI doesn't render the prompt.
    if (this._resumePromptTimer) clearTimeout(this._resumePromptTimer);
    this._resumePromptTimer = setTimeout(() => {
      if (this._pendingResumePrompt === first.id) {
        _log.warn(`[DRIVER] resume-prompt for ${first.id} timed out — auto-declining`);
        this.bus.fire('ui:resume-decision', {
          goalId: first.id,
          decision: 'pause',
          rememberAs: undefined,
        }, { source: 'GoalDriver' });
      }
    }, RESUME_PROMPT_TIMEOUT_MS);
  }

  async _discardGoalAndSubgoals(goalId) {
    const goal = this.goalStack.goals?.find(g => g.id === goalId);
    if (!goal) return;

    // Cascade: parent + all subgoals it was blocked by
    const toDiscard = [goalId];
    if (Array.isArray(goal.blockedBy)) {
      for (const subId of goal.blockedBy) {
        toDiscard.push(subId);
      }
    }

    for (const id of toDiscard) {
      try {
        await this.goalStack.updateGoal?.(id, {
          status: 'abandoned',
          updated: new Date().toISOString(),
        });
      } catch (err) {
        _log.warn(`[DRIVER] failed to discard ${id}:`, err.message);
      }
    }
    this.bus.fire('goal:discarded', { ids: toDiscard, via: 'user-resume-prompt' },
                  { source: 'GoalDriver' });
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
          setTimeout(() => {
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
          this.goalStack.completeGoal(goalId);
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

module.exports = { GoalDriver };
