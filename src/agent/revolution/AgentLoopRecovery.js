// @ts-checked-v7.6
// ============================================================
// GENESIS — AgentLoopRecovery.js (v7.6.0)
//
// V7-5: Extracted from AgentLoop.js to reduce God-class size.
// Handles error classification, repair attempts, goal verification,
// plan reflection, and tag extraction.
//
// Follows the same delegate pattern as AgentLoopPlanner,
// AgentLoopSteps, and AgentLoopCognition.
// ============================================================

const { createLogger } = require('../core/Logger');
const { THRESHOLDS } = require('../core/Constants');
const _log = createLogger('AgentLoopRecovery');

class AgentLoopRecoveryDelegate {
  constructor(loop) {
    this.loop = loop;
  }

  // ── Error Classification & Recovery ───────────────────

  /**
   * Classify error via FailureTaxonomy and apply recovery strategy.
   * @param {object} step
   * @param {object} result
   * @param {number} stepIndex
   * @param {Function} onProgress
   * @returns {Promise<{ action: string, category?: string }>}
   */
  async classifyAndRecover(step, result, stepIndex, onProgress) {
    try {
      const ft = this.loop.bus._container?.resolve?.('failureTaxonomy')
        || (this.loop._failureTaxonomy || null);
      if (!ft) return { action: 'none' };

      const taxonomy = ft.classify(result.error, {
        actionType: step.type,
        stepIndex,
        goalId: this.loop.currentGoalId,
        model: this.loop.model?.activeModel,
        attempt: this.loop.consecutiveErrors - 1,
      });
      onProgress({ phase: 'failure-classified', category: taxonomy.category, strategy: taxonomy.strategy });

      if (taxonomy.strategy === 'retry_backoff' && taxonomy.retryConfig?.shouldRetry) {
        const backoffMs = taxonomy.retryConfig.backoffMs || 2000;
        onProgress({ phase: 'retry-backoff', waitMs: backoffMs });
        await new Promise(r => setTimeout(r, backoffMs));
        return { action: 'retry', category: taxonomy.category };
      }

      if (taxonomy.strategy === 'update_world_replan' && taxonomy.worldStateUpdates) {
        try {
          const ws = this.loop.bus._container?.resolve?.('worldState');
          if (ws) await ws.refresh();
        } catch (_e) { _log.debug('[catch] worldState refresh:', _e.message); }
      } else if (taxonomy.strategy === 'escalate_model' && taxonomy.escalation) {
        try {
          const mr = this.loop.bus._container?.resolve?.('modelRouter');
          if (mr) mr.escalate?.(step.type);
        } catch (_e) { _log.debug('[catch] model escalation:', _e.message); }
      }
    } catch (_e) { _log.debug('[catch] FailureTaxonomy not available:', _e.message); }

    return { action: 'none' };
  }

  // ── Repair Attempt ────────────────────────────────────

  /**
   * Attempt to repair a failed step via LLM analysis + retry.
   * @param {object} failedStep
   * @param {object} failedResult
   * @param {Array} allResults
   * @param {Function} onProgress
   * @returns {Promise<{ recovered: boolean, output?: string, error?: string }>}
   */
  async attemptRepair(failedStep, failedResult, allResults, onProgress) {
    onProgress({ phase: 'repairing', detail: `Attempting to fix: ${failedResult.error}` });

    const prompt = `You are Genesis. A step in your autonomous execution failed.

Failed step: ${failedStep.type} — ${failedStep.description}
Error: ${failedResult.error}
Output: ${(failedResult.output || '').slice(0, 500)}

What went wrong and how can you fix it? Provide a corrected approach.
If the error is unfixable (e.g., missing dependency, permission denied), say "UNFIXABLE: reason".`;

    const analysis = await this.loop.model.chat(prompt, [], 'analysis');

    if (analysis.includes('UNFIXABLE')) {
      return { recovered: false, output: analysis };
    }

    const repairedStep = { ...failedStep };
    const repairContext = `REPAIR ATTEMPT: Previous error was "${failedResult.error}". Fix: ${analysis.slice(0, 500)}`;

    const retryResult = await this.loop.steps._executeStep(repairedStep, repairContext, onProgress);
    return {
      recovered: !retryResult.error,
      output: retryResult.output,
      error: retryResult.error,
    };
  }

  // ── Goal Verification ─────────────────────────────────

  /**
   * Verify whether a goal was achieved based on step results.
   * Uses programmatic verification first, falls back to LLM.
   * @param {object} plan
   * @param {Array} allResults
   * @returns {Promise<{ success: boolean, summary: string, verificationMethod: string }>}
   */
  async verifyGoal(plan, allResults) {
    const errors = allResults.filter(r => r.error);
    const successRate = (allResults.length - errors.length) / allResults.length;

    const verified = allResults.filter(r => r.verification);
    const programmaticPasses = verified.filter(r => r.verification.status === 'pass').length;
    const programmaticFails = verified.filter(r => r.verification.status === 'fail').length;
    const ambiguous = verified.filter(r => r.verification.status === 'ambiguous').length;

    // Programmatic verification available and clean
    if (verified.length > 0 && programmaticFails === 0 && successRate >= THRESHOLDS.GOAL_SUCCESS_PROGRAMMATIC) {
      const summary = [
        `Goal "${plan.title}" completed.`,
        `${allResults.length} steps: ${programmaticPasses} verified, ${ambiguous} ambiguous, ${errors.length} errors.`,
        `Success rate: ${Math.round(successRate * 100)}%.`,
      ].join(' ');
      return { success: true, summary, verificationMethod: 'programmatic' };
    }

    // High success rate without verification data
    if (successRate >= THRESHOLDS.GOAL_SUCCESS_HEURISTIC && programmaticFails === 0) {
      return {
        success: true,
        summary: `Goal "${plan.title}" completed. ${allResults.length} steps, ${errors.length} errors. Success rate: ${Math.round(successRate * 100)}%.`,
        verificationMethod: 'heuristic',
      };
    }

    // Ambiguous — ask LLM
    const verificationContext = verified.length > 0
      ? `\nProgrammatic verification: ${programmaticPasses} pass, ${programmaticFails} fail, ${ambiguous} ambiguous`
      : '';

    const prompt = `Goal: "${plan.title}"
Success criteria: ${plan.successCriteria || 'All steps complete'}
Steps completed: ${allResults.length}
Errors: ${errors.length}
Error details: ${errors.map(e => e.error).join('; ')}${verificationContext}

Was this goal achieved? Respond with: SUCCESS or PARTIAL or FAILED, followed by a brief explanation.`;

    const evaluation = await this.loop.model.chat(prompt, [], 'analysis');

    // Record episode if EpisodicMemory is available
    if (this.loop.episodicMemory) {
      try {
        const success = evaluation.toUpperCase().startsWith('SUCCESS');
        this.loop.episodicMemory.recordEpisode({
          topic: plan.title || 'Agent goal execution',
          summary: evaluation.slice(0, 200),
          outcome: success ? 'success' : 'failed',
          toolsUsed: [...new Set(allResults.map(r => r.type).filter(Boolean))],
          artifacts: allResults
            .filter(r => r.target)
            .map(r => ({ type: 'file-modified', path: r.target })),
          tags: this.extractTags(plan.title + ' ' + (plan.successCriteria || '')),
        });
      } catch (err) { _log.debug('[RECOVERY] Episode recording failed:', err.message); }
    }

    return {
      success: evaluation.toUpperCase().startsWith('SUCCESS'),
      summary: evaluation.slice(0, 300),
      verificationMethod: 'llm-fallback',
    };
  }

  // ── Plan Reflection ───────────────────────────────────

  /**
   * Reflect on progress and suggest plan adjustments if recent errors.
   * @param {object} plan
   * @param {Array} results
   * @param {number} currentStep
   * @returns {Promise<{ reason: string, newSteps: Array }|null>}
   */
  async reflectOnProgress(plan, results, currentStep) {
    const recentErrors = results.slice(-3).filter(r => r.error);
    if (recentErrors.length === 0) return null;

    const prompt = `You are Genesis. You're ${currentStep + 1}/${plan.steps.length} steps into a plan.

Goal: "${plan.title}"
Success criteria: ${plan.successCriteria || 'Complete all steps'}

Recent errors: ${recentErrors.map(r => r.error).join('; ')}

Should the plan be adjusted? If yes, provide new remaining steps.
Respond with JSON: { "adjust": true/false, "reason": "why", "newSteps": [...] }
If no adjustment needed: { "adjust": false }`;

    try {
      const response = await this.loop.model.chatStructured(prompt, [], 'analysis');
      if (response.adjust && response.newSteps) {
        return { reason: response.reason, newSteps: response.newSteps };
      }
    } catch (err) { _log.debug('[RECOVERY] Reflection failed:', err.message); }
    return null;
  }

  // ── Helpers ───────────────────────────────────────────

  /**
   * Extract topic tags from text for episodic memory.
   * @param {string} text
   * @returns {string[]}
   */
  extractTags(text) {
    const tags = [];
    const lower = (text || '').toLowerCase();
    const patterns = [
      { pattern: /(?:test|spec|jest|mocha)/i, tag: 'testing' },
      { pattern: /(?:refactor|clean|simplif)/i, tag: 'refactoring' },
      { pattern: /(?:bug|fix|repair|error)/i, tag: 'bugfix' },
      { pattern: /(?:feature|add|new|implement)/i, tag: 'feature' },
      { pattern: /(?:security|auth|encrypt)/i, tag: 'security' },
      { pattern: /(?:mcp|server|client|transport)/i, tag: 'mcp' },
      { pattern: /(?:ui|render|display|css)/i, tag: 'ui' },
      { pattern: /(?:memory|knowledge|embedding)/i, tag: 'memory' },
      { pattern: /(?:api|endpoint|rest)/i, tag: 'api' },
    ];
    for (const { pattern, tag } of patterns) {
      if (pattern.test(lower)) tags.push(tag);
    }
    return tags;
  }
}

module.exports = { AgentLoopRecoveryDelegate };
