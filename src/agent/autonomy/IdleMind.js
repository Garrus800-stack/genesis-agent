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

    // Thought journal
    this.journalPath = path.join(storageDir, 'journal.jsonl');
    this.planPath = path.join(storageDir, 'plans.json');
    this.plans = this._loadPlans();

    // Track what activities have been done recently
    this.activityLog = [];
    this._lastInsightTs = 0; // v5.7.0: Rate-limit proactive insights

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
  }



  start() {
    if (this.running) return;
    this.running = true;

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

  // ── Main Think Loop ──────────────────────────────────────

  async _think() {
    if (!this.model?.activeModel) return;
    this.thoughtCount++;

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
    this.bus.emit('idle:cycle-start', {
      thoughtCount: this.thoughtCount,
      timeSinceUser,
      energy: this._metabolism?.getEnergy?.() || 0,
    }, { source: 'IdleMind' });

    // PRIORITY 1: Execute active goals (purposeful work)
    if (this.goalStack) {
      const activeGoals = this.goalStack.getActiveGoals();
      if (activeGoals.length > 0) {
        this.bus.emit('idle:thinking', { activity: 'goal', thought: this.thoughtCount }, { source: 'IdleMind' });
        try {
          const result = await this.goalStack.executeNextStep();
          if (result) {
            this._journal('goal', `[${result.goalId}] Step: ${result.action} -> ${result.success ? 'OK' : 'FAIL'}: ${(result.output || '').slice(0, 200)}`);
            this.bus.emit('idle:thought-complete', { activity: 'goal', summary: result.action }, { source: 'IdleMind' });
            return;
          }
        } catch (err) {
          _log.warn('[IDLE-MIND] Goal step failed:', err.message);
        }
      }
    }

    // PRIORITY 2: Needs-driven + emotion-weighted activity selection
    const activity = this._pickActivity();

    this.bus.emit('idle:thinking', { activity, thought: this.thoughtCount }, { source: 'IdleMind' });

    try {
      let result;
      // v7.3.1: Registry-based dispatch. Falls back to Reflect on unknown
      // activity names (preserves legacy `default: _reflect()` behavior).
      const act = ACTIVITY_BY_NAME[activity] || ACTIVITY_BY_NAME['reflect'];
      result = await act.run(this);

      if (result) {
        this._journal(activity, result);
        this.activityLog.push({ activity, timestamp: Date.now() });

        // Keep only last 20 activity entries
        if (this.activityLog.length > 20) this.activityLog = this.activityLog.slice(-20);

        this.bus.emit('idle:thought-complete', { activity, summary: result.slice(0, 200) }, { source: 'IdleMind' });

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
    // Preserved from legacy _pickActivity() behavior.
    const recent = this.activityLog.slice(-5).map(a => a.activity);
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

  readJournal(limit = 20) {
    try {
      const raw = this.storage
        ? this.storage.readText('journal.jsonl', '')
        : (fs.existsSync(this.journalPath) ? fs.readFileSync(this.journalPath, 'utf-8') : '');
      const lines = raw.split('\n').filter(Boolean);
      return lines.slice(-limit).map(l => {
        try { return JSON.parse(l); } catch (err) { return null; }
      }).filter(Boolean);
    } catch (err) { _log.debug('[IDLE] Journal read failed:', err.message); return []; }
  }

  // ── Plans ────────────────────────────────────────────────

  getPlans() { return this.plans; }

  updatePlanStatus(planId, status) {
    const plan = this.plans.find(p => p.id === planId);
    if (plan) {
      plan.status = status;
      plan.updated = new Date().toISOString();
      this._savePlans();
    }
  }

  _loadPlans() {
    try {
      if (this.storage) return this.storage.readJSON('plans.json', []);
      if (fs.existsSync(this.planPath)) return safeJsonParse(fs.readFileSync(this.planPath, 'utf-8'), null, 'IdleMind');
    } catch (err) { _log.debug('[IDLE] Plan load failed:', err.message); }
    return [];
  }

  _savePlans() {
    try {
      if (this.storage) { this.storage.writeJSONDebounced('plans.json', this.plans); return; }
      if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
      // FIX v5.1.0 (N-3): Atomic write fallback when StorageService unavailable.
      atomicWriteFileSync(this.planPath, JSON.stringify(this.plans, null, 2), 'utf-8');
    } catch (err) {
      _log.warn('[IDLE-MIND] Plan save failed:', err.message);
    }
  }

  // FIX v5.5.0 (H-1): Synchronous persist for shutdown path.
  _savePlansSync() {
    try {
      if (this.storage) { this.storage.writeJSON('plans.json', this.plans); return; }
      if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
      atomicWriteFileSync(this.planPath, JSON.stringify(this.plans, null, 2), 'utf-8');
    } catch (err) {
      _log.warn('[IDLE-MIND] Plan sync save failed:', err.message);
    }
  }

  // ── Status ───────────────────────────────────────────────

  getStatus() {
    let journalCount = 0;
    try {
      const raw = this.storage
        ? this.storage.readText('journal.jsonl', '')
        : (fs.existsSync(this.journalPath) ? fs.readFileSync(this.journalPath, 'utf-8') : '');
      journalCount = raw.split('\n').filter(Boolean).length;
    } catch (err) { _log.debug('[IDLE-MIND] Journal write error:', err.message); }
    return {
      running: this.running,
      idleSince: Date.now() - this.lastUserActivity,
      isIdle: (Date.now() - this.lastUserActivity) >= this.idleThreshold,
      thoughtCount: this.thoughtCount,
      recentActivities: this.activityLog.slice(-5),
      plans: this.plans.length,
      activeGoals: this.goalStack ? this.goalStack.getActiveGoals().length : 0,
      totalGoals: this.goalStack ? this.goalStack.getAll().length : 0,
      journalEntries: journalCount,
    };
  }

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   *
   * CRITICAL: I/O-free by design. This is NOT a wrapper around
   * getStatus() — getStatus() does fs.readFileSync on journal.jsonl
   * at every call, which would block the prompt-build path with
   * disk-I/O. getRuntimeSnapshot() reads only in-memory fields.
   *
   * The LLM sees the latest activity from activityLog (already in
   * RAM, bounded) and minutesIdle (computed from lastUserActivity
   * which is updated on every event). journal line-count is
   * intentionally omitted — if the LLM needs it, a separate tool
   * call can fetch it.
   */
  getRuntimeSnapshot() {
    const now = Date.now();
    const idleMs = now - this.lastUserActivity;
    const minutesIdle = Math.floor(idleMs / 60000);
    // Latest activity (if any). activityLog is in-memory, bounded.
    let currentActivity = null;
    let lastActivityAgo = null;
    if (this.activityLog.length > 0) {
      const last = this.activityLog[this.activityLog.length - 1];
      currentActivity = last.activity || null;
      lastActivityAgo = Math.floor((now - last.timestamp) / 1000);
    }
    return {
      running: this.running,
      isIdle: idleMs >= this.idleThreshold,
      minutesIdle,
      thoughtCount: this.thoughtCount,
      currentActivity,
      lastActivityAgoSeconds: lastActivityAgo,
    };
  }

  // v7.3.1: _journal moved from IdleMindActivities.js into IdleMind itself.
  // Previously attached via prototype-delegation; now lives here as a real
  // instance method because activities/*.js (Calibrate, Improve) call it
  // via idleMind._journal(...) rather than through a prototype chain.
  _journal(activity, content) {
    const entry = {
      timestamp: new Date().toISOString(),
      activity,
      thought: content.slice(0, 500),
      thoughtNumber: this.thoughtCount,
    };

    try {
      if (this.storage) {
        this.storage.appendText('journal.jsonl', JSON.stringify(entry) + '\n');
      } else {
        if (!fs.existsSync(this.storageDir)) fs.mkdirSync(this.storageDir, { recursive: true });
        fs.appendFileSync(this.journalPath, JSON.stringify(entry) + '\n', 'utf-8');
      }
    } catch (err) {
      _log.warn('[IDLE-MIND] Journal write failed:', err.message);
    }

    if (this.eventStore) {
      this.eventStore.append('IDLE_THOUGHT', { activity, summary: content.slice(0, 200) }, 'IdleMind');
    }
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

module.exports = { IdleMind };
