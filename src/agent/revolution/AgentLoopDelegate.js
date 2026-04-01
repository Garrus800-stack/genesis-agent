// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentLoopDelegate.js (v3.5.0 Patch)
//
// DELEGATE step implementation for AgentLoop.
// Apply these changes to src/agent/AgentLoop.js
//
// 3 changes needed:
//   1. Add property slot in constructor
//   2. Add DELEGATE case in _executeStep switch
//   3. Add delegate pattern in _inferStepType
//   4. Add _stepDelegate method
// ============================================================

// ──────────────────────────────────────────────────────────
// CHANGE 1: Constructor — add after line 88 (this._pendingApproval)
// ──────────────────────────────────────────────────────────
const { createLogger } = require('../core/Logger');
const _log = createLogger('AgentLoopDelegate');
/*
    // v3.5.0: Multi-agent delegation (late-bound by Container)
    this.taskDelegation = null;

    // v3.5.0: HTN Planner for pre-validation (late-bound)
    this.htnPlanner = null;
*/

// ──────────────────────────────────────────────────────────
// CHANGE 2: _executeStep switch — add before 'default:' (line 468)
// ──────────────────────────────────────────────────────────
/*
        case 'DELEGATE':
          return { ...(await this._stepDelegate(step, context, onProgress)), durationMs: Date.now() - start };
*/

// ──────────────────────────────────────────────────────────
// CHANGE 3: _inferStepType — add before 'return ANALYZE' (line 312)
// ──────────────────────────────────────────────────────────
/*
    if (/(?:delegat|delegier|peer|agent|auslager|outsourc)/i.test(d)) return 'DELEGATE';
*/

// ──────────────────────────────────────────────────────────
// CHANGE 4: New method — add after _stepAsk (around line 660)
// ──────────────────────────────────────────────────────────

/**
 * Execute a DELEGATE step: send a sub-task to a peer agent.
 * Requires TaskDelegation to be wired via late-binding.
 *
 * @param {object} step - { type: 'DELEGATE', description, target?, skills? }
 * @param {string} context - Current execution context
 * @param {Function} onProgress - Progress callback
 * @returns {Promise<object>} { output, error }
 */
async function _stepDelegate(step, context, onProgress) {
  // Check if delegation is available
  if (!this.taskDelegation) {
    // Fallback: treat as ANALYZE (no peers available)
    return this._stepAnalyze({
      ...step,
      type: 'ANALYZE',
      description: `[Delegation unavailable, analyzing locally] ${step.description}`,
    }, context);
  }

  // Extract required skills from step metadata or description
  const requiredSkills = step.skills || this._extractSkills(step.description);

  // Notify UI
  onProgress({
    phase: 'delegating',
    detail: `Delegiere an Peer: ${step.description.slice(0, 80)}`,
    action: 'delegation',
    skills: requiredSkills,
  });

  // Request approval before delegating (user should know work is leaving this agent)
  const approved = await this._requestApproval(
    'delegate-task',
    `Delegate task to peer: ${step.description.slice(0, 120)}\nRequired skills: [${requiredSkills.join(', ') || 'general'}]`
  );

  if (!approved) {
    // User rejected — fall back to local execution
    onProgress({ phase: 'delegation-rejected', detail: 'User rejected delegation — executing locally' });
    return this._stepAnalyze(step, context);
  }

  // Delegate to peer
  this.bus.emit('agent-loop:step-delegating', {
    description: step.description,
    skills: requiredSkills,
  }, { source: 'AgentLoop' });

  const result = await this.taskDelegation.delegate(
    step.description,
    requiredSkills,
    {
      parentGoalId: this.currentGoalId,
      deadline: Date.now() + 5 * 60 * 1000, // 5 min timeout
    }
  );

  if (result.success) {
    onProgress({
      phase: 'delegation-complete',
      detail: `Peer ${result.peerId} delivered result`,
      peerId: result.peerId,
    });

    const output = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result, null, 2).slice(0, 3000);

    return { output: `[Delegated to ${result.peerId}]\n${output}`, error: null };
  }

  // Delegation failed — fall back to local
  onProgress({
    phase: 'delegation-failed',
    detail: `Delegation failed: ${result.error}. Executing locally.`,
  });

  return this._stepAnalyze({
    ...step,
    type: 'ANALYZE',
    description: `[Delegation failed: ${result.error}] ${step.description}`,
  }, context);
}

/**
 * Extract skill keywords from a task description.
 * Used when step.skills is not explicitly set.
 */
function _extractSkills(description) {
  const d = description.toLowerCase();
  const skills = [];

  if (/(?:test|spec|jest|mocha|verify)/.test(d)) skills.push('testing');
  if (/(?:code|implement|refactor|write|build)/.test(d)) skills.push('coding');
  if (/(?:deploy|docker|kubernetes|ci|cd|pipeline)/.test(d)) skills.push('devops');
  if (/(?:design|ui|css|layout|figma)/.test(d)) skills.push('design');
  if (/(?:data|sql|database|db|query)/.test(d)) skills.push('data');
  if (/(?:security|auth|encrypt|secure)/.test(d)) skills.push('security');
  if (/(?:api|endpoint|rest|graphql)/.test(d)) skills.push('api');

  return skills;
}

// ──────────────────────────────────────────────────────────
// CHANGE 5: Enhanced _plan with HTNPlanner pre-validation
// Add at the end of _plan(), before 'return plan;'
// ──────────────────────────────────────────────────────────
/*
    // v3.5.0: Pre-validate and cost-estimate the plan
    if (this.htnPlanner && plan.steps.length > 0) {
      try {
        const dryRun = await this.htnPlanner.dryRun(plan.steps, {
          goalDescription,
          rootDir: this.rootDir,
        });

        // Emit cost estimate for UI
        onProgress({
          phase: 'plan-validated',
          detail: dryRun.summary,
          cost: dryRun.cost,
          valid: dryRun.valid,
        });

        // If blockers found, ask user to proceed
        if (!dryRun.valid) {
          const proceed = await this._requestApproval(
            'plan-has-issues',
            `Plan hat ${dryRun.validation.totalIssues} Blocker:\n${dryRun.summary}`
          );
          if (!proceed) {
            throw new Error('User hat Plan mit Blockern abgelehnt');
          }
        }
      } catch (err) {
        if (err.message.includes('abgelehnt')) throw err;
        _log.debug('[AGENT-LOOP] HTN validation skipped:', err.message);
      }
    }
*/

module.exports = { _stepDelegate, _extractSkills };
