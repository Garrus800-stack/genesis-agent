'use strict';
// ============================================================
// GENESIS — AgentLoopPursuit.js
// Mixin extraction of pursue() and _executeLoop() from AgentLoop.js.
// Holds the pursuit sequence: input parsing, goal-creation, isolation
// checks, plan, simulate, consciousness, execute-loop, cleanup. Mixin
// (not delegate) due to deep state-coupling. Plan-failure reflection
// extracted to AgentLoopPursuitReflection (v7.7.8). Stays under 700 LOC.
// ============================================================
const { TIMEOUTS, LIMITS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const { CorrelationContext } = require('../core/CorrelationContext');
const { reflectIfNeeded, composeFailureMessage } = require('./AgentLoopPursuitReflection');
const { CancellationToken } = require('../core/CancellationToken');
const { NullWorkspace } = require('../ports/WorkspacePort');
const { normalizeStepTypes } = require('./plan-context');
const { shouldAbortOnRisk, cleanupAfterAbort, safeFailureMessage, handleHardGateAbort } = require('./AgentLoopPursuitGate');
const { ProgressDetector } = require('./AgentLoopProgressDetector');

const _log = createLogger('AgentLoop');

const agentLoopPursuitMixin = {
  /**
   * Start pursuing a goal. This is the main entry point.
   * Called by ChatOrchestrator when it detects a goal-oriented message.
   *
   * @param {string} goalDescription - Natural language goal from user
   * @param {Function} onProgress - (update) => void - streams progress to UI
   * @returns {Promise<*>}
   */
  async pursue(input, onProgress = () => {}) {
    if (this.running) {
      return { success: false, error: 'Agent loop already running. Use stop() first.' };
    }

    // v7.4.5: Accept string (legacy DaemonController-direct) OR Goal object (GoalDriver-pickup with optional preGeneratedSteps).
    const _isGoalObject = (typeof input === 'object' && input !== null
                           && typeof input.id === 'string'
                           && typeof input.description === 'string');
    const goalDescription = _isGoalObject ? input.description : input;
    const _presetGoal = _isGoalObject ? input : null;

    _log.info(`[AGENT-LOOP] starting pursuit — goal="${(goalDescription || '').slice(0, 80)}"${_presetGoal ? ` (id=${_presetGoal.id}, ${(_presetGoal.steps || []).length} preset steps)` : ' (legacy string input)'}`);
    // v7.9.9 Fix 1: notify SymbolicResolver to reset its per-pursuit AVOID counter.
    try { this.bus.fire('agent-loop:starting-pursuit', { goalDescription: typeof goalDescription === 'string' ? goalDescription.slice(0, 200) : '', goalId: _presetGoal?.id || null }, { source: 'AgentLoop' }); } catch (_e) { /* never break pursuit */ }

    // v3.7.0: Strict Cognitive Mode — refuse to run without core cognitive services
    if (this._strictCognitiveMode && this._cognitiveLevel !== 'FULL') {
      const missing = ['verifier', 'formalPlanner', 'worldState']
        .filter(k => this[k] == null);
      const msg = `Strict cognitive mode: refusing to pursue goal — missing: ${missing.join(', ')}. ` +
        `Disable via Settings → cognitive.strictMode = false, or install missing dependencies.`;
      _log.error(`[AGENT-LOOP] ${msg}`);
      this.bus.fire('agent:status', { state: 'error', detail: msg }, { source: 'AgentLoop' });
      return { success: false, error: msg };
    }
    // v7.6.1 audit-closeout: Self-Gate 'plan-start' observation (telemetry-only).
    if (this.selfGate) {
      try {
        this.selfGate.check({
          actionType: 'plan-start',
          actionPayload: {
            goalDescription,
            goalId: _presetGoal?.id || null,
          },
          userContext: this._lastUserMessage || '',
          triggerSource: this._triggerSource || '',
        });
      } catch (err) {
        _log.debug(`[SELF-GATE] plan-start check skipped: ${err?.message || err}`);
      }
    }

    this.running = true;
    this._aborted = false;
    this._reflected = false;  // v7.7.9 (post-Phase-3c.4) dedup for reflectIfNeeded
    this.stepCount = 0;
    this.consecutiveErrors = 0;
    this.executionLog = [];

    // v7.9.7-fix (P5): increment per-goal attempt counter; used by the
    // simulation hard-gate below to distinguish first attempt (advisory)
    // from retries (hard-gate if high risk).
    if (_presetGoal?.id) {
      const prev = this._pursuitAttempts.get(_presetGoal.id) || 0;
      this._pursuitAttempts.set(_presetGoal.id, prev + 1);
    }

    // Shared early-return helper (v7.4.5.fix + v7.9.8 Fix 7): fires complete + safeFailureMessage.
    const _emitFailure = (errorMessage) => {
      const safeMsg = safeFailureMessage(errorMessage, this.stepCount, 'aborted early');
      try {
        const _emittedGoalId = this.currentGoalId || `loop_early_${Date.now()}`;
        this.bus.fire('agent-loop:complete', {
          goalId: _emittedGoalId,
          backend: this.model?.activeBackend || 'unknown',
          success: false, steps: this.stepCount,
          title: (typeof goalDescription === 'string' ? goalDescription : '').slice(0, 100),
          summary: `Failed: ${safeMsg.slice(0, 200)}`,
          error: safeMsg, // v7.9.8 Fix 7: explicit field for GoalDriver primary extraction
          verificationMethod: 'early-return',
          toolsUsed: [],
        }, { source: 'AgentLoop' });
      } catch (_e) { /* never let emit break the return path */ }
      // v7.7.8 / Phase 3b/c4: plan-failure-reflection via reflectIfNeeded.
      reflectIfNeeded(this, {
        goalId: this.currentGoalId,
        goalDescription: typeof goalDescription === 'string' ? goalDescription : null,
        errorMessage: safeMsg,
        stepsExecuted: this.stepCount,
      });
    };

    // v5.2.0: Structured cancellation token for this goal.
    // Global timeout, user stop(), and step guards all use this token.
    this._cancelToken = new CancellationToken();

    // v5.2.0 (SA-P6): Fresh working memory for this goal.
    this._workspace = this._createWorkspace({
      goalId: this.currentGoalId,
      goalTitle: typeof goalDescription === 'string' ? goalDescription.slice(0, 100) : 'goal',
    });
    // v5.2.0: wrap goal in correlation scope so every emit/log inherits the goalId.
    const _goalCorrelationId = CorrelationContext.generate('goal');
    return CorrelationContext.run(_goalCorrelationId, async () => {
    // FIX v3.5.3: global timeout caps unbounded goal execution.
    const globalTimeout = setTimeout(() => {
      if (this.running) {
        _log.warn(`[AGENT-LOOP] Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms) reached — aborting goal`);
        this._aborted = true;
        this._cancelToken?.cancel(`Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms)`);
        this.bus.fire('agent-loop:timeout', {
          goal: goalDescription.slice(0, 80),
          steps: this.stepCount,
          elapsed: TIMEOUTS.AGENT_LOOP_GLOBAL,
        }, { source: 'AgentLoop' });
        // v4.12.5-fix: Also emit goal:abandoned for GoalPersistence
        this.bus.fire('goal:abandoned', {
          id: this.currentGoalId,
          reason: `Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms)`,
          stepsCompleted: this.stepCount,
        }, { source: 'AgentLoop' });
        // v7.7.9 (post-Phase-3c.4): reflectIfNeeded covers the timeout
        // path; see AgentLoopPursuitReflection.reflectIfNeeded for the
        // dedup contract.
        reflectIfNeeded(this, {
          goalId: this.currentGoalId,
          goalDescription: typeof goalDescription === 'string' ? goalDescription : null,
          errorMessage: `Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms) reached after ${this.stepCount} steps`,
          stepsExecuted: this.stepCount,
        });
      }
    }, TIMEOUTS.AGENT_LOOP_GLOBAL);
    const _clearGlobalTimeout = () => clearTimeout(globalTimeout);

    onProgress({ phase: 'planning', detail: 'Decomposing goal into steps...' });

    try {
      // ── Phase 1: PLAN ── v7.4.5: presetGoal.preGeneratedSteps skip the planner.
      /** @type {*} */ let plan;
      if (_presetGoal && Array.isArray(_presetGoal.preGeneratedSteps)
          && _presetGoal.preGeneratedSteps.length > 0) {
        plan = {
          title: (_presetGoal.description || '').slice(0, 100) || 'Pre-planned goal',
          steps: _presetGoal.preGeneratedSteps,
          successCriteria: _presetGoal.successCriteria,
        };
      } else {
        plan = await this.planner._planGoal(goalDescription);
      }

      if (!plan || !plan.steps || plan.steps.length === 0) {
        this.running = false;
        _clearGlobalTimeout();
        const _err = 'Could not decompose goal into actionable steps.';
        _emitFailure(_err);
        return { success: false, error: _err };
      }

      // v7.9.9 Fix 5: identical-plan detection + forced replan if same as previous attempt.
      if (!this._progressDetector) this._progressDetector = new ProgressDetector({ bus: this.bus });
      this._progressDetector.attachCleanupListeners();
      // v7.9.9 final: dedup simulation-abort telemetry across pursuit retries.
      if (!this._simulationAbortCleanupAttached) {
        this._simulationAbortCleanupAttached = true;
        this._simulationAbortEmittedGoals ??= new Set();
        const clr = (d) => { const id = d?.goalId || d?.id; if (id) this._simulationAbortEmittedGoals.delete(id); };
        for (const ev of ['goal:completed','goal:abandoned','goal:obsolete','goal:stalled']) {
          try { this.bus?.on?.(ev, clr); } catch (_e) { /* bus may lack .on */ }
        }
      }
      if (this.currentGoalId && this._progressDetector.recordPlan(this.currentGoalId, { description: goalDescription }, plan.steps).identical) {
        try {
          const forced = await this.recovery?.reflectOnProgress?.(plan, [], 0);
          if (forced?.newSteps?.length > 0) plan.steps = forced.newSteps;
        } catch (_e) { _log.debug('[PROGRESS] forced replan failed:', _e.message); }
      }

      // v3.5.0: Pre-validate and cost-estimate the plan
      if (this.htnPlanner && plan.steps.length > 0) {
        try {
          const dryRun = await this.htnPlanner.dryRun(plan.steps, {
            goalDescription, rootDir: this.rootDir,
          });

          onProgress({
            phase: 'plan-validated',
            detail: dryRun.summary,
            cost: dryRun.cost,
            valid: dryRun.valid,
          });

          if (!dryRun.valid) {
            const proceed = await this.approval.request(
              'plan-has-issues',
              `Plan has ${dryRun.validation.totalIssues} blockers:\n${dryRun.summary}`
            );
            if (!proceed) {
              this.running = false;
              _clearGlobalTimeout();
              const _err = 'User rejected plan with blockers';
              _emitFailure(_err);
              return { success: false, error: _err };
            }
          }
        } catch (err) {
          if (err.message && err.message.includes('rejected')) {
            this.running = false;
            _clearGlobalTimeout();
            _emitFailure(err.message);
            return { success: false, error: err.message };
          }
          _log.debug('[AGENT-LOOP] HTN validation skipped:', err.message);
        }
      }

      // Register goal in GoalStack
      // FIX v6.1.1: addGoal expects (description:string, source, priority, options) — not an object

      // ── Colony Escalation Gate (v7.0.3 — C1) ─────────────
      // v7.9.9 Fix 1: threshold raised 8 → 15. The v7.9.8 Win-station trace
      // showed every IdleMind goal (typically 10-15 steps) eskalating into
      // Colony with 3× LLM calls each, draining the session token budget
      // (100%) within ~2h45min. Threshold 15 keeps Colony for genuinely
      // complex tasks while stopping autonomous-goal cost explosion.
      const _COLONY_STEP_THRESHOLD = 15;
      if (this._colonyOrchestrator && plan.steps.length > _COLONY_STEP_THRESHOLD) {
        try {
          _log.info(`[AGENT-LOOP] Colony escalation: ${plan.steps.length} steps > threshold ${_COLONY_STEP_THRESHOLD}`);
          const colonyRun = await this._colonyOrchestrator.execute(goalDescription, {
            context: JSON.stringify({ localPlanSteps: plan.steps.length, title: plan.title }),
          });

          // Only use colony result if it actually executed (not passthrough)
          const hasRealResults = colonyRun.subtasks && colonyRun.subtasks.some(
            s => s.result && !s.result.passthrough
          );

          if (hasRealResults && colonyRun.status === 'done') {
            const _doneSubtasks = colonyRun.subtasks.filter(s => s.status === 'done' && s.result);
            const _totalSubtasks = colonyRun.subtasks.length;
            // v7.7.9 (P6): require MAJORITY done. 1/3 was logged as success.
            const _majorityOk = _totalSubtasks > 0 && _doneSubtasks.length >= Math.ceil(_totalSubtasks / 2);
            if (_majorityOk) {
              /** @type {*} */ (plan).colonyInsights = _doneSubtasks.map(s => s.result);
              _log.info(`[AGENT-LOOP] Colony escalation succeeded — ${_doneSubtasks.length}/${_totalSubtasks} subtasks done, ${/** @type {*} */ (plan).colonyInsights.length} insights merged`);
              this.bus.fire('agentloop:colony-escalated', {
                runId: colonyRun.id,
                reason: 'complexity',
                subtasks: _totalSubtasks,
                insights: /** @type {*} */ (plan).colonyInsights.length,
              }, { source: 'AgentLoop' });
            } else {
              _log.warn(`[AGENT-LOOP] Colony escalation partial — only ${_doneSubtasks.length}/${_totalSubtasks} subtasks done, treating as escalation-failed (not merging)`);
            }
          } else {
            _log.debug('[AGENT-LOOP] Colony returned passthrough — using local plan');
          }
        } catch (colonyErr) {
          _log.debug(`[AGENT-LOOP] Colony escalation skipped: ${colonyErr.message}`);
        }
      }

      // v7.4.5: GoalDriver path reuses stack entry; legacy string path is TRANSIENT.
      let _registeredGoal;
      if (_presetGoal) {
        _registeredGoal = _presetGoal;
      } else {
        // Transient ephemeral goal — NOT persisted to GoalStack.
        _registeredGoal = {
          id: `loop_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          description: goalDescription.slice(0, 200),
          source: 'transient',
          priority: 'high',
          status: 'active',
          steps: [],
          currentStep: 0,
          _transient: true,
        };
      }
      this.currentGoalId = _registeredGoal?.id || `loop_${Date.now()}`;
      this.approval.currentGoalId = this.currentGoalId;

      onProgress({
        phase: 'planned',
        goalId: this.currentGoalId,
        title: plan.title,
        steps: plan.steps.map(s => s.description),
        detail: `Plan: ${plan.steps.length} steps`,
      });

      this.bus.fire('agent-loop:started', {
        goalId: this.currentGoalId,
        title: plan.title,
        stepCount: plan.steps.length,
      }, { source: 'AgentLoop' });

      // FIX v5.0.0: Append to EventStore so FitnessEvaluator can count goals
      // started (taskCompletion needs a denominator).
      this.eventStore?.append('AGENT_LOOP_STARTED', {
        goalId: this.currentGoalId,
        title: plan.title,
        stepCount: plan.steps.length,
        correlationId: _goalCorrelationId,
      }, 'AgentLoop');

      // ── Phase 1b: SIMULATE (Phase 9 cognitive hook) ────
      const cogResult = await this.cognition.preExecute(plan);
      if (!cogResult.proceed) {
        // v7.9.7-fix (P5/P5b) + v7.9.9 Fix 4: trust-level-aware hard-gate dispatch.
        const priorFailures = Math.max(0, (this._pursuitAttempts.get(this.currentGoalId) || 1) - 1);
        const _firstStep = plan.steps && plan.steps[0];
        const _gateResult = await handleHardGateAbort(this, cogResult, priorFailures, onProgress, _emitFailure, _clearGlobalTimeout, NullWorkspace, _log, _firstStep, 0);
        if (_gateResult.aborted) {
          if (_gateResult.action === 'decomposed') {
            return { success: false, blocked: true, blockedOnSubgoal: _gateResult.subId, stepResults: [] };
          }
          return { success: false, error: _gateResult.abortMsg };
        }
      }

      // ── Phase 1c: CONSCIOUSNESS CHECK (v4.12.4) — inject concerns/values into plan context.
      if (cogResult.consciousnessConcerns?.length > 0) {
        plan._consciousnessContext = cogResult.consciousnessConcerns.join(' ');
        onProgress({ phase: 'consciousness', detail: plan._consciousnessContext });
      }
      if (cogResult.valueContext) plan._valueContext = cogResult.valueContext;
      if (cogResult.consciousnessWarning) {
        _log.info(`[AGENT] Consciousness pause: ${cogResult.consciousnessWarning}`);
        onProgress({ phase: 'consciousness-pause', detail: cogResult.consciousnessWarning });
      }

      // ── Phase 2: EXECUTE LOOP ─────────────────────────
      const result = await this._executeLoop(plan, onProgress);

      // FIX v3.5.0: Save goalId before clearing (was always null in the event log)
      const completedGoalId = this.currentGoalId;
      this.running = false;
      this.currentGoalId = null;
      _clearGlobalTimeout();

      // Log completion
      this.eventStore?.append('AGENT_LOOP_COMPLETE', {
        goalId: completedGoalId,
        success: result.success,
        steps: this.stepCount,
        errors: this.executionLog.filter(l => l.error).length,
      }, 'AgentLoop');

      // v7.7.9 (post-Phase-3c.4): plan-failure-reflection on early-return paths — dedups via _reflected.
      if (!result.success) {
        reflectIfNeeded(this, {
          goalId: completedGoalId,
          goalDescription: typeof goalDescription === 'string' ? goalDescription : (plan.title || null),
          errorMessage: composeFailureMessage(result, this.stepCount),
          stepsExecuted: this.stepCount,
        });
      }

      // v5.2.0 (SA-P6): Consolidate working memory before clearing; high-salience items go to DreamCycle.
      const candidates = this._workspace.getConsolidationCandidates();
      if (candidates.length > 0) {
        this.bus.fire('workspace:consolidate', {
          goalId: completedGoalId,
          items: candidates,
          workspaceStats: this._workspace.getStats(),
        }, { source: 'AgentLoop' });
      }
      const wsStats = this._workspace.clear();
      this._workspace = new NullWorkspace();
      result.workspaceStats = wsStats;

      // v7.9.7-fix (P5): clear per-goal pursuit-attempts counter on success.
      if (completedGoalId && result?.success) {
        this._pursuitAttempts.delete(completedGoalId);
      }

      return result;

    } catch (err) {
      // v7.9.9 Fix 6: synth loop_early_<ts> if pursuit threw before
      // currentGoalId was assigned (FormalPlanner rate-limit etc.).
      const failedGoalId = this.currentGoalId || `loop_early_${Date.now()}`;
      this.running = false;
      this.currentGoalId = null;
      _clearGlobalTimeout();
      this._workspace.clear();
      this._workspace = new NullWorkspace();
      onProgress({ phase: 'error', detail: err && err.message });
      const safeMsg = safeFailureMessage(err, this.stepCount, 'threw');
      try {
        this.bus.fire('agent-loop:complete', {
          goalId: failedGoalId,
          backend: this.model?.activeBackend || 'unknown',
          success: false, steps: this.stepCount,
          title: (typeof goalDescription === 'string' ? goalDescription : '').slice(0, 100),
          summary: `Failed: ${safeMsg.slice(0, 200)}`,
          error: safeMsg, // v7.9.8 Fix 7: explicit field for GoalDriver primary extraction
          verificationMethod: 'error',
          toolsUsed: [],
        }, { source: 'AgentLoop' });
      } catch (_e) { /* never let event emission break the error path */ }
      reflectIfNeeded(this, {
        goalId: failedGoalId,
        goalDescription: typeof goalDescription === 'string' ? goalDescription : null,
        errorMessage: safeMsg,
        stepsExecuted: this.stepCount,
      });
      return { success: false, error: safeMsg, steps: this.executionLog, goalId: failedGoalId };
    }
    }); // end of CorrelationContext.run
  },

  // ════════════════════════════════════════════════════════
  // EXECUTION LOOP
  // ════════════════════════════════════════════════════════
  async _executeLoop(plan, onProgress) {
    const steps = plan.steps;
    let allResults = [];
    this._currentPlan = plan; // v4.12.4: Store for consciousness context access

    for (let i = 0; i < steps.length; i++) {
      // v5.2.0: Structured cancellation check (replaces raw _aborted flag check)
      if (this._cancelToken?.isCancelled || this._aborted) {
        // v7.7.9 Phase 3b (bug-1a): include `error` field so GoalDriver
        // resolve-side (which reads result.error, not result.summary)
        // sees the actual abort reason instead of '<empty>'.
        const _reason = this._cancelToken?.reason || 'Stopped by user';
        return { success: false, aborted: true, summary: _reason, error: _reason, steps: this.executionLog };
      }

      if (this.stepCount >= this.maxStepsPerGoal) {
        // Safety limit — ask user to continue
        onProgress({ phase: 'limit', detail: `Reached ${this.maxStepsPerGoal} steps. Pausing.` });
        const shouldContinue = await this.approval.request(
          'continue',
          `Goal has taken ${this.stepCount} steps. Continue?`
        );
        if (!shouldContinue) {
          return { success: false, summary: 'User stopped after step limit', steps: this.executionLog };
        }
        this.maxStepsPerGoal += LIMITS.AGENT_LOOP_STEP_EXTENSION;
      }

      const step = steps[i];
      this.stepCount++;

      onProgress({
        phase: 'executing',
        step: i + 1,
        total: steps.length,
        type: step.type,
        detail: step.description,
      });

      // ── THINK: Build context for this step ────────────
      const context = await this.recovery.buildStepContext(step, i, steps, allResults);

      // ── ACT: Execute the step ─────────────────────────
      /** @type {*} */ const result = await this.steps._executeStep(step, context, onProgress);

      // ── v7.4.5 Baustein C: Resource-blocked? ──────────
      // v7.4.5 Baustein C: step blocked on missing resources — park the goal; driver re-picks on resource:available.
      if (result && result.blocked === true && Array.isArray(result.blockedByResources)) {
        if (this.goalStack && this.currentGoalId && this.goalStack.blockOnResources) {
          this.goalStack.blockOnResources(this.currentGoalId, result.blockedByResources);
        }
        if (this.bus && this.bus.fire) {
          this.bus.fire('agent-loop:blocked-on-resources', {
            goalId: this.currentGoalId,
            stepIndex: i,
            stepType: step.type,
            resources: result.blockedByResources,
          }, { source: 'AgentLoop' });
        }
        return {
          ok: false,
          blocked: true,
          blockedByResources: result.blockedByResources,
          stepResults: allResults,
        };
      }

      // ── v3.5.0: VERIFY — programmatic verification ────
      if (this.verifier && result && !result.error) {
        try {
          const stepVerification = await this.verifier.verify(
            step.type || step.verifierType, step, result
          );
          result.verification = stepVerification;
          if (stepVerification.status === 'fail') {
            result.error = `Verification failed: ${stepVerification.reason}`;
            // v7.8.4: overlay output so step-log doesn't show pre-verification claim + failure together.
            if (typeof result.output === 'string') result.output = `[verification failed] ${result.output}`;
          }
        } catch (err) {
          _log.debug('[AGENT-LOOP] Step verification error:', err.message);
        }
      }

      // ── v3.5.0: UPDATE WorldState after step ──────────
      if (this.worldState && step.target) {
        this.worldState.markFileModified(step.target);
      }

      // ── v4.0: COMPARE expectation vs outcome (Phase 9) ──
      this.cognition.postStep(plan, i, step, result);

      // ── OBSERVE: Record and evaluate ──────────────────
      this.executionLog.push({
        step: i + 1,
        type: step.type,
        description: step.description,
        result: result.output?.slice(0, 500) || '',
        error: result.error || null,
        timestamp: new Date().toISOString(),
        durationMs: result.durationMs || 0,
      });
      // FIX v4.0.0 (F-05): Trim execution log to prevent unbounded growth
      if (this.executionLog.length > this._maxExecutionLogEntries) {
        this.executionLog = this.executionLog.slice(-this._maxExecutionLogEntries);
      }

      allResults.push(result);
      // v7.9.9 Fix 5: per-step no-progress detector — emits event when last 3 step-hashes identical.
      this._progressDetector?.recordStep(this.currentGoalId, step, result);

      // v5.2.0 (SA-P6): Working memory — store step result and decay salience
      this._workspace.store(
        `step-${i + 1}-${step.type}`,
        result.error ? `ERROR: ${result.error}` : (result.output || '').slice(0, 300),
        result.error ? 0.8 : 0.6, // Errors are more salient
      );
      this._workspace.tick();

      if (result.error) {
        this.consecutiveErrors++;
        onProgress({ phase: 'error', step: i + 1, detail: result.error });

        // v6.0.7: Emit step-failed for EarnedAutonomy tracking
        this.bus.fire('agent-loop:step-failed', {
          goalId: this.currentGoalId,
          stepIndex: i,
          type: step.type,
          error: (result.error || '').slice(0, 200),
        }, { source: 'AgentLoop' });

        // FailureTaxonomy classify (SA-O2) + Fix 8: plan+allResults for refresh→replan.
        const recovery = await this.recovery.classifyAndRecover(step, result, i, onProgress);
        if (recovery.action === 'retry') {
          i--; // Retry same step
          allResults.push({ retried: true, category: recovery.category });
          continue;
        }

        // v7.4.5 Baustein D: parent parked on freshly-spawned sub-goal; resume via _unblockDependents.
        if (recovery.action === 'blocked-on-subgoal') {
          if (this.bus && this.bus.fire) {
            this.bus.fire('agent-loop:blocked-on-subgoal', { goalId: this.currentGoalId, stepIndex: i, stepType: step.type, subId: recovery.subId }, { source: 'AgentLoop' });
          }
          return {
            ok: false,
            blocked: true,
            blockedOnSubgoal: recovery.subId,
            stepResults: allResults,
          };
        }

        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          // ── REFLECT: Too many errors — attempt self-repair ──
          const repairResult = await this.recovery.attemptRepair(step, result, allResults, onProgress);
          if (repairResult.recovered) {
            this.consecutiveErrors = 0;
            allResults.push(repairResult);
            continue;
          } else {
            // v4.12.5-fix: Emit goal:abandoned so GoalPersistence can record failure
            this.bus.fire('goal:abandoned', {
              id: this.currentGoalId,
              reason: `Max errors at step ${i + 1}: ${result.error}`,
              stepsCompleted: i,
            }, { source: 'AgentLoop' });
            return {
              success: false,
              summary: `Failed at step ${i + 1}: ${result.error}`,
              steps: this.executionLog,
            };
          }
        }
      } else {
        this.consecutiveErrors = 0;

        // v4.12.5-fix: Standardized to 'agent-loop:step-complete' (was 'agentloop:step-complete').
        // Matches EVENTS.AGENT_LOOP.STEP_COMPLETE and EventPayloadSchemas.
        this.bus.fire('agent-loop:step-complete', {
          goalId: this.currentGoalId,
          stepIndex: i,
          result: result.output?.slice(0, 200) || '',
          type: step.type,
        }, { source: 'AgentLoop' });
      }

      // ── REFLECT: Should we adjust the plan? ───────────
      if (i < steps.length - 1 && (i + 1) % 3 === 0) {
        // Every 3 steps, check if the plan still makes sense
        const adjustment = await this.recovery.reflectOnProgress(plan, allResults, i);
        if (adjustment && adjustment.newSteps) {
          normalizeStepTypes(adjustment.newSteps, { logger: _log, tag: '[REPLAN]' });
          steps.splice(i + 1, steps.length, ...adjustment.newSteps);
          onProgress({
            phase: 'replanned',
            detail: `Plan adjusted: ${adjustment.reason}`,
            newSteps: adjustment.newSteps.map(s => s.description),
          });
        }
      }

      onProgress({
        phase: 'step-complete',
        step: i + 1,
        total: steps.length,
        success: !result.error,
        detail: result.output?.slice(0, 200) || 'Done',
      });
    }

    // ── Final verification ────────────────────────────────
    const verification = await this.recovery.verifyGoal(plan, allResults);

    onProgress({
      phase: 'complete',
      success: verification.success,
      detail: verification.summary,
    });

    let _finalSummary = verification.summary;
    if (!verification.success && (!_finalSummary || _finalSummary.trim() === '')) {
      const lastErr = [...allResults].reverse().find(r => r && r.error);
      const msg = lastErr && typeof lastErr.error === 'string' ? lastErr.error.slice(0, 120) : '';
      const errCnt = allResults.filter(r => r && r.error).length;
      _finalSummary = msg
        ? `Goal verification failed after ${this.stepCount} steps. Last error: ${msg}`
        : `Goal verification failed after ${this.stepCount} steps with ${errCnt} step error(s) — no explicit error message captured.`;
    }

    this.bus.fire('agent-loop:complete', {
      goalId: this.currentGoalId,
      backend: this.model?.activeBackend || 'unknown',
      success: verification.success,
      steps: this.stepCount,
      title: plan.title,
      summary: _finalSummary,
      error: verification.success ? null : _finalSummary, // v7.7.9 (P4): explicit field for GoalDriver
      verificationMethod: verification.verificationMethod,
      toolsUsed: [...new Set(this.executionLog.map(l => l.type).filter(Boolean))],
    }, { source: 'AgentLoop' });

    if (!verification.success) {
      reflectIfNeeded(this, {
        goalId: this.currentGoalId,
        goalDescription: plan.title || null,
        errorMessage: _finalSummary || '',
        stepsExecuted: this.stepCount,
      });
    }

    return {
      success: verification.success,
      summary: _finalSummary,
      // v7.9.6: surface as `error` so the GoalDriver hallucination fast-track can fire.
      error: verification.success ? null : _finalSummary,
      steps: this.executionLog,
      verification,
    };
  },
};

module.exports = { agentLoopPursuitMixin };
