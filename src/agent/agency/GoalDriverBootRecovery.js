// ============================================================
// GENESIS — agency/GoalDriverBootRecovery.js (v7.6.2)
//
// Boot-pickup + discard-cascade mixin extracted from GoalDriver.js
// in the v7.6.2 Track A continuation. Holds the recovery logic that
// runs once on driver-boot ("we restarted while a user-goal was
// in-flight — what now?") plus the cascade-discard for parent +
// blocking-subgoals when the user declines a resume prompt:
//
//   _handleBootPickup()
//   _discardGoalAndSubgoals(goalId)
//
// Why split: GoalDriver.js was 841 LOC (>700 soft-guard). These two
// methods plus the supporting RESUME_PROMPT_TIMEOUT_MS constant are
// a coherent post-restart path that doesn't share state with the
// failure-pause / pursuit / scan logic — only with the resume-prompt
// state held on the driver instance.
//
// Coupling note: methods read/write
//   this.goalStack.{goals, updateGoal}
//   this.settings.get('agency.autoResumeGoals')
//   this.bus.fire('goal:resumed-auto' | 'ui:resume-prompt'
//                 | 'ui:resume-decision' | 'goal:discarded')
//   this._pendingResumePrompt   string|null (also set by stop +
//                                            _onResumeDecision in main)
//   this._resumePromptTimer     Timeout|null (also cleared by stop +
//                                             _onResumeDecision)
//   this._scanAndMaybePursue()  staying on main class
//
// _handleBootPickup is invoked once from _onBootComplete in the main
// class. _discardGoalAndSubgoals is invoked from _onResumeDecision
// when the user picks 'discard' in the resume prompt UI. Both are
// reached via prototype-lookup once the mixin is applied.
//
// Mixed onto GoalDriver.prototype at module-load via Object.assign
// — see GoalDriver.js bottom + the canonical Mixin Convention in
// ARCHITECTURE.md § 5.8.
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalDriver');

// Stuck-prompt safety: if the UI doesn't render or answer the
// resume-prompt within this window, the driver auto-declines so
// freshly-created goals can still be picked up. Without this the
// dashboard hangs at "Idle — no active goal" forever.
const RESUME_PROMPT_TIMEOUT_MS = 60_000;

const bootRecoveryMixin = {

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
  },

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
  },


};

module.exports = { bootRecoveryMixin };
