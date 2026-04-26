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
  constructor({ lang, bus,  model, prompts, storageDir, storage, selfGate}) {
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

    // v7.3.6 #2: Self-Gate — optional telemetry. Records observations
    // on non-user goal pushes; never blocks.
    this.selfGate = selfGate || null;
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
    // v7.3.6 #2: Self-Gate observation. Only fires for non-user sources
    // — user-originated goals are always responsive. Idle, daemon, and
    // self-originated goals get observed for topic mismatch. Telemetry
    // event fires; the goal always pushes.
    if (this.selfGate && source !== 'user') {
      try {
        this.selfGate.check({
          actionType: 'goal-push',
          actionPayload: { label: description, description },
          userContext: options.userContext || '',
          triggerSource: options.triggerSource || `goal source: ${source}`,
        });
      } catch (err) {
        _log.debug('[SELF-GATE] goal-push check skipped:', err?.message);
      }
    }

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
      status: 'active',       // active | paused | completed | failed | abandoned | blocked | stalled
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
    // v7.3.6 patch: propagate parent identity into triggerSource so Self-Gate
    // can see where decomposition-pushed sub-goals originate.
    return this.addGoal(description, 'goal-decomposition', priority, {
      parentId,
      triggerSource: `decomposition from parent goal ${parentId}`,
    });
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

  /**
   * v7.4.0: Runtime snapshot for RuntimeStatePort.
   * I/O-free, in-memory only. Returns goal counts and the
   * top active goal's description (truncated to 80 chars
   * for budget). Full descriptions are NEVER exposed to keep
   * the prompt block compact.
   */
  getRuntimeSnapshot() {
    const open = this.goals.filter(g => g.status === 'active').length;
    const paused = this.goals.filter(g => g.status === 'paused').length;
    const blocked = this.goals.filter(g => g.status === 'blocked').length;
    const top = this._getTopGoal();
    let topTitle = null;
    if (top && typeof top.description === 'string') {
      topTitle = top.description.length > 80
        ? top.description.slice(0, 77) + '...'
        : top.description;
    }
    return {
      open,
      paused,
      blocked,
      topTitle,
    };
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

  // FIX v7.4.1: Terminal-state guards. Without these, pauseGoal(completedId)
  // would silently overwrite 'completed' → 'paused', and resumeGoal(failedId)
  // would resurrect a failed goal. markStalled/markObsolete already had this
  // guard since v7.3.3 — pause/resume/abandon were missing it.
  /**
   * Terminal statuses = completed | failed | abandoned.
   *
   * `stalled` and `paused` are intentionally NOT terminal — they are
   * active-with-warning. This matters because `pauseGoal()` and
   * `resumeGoal()` below guard against terminal status; if `stalled`
   * were terminal, stalled goals could never be paused or resumed,
   * which defeats the "stalled = needs intervention" semantics.
   *
   * See v7.4.2 "Kassensturz" Baustein B for the regression test that
   * locks this behavior.
   */
  static _isTerminal(status) {
    return status === 'completed' || status === 'failed' || status === 'abandoned';
  }

  pauseGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || GoalStack._isTerminal(g.status)) return false;
    g.status = 'paused'; g.updated = new Date().toISOString(); this._save();
    return true;
  }

  resumeGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || GoalStack._isTerminal(g.status)) return false;
    g.status = 'active'; g.updated = new Date().toISOString(); this._save();
    return true;
  }

  /**
   * v7.4.5.fix #22: Public API to mark a goal as completed.
   * Symmetric with abandonGoal/pauseGoal. Used by GoalDriver after a
   * successful AgentLoop.pursue() — AgentLoop runs its own plan
   * (not goal.steps) and never sets goal.status itself, so without
   * this call the goal would stay 'active' forever and the periodic
   * scan would keep re-picking it.
   *
   * @param {string} goalId
   * @returns {boolean} true if the goal was marked completed,
   *   false if it didn't exist or was already terminal.
   */
  completeGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || GoalStack._isTerminal(g.status)) return false;
    g.status = 'completed';
    g.completedAt = new Date().toISOString();
    g.updated = g.completedAt;
    this._save();
    // Cascading effects (matching the executeNextStep completion path).
    this._unblockDependents(goalId);
    if (g.parentId) this._checkParentCompletion(g.parentId);
    if (this.bus && this.bus.emit) {
      this.bus.emit('goal:completed', {
        id: g.id, description: g.description,
      }, { source: 'GoalStack' });
    }
    return true;
  }

  abandonGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || GoalStack._isTerminal(g.status)) return false;
    g.status = 'abandoned'; g.updated = new Date().toISOString(); this._save();
    return true;
  }

  /**
   * v7.4.5 Baustein D: Block a parent goal on a sub-goal that
   * was spawned to clear an obstacle. The existing
   * _unblockDependents() chain takes care of unblocking once
   * the sub-goal completes.
   *
   * @param {string} parentId
   * @param {string} subId
   */
  blockOnSubgoal(parentId, subId) {
    const parent = this.goals.find(g => g.id === parentId);
    if (!parent) return false;
    if (GoalStack._isTerminal(parent.status)) return false;
    parent.status = 'blocked';
    parent.blockedBy = Array.isArray(parent.blockedBy) ? parent.blockedBy : [];
    if (!parent.blockedBy.includes(subId)) parent.blockedBy.push(subId);
    parent.updated = new Date().toISOString();
    if (!parent.childIds) parent.childIds = [];
    if (!parent.childIds.includes(subId)) parent.childIds.push(subId);
    this._save();
    if (this.bus && this.bus.fire) {
      this.bus.fire('goal:blocked-on-subgoal', {
        parentId, subId,
      }, { source: 'GoalStack' });
    }
    return true;
  }

  // ── v7.4.5 Baustein C: Resource-blocked goals ──────────

  /**
   * Block a goal because one or more required resources are missing.
   * The goal stays in the stack and is automatically re-pursued by
   * GoalDriver when ResourceRegistry emits 'resource:available' for
   * the missing tokens.
   *
   * @param {string} goalId
   * @param {string[]} resources - tokens that are missing
   *   (e.g. ['service:llm', 'network'])
   */
  blockOnResources(goalId, resources) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g) return false;
    if (GoalStack._isTerminal(g.status)) return false;
    g.status = 'blocked';
    g.blockedByResources = Array.isArray(resources) ? [...resources] : [];
    g.blockedAt = new Date().toISOString();
    g.updated = g.blockedAt;
    this._save();
    if (this.bus && this.bus.fire) {
      this.bus.fire('goal:blocked-on-resources', {
        goalId, resources: g.blockedByResources,
      }, { source: 'GoalStack' });
    }
    return true;
  }

  /**
   * A resource came back. For every goal blocked-on-resources that
   * lists this token, remove it from the blocked-list. If the list
   * becomes empty, transition goal back to 'active'.
   *
   * Returns the array of goal IDs that became active.
   *
   * @param {string} resourceToken
   */
  unblockOnResource(resourceToken) {
    if (!resourceToken) return [];
    const reactivated = [];
    for (const g of this.goals) {
      if (g.status !== 'blocked') continue;
      if (!Array.isArray(g.blockedByResources)) continue;
      const before = g.blockedByResources.length;
      g.blockedByResources = g.blockedByResources.filter(t => t !== resourceToken);
      if (g.blockedByResources.length === before) continue;  // no change for this goal
      if (g.blockedByResources.length === 0) {
        g.status = 'active';
        g.updated = new Date().toISOString();
        delete g.blockedAt;
        reactivated.push(g.id);
      }
    }
    if (reactivated.length > 0) {
      this._save();
      if (this.bus && this.bus.fire) {
        for (const id of reactivated) {
          this.bus.fire('goal:resumed-from-resource-block', {
            goalId: id, resource: resourceToken,
          }, { source: 'GoalStack' });
        }
      }
    }
    return reactivated;
  }

  // ── v7.3.3: Extended lifecycle states ───────────────────

  /**
   * Mark a goal as stalled — it's active but has made no progress for too long.
   * Stalled goals remain visible but don't block new proposals. They can be
   * resumed (set back to active) or abandoned by the user.
   *
   * Use this when Genesis decides, during self-review, that a goal is stuck
   * and wants to acknowledge it honestly instead of pretending to still work on it.
   *
   * @param {string} goalId
   * @param {string} reason - Why it's stalled (recorded on the goal)
   */
  markStalled(goalId, reason = 'no-progress') {
    const g = this.goals.find(g => g.id === goalId);
    if (!g) return false;
    if (g.status === 'completed' || g.status === 'failed' || g.status === 'abandoned') return false;
    g.status = 'stalled';
    g.stalledReason = String(reason).slice(0, 200);
    g.updated = new Date().toISOString();
    this._save();
    this.bus.emit('goal:stalled', {
      id: g.id, description: g.description, reason: g.stalledReason,
    }, { source: 'GoalStack' });
    return true;
  }

  /**
   * Mark a goal as obsolete — the world changed and the goal is no longer
   * relevant. Distinct from abandoned (user gave up) and stalled (stuck but
   * still relevant). Obsolete means: there's no point in pursuing this anymore,
   * regardless of whether progress was possible.
   *
   * Example: "Implement feature X" becomes obsolete if X is deprecated.
   *
   * @param {string} goalId
   * @param {string} reason
   */
  markObsolete(goalId, reason = 'no-longer-relevant') {
    const g = this.goals.find(g => g.id === goalId);
    if (!g) return false;
    if (g.status === 'completed' || g.status === 'failed' || g.status === 'abandoned') return false;
    g.status = 'obsolete';
    g.obsoleteReason = String(reason).slice(0, 200);
    g.updated = new Date().toISOString();
    this._save();
    this.bus.emit('goal:obsolete', {
      id: g.id, description: g.description, reason: g.obsoleteReason,
    }, { source: 'GoalStack' });
    return true;
  }

  /**
   * v7.3.3: Autonomous goal review — Genesis walks his own goal list and
   * decides, for each active goal, whether it's still a live pursuit.
   *
   * Three conditions that trigger automatic state changes:
   *  - stalled: active and no progress for >= stallThresholdHours (default 72h)
   *  - auto-complete: all steps complete but status never got flipped (bug)
   *  - auto-fail: attempts exhausted on a step but status never got flipped (bug)
   *
   * Returns a summary of what was changed. User-sourced goals are only
   * auto-transitioned when closeOwnGoals: true (the default for dream-cycle
   * autonomous review).
   *
   * @param {object} [opts]
   * @param {number} [opts.stallThresholdHours=72] - Hours of inactivity for stalled
   * @param {boolean} [opts.closeOwnGoals=true] - Genesis auto-closes his own goals
   * @returns {{ changed: Array<{id:string, from:string, to:string, reason:string}>, reviewed: number }}
   */
  reviewGoals({ stallThresholdHours = 72, closeOwnGoals = true } = {}) {
    const now = Date.now();
    const stallMs = stallThresholdHours * 60 * 60 * 1000;
    const changed = [];
    let reviewed = 0;

    for (const g of this.goals) {
      if (g.status !== 'active') continue;
      reviewed++;

      // Auto-complete: all steps done but status never flipped
      if (g.steps?.length > 0 && g.currentStep >= g.steps.length) {
        g.status = 'completed';
        g.updated = new Date().toISOString();
        changed.push({ id: g.id, from: 'active', to: 'completed', reason: 'all-steps-done-but-status-was-active' });
        this.bus.emit('goal:completed', { id: g.id, description: g.description, auto: true }, { source: 'GoalStack:review' });
        continue;
      }

      // Auto-fail: attempts exhausted on a step but status never flipped
      if (g.attempts >= (g.maxAttempts || 3) && g.currentStep < (g.steps?.length || 0)) {
        g.status = 'failed';
        g.updated = new Date().toISOString();
        changed.push({ id: g.id, from: 'active', to: 'failed', reason: 'attempts-exhausted-but-status-was-active' });
        this.bus.emit('goal:failed', { id: g.id, reason: 'auto-review: attempts exhausted', auto: true }, { source: 'GoalStack:review' });
        continue;
      }

      // Stalled: no updates for too long
      const lastUpdate = new Date(g.updated || g.created).getTime();
      if (Number.isFinite(lastUpdate) && (now - lastUpdate) > stallMs) {
        // User-sourced goals: only flag, don't auto-change
        if (g.source === 'user' && !closeOwnGoals) continue;
        if (g.source !== 'user' || closeOwnGoals) {
          g.status = 'stalled';
          g.stalledReason = `no progress for ${Math.floor((now - lastUpdate) / (60 * 60 * 1000))}h`;
          g.updated = new Date().toISOString();
          changed.push({ id: g.id, from: 'active', to: 'stalled', reason: g.stalledReason });
          this.bus.emit('goal:stalled', {
            id: g.id, description: g.description, reason: g.stalledReason, auto: true,
          }, { source: 'GoalStack:review' });
        }
      }
    }

    if (changed.length > 0) {
      this._save();
      _log.info(`[GOAL-REVIEW] ${changed.length} state changes across ${reviewed} active goals`);
    }
    return { changed, reviewed };
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

  /**
   * v7.4.0: Runtime snapshot — see the one defined earlier in
   * this class (at line ~359). This was a duplicate definition
   * that JavaScript silently overwrote; removed in v7.4.0 cleanup.
   */
}

module.exports = { GoalStack };

// Extracted to GoalStackExecution.js (v5.6.0) — same pattern
// as IdleMind → IdleMindActivities, DreamCycle → DreamCycleAnalysis.
const { execution } = require('./GoalStackExecution');
Object.assign(GoalStack.prototype, execution);
