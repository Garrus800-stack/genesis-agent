// @ts-checked-v7.9.9
// ============================================================
// GENESIS — AgentLoopProgressDetector.js (v7.9.9 Fix 5)
//
// No-progress detection for pursuits — Reflexion-style heuristic
// (Shinn et al., arXiv 2303.11366): "if the agent executes the same
// action and receives the same response for more than 3 cycles,
// self-reflect." Two detectors:
//
//   (1) Per-step action+observation hash. After each step result,
//   compute hash(step.type, step.description, result.error || 'ok').
//   If last 3 entries identical → fire idle:no-progress-detected,
//   force replan via reflectOnProgress with pressure prompt.
//
//   (2) Pursuit-start identical-plan detector. At pursuit start,
//   compute hash(goal.description, plan.steps as type+desc tuples).
//   Compare to the last hash for the same goalId. If identical →
//   fire agent-loop:identical-plan-detected, force replan.
//
// State cleanup: both Maps clear on goal:completed, goal:abandoned,
// goal:obsolete, goal:stalled. Memory-leak hardening compared to the
// v7.9.7+v7.9.8 _pursuitAttempts counter which only cleared on
// completion.
//
// Decision-only — execution (splice, retry) is in the pursuit.
// ============================================================

'use strict';

const crypto = require('crypto');
const { createLogger } = require('../core/Logger');
const _log = createLogger('ProgressDetector');

const ACTION_HASH_WINDOW = 3;          // last-N entries to compare
const HASH_MAP_MAX_AGE_MS = 60 * 60 * 1000; // 1h TTL for plan hashes

/**
 * Hash a step+result into a short hex digest.
 * @param {{type?: string, description?: string}} step
 * @param {{error?: string}} result
 * @returns {string}
 */
function hashStepResult(step, result) {
  const t = (step && step.type) || '';
  const d = (step && step.description) ? String(step.description).slice(0, 50) : '';
  const e = (result && result.error) ? String(result.error).slice(0, 100) : 'ok';
  return crypto.createHash('sha256').update(`${t}|${d}|${e}`).digest('hex').slice(0, 16);
}

/**
 * Hash a full plan into a short hex digest.
 * @param {{description?: string}} goal
 * @param {Array<{type?: string, description?: string}>} steps
 * @returns {string}
 */
function hashPlan(goal, steps) {
  const goalDesc = (goal && goal.description) ? String(goal.description).slice(0, 200) : '';
  const stepStr = Array.isArray(steps)
    ? steps.map(s => `${(s && s.type) || ''}|${((s && s.description) || '').slice(0, 50)}`).join('||')
    : '';
  return crypto.createHash('sha256').update(`${goalDesc}::${stepStr}`).digest('hex').slice(0, 16);
}

class ProgressDetector {
  /**
   * @param {{ bus?: object }} opts
   */
  constructor(opts = {}) {
    this.bus = opts.bus || { fire: () => {} };
    /** @type {Map<string, Array<string>>} goalId → last-3 step hashes */
    this._actionObservationHashes = new Map();
    /** @type {Map<string, {hash: string, ts: number}>} goalId → last plan hash */
    this._planHashes = new Map();
  }

  /**
   * Record a step+result for the given goalId; check for no-progress.
   * @param {string} goalId
   * @param {object} step
   * @param {object} result
   * @returns {{noProgress: boolean, hash: string}}
   */
  recordStep(goalId, step, result) {
    if (!goalId) return { noProgress: false, hash: '' };
    const hash = hashStepResult(step, result);
    const arr = this._actionObservationHashes.get(goalId) || [];
    arr.push(hash);
    if (arr.length > ACTION_HASH_WINDOW + 2) arr.shift(); // trim
    this._actionObservationHashes.set(goalId, arr);
    if (arr.length >= ACTION_HASH_WINDOW) {
      const tail = arr.slice(-ACTION_HASH_WINDOW);
      const allSame = tail.every(h => h === tail[0]);
      if (allSame) {
        _log.info(`[PROGRESS] no-progress detected: ${ACTION_HASH_WINDOW} identical (action, observation) pairs for goal ${goalId}`);
        this.bus.fire('agent-loop:no-progress-detected', {
          goalId,
          stepHash: hash,
          repeatCount: ACTION_HASH_WINDOW,
        }, { source: 'ProgressDetector' });
        return { noProgress: true, hash };
      }
    }
    return { noProgress: false, hash };
  }

  /**
   * Check whether the current plan is identical to the previous pursuit's
   * plan for the same goalId. Updates the stored hash regardless.
   * @param {string} goalId
   * @param {object} goal
   * @param {Array} steps
   * @returns {{identical: boolean, hash: string}}
   */
  recordPlan(goalId, goal, steps) {
    if (!goalId) return { identical: false, hash: '' };
    this._sweepExpired();
    const hash = hashPlan(goal, steps);
    const prev = this._planHashes.get(goalId);
    const identical = prev && prev.hash === hash;
    this._planHashes.set(goalId, { hash, ts: Date.now() });
    if (identical) {
      _log.info(`[PROGRESS] identical plan detected for goal ${goalId} — previous attempt failed with this exact plan`);
      this.bus.fire('agent-loop:identical-plan-detected', {
        goalId,
        planHash: hash,
      }, { source: 'ProgressDetector' });
    }
    return { identical: Boolean(identical), hash };
  }

  /**
   * Clear all state for a goalId (call on goal completion or terminal state).
   * @param {string} goalId
   */
  clear(goalId) {
    if (!goalId) return;
    this._actionObservationHashes.delete(goalId);
    this._planHashes.delete(goalId);
  }

  /**
   * Wire bus subscribers for goal-terminal events. Idempotent — call once.
   */
  attachCleanupListeners() {
    if (!this.bus || typeof this.bus.on !== 'function') return;
    if (this._cleanupAttached) return;
    this._cleanupAttached = true;
    const onTerminal = (data) => {
      const id = (data && (data.goalId || data.id)) || null;
      if (id) this.clear(id);
    };
    for (const ev of ['goal:completed', 'goal:abandoned', 'goal:obsolete', 'goal:stalled']) {
      try { this.bus.on(ev, onTerminal); } catch (_e) { /* bus may not support .on */ }
    }
  }

  /**
   * Drop plan-hash entries older than 1 hour.
   */
  _sweepExpired() {
    const now = Date.now();
    for (const [id, entry] of this._planHashes.entries()) {
      if (now - entry.ts > HASH_MAP_MAX_AGE_MS) this._planHashes.delete(id);
    }
  }

  /**
   * Inspection helper for tests/dashboards.
   */
  getStats() {
    return {
      stepHashKeys: this._actionObservationHashes.size,
      planHashKeys: this._planHashes.size,
    };
  }
}

module.exports = { ProgressDetector, hashStepResult, hashPlan, ACTION_HASH_WINDOW };
