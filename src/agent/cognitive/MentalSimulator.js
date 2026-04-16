// @ts-checked-v5.6
// ============================================================
// GENESIS — MentalSimulator.js (Phase 9 — Cognitive Architecture)

/**
 * @typedef {{stepIndex: number, action?: string, outcome: string, state: any, probability: number, cumulativeCost: number, cumulativeValue: number, expectation?: object, children: SimNode[]}} SimNode
 */

//
// The imagination. Runs entire plan sequences in-memory against
// cloned WorldState, propagating probabilistic outcomes through
// the chain. This is what separates "check preconditions" from
// "think about what will happen."
//
// FormalPlanner already does precondition checking on cloned state.
// MentalSimulator extends this with:
//   1. BRANCHING — success/failure branches per step
//   2. PROBABILITY — each branch weighted by ExpectationEngine
//   3. PRUNING — unlikely branches cut early (< 5% probability)
//   4. RISK — variance across paths = risk score
//   5. COMPARISON — run two alternative plans, pick the better one
//
// The simulation tree is pure data — no side effects, no LLM calls.
// ExpectationEngine.expect() provides probabilities (also no LLM).
// Total cost: O(steps × branches) WorldState clones.
//
// Integration:
//   AgentLoopCognition.preExecute() → simulate(plan)
//   WorldState.clone() → WorldStateSnapshot.deepClone()
//   ExpectationEngine.expect() → per-step probabilities
//   FormalPlanner action types → step value/cost model
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('MentalSimulator');

// Step value model — how much each action type contributes to goal completion
const STEP_VALUES = {
  'ANALYZE':       1,
  'CODE_GENERATE': 3,
  'WRITE_FILE':    2,
  'RUN_TESTS':     4,
  'SHELL_EXEC':    2,
  'SEARCH':        1,
  'ASK_USER':      0.5,
  'DELEGATE':      2,
  'GIT_SNAPSHOT':  1,
  'SELF_MODIFY':   5,
};

// Actions that can be retried after failure
const RETRYABLE = new Set(['CODE_GENERATE', 'RUN_TESTS', 'SHELL_EXEC', 'DELEGATE']);

class MentalSimulator {
  constructor({ bus, worldState, expectationEngine, storage, config }) {
    this.bus = bus || NullBus;
    this.worldState = worldState || null;
    this.expectationEngine = expectationEngine || null;
    this.storage = storage || null;

    // ── Configuration ────────────────────────────────────
    const cfg = config || {};
    this._maxBranches = cfg.maxBranches || 3;
    this._maxDepth = cfg.maxDepth || 15;
    this._pruneThreshold = cfg.pruneThreshold || 0.05;
    this._timeBudgetMs = cfg.timeBudgetMs || 5000; // Max 5s for simulation

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      simulations: 0,
      totalNodes: 0,
      totalPaths: 0,
      avgPathCount: 0,
      avgRisk: 0,
      recommendations: { proceed: 0, caution: 0, replan: 0, ask: 0 },
    };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Simulate a full plan with branching outcomes.
   * Returns a decision tree with expected values and risk.
   *
   * @param {Array<object>} steps - FormalPlanner typed steps
   * @param {object} options - { maxBranches, maxDepth, pruneThreshold, forcedOutcomes }
   * @returns {object} SimulationResult
   */
  simulate(steps, options = {}) {
    if (!steps || steps.length === 0) {
      return { paths: [], expectedValue: 0, riskScore: 0, recommendation: 'proceed' };
    }

    if (!this.worldState || !this.expectationEngine) {
      // Graceful degradation: no simulation possible
      return {
        paths: [{ probability: 1, expectedValue: steps.length, steps: steps.length }],
        expectedValue: steps.length,
        riskScore: 0,
        recommendation: 'proceed',
        degraded: true,
      };
    }

    this._stats.simulations++;
    const startTime = Date.now();

    const maxBranches = options.maxBranches || this._maxBranches;
    const maxDepth = Math.min(options.maxDepth || this._maxDepth, steps.length);
    const pruneThreshold = options.pruneThreshold || this._pruneThreshold;
    const forcedOutcomes = options.forcedOutcomes || {};

    this.bus.emit('simulation:started', {
      planSteps: steps.length,
      maxBranches,
      maxDepth,
    }, { source: 'MentalSimulator' });

    // Clone WorldState for simulation root
    let rootState;
    try {
      rootState = this.worldState.clone();
      // Use deepClone if available (v4.0 extension)
      if (typeof rootState.deepClone !== 'function') {
        // Fallback: rootState is already a fresh clone
      }
    } catch (_e) { _log.debug("[catch] simulation clone:", _e.message);
      return {
        paths: [{ probability: 1, expectedValue: steps.length }],
        expectedValue: steps.length,
        riskScore: 0,
        recommendation: 'proceed',
        degraded: true,
      };
    }

    // Build decision tree via iterative DFS (no recursion — safer stack)
    const rootNode = {
      stepIndex: -1,
      outcome: 'root',
      state: rootState,
      probability: 1.0,
      cumulativeCost: 0,
      cumulativeValue: 0,
      /** @type {SimNode[]} */
      children: [],
    };

    let nodeCount = 0;
    const stack = [{ node: rootNode, stepIdx: 0 }];

    while (stack.length > 0) {
      // Time budget check
      if (Date.now() - startTime > this._timeBudgetMs) break;

      const entry = stack.pop();
      if (!entry) break;
      const { node, stepIdx } = entry;

      if (stepIdx >= maxDepth || stepIdx >= steps.length) continue;
      if (node.probability < pruneThreshold) continue;

      const step = steps[stepIdx];
      const actionType = (step.type || 'ANALYZE').toUpperCase();

      // Get expectation for this step
      const expectation = this.expectationEngine.expect(step, {
        model: null, // simulation doesn't know which model will be used
      });

      // Check for forced outcomes (for whatIf scenarios)
      const forced = forcedOutcomes[stepIdx];

      // ── Branch: SUCCESS ────────────────────────────────
      const successProb = forced
        ? (forced.success ? 1.0 : 0.0)
        : expectation.successProb;

      if (successProb > pruneThreshold) {
        const successState = this._cloneState(node.state);
        this._applyEffects(successState, step, true);

        const successNode = /** @type {SimNode} */ ({
          stepIndex: stepIdx,
          action: actionType,
          outcome: 'success',
          state: successState,
          probability: node.probability * successProb,
          cumulativeCost: node.cumulativeCost + (step.cost || 1),
          cumulativeValue: node.cumulativeValue + this._stepValue(actionType, true),
          expectation: { successProb: expectation.successProb, confidence: expectation.confidence },
          children: [],
        });

        node.children.push(successNode);
        nodeCount++;

        // Continue to next step
        stack.push({ node: successNode, stepIdx: stepIdx + 1 });
      }

      // ── Branch: FAILURE ────────────────────────────────
      const failProb = forced
        ? (forced.success ? 0.0 : 1.0)
        : (1 - expectation.successProb);

      if (failProb > pruneThreshold && expectation.successProb < 0.95) {
        const failState = this._cloneState(node.state);
        this._applyEffects(failState, step, false);

        const failNode = /** @type {SimNode} */ ({
          stepIndex: stepIdx,
          action: actionType,
          outcome: 'failure',
          state: failState,
          probability: node.probability * failProb,
          cumulativeCost: node.cumulativeCost + (step.cost || 1) * 1.5,
          cumulativeValue: node.cumulativeValue + this._stepValue(actionType, false),
          expectation: { successProb: expectation.successProb, confidence: expectation.confidence },
          children: [],
        });

        node.children.push(failNode);
        nodeCount++;

        this.bus.emit('simulation:branched', {
          stepIndex: stepIdx,
          actionType,
          successProb: expectation.successProb,
          failProb,
        }, { source: 'MentalSimulator' });

        // After failure: skip to next step (can't retry in simulation)
        stack.push({ node: failNode, stepIdx: stepIdx + 1 });
      }
    }

    // Enumerate leaf paths
    const paths = this._enumeratePaths(rootNode);
    this._stats.totalNodes += nodeCount;
    this._stats.totalPaths += paths.length;

    // Calculate expected value and risk
    const expectedValue = this._weightedExpectedValue(paths);
    const riskScore = this._calculateRisk(paths, expectedValue);
    const recommendation = this._recommend(expectedValue, riskScore, paths);

    // Update rolling averages
    this._stats.avgPathCount = this._stats.avgPathCount * 0.9 + paths.length * 0.1;
    this._stats.avgRisk = this._stats.avgRisk * 0.9 + riskScore * 0.1;
    this._stats.recommendations[recommendation.replace('-', '')]++;

    const result = {
      paths: paths.map(p => ({
        probability: p.probability,
        expectedValue: p.value,
        steps: p.steps,
        outcomes: p.outcomes,
      })),
      expectedValue,
      riskScore,
      recommendation,
      nodeCount,
      durationMs: Date.now() - startTime,
    };

    this.bus.emit('simulation:complete', {
      pathCount: paths.length,
      expectedValue,
      riskScore,
      recommendation,
      durationMs: result.durationMs,
    }, { source: 'MentalSimulator' });

    return result;
  }

  /**
   * Quick what-if: "What happens if step N fails?"
   */
  whatIf(steps, failAtStep) {
    return this.simulate(steps, {
      forcedOutcomes: { [failAtStep]: { success: false } },
    });
  }

  /**
   * Compare two alternative plans.
   */
  comparePlans(stepsA, stepsB) {
    const simA = this.simulate(stepsA);
    const simB = this.simulate(stepsB);

    const winner = simA.expectedValue >= simB.expectedValue ? 'A' : 'B';

    return {
      winner,
      comparison: {
        expectedValueA: simA.expectedValue,
        expectedValueB: simB.expectedValue,
        riskA: simA.riskScore,
        riskB: simB.riskScore,
        stepsA: stepsA.length,
        stepsB: stepsB.length,
        pathsA: simA.paths.length,
        pathsB: simB.paths.length,
      },
      simA,
      simB,
    };
  }

  getStats() {
    return { ...this._stats };
  }

  // ════════════════════════════════════════════════════════
  // PATH ENUMERATION
  // ════════════════════════════════════════════════════════

  _enumeratePaths(rootNode) {
    /** @type {Array<{probability: number, value: number, cost: number, steps: number, outcomes: Array<{step: number, action: any, outcome: any}>}>} */
    const paths = [];
    const stack = [{ node: rootNode, outcomes: /** @type {Array<{step: number, action: any, outcome: any}>} */ ([]) }];

    while (stack.length > 0) {
      const entry = stack.pop();
      if (!entry) break;
      const { node, outcomes } = entry;

      if (node.children.length === 0) {
        // Leaf node — this is a complete path
        paths.push({
          probability: node.probability,
          value: node.cumulativeValue,
          cost: node.cumulativeCost,
          steps: node.stepIndex + 1,
          outcomes: [...outcomes],
        });
      } else {
        for (const child of node.children) {
          stack.push({
            node: child,
            outcomes: [...outcomes, { step: child.stepIndex, action: child.action, outcome: child.outcome }],
          });
        }
      }
    }

    return paths;
  }

  // ════════════════════════════════════════════════════════
  // VALUE & RISK CALCULATIONS
  // ════════════════════════════════════════════════════════

  _weightedExpectedValue(paths) {
    if (paths.length === 0) return 0;
    const totalProb = paths.reduce((s, p) => s + p.probability, 0);
    if (totalProb === 0) return 0;
    return paths.reduce((s, p) => s + p.probability * p.value, 0) / totalProb;
  }

  _calculateRisk(paths, expectedValue) {
    if (paths.length <= 1) return 0;
    const totalProb = paths.reduce((s, p) => s + p.probability, 0);
    if (totalProb === 0) return 0;

    // Risk = sqrt(probability-weighted variance)
    const variance = paths.reduce((sum, p) => {
      return sum + (p.probability / totalProb) * Math.pow(p.value - expectedValue, 2);
    }, 0);

    return Math.sqrt(variance);
  }

  _recommend(expectedValue, riskScore, paths) {
    // High value, low risk → proceed
    if (expectedValue > 5 && riskScore < 1.5) return 'proceed';

    // Moderate value, moderate risk → proceed with caution
    if (expectedValue > 3 && riskScore < 3.0) return 'proceed-with-caution';

    // Very high risk → replan
    if (riskScore > 5.0) return 'replan';

    // Low value → might not be worth it
    if (expectedValue < 1.5) return 'replan';

    // All paths have >50% failure probability → risky
    const allPathsRisky = paths.every(p => {
      const failOutcomes = p.outcomes.filter(o => o.outcome === 'failure');
      return failOutcomes.length > p.outcomes.length * 0.5;
    });
    if (allPathsRisky) return 'replan';

    return 'ask-user';
  }

  // ════════════════════════════════════════════════════════
  // SIMULATION HELPERS
  // ════════════════════════════════════════════════════════

  _stepValue(actionType, success) {
    if (!success) return -0.5; // Failure penalty
    return STEP_VALUES[actionType] || 1;
  }

  _cloneState(state) {
    // Use deepClone if available (WorldStateSnapshot v4.0)
    if (typeof state.deepClone === 'function') {
      return state.deepClone();
    }
    // Fallback: re-clone from root WorldState
    if (this.worldState && typeof this.worldState.clone === 'function') {
      return this.worldState.clone();
    }
    return state; // Last resort: shared state (not ideal)
  }

  _applyEffects(state, step, success) {
    if (!state) return;

    const actionType = (step.type || '').toUpperCase();

    if (success) {
      // Success effects
      if (actionType === 'WRITE_FILE' && step.target) {
        if (typeof state.markFileModified === 'function') {
          state.markFileModified(step.target);
        }
      }
    } else {
      // Failure effects
      if (actionType === 'RUN_TESTS') {
        if (typeof state.markTestsFailed === 'function') {
          state.markTestsFailed();
        }
      }
    }
  }
}

module.exports = { MentalSimulator, STEP_VALUES, RETRYABLE };
