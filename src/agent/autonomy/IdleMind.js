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
const _log = createLogger('IdleMind');

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
    this._currentWeakness = null; // { taskType, successRate, sampleSize }

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


  /** @private Subscribe to bus event with auto-cleanup in stop() */
  _sub(event, handler, opts) {
    const unsub = this.bus.on(event, handler, opts);
    this._unsubs.push(typeof unsub === 'function' ? unsub : () => {});
    return unsub;
  }

  stop() {
    for (const unsub of this._unsubs) { try { unsub(); } catch (_) { /* best effort */ } }
    this._unsubs = [];
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

    // PRIORITY 1: Execute active goals (purposeful work)
    if (this.goalStack) {
      const activeGoals = this.goalStack.getActiveGoals();
      if (activeGoals.length > 0) {
        this.bus.emit('idle:thinking', { activity: 'goal', thought: this.thoughtCount }, { source: 'IdleMind' });
        try {
          const result = await this.goalStack.executeNextStep();
          if (result) {
            // @ts-ignore — TS strict
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
      switch (activity) {
        // @ts-ignore — TS strict
        case 'reflect':      result = await this._reflect(); break;
        // @ts-ignore — TS strict
        case 'plan':         result = await this._plan(); break;
        // @ts-ignore — TS strict
        case 'explore':      result = await this._explore(); break;
        // @ts-ignore — TS strict
        case 'ideate':       result = await this._ideate(); break;
        // @ts-ignore — TS strict
        case 'tidy':         result = await this._tidy(); break;
        // @ts-ignore — TS strict
        case 'journal':      result = await this._writeJournalEntry(); break;
        // @ts-ignore — TS strict
        case 'mcp-explore':  result = await this._exploreMcp(); break;
        // @ts-ignore — TS strict
        case 'dream':        result = await this._dream(); break;
        // @ts-ignore — TS strict
        case 'consolidate':  result = await this._consolidateMemory(); break;
        // @ts-ignore — TS strict
        case 'calibrate':   result = await this._calibrate(); break;
        // @ts-ignore — TS strict
        default:             result = await this._reflect();
      }

      if (result) {
        // @ts-ignore — TS strict
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
    const recent = this.activityLog.slice(-5).map(a => a.activity);

    // ── Candidate list (conditionally extended) ─────────
    const candidates = ['reflect', 'plan', 'explore', 'ideate', 'tidy', 'journal'];

    try {
      if (this.mcpClient?.getStatus().connectedCount > 0) candidates.push('mcp-explore');
    } catch (_e) { /* no MCP */ }

    try {
      // @ts-ignore — TS strict
      if (this.dreamCycle) {
        // @ts-ignore — TS strict
        const timeSince = this.dreamCycle.getTimeSinceLastDream();
        // @ts-ignore — TS strict
        const unprocessed = this.dreamCycle.getUnprocessedCount();
        if (timeSince > 30 * 60 * 1000 && unprocessed >= 10) candidates.push('dream');
      }
    } catch (_e) { /* no dream */ }

    // v6.0.0: consolidate always available — MemoryConsolidator handles deps
    candidates.push('consolidate');

    // v6.0.2: calibrate available when AdaptiveStrategy is registered
    try {
      if (this.bus._container?.resolve?.('adaptiveStrategy')) {
        candidates.push('calibrate');
      }
    } catch (_e) { /* no adaptiveStrategy */ }

    // ── Static weight table ─────────────────────────────
    const STATIC_WEIGHTS = {
      reflect: 1.5, plan: 1.0, explore: 1.2, ideate: 0.8,
      tidy: 0.6, journal: 0.5, 'mcp-explore': 1.0, dream: 2.0,
      consolidate: 1.3, calibrate: 1.5,
    };

    // ── Initialize scores ───────────────────────────────
    const scores = {};
    for (const c of candidates) scores[c] = 1.0 + (STATIC_WEIGHTS[c] || 0);

    // ── Scoring pipeline ────────────────────────────────
    const scorers = [
      // NeedsSystem recommendations
      () => {
        if (!this.needsSystem) return;
        const recs = this.needsSystem.getActivityRecommendations();
        for (const rec of recs) {
          if (scores[rec.activity] !== undefined) scores[rec.activity] += rec.score * 3;
        }
      },
      // EmotionalState idle priorities
      () => {
        if (!this.emotionalState) return;
        const priorities = this.emotionalState.getIdlePriorities();
        for (const [activity, weight] of Object.entries(priorities)) {
          if (scores[activity] !== undefined) scores[activity] += weight * 2;
        }
      },
      // Genome trait influence
      () => {
        if (!this._genome) return;
        const curiosity = this._genome.trait('curiosity');
        const consolidation = this._genome.trait('consolidation');
        const curMul = 0.5 + curiosity;
        const conMul = 0.5 + consolidation;
        if (scores.explore !== undefined)        scores.explore        *= curMul;
        if (scores.ideate !== undefined)         scores.ideate         *= curMul;
        if (scores['mcp-explore'] !== undefined) scores['mcp-explore'] *= curMul;
        if (scores.dream !== undefined)          scores.dream          *= conMul;
        if (scores.consolidate !== undefined)    scores.consolidate    *= conMul;
        if (scores.calibrate !== undefined)     scores.calibrate      *= conMul;
        if (scores.tidy !== undefined)           scores.tidy           *= conMul;
      },
      // v6.0.8: Directed curiosity — boost explore when weak areas exist
      () => {
        if (!this._cognitiveSelfModel) return;
        try {
          const profile = this._cognitiveSelfModel.getCapabilityProfile();
          const weakAreas = Object.entries(profile).filter(([, p]) => p.isWeak);
          if (weakAreas.length > 0) {
            if (scores.explore !== undefined) scores.explore *= (1 + weakAreas.length * 0.5);
            // Store weakest area for targeted exploration
            this._currentWeakness = weakAreas
              .sort((a, b) => (a[1].successRate || 0) - (b[1].successRate || 0))[0];
          }
        } catch (_e) { /* optional */ }
      },
    ];

    for (const scorer of scorers) {
      try { scorer(); } catch (err) { _log.debug('[IDLE-MIND] Scorer error:', err.message); }
    }

    // ── Repetition penalty ──────────────────────────────
    for (const a of recent) {
      if (scores[a] !== undefined) scores[a] *= 0.2;
    }

    // ── Pick best with jitter ───────────────────────────
    let bestActivity = 'reflect';
    let bestScore = -1;
    for (const [activity, score] of Object.entries(scores)) {
      const jittered = score + Math.random() * 0.5;
      if (jittered > bestScore) {
        bestScore = jittered;
        bestActivity = activity;
      }
    }

    return bestActivity;
  }

  // ── Activity implementations → IdleMindActivities.js ──
  // (prototype delegation, see bottom of file)

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
}



// ── Prototype delegation: activity implementations ────────
// Extracted to IdleMindActivities.js (v5.6.0) — same pattern
// as Dashboard → DashboardRenderers, PromptBuilder → PromptBuilderSections.
const { activities } = require('./IdleMindActivities');
Object.assign(IdleMind.prototype, activities);

module.exports = { IdleMind };
