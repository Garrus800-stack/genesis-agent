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
      switch (activity) {
        case 'reflect':      result = await this._reflect(); break;
        case 'plan':         result = await this._plan(); break;
        case 'explore':      result = await this._explore(); break;
        case 'ideate':       result = await this._ideate(); break;
        case 'tidy':         result = await this._tidy(); break;
        case 'journal':      result = await this._writeJournalEntry(); break;
        case 'mcp-explore':  result = await this._exploreMcp(); break;
        case 'dream':        result = await this._dream(); break;
        case 'consolidate':  result = await this._consolidateMemory(); break;
        case 'calibrate':   result = await this._calibrate(); break;
        case 'research':    result = await this._research(); break;
        case 'self-define': result = await this._selfDefine(); break;
        case 'improve':    result = await this._improve(); break;   // v7.2.10: was missing since v7.0.9
        case 'study':      result = await this._study(); break;     // v7.2.10: LLM-based learning
        default:             result = await this._reflect();
      }

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
    const recent = this.activityLog.slice(-5).map(a => a.activity);

    // ── Candidate list (conditionally extended) ─────────
    const candidates = ['reflect', 'plan', 'explore', 'ideate', 'tidy', 'journal'];

    try {
      if (this.mcpClient?.getStatus().connectedCount > 0) candidates.push('mcp-explore');
    } catch (_e) { /* no MCP */ }

    try {
      if (this.dreamCycle) {
        const timeSince = this.dreamCycle.getTimeSinceLastDream();
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

    // v7.0.9 Phase 4: improve — GoalSynthesizer-driven self-improvement
    try {
      if (this.bus._container?.resolve?.('goalSynthesizer')) {
        candidates.push('improve');
      }
    } catch (_e) { /* no goalSynthesizer */ }

    // v7.1.6: research — web-based learning from trusted domains
    try {
      const hasWeb = !!this._webFetcher;
      const netOk = hasWeb ? this._isNetworkAvailable() : false;
      _log.debug(`[IDLE] Research check: webFetcher=${hasWeb}, network=${netOk}`);
      if (hasWeb && netOk) {
        candidates.push('research');
      }
    } catch (_e) { _log.debug(`[IDLE] Research check failed: ${_e.message}`); }

    // v7.2.0: self-define — Genesis writes its own identity
    try {
      if (this._cognitiveSelfModel && this.storage) {
        candidates.push('self-define');
      }
    } catch (_e) { /* no cognitiveSelfModel */ }

    // v7.2.10: study — learn from LLM's training knowledge
    try {
      if (this.model?.activeModel && this.kg) {
        candidates.push('study');
      }
    } catch (_e) { /* no model or kg */ }

    // ── Static weight table ─────────────────────────────
    const STATIC_WEIGHTS = {
      reflect: 1.5, plan: 1.0, explore: 1.2, ideate: 0.8,
      tidy: 0.6, journal: 0.5, 'mcp-explore': 1.0, dream: 2.0,
      consolidate: 1.3, calibrate: 1.5, improve: 1.8, research: 1.2,
      'self-define': 0.4, study: 0.9,
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
        // v7.2.10: research + study are curiosity-driven
        if (scores.research !== undefined)     scores.research     *= curMul;
        if (scores.study !== undefined)        scores.study        *= curMul;
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
            // v7.0.9: Boost improve when weak areas exist
            if (scores.improve !== undefined) scores.improve *= (1 + weakAreas.length * 0.8);
            // Store weakest area for targeted exploration
            this._currentWeakness = weakAreas
              .sort((a, b) => (a[1].successRate || 0) - (b[1].successRate || 0))[0];
          }
        } catch (_e) { /* optional */ }
      },
      // v7.0.9: selfAwareness trait boosts improve activity
      () => {
        if (!this._genome) return;
        const sa = this._genome.trait('selfAwareness');
        if (sa !== undefined && scores.improve !== undefined) {
          scores.improve *= (0.5 + sa); // selfAwareness=1.0 → 1.5x boost
        }
      },
      // v7.1.5: EmotionalFrontier — emotion-aware activity targeting
      // Frustration peaks → boost EXPLORE toward the pain point
      // Curiosity sustained → boost IDEATE toward the interest
      // Imprint cooldown → halve score if same imprint was used in last 2 picks
      () => {
        if (!this._emotionalFrontier) return;
        try {
          const imprints = this._emotionalFrontier.getRecentImprints(3);
          if (imprints.length === 0) return;

          for (const imp of imprints) {
            const cooldownFactor = this._recentImprintIds.has(imp.nodeId) ? 0.5 : 1.0;

            // Frustration peaks → boost explore
            const frustPeaks = (imp.peaks || []).filter(p => p.dim === 'frustration');
            if (frustPeaks.length > 0 && scores.explore !== undefined) {
              scores.explore *= (1 + 0.4 * cooldownFactor);
            }

            // Curiosity sustained → boost ideate
            const curiositySust = (imp.sustained || []).filter(s => s.dim === 'curiosity');
            if (curiositySust.length > 0 && scores.ideate !== undefined) {
              scores.ideate *= (1 + 0.4 * cooldownFactor);
            }
            // v7.2.10: sustained curiosity also boosts research
            if (curiositySust.length > 0 && scores.research !== undefined) {
              scores.research *= (1 + 0.3 * cooldownFactor);
            }

            // Satisfaction deficit → boost reflect on unresolved problems
            const satDeficit = (imp.peaks || []).filter(p => p.dim === 'satisfaction' && p.value < p.baseline);
            if (satDeficit.length > 0 && scores.reflect !== undefined) {
              scores.reflect *= (1 + 0.3 * cooldownFactor);
            }
          }

          // Update cooldown: track which imprints were used this pick
          this._recentImprintIds = new Set(imprints.slice(0, 2).map(i => i.nodeId).filter(Boolean));
        } catch (_e) { /* optional */ }
      },
      // v7.1.6: UNFINISHED_WORK → boost plan activity
      () => {
        if (!this._unfinishedWorkFrontier) return;
        try {
          const items = this._unfinishedWorkFrontier.getRecent(2);
          if (items.length > 0 && scores.plan !== undefined) {
            scores.plan *= 1.6;
          }
        } catch (_e) { /* optional */ }
      },
      // v7.1.6: HIGH_SUSPICION → boost explore for affected category
      () => {
        if (!this._suspicionFrontier) return;
        try {
          const items = this._suspicionFrontier.getRecent(2);
          if (items.length > 0 && scores.explore !== undefined) {
            scores.explore *= 1.5;
          }
        } catch (_e) { /* optional */ }
      },
      // v7.1.6: LESSON_APPLIED low confirmation → boost reflect
      () => {
        if (!this._lessonFrontier) return;
        try {
          const items = this._lessonFrontier.getRecent(1);
          if (items.length > 0 && scores.reflect !== undefined) {
            // Low lesson count in session could indicate lessons aren't being applied
            if ((items[0].count || 0) <= 1) scores.reflect *= 1.3;
          }
        } catch (_e) { /* optional */ }
      },
      // v7.1.6: Research gates — energy, trust, rate limit, frontier-driven boost
      () => {
        if (scores.research === undefined) return;
        // Energy gate
        const energy = this.emotionalState?.getState?.()?.energy ?? 0.5;
        if (energy < 0.5) { scores.research = 0; return; }
        // Trust gate
        const trustLevel = this._trustLevelSystem?.getLevel?.() ?? 1;
        if (trustLevel < 1) { scores.research = 0; return; }
        // Rate limit: max 3 per hour
        const recentResearch = this.activityLog
          .filter(a => a.activity === 'research' && Date.now() - a.timestamp < 60 * 60 * 1000);
        if (recentResearch.length >= 3) { scores.research = 0; return; }
        // Cooldown: 30min after last research
        const lastR = recentResearch[recentResearch.length - 1];
        if (lastR && Date.now() - lastR.timestamp < 30 * 60 * 1000) {
          scores.research *= 0.1;
        }
        // Frontier-driven boost: topics available → higher score
        if (this._unfinishedWorkFrontier?.getRecent(1).length > 0) scores.research *= 1.4;
        if (this._suspicionFrontier?.getRecent(1).length > 0) scores.research *= 1.3;
        // Knowledge need boost
        if (this.needsSystem) {
          const needs = this.needsSystem.getNeeds();
          if (needs.knowledge > 0.6) scores.research *= 1.5;
        }
      },
      // v7.2.5: Memory-pressure-based dream boost — dream more when system has headroom
      () => {
        if (scores.dream === undefined || !this._homeostasis) return;
        try {
          const vitals = this._homeostasis.vitals || {};
          const memPressure = vitals.memoryPressure?.value ?? 50;
          if (memPressure < 15) scores.dream *= 2.0;
          else if (memPressure < 30) scores.dream *= 1.5;
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

    // v7.2.9: Debug — why is research never picked?
    if (scores.research !== undefined) {
      _log.debug(`[IDLE] Activity scores: research=${scores.research.toFixed(2)}, winner=${bestActivity}(${bestScore.toFixed(2)}), candidates=${Object.keys(scores).join(',')}`);
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
}



// ── Prototype delegation: activity implementations ────────
// Extracted to IdleMindActivities.js (v5.6.0) — same pattern
// as Dashboard → DashboardRenderers, PromptBuilder → PromptBuilderSections.
const { activities } = require('./IdleMindActivities');
Object.assign(IdleMind.prototype, activities);

module.exports = { IdleMind };
