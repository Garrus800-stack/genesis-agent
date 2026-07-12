// ============================================================
// GENESIS — src/agent/revolution/AgentLoopObstacles.js
//
// v7.9.29 (hygiene #7): repeated-failure recovery tactics
// (decompose-on-repeat + obstacle sub-goal spawn/loop-guard),
// extracted from AgentLoopRecovery to keep it under the 700-LOC guard.
// Class methods (no comma-rewriting) copied onto
// AgentLoopRecoveryDelegate.prototype via the mixin. this.* + _log.
// ============================================================

const { createLogger } = require('../core/Logger');
const _log = createLogger('AgentLoopRecovery');

class _AgentLoopObstaclesHost {
  async _tryDecomposeOnRepeatedFailure(step, result, stepIndex, onProgress) {
    // v7.9.37 (V-C): depth-1 guard — a decomposition child never spawns another
    // investigate (field 11.07.: identical-title recursion four levels deep;
    // the per-goal strike brake could not see the chain because every child is
    // a NEW goal). The normal failure path (3 attempts → abandon) takes over.
    if (this.loop && this.loop._goalSource === 'goal-decomposition') {
      _log.info('[D] depth-1 guard: investigate goals do not spawn investigates');
      return null;
    }
    const goalId = this.loop.currentGoalId;
    if (!goalId) return null;
    const errMsg = (result && result.error) ? String(result.error) : '';
    if (!errMsg) return null;
    // errorClass: first 80 chars of error message — coarse but stable enough
    // to detect "same failure-class again" across retries (LLM-generated
    // errors with timestamps would never match by full text).
    const errorClass = errMsg.slice(0, 80);
    const failKey = `${goalId}::${errorClass}`;
    this._sweepRepeatedFailures();
    const prev = this._repeatedFailures.get(failKey);
    const strikes = (prev?.count || 0) + 1;
    this._repeatedFailures.set(failKey, { count: strikes, ts: Date.now() });
    // 1st strike: just record. 2nd strike: spawn. 3rd+: don't double-spawn.
    if (strikes !== 2) return null;
    const syntheticObstacle = {
      contextKey: `repeated-failure-${errorClass.slice(0, 30).replace(/\s+/g, '_')}`,
      subGoalDescription: `Investigate why this goal repeatedly fails with: ${errorClass}. Document findings, then describe a different approach.`,
    };
    onProgress({ phase: 'decompose-on-failure', detail: `2nd strike of same error-class on goal — spawning investigative sub-goal`, errorClass });
    try {
      this.loop.bus.fire('agent-loop:decompose-on-failure', {
        goalId, stepIndex, errorClass: errorClass.slice(0, 80), strikes,
      }, { source: 'AgentLoopRecovery' });
    } catch (_e) { /* never let emit break the recovery path */ }
    const spawned = await this._trySpawnObstacleSubgoal(syntheticObstacle, step, stepIndex, onProgress);
    if (spawned.spawned) {
      return { action: 'blocked-on-subgoal', category: 'repeated-failure', subId: spawned.subId };
    }
    return null;
  }

  /** v7.9.9 Fix 3: drop _repeatedFailures entries older than TTL. */
  _sweepRepeatedFailures() {
    const now = Date.now();
    const ttl = this._REPEATED_FAILURES_TTL_MS;
    for (const [key, entry] of this._repeatedFailures.entries()) {
      if (now - entry.ts > ttl) this._repeatedFailures.delete(key);
    }
  }

  // ── v7.4.5 Baustein D: Sub-goal spawn for known obstacles ──

  /**
   * Try to spawn a sub-goal that resolves the obstacle, then block
   * the parent on it. Refuses to spawn if:
   *   - depth limit reached (max 3 levels of recursion)
   *   - loop protection fires (same contextPath 3+ times in 5 min)
   *   - LessonsStore has 3+ recent lessons saying "subgoal-failed"
   *     for this obstacle pattern
   *
   * @param {{type:string, contextKey:string, subGoalDescription:string}} obstacle
   * @param {object} step
   * @param {number} stepIndex
   * @param {Function} onProgress
   * @returns {Promise<{spawned: boolean, reason?: string, subId?: string}>}
   */
  async _trySpawnObstacleSubgoal(obstacle, step, stepIndex, onProgress) {
    const goalStack = this.loop.goalStack;
    const parentId = this.loop.currentGoalId;
    if (!goalStack || !parentId) {
      return { spawned: false, reason: 'no-goalstack-or-parent' };
    }

    const parent = goalStack.goals?.find(g => g.id === parentId);
    if (!parent) return { spawned: false, reason: 'parent-not-found' };

    // Recursion-depth limit: max 3 levels
    const MAX_DEPTH = 3;
    let depth = 0;
    let cursor = parent;
    while (cursor && cursor.parentId) {
      depth += 1;
      if (depth >= MAX_DEPTH) {
        this._fireLoopProtected(parentId, obstacle, 'depth-limit');
        return { spawned: false, reason: 'depth-limit' };
      }
      cursor = goalStack.goals?.find(g => g.id === cursor.parentId);
    }

    // Loop protection — contextPath = parentId/stepIndex/contextKey
    const contextPath = `${parentId}/${stepIndex}/${obstacle.contextKey}`;
    if (this._isObstacleLoop(contextPath)) {
      this._fireLoopProtected(parentId, obstacle, 'loop-protection');
      return { spawned: false, reason: 'loop-protection' };
    }

    // Lessons-Konsum — has this obstacle pattern repeatedly failed?
    const lessons = this._recallObstacleLessons(obstacle);
    if (lessons.recentFailures >= 3) {
      this._fireLoopProtected(parentId, obstacle, 'lessons-veto');
      return { spawned: false, reason: 'lessons-veto' };
    }

    // OK — spawn sub-goal
    let subGoal;
    try {
      subGoal = await goalStack.addSubGoal(parentId, obstacle.subGoalDescription, 'high');
    } catch (err) {
      _log.warn('[D] addSubGoal failed:', err.message);
      return { spawned: false, reason: 'addSubGoal-error' };
    }
    if (!subGoal || !subGoal.id) {
      return { spawned: false, reason: 'no-subgoal-id' };
    }

    // Annotate the sub-goal with provenance for later reference
    subGoal.spawnedFor = {
      obstacleType: obstacle.type,
      contextKey: obstacle.contextKey,
      stepIndex,
      stepType: step.type,
    };

    // Park parent on sub-goal
    if (typeof goalStack.blockOnSubgoal === 'function') {
      goalStack.blockOnSubgoal(parentId, subGoal.id);
    }

    // Record contextPath for future loop-protection
    this._recordObstacleSpawn(contextPath);

    // Emit observable event for dashboards / tests
    if (this.loop.bus && this.loop.bus.fire) {
      this.loop.bus.fire('goal:subgoal-spawned', {
        parentId,
        subId: subGoal.id,
        obstacleType: obstacle.type,
        contextKey: obstacle.contextKey,
        stepIndex,
        description: obstacle.subGoalDescription,
      }, { source: 'AgentLoopRecovery' });
    }

    onProgress?.({ phase: 'subgoal-spawned', subGoalId: subGoal.id, obstacle: obstacle.type });
    _log.info(`[D] obstacle "${obstacle.type || obstacle.name || 'synthetic'}" → spawned sub-goal ${subGoal.id} (parent=${parentId})`); // v7.9.37 (V-C): never log "undefined"

    return { spawned: true, subId: subGoal.id };
  }

  // Loop-protection bookkeeping. Window: last 5 minutes.
  // Threshold semantics: if there are already 2+ recorded spawns
  // for this contextPath in the window, the *next* spawn (this 3rd
  // attempt) is the one we refuse — that's the third strike.
  _isObstacleLoop(contextPath) {
    if (!this._obstacleSpawnLog) this._obstacleSpawnLog = new Map();
    const now = Date.now();
    const WINDOW_MS = 5 * 60 * 1000;
    const THRESHOLD = 2;
    const hits = (this._obstacleSpawnLog.get(contextPath) || []).filter(t => now - t < WINDOW_MS);
    return hits.length >= THRESHOLD;
  }

  _recordObstacleSpawn(contextPath) {
    if (!this._obstacleSpawnLog) this._obstacleSpawnLog = new Map();
    const now = Date.now();
    const list = this._obstacleSpawnLog.get(contextPath) || [];
    list.push(now);
    // GC: keep only last 5 minutes
    const WINDOW_MS = 5 * 60 * 1000;
    this._obstacleSpawnLog.set(contextPath, list.filter(t => now - t < WINDOW_MS));
  }

  _recallObstacleLessons(obstacle) {
    try {
      const lessonsStore = this.loop.lessonsStore || this.loop._lessonsStore;
      if (!lessonsStore || typeof lessonsStore.recall !== 'function') {
        return { recentFailures: 0 };
      }
      const lessons = lessonsStore.recall('obstacle-resolution', {
        contextKey: obstacle.contextKey,
        type: obstacle.type,
      }, 5) || [];
      const recentFailures = lessons.filter(l => l?.outcome === 'subgoal-failed').length;
      return { recentFailures, lessons };
    } catch (_e) {
      return { recentFailures: 0 };
    }
  }

  _fireLoopProtected(parentId, obstacle, reason) {
    if (this.loop.bus && this.loop.bus.fire) {
      this.loop.bus.fire('goal:obstacle-loop-protected', {
        parentId,
        obstacleType: obstacle.type,
        contextKey: obstacle.contextKey,
        reason,
      }, { source: 'AgentLoopRecovery' });
    }
  }
}

const agentLoopObstaclesMixin = {};
for (const name of Object.getOwnPropertyNames(_AgentLoopObstaclesHost.prototype)) {
  if (name !== 'constructor') agentLoopObstaclesMixin[name] = _AgentLoopObstaclesHost.prototype[name];
}

module.exports = { agentLoopObstaclesMixin };
