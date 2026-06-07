// @ts-checked-v5.8
// ============================================================
// GENESIS — GoalStackLifecycle.js (v7.6.8)
//
// Mixin extraction from GoalStack.js. Holds the lifecycle and
// hierarchy concern: status transitions (pause/resume/complete/
// abandon, block/unblock, stalled/obsolete), bulk auto-review,
// sub-goal tree queries, and the dependency-unblock chain.
//
// Mounted onto GoalStack.prototype via:
//   Object.assign(GoalStack.prototype, goalStackLifecycleMixin)
//
// Pure structural extraction — runtime semantics unchanged from
// the pre-v7.6.8 inline form. Same pattern as
// SettingsEncryption (v7.6.7), ModelBridgeFailover (v7.6.5), and
// ModelBridgeAvailability/Discovery (v7.5.6).
// ============================================================

'use strict';

const { createLogger } = require('../core/Logger');
const _log = createLogger('GoalStack');

// Module-level helper. Mirrors GoalStack._isTerminal() static — duplicated
// here to keep the mixin file independent of GoalStack.js (would otherwise
// create a circular require). Same condition string-list.
function isTerminal(status) {
  return status === 'completed' || status === 'failed' || status === 'abandoned';
}

const goalStackLifecycleMixin = {

  // ── Status transitions: pause / resume / complete / abandon ────

  pauseGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || isTerminal(g.status)) return false;
    g.status = 'paused'; g.updated = new Date().toISOString(); this._save();
    return true;
  },

  resumeGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || isTerminal(g.status)) return false;
    g.status = 'active'; g.updated = new Date().toISOString(); this._save();
    return true;
  },

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
  completeGoal(goalId, outcome = null) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || isTerminal(g.status)) return false;
    g.status = 'completed';
    g.completedAt = new Date().toISOString();
    g.updated = g.completedAt;
    // v7.9.20 (F2/K1): keep a compact outcome on the goal so a completion is
    // not just a status flip (the field showed completed goals carried no result).
    if (outcome) g.outcome = typeof outcome === 'string' ? outcome.slice(0, 400) : outcome;
    this._save();
    // Cascading effects (matching the executeNextStep completion path).
    this._unblockDependents(goalId);
    if (g.parentId) this._checkParentCompletion(g.parentId);
    if (this.bus && this.bus.emit) {
      // v7.9.20 (K1): emit success:true — 'completed' is by definition success
      // (vs failed/abandoned); CognitiveMonitor reads data.success to score
      // decision quality and previously saw it undefined → scored every
      // completed decision as a failure.
      this.bus.fire('goal:completed', {
        id: g.id, description: g.description, success: true, outcome: g.outcome || null,
      }, { source: 'GoalStack' });
    }
    return true;
  },

  abandonGoal(goalId) {
    const g = this.goals.find(g => g.id === goalId);
    if (!g || isTerminal(g.status)) return false;
    g.status = 'abandoned'; g.updated = new Date().toISOString(); this._save();
    return true;
  },

  // ── Block / unblock on sub-goal or resources ────────────────────

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
    if (isTerminal(parent.status)) return false;
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
  },

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
    if (isTerminal(g.status)) return false;
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
  },

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
  },

  // ── v7.3.3: Extended lifecycle states ──────────────────────────

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
    this.bus.fire('goal:stalled', {
      id: g.id, description: g.description, reason: g.stalledReason,
    }, { source: 'GoalStack' });
    return true;
  },

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
    this.bus.fire('goal:obsolete', {
      id: g.id, description: g.description, reason: g.obsoleteReason,
    }, { source: 'GoalStack' });
    return true;
  },

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
        this.bus.fire('goal:completed', { id: g.id, description: g.description, auto: true, success: true }, { source: 'GoalStack:review' });
        continue;
      }

      // Auto-fail: attempts exhausted on a step but status never flipped
      if (g.attempts >= (g.maxAttempts || 3) && g.currentStep < (g.steps?.length || 0)) {
        g.status = 'failed';
        g.updated = new Date().toISOString();
        changed.push({ id: g.id, from: 'active', to: 'failed', reason: 'attempts-exhausted-but-status-was-active' });
        this.bus.fire('goal:failed', { id: g.id, reason: 'auto-review: attempts exhausted', auto: true }, { source: 'GoalStack:review' });
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
          this.bus.fire('goal:stalled', {
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
  },

  // ── Hierarchy ──────────────────────────────────────────────────

  /** Get sub-goals of a parent goal */
  getSubGoals(parentId) {
    return this.goals.filter(g => g.parentId === parentId);
  },

  /** Get a tree structure of goals */
  getGoalTree() {
    const roots = this.goals.filter(g => !g.parentId);
    const buildNode = (goal) => ({
      ...goal,
      children: this.goals.filter(g => g.parentId === goal.id).map(buildNode),
    });
    return roots.map(buildNode);
  },

  /** Unblock goals that were waiting for a completed goal */
  _unblockDependents(completedId) {
    for (const g of this.goals) {
      if (g.status !== 'blocked' || !g.blockedBy?.length) continue;
      g.blockedBy = g.blockedBy.filter(id => id !== completedId);
      if (g.blockedBy.length === 0) {
        g.status = 'active';
        g.updated = new Date().toISOString();
        this.bus.fire('goal:unblocked', { id: g.id, description: g.description }, { source: 'GoalStack' });
      }
    }
    this._save();
  },

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
      this.bus.fire('goal:completed', { id: parent.id, description: parent.description, via: 'sub-goals', success: true }, { source: 'GoalStack' });
    }
  },

};

module.exports = { goalStackLifecycleMixin, isTerminal };
