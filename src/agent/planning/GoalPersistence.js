// @ts-checked-v5.7
// ============================================================
// GENESIS — GoalPersistence.js (Phase 10 — Persistent Agency)
//
// THE MISSING PIECE: Goals that survive restarts.
// Without this, Genesis is a tool, not an agent.
//
// Responsibilities:
//   1. Serialize active goals + progress to StorageService
//   2. On boot: load unfinished goals, prompt user for resume
//   3. Track partial results per step (crash recovery)
//   4. Auto-checkpoint after every completed step
//   5. Garbage-collect completed/abandoned goals after N days
//
// Integration:
//   GoalStack.addGoal()     → GoalPersistence.checkpoint()
//   AgentLoop.postStep()    → GoalPersistence.checkpointStep()
//   AgentCore.boot()        → GoalPersistence.loadAndResume()
//   GoalStack.completeGoal()→ GoalPersistence.markComplete()
//
// Storage format:
//   .genesis/goals/active.json   — currently active goals
//   .genesis/goals/archive.json  — completed/failed (last 50)
//   .genesis/goals/steps/<goalId>.json — step-level checkpoints
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalPersistence');

const GOAL_STATUSES = new Set(['active', 'paused', 'blocked', 'running']);
const ARCHIVE_MAX = 50;
const GC_DAYS = 30;

class GoalPersistence {
  static containerConfig = {
    name: 'goalPersistence',
    phase: 4,
    deps: ['storage', 'goalStack', 'eventStore'],
    tags: ['planning', 'persistence'],
    lateBindings: [
      { prop: 'agentLoop', service: 'agentLoop', optional: true },
    ],
  };

  constructor({ bus, storage, goalStack, eventStore, config }) {
    this.bus = bus || NullBus;
    this.storage = storage;
    this.goalStack = goalStack;
    this.eventStore = eventStore || null;
    this.agentLoop = null; // lateBinding

    const cfg = config || {};
    this._archiveMax = cfg.archiveMax || ARCHIVE_MAX;
    this._gcDays = cfg.gcDays || GC_DAYS;
    this._autoResumeEnabled = cfg.autoResume !== false;

    // ── State ────────────────────────────────────────────
    this._activeGoals = [];
    this._archive = [];
    this._stepCheckpoints = new Map(); // goalId → { stepIndex, partialResult, timestamp }
    this._loaded = false;

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      checkpoints: 0,
      resumes: 0,
      gcRuns: 0,
      goalsArchived: 0,
    };

    /** @type {Array<Function>} */
    this._unsubs = [];

    // ── Wire into GoalStack events ──────────────────────
    this._unsubs.push(
      this.bus.on('goal:created', (data) => this._onGoalCreated(data), { source: 'GoalPersistence' }),
      this.bus.on('goal:completed', (data) => this._onGoalCompleted(data), { source: 'GoalPersistence' }),
      this.bus.on('goal:failed', (data) => this._onGoalFailed(data), { source: 'GoalPersistence' }),
      this.bus.on('goal:abandoned', (data) => this._onGoalAbandoned(data), { source: 'GoalPersistence' }),
      // v4.12.5-fix: Standardized from 'agentloop:step-complete' to 'agent-loop:step-complete'
      this.bus.on('agent-loop:step-complete', (data) => this._onStepComplete(data), { source: 'GoalPersistence' }),
    );
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Load persisted goals and return unfinished ones.
   * Called during boot by AgentCore.
   * @returns {Promise<object>}
   */
  async load() {
    try {
      const raw = await this.storage.readJSON('goals/active.json');
      this._activeGoals = Array.isArray(raw) ? raw : [];
    } catch (_e) { _log.debug("[catch] load active goals:", _e.message);
      this._activeGoals = [];
    }

    try {
      const rawArchive = await this.storage.readJSON('goals/archive.json');
      this._archive = Array.isArray(rawArchive) ? rawArchive : [];
    } catch (_e) { _log.debug("[catch] load goal archive:", _e.message);
      this._archive = [];
    }

    // Load step checkpoints for active goals
    for (const goal of this._activeGoals) {
      try {
        const stepData = await this.storage.readJSON(`goals/steps/${goal.id}.json`);
        if (stepData) {
          this._stepCheckpoints.set(goal.id, stepData);
        }
      } catch (_e) { _log.debug('[catch] no checkpoint — fine:', _e.message); }
    }

    this._loaded = true;
    const unfinished = this._activeGoals.filter(g => GOAL_STATUSES.has(g.status));

    this.bus.emit('goals:loaded', {
      total: this._activeGoals.length,
      unfinished: unfinished.length,
      archived: this._archive.length,
    }, { source: 'GoalPersistence' });

    return { unfinished, archive: this._archive };
  }

  /**
   * Restore unfinished goals into GoalStack.
   * Returns goals that were resumed.
   * @returns {Promise<Array>} resumed goals
   */
  async resume() {
    if (!this._loaded) await this.load();

    const unfinished = this._activeGoals.filter(g => GOAL_STATUSES.has(g.status));
    if (unfinished.length === 0) return [];

    const resumed = [];

    for (const goal of unfinished) {
      // Restore into GoalStack without re-decomposing
      const existingGoal = this.goalStack.goals.find(g => g.id === goal.id);
      if (existingGoal) continue; // Already in stack

      // Inject directly into GoalStack
      this.goalStack.goals.push(goal);
      resumed.push(goal);

      // Restore step checkpoint if available
      const checkpoint = this._stepCheckpoints.get(goal.id);
      if (checkpoint && typeof checkpoint.stepIndex === 'number') {
        goal.currentStep = checkpoint.stepIndex;
        if (checkpoint.partialResults) {
          goal.results = checkpoint.partialResults;
        }
      }

      this.bus.emit('goal:resumed', {
        id: goal.id,
        description: goal.description,
        step: goal.currentStep,
        totalSteps: goal.steps ? goal.steps.length : 0,
      }, { source: 'GoalPersistence' });
    }

    if (resumed.length > 0) {
      this.goalStack._prioritize();
      this._stats.resumes += resumed.length;
    }

    return resumed;
  }

  /**
   * Checkpoint current goal state to disk.
   * Called after every significant state change.
   */
  async checkpoint() {
    if (!this.goalStack) return;

    // Sync from GoalStack
    this._activeGoals = this.goalStack.goals.filter(g => GOAL_STATUSES.has(g.status));

    try {
      await this.storage.writeJSON('goals/active.json', this._activeGoals);
      this._stats.checkpoints++;
    } catch (err) {
      _log.warn('[GOAL-PERSIST] Checkpoint failed:', err.message);
    }
  }

  /**
   * Checkpoint a specific step's progress (crash recovery).
   * @param {string} goalId
   * @param {number} stepIndex
   * @param {object} partialResult
   */
  async checkpointStep(goalId, stepIndex, partialResult) {
    const data = {
      goalId,
      stepIndex,
      partialResult,
      partialResults: this._getGoalResults(goalId),
      timestamp: Date.now(),
    };

    this._stepCheckpoints.set(goalId, data);

    try {
      await this.storage.writeJSON(`goals/steps/${goalId}.json`, data);
    } catch (err) {
      _log.warn('[GOAL-PERSIST] Step checkpoint failed:', err.message);
    }
  }

  /**
   * Get summary of persisted goals for UI/prompt injection.
   * @returns {object}
   */
  getSummary() {
    const active = this._activeGoals.filter(g => g.status === 'active' || g.status === 'running');
    const paused = this._activeGoals.filter(g => g.status === 'paused' || g.status === 'blocked');

    return {
      active: active.length,
      paused: paused.length,
      descriptions: active.slice(0, 5).map(g => ({
        id: g.id,
        description: g.description,
        progress: g.steps ? `${g.currentStep}/${g.steps.length}` : 'unknown',
        source: g.source,
      })),
    };
  }

  /**
   * Garbage-collect old archived goals.
   */
  async gc() {
    const cutoff = Date.now() - this._gcDays * 24 * 60 * 60 * 1000;
    const before = this._archive.length;

    this._archive = this._archive.filter(g => {
      const ts = g.completedAt || g.updated || g.created;
      return new Date(ts).getTime() > cutoff;
    });

    // Also trim to max
    if (this._archive.length > this._archiveMax) {
      this._archive = this._archive.slice(-this._archiveMax);
    }

    if (this._archive.length !== before) {
      await this.storage.writeJSON('goals/archive.json', this._archive);
      this._stats.gcRuns++;
    }

    // Clean step checkpoints for non-existent goals
    const activeIds = new Set(this._activeGoals.map(g => g.id));
    for (const [goalId] of this._stepCheckpoints) {
      if (!activeIds.has(goalId)) {
        this._stepCheckpoints.delete(goalId);
        try { await this.storage.delete(`goals/steps/${goalId}.json`); } catch (_e) { _log.debug('[catch] delete goal steps:', _e.message); }
      }
    }
  }

  getStats() {
    return {
      ...this._stats,
      activeGoals: this._activeGoals.length,
      archivedGoals: this._archive.length,
      stepCheckpoints: this._stepCheckpoints.size,
    };
  }

  // ════════════════════════════════════════════════════════
  // EVENT HANDLERS
  // ════════════════════════════════════════════════════════

  _onGoalCreated(data) {
    this.checkpoint().catch(() => { /* best effort */ });
  }

  _onGoalCompleted(data) {
    this._archiveGoal(data.id, 'completed');
  }

  _onGoalFailed(data) {
    this._archiveGoal(data.id, 'failed');
  }

  _onGoalAbandoned(data) {
    this._archiveGoal(data.id, 'abandoned');
  }

  _onStepComplete(data) {
    if (data.goalId && typeof data.stepIndex === 'number') {
      this.checkpointStep(data.goalId, data.stepIndex, data.result).catch(() => { /* best effort */ });
    }
    this.checkpoint().catch(() => { /* best effort */ });
  }

  // ════════════════════════════════════════════════════════
  // INTERNAL
  // ════════════════════════════════════════════════════════

  async _archiveGoal(goalId, status) {
    const goal = this._activeGoals.find(g => g.id === goalId);
    if (!goal) return;

    goal.status = status;
    goal.completedAt = new Date().toISOString();
    this._archive.push(goal);
    this._activeGoals = this._activeGoals.filter(g => g.id !== goalId);
    this._stepCheckpoints.delete(goalId);

    this._stats.goalsArchived++;

    try {
      await this.storage.writeJSON('goals/active.json', this._activeGoals);
      await this.storage.writeJSON('goals/archive.json', this._archive);
      try { await this.storage.delete(`goals/steps/${goalId}.json`); } catch (_e) { _log.debug('[catch] delete archived steps:', _e.message); }
    } catch (err) {
      _log.warn('[GOAL-PERSIST] Archive failed:', err.message);
    }
  }

  _getGoalResults(goalId) {
    const goal = this.goalStack?.goals?.find(g => g.id === goalId);
    return goal?.results || [];
  }

  // v5.9.9: Lifecycle compliance — unsubscribe listeners + sync persist
  stop() {
    for (const unsub of this._unsubs) {
      try { if (typeof unsub === 'function') unsub(); } catch (_e) { /* ok */ }
    }
    this._unsubs.length = 0;

    // Sync persist active goals on shutdown
    try {
      this.storage?.writeJSONSync?.('goals/active.json', this._activeGoals);
    } catch (_e) {
      _log.debug('[catch] GoalPersistence sync persist on stop:', _e?.message);
    }
  }
}

module.exports = { GoalPersistence };
