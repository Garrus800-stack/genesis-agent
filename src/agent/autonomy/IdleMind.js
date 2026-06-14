// @ts-checked-v5.8
// ============================================================
// GENESIS — IdleMind.js
// Autonomous thinking when the user is not interacting.
// Genesis doesn't just sit there waiting — it thinks.
//
// Activities:
// - REFLECT: Review recent conversations for insights
// - PLAN: Create improvement plans for itself
// - EXPLORE: Read own code and find optimization opportunities
// - IDEATE: Generate ideas for new skills or features
// - JOURNAL: Write notes about what it learned
// - TIDY: Organize memory, prune dead knowledge
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { INTERVALS } = require('../core/Constants');
const { safeJsonParse, atomicWriteFileSync } = require('../core/utils');
const { createLogger } = require('../core/Logger');
const { applySubscriptionHelper } = require('../core/subscription-helper');
const _log = createLogger('IdleMind');

// v7.3.1: Activity-Registry. Replaces the 14 prototype-delegated
// method definitions from IdleMindActivities.js with discrete modules
// exposing { name, weight, cooldown, shouldTrigger(ctx), run(idleMind) }.
// The legacy IdleMindActivities.js mixin is still attached at the
// bottom of this file for backward compatibility — registry-based
// dispatch takes precedence.
const { buildPickContext } = require('./activities/PickContext');
const ACTIVITY_MODULES = [
  require('./activities/Reflect'),
  require('./activities/Plan'),
  require('./activities/Explore'),
  require('./activities/Ideate'),
  require('./activities/Tidy'),
  require('./activities/Journal'),
  require('./activities/MCPExplore'),
  require('./activities/Dream'),
  require('./activities/Consolidate'),
  require('./activities/Calibrate'),
  require('./activities/Improve'),
  require('./activities/Research'),
  require('./activities/SelfDefine'),
  require('./activities/Study'),
  require('./activities/ReadSource'), // v7.3.1
  require('./activities/SkillRehearsal'), // v7.9.4
  require('./activities/Inhabit'),        // v7.9.5
  require('./activities/ProposeImprovements'), // v7.9.20 (D)
];
const ACTIVITY_BY_NAME = Object.fromEntries(ACTIVITY_MODULES.map(a => [a.name, a]));

class IdleMind {
  constructor({ bus,  model, prompts, selfModel, memory, knowledgeGraph, eventStore, storageDir, goalStack, intervals, storage }) {
    this.bus = bus || NullBus;
    /** @type {Function[]} */ this._unsubs = [];
    this.model = model;
    this.prompts = prompts;
    this.selfModel = selfModel;
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.eventStore = eventStore;
    this.storageDir = storageDir;
    this.storage = storage || null;
    this.goalStack = goalStack; // HTN goal planner
    this.mcpClient = null;      // Set later by AgentCore (avoids circular dep)
    this._intervals = intervals || null;

    // v3.5.0: Organism modules — late-bound by AgentCore._wireAndStart()
    this.emotionalState = null;
    this.needsSystem = null;
    this._homeostasis = null;   // Used to check isAutonomyAllowed()
    // v4.12.8: Memory consolidation during idle
    this.unifiedMemory = null;
    // v5.0.0: Genome traits influence activity selection; Metabolism gates energy
    this._genome = null;
    this._metabolism = null;
    // v6.0.8: Directed curiosity — explore weak areas
    this._cognitiveSelfModel = null;
    // v6.0.0: DreamCycle — idle dreaming integration (late-bound)
    /** @type {*} */ this.dreamCycle = null;
    this._currentWeakness = null; // { taskType, successRate, sampleSize }

    // v7.1.5: EmotionalFrontier — emotion-aware activity targeting
    this._emotionalFrontier = null;
    this._recentImprintIds = new Set(); // Cooldown: halve score for recently-used imprints

    // v7.1.6: Frontier writers (late-bound)
    this._unfinishedWorkFrontier = null;
    this._suspicionFrontier = null;
    this._lessonFrontier = null;
    this._webFetcher = null;
    this._trustLevelSystem = null;

    // v7.2.0: LessonsStore — for self-define activity
    this.lessonsStore = null;

    // v7.7.9: InnerSpeech — first-person thought channel (late-bound, optional)
    this.innerSpeech = null;

    // v7.9.4: Können Phase 3 — late-bound via DI for SkillRehearsal activity.
    this.skillManager = null; this.effectivenessTracker = null;

    // v7.9.5: BodySchema — read-only capability snapshot for Inhabit activity.
    this.bodySchema = null;

    // v7.1.6: Research state
    this._pendingResearch = null;
    this._networkCheckCache = undefined;
    this._networkCheckTs = 0;

    // v7.0.3 — C4: DreamCycle active push — queue actionable insights
    this._pendingInsights = [];

    this.running = false;
    this.intervalHandle = null;
    this.lastUserActivity = Date.now();
    this.idleThreshold = INTERVALS.IDLE_THRESHOLD;
    this.thinkInterval = INTERVALS.IDLE_THINK_CYCLE;
    this.thoughtCount = 0;
    // v7.7.9 Phase 3b: insight-only counter for novelty decay.
    this.insightThoughtCount = 0;

    // Thought journal
    this.journalPath = path.join(storageDir, 'journal.jsonl');
    this.planPath = path.join(storageDir, 'plans.json');
    this.plans = this._loadPlans();
    // v7.9.20 (D): self-improvement proposals (bounded), raised by the
    // ProposeImprovements activity, decided via the dashboard.
    this.proposalPath = path.join(storageDir, 'proposals.json');
    this.proposals = this._loadProposals();

    // v7.5.7-fix Phase 2: journal rotation. Default 10MB, keep 3 rotations.
    // Read from settings if available (settings is late-bound — fallback ok).
    this._journalMaxFileSizeMB = 10;
    this._journalMaxRotations = 3;
    this._journalRotateCheckCounter = 0;

    // Track what activities have been done recently
    this.activityLog = [];
    // v7.9.1: _activityCounts is lazy-initialised by IdleMindActivityStats mixin
    // v7.9.4: restore activity-stats from disk so the picker's
    // repetition-penalty (in _pickActivity) and the dashboard counts
    // reflect history across restarts. No-op when storage isn't wired
    // (tests, partial boots).
    if (typeof this._loadActivityStats === 'function') {
      try { this._loadActivityStats(); } catch (e) { _log.debug('[IDLE-MIND] activity-stats restore skipped:', e.message); }
    }
    this._lastInsightTs = 0; // v5.7.0: Rate-limit proactive insights
    this._thinking = false;  // FIX v7.4.1: Re-entrancy guard for _think()
    // v7.9.12: rest-mode flag — true when all models marked unavailable.
    // Set/cleared via _enterRestMode/_exitRestMode (idempotent transitions).
    this._inRestMode = false;
    // v7.9.4: goal-activity balance counter — see _think() goal-step path
    this._goalStepsSincePick = 0;

    // Listen for user activity (multiple sources for reliability)
    this._sub('agent:status', () => { this.lastUserActivity = Date.now(); }, { source: 'IdleMind' });
    this._sub('user:message', () => { this.lastUserActivity = Date.now(); }, { source: 'IdleMind' });
    this._sub('store:CHAT_MESSAGE', () => { this.lastUserActivity = Date.now(); }, { source: 'IdleMind' });

    // v7.0.3 — C4: Queue actionable insights from DreamCycle for next idle tick
    this._sub('insight:actionable', (data) => {
      this._pendingInsights.push({ ...data, receivedAt: Date.now() });
      // Cap queue at 10 to prevent unbounded growth
      if (this._pendingInsights.length > 10) this._pendingInsights.shift();
    }, { source: 'IdleMind' });

    // v7.9.12: when a model recovers, leave rest-mode immediately instead of
    // waiting for the next think interval. _exitRestMode is idempotent, so a
    // cleared event for a model we weren't resting on is a harmless no-op.
    this._sub('model:unavailable-cleared', (data) => {
      this._exitRestMode(data?.modelName);
    }, { source: 'IdleMind' });
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._subscribeGoalTerminal();   // v7.9.22 Item 4: link plans to terminal goals
    this._reconcilePreLinkPlans();   // v7.9.22 R2: heal a plan whose link predates Item 4

    const tickFn = () => {
      const idleTime = Date.now() - this.lastUserActivity;
      if (idleTime >= this.idleThreshold) {
        this._think();
      }
    };

    if (this._intervals) {
      this._intervals.register('idlemind-think', tickFn, this.thinkInterval);
    } else {
      this.intervalHandle = setInterval(tickFn, this.thinkInterval);
    }

    // v7.7.9 (post-burnin P7): listen to PSE's plan-failure-reflection so
    // the activity-picker can cool down goal-generation when a similar
    // pursuit just failed. The map tracks { tokenSet → expiresAt } and
    // is consulted by activities/Plan.js before addGoal.
    this._recentlyFailedGoalTokens = this._recentlyFailedGoalTokens || [];
    if (this.bus && typeof this.bus.on === 'function') {
      const unsubPSE = this.bus.on('agent:self-message', (data) => {
        try {
          if (!data || data.kind !== 'plan-failure-reflection') return;
          const desc = data.sourceRef?.goalDescription || data.payload?.goalDescription || '';
          if (!desc) return;
          const tokens = desc.toLowerCase()
            .replace(/[^a-z0-9äöüß]+/g, ' ')
            .split(/\s+/)
            .filter(t => t.length >= 4);
          this._recentlyFailedGoalTokens.push({
            tokens: new Set(tokens),
            expiresAt: Date.now() + 60 * 60 * 1000, // 1h cooldown
          });
          // prune expired
          const now = Date.now();
          this._recentlyFailedGoalTokens = this._recentlyFailedGoalTokens
            .filter(e => e.expiresAt > now)
            .slice(-20);
        } catch (_e) { /* best-effort */ }
      }, { source: 'IdleMind' });
      this._unsubs.push(unsubPSE);
    }

    _log.info('[IDLE-MIND] Active — autonomous thinking enabled');
  }

  /** @private Subscribe to bus event with auto-cleanup in stop() — see subscription-helper.js */

  stop() {
    this._unsubAll();
    this.running = false;
    if (this._intervals) {
      this._intervals.clear('idlemind-think');
    } else if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // FIX v5.5.0 (H-1): Sync persist on shutdown — writeJSONDebounced timer
    // won't fire after process exits. Same class as D-1/C-1.
    this._savePlansSync();
  }

  /** Notify that the user is active (resets idle timer) */
  userActive() {
    this.lastUserActivity = Date.now();
  }

  /**
   * v7.9.12: Enter rest-mode — all models marked unavailable. Idempotent:
   * the InnerSpeech note and the entered-event fire only on the transition,
   * not on every skipped tick. The rest-mode flag is read by _think() to
   * short-circuit before any LLM-backed activity is picked.
   * @private
   */
  _enterRestMode() {
    if (this._inRestMode) return;
    this._inRestMode = true;
    const modelCount = Array.isArray(this.model?.availableModels)
      ? this.model.availableModels.length
      : 0;
    try {
      this.bus.fire('model:rest-mode-entered', { modelCount }, { source: 'IdleMind' });
    } catch (_e) { /* best-effort */ }
    // Private InnerSpeech note — kind 'rest-mode' is blocklisted in PSE
    // HardGates so it never surfaces to the user. Neutral phrasing: this is
    // an observation of an external condition, not a complaint.
    try {
      if (this.innerSpeech && typeof this.innerSpeech.emit === 'function') {
        this.innerSpeech.emit(
          'resting — no model available right now; will resume when one returns',
          'rest-mode',
          { sourceModule: 'IdleMind' }
        );
      }
    } catch (_e) { /* InnerSpeech.emit is contractually non-throwing */ }
    _log.info('[IDLE-MIND] Entering rest-mode — all models unavailable');
  }

  /**
   * v7.9.12: Exit rest-mode. Idempotent — only acts on the transition out.
   * Called both by _think() (when a tick finds models available again) and
   * by the model:unavailable-cleared listener (faster recovery without
   * waiting for the next think interval).
   * @param {string} [modelName] — the model that recovered, if known
   * @private
   */
  _exitRestMode(modelName) {
    if (!this._inRestMode) return;
    this._inRestMode = false;
    try {
      this.bus.fire('model:rest-mode-exited',
        modelName ? { modelName } : {},
        { source: 'IdleMind' });
    } catch (_e) { /* best-effort */ }
    try {
      if (this.innerSpeech && typeof this.innerSpeech.emit === 'function') {
        this.innerSpeech.emit(
          'a model is available again — resuming',
          'rest-mode',
          { sourceModule: 'IdleMind' }
        );
      }
    } catch (_e) { /* non-throwing by contract */ }
    _log.info('[IDLE-MIND] Exiting rest-mode — model available again');
  }

  // ── Main Think Loop ──────────────────────────────────────

  async _think() {
    // FIX v7.4.1: Re-entrancy guard. setInterval fires regardless of whether
    // the previous _think() has finished. If an LLM call or goal step takes
    // longer than the 5-minute interval, the next tick would start a parallel
    // cycle — potentially double-executing goal steps or activities.
    if (this._thinking) return;
    this._thinking = true;
    try {
    if (!this.model?.activeModel) return;
    // v7.9.12: rest-mode when every discovered model is marked unavailable.
    // Sits after the activeModel guard (which catches the boot/no-model case)
    // and before thoughtCount++ (rest-mode ticks must not inflate the thought
    // counter — resting is the absence of a cycle, not a cycle). When all
    // models are marked, looping LLM-backed activities would only produce
    // failures and accumulate frustration; instead we idle until a model
    // recovers (model:unavailable-cleared → _exitRestMode).
    if (this.model?.areAllModelsUnavailable?.()) {
      this._enterRestMode();
      return;
    }
    this._exitRestMode(); // models are available — clear any prior rest state
    this.thoughtCount++;
    // v7.9.15: persist the counter the moment it increments, before any of the
    // early-exit gates below (user-active <60s, homeostasis-block, low-energy)
    // can return. Pre-fix the only save path was _recordActivity at the end of
    // a fully-completed cycle, so every skipped cycle incremented thoughtCount
    // without persisting it — and a short session (idle threshold + a couple of
    // gated cycles, then close) wrote the stats file zero times, leaving the
    // counter at 0 on the next boot. The write is debounced and collapses with
    // the later _recordActivity write into one flush; storage.flush() on a clean
    // shutdown drains it, and continued idle lets the 1s timer fire on its own.
    this._saveActivityStats();

    // FIX v4.12.8: Skip idle activities when system is under load.
    // On consumer hardware, each LLM call takes 10-30s and blocks the
    // semaphore. If the user might send a message soon, don't start
    // a slow idle activity that delays their response.
    const timeSinceUser = Date.now() - this.lastUserActivity;
    if (timeSinceUser < 60000) { // Less than 1 min since last user msg
      _log.debug('[IDLE-MIND] Skipping — user was active recently');
      return;
    }

    // FIX v3.5.0: Check Homeostasis before ANY autonomous action.
    // Previously this check was wired to a dead property (this._intervals bug).
    // Now the IdleMind itself respects the organism state.
    if (this._homeostasis && !this._homeostasis.isAutonomyAllowed()) {
      _log.debug('[IDLE-MIND] Autonomy blocked by homeostasis:', this._homeostasis.getState());
      return;
    }

    // v5.0.0: Metabolism energy gating — skip if insufficient energy
    if (this._metabolism && !this._metabolism.canAfford('idleMindCycle')) {
      _log.debug('[IDLE-MIND] Skipping — insufficient energy');
      return;
    }
    // Consume energy for this cycle
    if (this._metabolism) this._metabolism.consume('idleMindCycle');

    // v7.2.5: Emit cycle-start after all gates pass.
    // Listeners can trust this means a cycle IS happening, not just considered.
    this.bus.fire('idle:cycle-start', {
      thoughtCount: this.thoughtCount,
      timeSinceUser,
      energy: this._metabolism?.getEnergy?.() || 0,
    }, { source: 'IdleMind' });

    // PRIORITY 1: Execute active goals (purposeful work)
    // v7.9.4: goal-activity balance. Pre-fix, every cycle with an active
    // goal ran a goal-step and returned early, so non-goal activities
    // (reflect, journal, dream, etc.) never fired while a goal was active.
    // Now we count goal-steps and break out to the activity-pick path
    // every N steps (setting idleMind.goalStepsPerActivityPick, default 3).
    // Setting null/0 restores the legacy always-goal-step behavior.
    if (this.goalStack) {
      const activeGoals = this.goalStack.getActiveGoals();
      if (activeGoals.length > 0) {
        const N = (() => {
          const v = this._settings?.get?.('idleMind.goalStepsPerActivityPick');
          return Number.isFinite(v) ? v : 3;
        })();
        const next = (this._goalStepsSincePick || 0) + 1;
        if (N > 0 && next > N) {
          // Reset and intentionally fall through to activity pick this cycle.
          this._goalStepsSincePick = 0;
          this.bus.fire('idle:goal-balance-break', { stepsTaken: N }, { source: 'IdleMind' });
        } else {
          this._goalStepsSincePick = next;
          this.bus.fire('idle:thinking', { activity: 'goal', thought: this.thoughtCount }, { source: 'IdleMind' });
          try {
            const result = await this.goalStack.executeNextStep();
            if (result) {
              this._journal('goal', `[${result.goalId}] Step: ${result.action} -> ${result.success ? 'OK' : 'FAIL'}: ${(result.output || '').slice(0, 200)}`);
              this.bus.fire('idle:thought-complete', { activity: 'goal', summary: result.action }, { source: 'IdleMind' });
              return;
            }
          } catch (err) {
            _log.warn('[IDLE-MIND] Goal step failed:', err.message);
          }
        }
      }
    }

    // PRIORITY 2: Needs-driven + emotion-weighted activity selection
    const activity = this._pickActivity();

    this.bus.fire('idle:thinking', { activity, thought: this.thoughtCount }, { source: 'IdleMind' });

    try {
      let result;
      // v7.3.1: Registry-based dispatch. Falls back to Reflect on unknown
      // activity names (preserves legacy `default: _reflect()` behavior).
      const act = ACTIVITY_BY_NAME[activity] || ACTIVITY_BY_NAME['reflect'];
      result = await act.run(this);

      // v7.9.4: per-activity Metabolism cost. The baseline idleMindCycle
      // cost already fired once for the cycle itself; this second consume
      // charges the activity-specific cost so a Plan (12) and a Journal (2)
      // entry don't drain the pool at the same rate. Controlled by setting
      // `organism.metabolism.differentiatedCosts` (default true). Unknown
      // activity keys cost 0 by design (see Metabolism.consume) — no throw.
      try {
        const useDifferentiated = this._settings?.get?.('organism.metabolism.differentiatedCosts');
        const enabled = useDifferentiated === undefined ? true : !!useDifferentiated;
        if (enabled && this._metabolism && typeof this._metabolism.consume === 'function') {
          this._metabolism.consume(`idleMind:${activity}`);
        }
      } catch (e) { _log.debug('[IDLE-MIND] differentiated cost skipped:', e.message); }

      // v7.9.7: split the previous `if (result)` gate. _recordActivity
      // must run unconditionally so the Insights Timeline reflects what
      // IdleMind actually picked, not just what produced a truthy output.
      // Several activities (Reflect, Explore, Study, ReadSource, MCPExplore,
      // SkillRehearsal, Inhabit) have legitimate `return null` paths and
      // were silently missing from the counter pre-fix.
      this._recordActivity(activity, result);
      if (result) {
        this._journal(activity, result);

        this.bus.fire('idle:thought-complete', { activity, summary: result.slice(0, 200) }, { source: 'IdleMind' });

        // v5.7.0: Proactive insight — share significant findings with the user
        if (this._isSignificantInsight(activity, result)) {
          this.bus.fire('idle:proactive-insight', {
            activity,
            insight: result.slice(0, 300),
          }, { source: 'IdleMind' });
        }
      }
    } catch (err) {
      _log.warn(`[IDLE-MIND] ${activity} failed:`, err.message);
    }
    } finally { this._thinking = false; }
  }

  /**
   * WEAKNESS FIX v3.5.0: Activity selection is now driven by THREE sources:
   *
   * 1. NeedsSystem recommendations (if available) — maps biological drives
   *    (knowledge hunger, social need, maintenance, rest) to activities
   * 2. EmotionalState idle priorities (if available) — frustration → reflect,
   *    curiosity → explore, low energy → tidy/journal
   * 3. Static weights as fallback
   *
   * The scores from all sources are combined. Recent activities are penalized
   * to ensure variety. The result: Genesis doesn't randomly pick activities —
   * it does what it NEEDS and FEELS like doing.
   */
  /**
   * v5.7.0: Determine if an idle thought is significant enough
   * to proactively share with the user.
   * Criteria: actionable findings from reflect/explore/tidy,
  /**
   * v5.7.0 / v5.9.7: proactive-insight gate — only "interesting" findings
   * rate-limited to max 1 per 10 minutes.
   */
  _isSignificantInsight(activity, result) {
    // Only share insights from activities that produce actionable findings
    const INSIGHT_ACTIVITIES = new Set(['reflect', 'explore', 'tidy', 'plan', 'ideate']);
    if (!INSIGHT_ACTIVITIES.has(activity)) return false;

    // Must have meaningful content
    if (!result || result.length < 50) return false;

    // Heuristic: contains actionable keywords
    const lower = result.toLowerCase();
    const hasAction = /found|discovered|noticed|detected|suggest|could|should|improved|issue|bug|opportunity|pattern|optimiz/.test(lower);
    if (!hasAction) return false;

    // Rate limit: max 1 proactive insight per 10 minutes
    const now = Date.now();
    if (this._lastInsightTs && now - this._lastInsightTs < 600_000) return false;
    this._lastInsightTs = now;

    return true;
  }

  _pickActivity() {
    // v7.3.1: Registry-based dispatch. Replaces the 267-LOC pipeline of
    // 10 scorers with hardcoded activity-name references. Each activity's
    // shouldTrigger(ctx) self-reports its boost from the shared PickContext.
    // Behavior is preserved via the activities-split.test.js snapshot tests.
    const ctx = buildPickContext(this);

    // Compute initial scores: base (1.0 + weight) * shouldTrigger-boost.
    // Activities returning 0 are implicitly excluded (not candidates).
    const scores = {};
    for (const act of ACTIVITY_MODULES) {
      let boost;
      try {
        boost = act.shouldTrigger(ctx);
      } catch (err) {
        _log.debug(`[IDLE-MIND] ${act.name}.shouldTrigger error:`, err.message);
        continue;
      }
      if (!Number.isFinite(boost) || boost <= 0) continue;
      scores[act.name] = (1.0 + act.weight) * boost;
    }

    // Repetition penalty: recently-run activities get their score reduced.
    // v7.9.4: use a Set so each unique activity in the last 5 cycles gets
    // the 0.2 multiplier exactly once. Pre-fix this loop iterated the raw
    // array, so an activity appearing N times in the recent window got
    // hit with 0.2^N — e.g. ['reflect','reflect','reflect','reflect','reflect']
    // pushed reflect's score to score * 0.00032, effectively locking the
    // activity out for a long time and skewing the picker toward whatever
    // happened to be different. Single-application Set restores the
    // intended "discourage repetition" semantic without runaway penalty.
    const recent = new Set(this.activityLog.slice(-5).map(a => a.activity));
    for (const a of recent) {
      if (scores[a] !== undefined) scores[a] *= 0.2;
    }

    // Pick best with jitter (also preserved from legacy).
    let bestActivity = 'reflect';
    let bestScore = -1;
    for (const [name, score] of Object.entries(scores)) {
      const jittered = score + Math.random() * 0.5;
      if (jittered > bestScore) {
        bestScore = jittered;
        bestActivity = name;
      }
    }

    // Debug trace — matches legacy format for continuity.
    if (scores.research !== undefined) {
      _log.debug(`[IDLE] Activity scores: research=${scores.research.toFixed(2)}, winner=${bestActivity}(${bestScore.toFixed(2)}), candidates=${Object.keys(scores).join(',')}`);
    }

    // Persist cross-cycle state that activities may have updated.
    // (ctx.cycleState carries e.g. recentImprintIds and currentWeakness.)
    this._recentImprintIds = ctx.cycleState.recentImprintIds || this._recentImprintIds;

    // v7.3.1: Preserve legacy scorer #4 side-effect — update currentWeakness
    // from the weakest area so Explore.run() can target it. In the legacy
    // _pickActivity(), this was an inline mutation inside the scorer.
    const weakAreas = ctx.snap.weakAreas || [];
    if (weakAreas.length > 0) {
      this._currentWeakness = weakAreas[0]; // already sorted by successRate asc
    }

    return bestActivity;
  }

  // ── Activity implementations → IdleMindActivities.js ──
  // (prototype delegation, see bottom of file)

  // v7.1.6: Network availability check for research activity
  // Cached for 5 minutes — async DNS probe, non-blocking.
  _isNetworkAvailable() {
    if (this._networkCheckCache !== undefined
        && Date.now() - this._networkCheckTs < 5 * 60 * 1000) {
      return this._networkCheckCache;
    }

    // Async DNS probe — result available next tick
    try {
      const dns = require('dns');
      dns.resolve('registry.npmjs.org', (err) => {
        this._networkCheckCache = !err;
        this._networkCheckTs = Date.now();
      });
    } catch (_e) {
      this._networkCheckCache = false;
      this._networkCheckTs = Date.now();
    }

    // First call: optimistic (fetch timeout catches failures)
    if (this._networkCheckCache === undefined) {
      this._networkCheckCache = true;
      this._networkCheckTs = Date.now();
    }

    return this._networkCheckCache;
  }

}

// v7.3.1: Prototype delegation removed. Activity implementations now
// live as separate modules in ./activities/ and are dispatched through
// the ACTIVITY_BY_NAME registry defined at the top of this file.
// v7.3.2: Legacy IdleMindActivities.js removed. The old tests
// (idlemind-activities.test.js, idle-mind-activities.test.js) were
// migrated to test/modules/activities-modules.test.js which tests
// the new modules directly. IdleMindResearch.test.js was updated to
// import from activities/Research.js.
applySubscriptionHelper(IdleMind);
const { activityStatsMixin } = require('./IdleMindActivityStats'); // v7.9.1
const { journalMixin } = require('./IdleMindJournal');   // v7.9.22 Item 15
const { plansMixin } = require('./IdleMindPlans');       // v7.9.22 Items 4 + 15
const { statusMixin } = require('./IdleMindStatus');     // v7.9.22 Item 15
Object.assign(IdleMind.prototype, activityStatsMixin, journalMixin, plansMixin, statusMixin);
module.exports = { IdleMind };
