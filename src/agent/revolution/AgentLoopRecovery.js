// @ts-checked-v7.6
// ============================================================
// GENESIS — AgentLoopRecovery.js
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

      // v7.4.5 Baustein D: spawn a sub-goal that fixes the obstacle,
      // park the parent. The bestehende _unblockDependents-Pfad
      // reactivates the parent when the sub-goal completes.
      if (taxonomy.strategy === 'spawn_subgoal' && taxonomy.obstacle) {
        const spawned = await this._trySpawnObstacleSubgoal(
          taxonomy.obstacle, step, stepIndex, onProgress
        );
        if (spawned.spawned) {
          return { action: 'blocked-on-subgoal', category: taxonomy.category, subId: spawned.subId };
        }
        // spawn refused → fall through to default deterministic path
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
    _log.info(`[D] obstacle "${obstacle.type}" → spawned sub-goal ${subGoal.id} (parent=${parentId})`);

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

    // v7.4.5.fix #24: collect actual step outputs so the user sees the
    // RESULT, not just verifier metadata. Without this, a goal like
    // "list .js files and count them" returns "Goal completed. 2 steps
    // verified. 100% success." — the user has to dig through logs to
    // find the actual count. Now we append step outputs to the summary.
    //
    // v7.4.5.fix #25: robust output extraction. The previous filter
    // (!error && output) silently dropped:
    //   - Steps where output was empty but the step ran successfully
    //     (ANALYZE steps that wrote to workspace, CODE steps with
    //      no return value, etc.)
    //   - Steps where the output is on a different field
    //     (some step types use `result`, `summary`, or `text`)
    //   - Steps that had a non-fatal error but produced useful output
    // Now we also show what Genesis ATTEMPTED via plan.steps so even
    // when no output was captured the user sees the work performed.
    const _formatOutputs = () => {
      const lines = [];
      const planSteps = (plan && Array.isArray(plan.steps)) ? plan.steps : [];
      for (let i = 0; i < allResults.length; i++) {
        const r = allResults[i] || {};
        if (r.retried) continue; // skip retry markers
        const planStep = planSteps[i] || {};
        const stepNum = i + 1;
        const type = (r.type || planStep.type) ? ` (${r.type || planStep.type})` : '';
        const description = (planStep.description || planStep.action || '').toString().trim();
        // Extract output from any of the common fields. Coerce to string.
        let out = '';
        if (typeof r.output === 'string') out = r.output;
        else if (typeof r.result === 'string') out = r.result;
        else if (typeof r.summary === 'string') out = r.summary;
        else if (typeof r.text === 'string') out = r.text;
        else if (r.output != null) out = JSON.stringify(r.output);
        out = out.trim().slice(0, 600);
        const errMsg = r.error ? String(r.error).trim().slice(0, 200) : '';
        // Build the per-step block. Always show the description (so the
        // user sees what was attempted), then output if present, then
        // any error.
        const block = [`**Step ${stepNum}${type}:**`];
        if (description) block.push(`_${description}_`);
        if (out) block.push(out);
        if (errMsg) block.push(`⚠️ ${errMsg}`);
        if (block.length > 1) {
          lines.push(block.join('\n'));
        }
      }
      if (lines.length === 0) return '';
      return '\n\n' + lines.join('\n\n');
    };

    // Programmatic verification available and clean
    if (verified.length > 0 && programmaticFails === 0 && successRate >= THRESHOLDS.GOAL_SUCCESS_PROGRAMMATIC) {
      const header = [
        `Goal "${plan.title}" completed.`,
        `${allResults.length} steps: ${programmaticPasses} verified, ${ambiguous} ambiguous, ${errors.length} errors.`,
        `Success rate: ${Math.round(successRate * 100)}%.`,
      ].join(' ');
      const summary = header + _formatOutputs();
      return { success: true, summary, verificationMethod: 'programmatic' };
    }

    // High success rate without verification data
    if (successRate >= THRESHOLDS.GOAL_SUCCESS_HEURISTIC && programmaticFails === 0) {
      const header = `Goal "${plan.title}" completed. ${allResults.length} steps, ${errors.length} errors. Success rate: ${Math.round(successRate * 100)}%.`;
      return {
        success: true,
        summary: header + _formatOutputs(),
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
If no adjustment needed: { "adjust": false }

Each step MUST be an object: { "type": "<TYPE>", "description": "<one short sentence>" }.
Valid types: ANALYZE, CODE, SHELL, SANDBOX, SEARCH, ASK, DELEGATE.
Bare strings or arrays are NOT valid step entries.

Three worked examples:
  { "type": "ANALYZE", "description": "Read src/agent/foundation/Settings.js to find the trust-level field" }
  { "type": "CODE",    "description": "Add a default value for trust.level in Settings.getDefaults" }
  { "type": "SHELL",   "description": "Run npm test to verify the change" }`;

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

  // ── Step Context (v7.1.2 — extracted from AgentLoop) ──

  /**
   * Build LLM context string for the current step execution.
   * @param {object} step
   * @param {number} stepIndex
   * @param {Array} allSteps
   * @param {Array} previousResults
   * @returns {string}
   */
  buildStepContext(step, stepIndex, allSteps, previousResults) {
    const recentResults = previousResults.slice(-3).map((r, i) => {
      const stepNum = stepIndex - previousResults.slice(-3).length + i + 1;
      return `Step ${stepNum}: ${r.error ? 'ERROR: ' + r.error : (r.output || '').slice(0, 200)}`;
    }).join('\n');

    const plan = this.loop._currentPlan || {};
    const consciousnessHint = plan._consciousnessContext
      ? `\n${plan._consciousnessContext}`
      : '';
    const valueHint = plan._valueContext
      ? `\nRELEVANT VALUES: ${plan._valueContext}`
      : '';
    const workspaceHint = this.loop._workspace.buildContext(5);

    // v7.7.9 (post-Phase-3c.2): Knowledge / lessons hints.
    // Before this fix, the step prompt carried no information from
    // Genesis' own research, study, exploration, or past failure
    // reflections. Plan-failure-reflection and IdleMind-insight
    // mirrors now both write into LessonsStore, and the KG already
    // holds research/insight/idea/learning nodes from autonomous
    // activities — but the prompt fed to model.chat() saw none of
    // it. The two helpers below pull a top-N digest into context.
    // Both are best-effort and never throw; if either service is
    // unbound or recall returns empty, the original prompt shape is
    // unchanged.
    const lessonsHint = this._buildLessonsHint(step);
    const knowledgeHint = this._buildKnowledgeHint(step);

    // v7.9.7 P2 + EXT2 P2: module-path hint for code-producing steps. The planner
    // already gives the LLM a goal-relevant module path list (via
    // pickRelevantModules / formatModulePathList in plan-context), but each
    // individual _stepCode call subsequently runs without that list in scope —
    // the step-context contained recent results and lessons but no actual
    // code-base file inventory. Live-Befund v7.9.7 outpost trace: every CODE
    // step in "Research Activity Time Logging" emitted `require('../../core/Logger')`
    // (a relative path that doesn't resolve). Sandbox.testPatch then blocked
    // with "Read access blocked" or "Cannot find module". Adding a path-list
    // block here gives the CODE step the same path grounding the planner had,
    // with the core-infrastructure floor (Logger, EventBus, Container, etc.)
    // always present. ANALYZE/SEARCH only get the hint when step.target looks
    // like a real source file — see _buildPathHint.
    const pathHint = this._buildPathHint(step);

    return `You are Genesis, executing step ${stepIndex + 1}/${allSteps.length} of an autonomous plan.
${recentResults ? '\nRecent results:\n' + recentResults : ''}${consciousnessHint}${valueHint}${workspaceHint ? '\n' + workspaceHint : ''}${lessonsHint}${knowledgeHint}${pathHint}
Current step: ${step.type} — ${step.description}
${step.target ? 'Target: ' + step.target : ''}`;
  }

  /**
   * Best-effort lessons digest for the current step. Pulls up to 3
   * obstacle-resolution lessons filtered by step description.
   */
  _buildLessonsHint(step) {
    try {
      const lessonsStore = this.loop.lessonsStore || this.loop._lessonsStore;
      if (!lessonsStore || typeof lessonsStore.recall !== 'function') return '';

      const query = (step.description || '').slice(0, 80);
      const obstacleLessons = lessonsStore.recall('obstacle-resolution', { query, tags: [step.type] }, 3) || [];
      if (obstacleLessons.length === 0) return '';

      const lines = obstacleLessons.slice(0, 3).map(l => {
        const cat = l.category || 'lesson';
        const insight = (l.insight || '').slice(0, 140);
        return `  - [${cat}] ${insight}`;
      });
      return `\nRELEVANT LESSONS (from past pursuits):\n${lines.join('\n')}`;
    } catch (_e) {
      return '';
    }
  }

  /**
   * Best-effort knowledge digest for the current step. Searches the
   * KG by step description and surfaces the top 3 hits' labels and
   * abbreviated properties. Keyword-based even when embeddings are
   * available — buildContext keeps it lightweight.
   */
  _buildKnowledgeHint(step) {
    try {
      const kg = this.loop.kg || this.loop._kg || this.loop.knowledgeGraph;
      if (!kg || typeof kg.buildContext !== 'function') return '';

      const query = (step.description || '').slice(0, 80);
      if (!query) return '';
      const block = kg.buildContext(query, 250);
      if (!block) return '';
      return `\n${block}`;
    } catch (_e) {
      return '';
    }
  }

  /**
   * v7.9.7 P2 / EXT2 P2: best-effort module-path block for code-producing
   * steps. Returns '' for non-code steps that don't need it. Pulls the
   * goal-relevant module list through the same pickRelevantModules helper
   * the planner uses, then formats it as a labelled block. The list is
   * bounded by pickRelevantModules (30 entries) and prefixed by the
   * core-infrastructure floor (Logger, EventBus, Container, etc.) so
   * the LLM always sees the real path to standard infra modules
   * regardless of whether the goal's tokens happen to match them.
   */
  _buildPathHint(step) {
    try {
      if (!step) return '';
      const { normalizeStepType } = require('./step-types');
      const canonical = normalizeStepType(step.type) || step.type;
      // Primary gate: CODE-class steps always get the hint.
      const isCodeClass = canonical === 'CODE' || canonical === 'SANDBOX';
      // ANALYZE/SEARCH get the hint only if the step's target looks like
      // a real source file. "Analyse EventBus.js" benefits from the path
      // list; "analyse the current situation" doesn't and shouldn't pay
      // the prompt-budget cost.
      const targetLooksLikeFile = typeof step.target === 'string' &&
        /\.(js|jsx|ts|tsx|json|md|yml|yaml)$/i.test(step.target);
      const isAnalyseClass = (canonical === 'ANALYZE' || canonical === 'SEARCH') && targetLooksLikeFile;
      if (!isCodeClass && !isAnalyseClass) return '';

      const selfModel = this.loop.selfModel || this.loop._selfModel;
      if (!selfModel || typeof selfModel.getModuleSummary !== 'function') return '';
      const allModules = selfModel.getModuleSummary() || [];
      if (allModules.length === 0) return '';
      const { pickRelevantModules, formatModulePathList } = require('./plan-context');
      const goalDesc = this.loop._currentPlan?.title || step.description || '';
      const picked = pickRelevantModules(allModules, goalDesc);
      if (!picked || picked.length === 0) return '';
      const block = formatModulePathList(picked);
      return `\nAVAILABLE SOURCE MODULES (use these EXACT paths from project root; never invent relative paths):\n${block}`;
    } catch (_e) {
      return '';
    }
  }
}

module.exports = { AgentLoopRecoveryDelegate };
