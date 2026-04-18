// @ts-checked-v5.7 — prototype delegation not visible to tsc
// ============================================================
// GENESIS — GoalStack.js
// Hierarchical Task Network (HTN) style goal planner.
//
// Genesis sets a GOAL -> decomposes into STEPS -> executes
// one step at a time -> checks result -> continues or replans.
//
// This is the difference between "thinks randomly" and
// "pursues objectives".
// ============================================================

const fs = require('fs');
const path = require('path');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalStack');
// v7.3.1: Capability-gate for duplicate detection
const CapabilityMatcher = require('./CapabilityMatcher');
class GoalStack {
  constructor({ lang, bus,  model, prompts, storageDir, storage}) {
    this.lang = lang || { t: (k) => k, detect: () => {}, current: 'en' };
    this.bus = bus || NullBus;
    this.model = model;
    this.prompts = prompts;
    this.storageDir = storageDir;
    this.storage = storage || null;

    // The stack: most urgent goal on top
    // v3.8.0: Moved to asyncLoad() — called by Container.bootAll()
    // this.goals = this._load();
    this.goals = [];
    this.maxGoals = 10;
    this._idSeq = 0; // v5.1.0: Counter prevents duplicate IDs on Windows (15ms timer resolution)
    this.maxStepsPerGoal = 8;

    // v7.3.1: Late-bound. SelfModel is in phase 1, GoalStack in later phase.
    // Container wires this via late-binding; may be null in tests.
    this.selfModel = null;
    this.lessonsStore = null;
  }



  /* c8 ignore stop */

  // ── Goal Management ──────────────────────────────────────

  /**
   * Add a new goal
   * @param {string} description - What to achieve
   * @param {string} source - Who created it ('user', 'idle-mind', 'daemon', 'self')
   * @param {string} priority - 'high' | 'medium' | 'low'
   * @param {object} options - { parentId, blockedBy: [goalId], tags: [] }
   */
  async addGoal(description, source = 'self', priority = 'medium', options = {}) {
    // v7.3.1: Capability-Gate — prevent duplicate goal proposals.
    // Runs before decomposition (saves LLM calls on blocks).
    // Skipped when override is claimed via options.novel.
    const gateResult = this._capabilityGate(description, source, options);
    if (gateResult.action === 'block') {
      _log.info(`[GOAL-GATE] Blocked duplicate: "${description.slice(0, 60)}" ~ ${gateResult.matched.id} (score ${gateResult.score})`);
      // Record lesson + emit event so dashboard can surface this
      this._recordLesson('duplicate-proposal', {
        goalText: description.slice(0, 200),
        matchedCapability: gateResult.matched.id,
        matchScore: gateResult.score,
        source,
      });
      this.bus.emit('goal:blocked-as-duplicate', {
        goalId: `blocked_${Date.now()}`,
        matchScore: gateResult.score,
        matchedCapability: gateResult.matched.id,
        source,
      }, { source: 'GoalStack' });
      return null;
    }
    if (gateResult.action === 'warn') {
      // User goals never block — they always pass through, but we emit
      // a warning so the UI can surface "looks similar to X" inline.
      this.bus.emit('goal:duplicate-warning', {
        goalId: `pending_${Date.now()}`,
        matchScore: gateResult.score,
        matchedCapability: gateResult.matched.id,
      }, { source: 'GoalStack' });
    }
    if (gateResult.action === 'novel-claimed') {
      // Override was used — record for later auditing
      this._recordLesson('novel-claimed', {
        goalText: description.slice(0, 200),
        matchedCapability: gateResult.matched?.id || null,
        matchScore: gateResult.score,
        reason: options.novel.reason,
        contrasting: options.novel.contrasting,
        source,
      });
    }

    // GoalStackExecution mixin — single cast covers all delegated calls in this method
    const _exe = /** @type {import('./GoalStackExecution').GoalStackExecutionMixin} */ (/** @type {any} */ (this));
    const steps = await _exe._decompose(description);

    const goal = {
      id: `goal_${Date.now()}_${++this._idSeq}`,
      description,
      source,
      priority,
      status: 'active',       // active | paused | completed | failed | abandoned | blocked
      steps,
      currentStep: 0,
      results: [],             // Result of each completed step
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
      attempts: 0,
      maxAttempts: 3,
      // v2.5: Hierarchical + dependency support
      parentId: options.parentId || null,    // Parent goal (sub-goal relationship)
      blockedBy: options.blockedBy || [],    // Goal IDs that must complete first
      childIds: [],                          // Populated when sub-goals are created
      tags: options.tags || [],              // For grouping/filtering
    };

    // If this is a sub-goal, register with parent
    if (goal.parentId) {
      const parent = this.goals.find(g => g.id === goal.parentId);
      if (parent) {
        if (!parent.childIds) parent.childIds = [];
        parent.childIds.push(goal.id);
      }
    }

    // Check if blocked by unfinished dependencies
    if (goal.blockedBy.length > 0) {
      const unfinished = goal.blockedBy.filter(depId => {
        const dep = this.goals.find(g => g.id === depId);
        return dep && dep.status !== 'completed';
      });
      if (unfinished.length > 0) goal.status = 'blocked';
    }

    this.goals.push(goal);
    this._prioritize();
    this._save();

    this.bus.emit('goal:created', { goalId: goal.id, id: goal.id, description, steps: steps.length, parentId: goal.parentId }, { source: 'GoalStack' });
    return goal;
  }

  /**
   * v7.3.1: Capability-gate decision function.
   * @param {string} description
   * @param {string} source
   * @param {object} options
   * @returns {{ action: 'pass'|'warn'|'block'|'novel-claimed', score: number, matched?: object }}
   */
  _capabilityGate(description, source, options) {
    // If override is claimed, validate and short-circuit
    if (options && options.novel) {
      const validation = CapabilityMatcher.validateNovelOverride(options.novel);
      if (!validation.valid) {
        _log.warn(`[GOAL-GATE] Invalid novel override: ${validation.violations.join(', ')}`);
        // Invalid override — treat as no override (fall through to normal gate)
      } else {
        // Valid override — do a match anyway for auditing, but never block
        const capabilities = this.selfModel?.getCapabilitiesDetailed?.() || [];
        const result = CapabilityMatcher.match(description, capabilities);
        return { action: 'novel-claimed', score: result.score, matched: result.matched };
      }
    }

    // No SelfModel available → pass (graceful degradation in tests/early-boot)
    if (!this.selfModel || typeof this.selfModel.getCapabilitiesDetailed !== 'function') {
      return { action: 'pass', score: 0 };
    }

    const capabilities = this.selfModel.getCapabilitiesDetailed();
    if (!capabilities || capabilities.length === 0) {
      return { action: 'pass', score: 0 };
    }

    const result = CapabilityMatcher.match(description, capabilities);

    // User-sourced goals never block — they get a warning at most
    if (source === 'user') {
      if (result.decision === 'block' || result.decision === 'grey') {
        return { action: 'warn', score: result.score, matched: result.matched };
      }
      return { action: 'pass', score: result.score };
    }

    // Non-user goals: block if clearly duplicate, pass otherwise
    // Grey zone (0.4–0.8) passes through for now — a future LLM classifier
    // could refine this into block/pass. For v7.3.1 we stay conservative.
    if (result.decision === 'block') {
      return { action: 'block', score: result.score, matched: result.matched };
    }
    return { action: 'pass', score: result.score, matched: result.matched };
  }

  /**
   * v7.3.1: Record a lesson via LessonsStore. Silently no-op if unavailable.
   * Used for both 'duplicate-proposal' (blocked goals) and 'novel-claimed'
   * (overrides) to build a historical auditable record.
   */
  _recordLesson(category, details) {
    try {
      if (!this.lessonsStore || typeof this.lessonsStore.record !== 'function') return;
      this.lessonsStore.record({
        category,
        insight: `[${category}] ${JSON.stringify(details).slice(0, 300)}`,
        strategy: details,
        evidence: {
          surpriseScore: 0.5, successRate: null, sampleSize: 1,
        },
        tags: ['goal-gate', category, details.source || 'unknown'],
      });
    } catch (err) {
      _log.debug(`[GOAL-GATE] Lesson record failed for ${category}:`, err.message);
    }
  }

  /**
   * Create a sub-goal under an existing goal
   */
  async addSubGoal(parentId, description, priority = 'medium') {
    return this.addGoal(description, 'goal-decomposition', priority, { parentId });
  }

  /**
   * Execute the next step of the top-priority active goal
   * Returns null if nothing to do
   */
  async executeNextStep() {
    const goal = this._getTopGoal();
    if (!goal) return null;

    if (goal.currentStep >= goal.steps.length) {
      goal.status = 'completed';
      goal.updated = new Date().toISOString();
      this._save();
      // Unblock dependent goals
      this._unblockDependents(goal.id);
      // Check if parent goal's sub-goals are all done
      if (goal.parentId) this._checkParentCompletion(goal.parentId);
      this.bus.emit('goal:completed', { id: goal.id, description: goal.description }, { source: 'GoalStack' });
      return { goalId: goal.id, action: 'completed', description: goal.description };
    }

    const step = goal.steps[goal.currentStep];
    goal.attempts++;
    goal.updated = new Date().toISOString();

    this.bus.emit('goal:step-start', {
      goalId: goal.id, stepIndex: goal.currentStep, step: goal.currentStep + 1,
      total: goal.steps.length, action: step.action,
    }, { source: 'GoalStack' });

    try {
      // GoalStackExecution mixin — single cast covers all delegated calls in this method
      const _exe = /** @type {import('./GoalStackExecution').GoalStackExecutionMixin} */ (/** @type {any} */ (this));
      const result = await _exe._executeStep(step, goal);

      // Record result
      goal.results.push({
        step: goal.currentStep,
        action: step.action,
        success: result.success,
        output: (result.output || '').slice(0, 500),
        timestamp: new Date().toISOString(),
      });

      if (result.success) {
        goal.currentStep++;
        goal.attempts = 0; // Reset attempts for next step

        // Check if goal is now complete
        if (goal.currentStep >= goal.steps.length) {
          goal.status = 'completed';
          this.bus.emit('goal:completed', { id: goal.id, description: goal.description }, { source: 'GoalStack' });
        }
      } else {
        // Step failed
        if (goal.attempts >= goal.maxAttempts) {
          // Too many failures on this step — try replanning
          const replanned = await _exe._replan(goal, result.error);
          if (!replanned) {
            goal.status = 'failed';
            this.bus.emit('goal:failed', { id: goal.id, reason: result.error || 'step failed (no error details)' }, { source: 'GoalStack' });
          }
        }
      }

      this._save();
      return {
        goalId: goal.id,
        action: step.action,
        step: goal.currentStep,
        total: goal.steps.length,
        success: result.success,
        output: result.output,
      };
    } catch (err) {
      goal.results.push({
        step: goal.currentStep,
        action: step.action,
        success: false,
        output: err.message,
        timestamp: new Date().toISOString(),
      });
      this._save();
      return { goalId: goal.id, action: step.action, success: false, output: err.message };
    }
  }

  // ── Step Execution, Decomposition, Replanning → GoalStackExecution.js (v5.6.0) ──
  // (prototype delegation, see bottom of file)

  // ── Query ────────────────────────────────────────────────

  getActiveGoals() { return this.goals.filter(g => g.status === 'active'); }
  getAll() { return this.goals; }
  _getTopGoal() {
    return this.goals.find(g => g.status === 'active');
  }

  getProgress(goalId) {
    const goal = this.goals.find(g => g.id === goalId);
    if (!goal) return null;
    return {
      ...goal,
      progress: goal.steps.length > 0
        ? Math.round((goal.currentStep / goal.steps.length) * 100)
        : 0,
    };
  }

  pauseGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (g) { g.status = 'paused'; g.updated = new Date().toISOString(); this._save(); }
  }

  resumeGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (g) { g.status = 'active'; g.updated = new Date().toISOString(); this._save(); }
  }

  abandonGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (g) { g.status = 'abandoned'; g.updated = new Date().toISOString(); this._save(); }
  }

  // ── Hierarchy ───────────────────────────────────────────

  /** Get sub-goals of a parent goal */
  getSubGoals(parentId) {
    return this.goals.filter(g => g.parentId === parentId);
  }

  /** Get a tree structure of goals */
  getGoalTree() {
    const roots = this.goals.filter(g => !g.parentId);
    const buildNode = (goal) => ({
      ...goal,
      children: this.goals.filter(g => g.parentId === goal.id).map(buildNode),
    });
    return roots.map(buildNode);
  }

  /** Unblock goals that were waiting for a completed goal */
  _unblockDependents(completedId) {
    for (const g of this.goals) {
      if (g.status !== 'blocked' || !g.blockedBy?.length) continue;
      g.blockedBy = g.blockedBy.filter(id => id !== completedId);
      if (g.blockedBy.length === 0) {
        g.status = 'active';
        g.updated = new Date().toISOString();
        this.bus.emit('goal:unblocked', { id: g.id, description: g.description }, { source: 'GoalStack' });
      }
    }
    this._save();
  }

  /** Check if all sub-goals of a parent are done */
  _checkParentCompletion(parentId) {
    if (!parentId) return;
    const parent = this.goals.find(g => g.id === parentId);
    if (!parent || parent.status === 'completed') return;
    const children = this.goals.filter(g => g.parentId === parentId);
    if (children.length > 0 && children.every(c => c.status === 'completed')) {
      parent.status = 'completed';
      parent.updated = new Date().toISOString();
      this._save();
      this.bus.emit('goal:completed', { id: parent.id, description: parent.description, via: 'sub-goals' }, { source: 'GoalStack' });
    }
  }

  // ── Internal ─────────────────────────────────────────────

  _prioritize() {
    const order = { high: 0, medium: 1, low: 2 };
    this.goals.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return (order[a.priority] || 1) - (order[b.priority] || 1);
    });
    if (this.goals.length > this.maxGoals) {
      this.goals = this.goals.filter(g => g.status === 'active').slice(0, this.maxGoals);
    }
  }

  _save() {
    try {
      if (this.storage) this.storage.writeJSONDebounced('goals.json', this.goals);
    } catch (err) { _log.warn('[GOALS] Save failed:', err.message); }
  }

  /**
   * v3.8.0: Async boot-time data loading.
   * Called by Container.bootAll() after all services are resolved.
   */
  async asyncLoad() {
    this.goals = this._load();
  }


  _load() {
    try {
      if (this.storage) return this.storage.readJSON('goals.json', []);
    } catch (err) { _log.debug('[GOALS] Load failed:', err.message); }
    return [];
  }
}

module.exports = { GoalStack };

// Extracted to GoalStackExecution.js (v5.6.0) — same pattern
// as IdleMind → IdleMindActivities, DreamCycle → DreamCycleAnalysis.
const { execution } = require('./GoalStackExecution');
Object.assign(GoalStack.prototype, execution);
