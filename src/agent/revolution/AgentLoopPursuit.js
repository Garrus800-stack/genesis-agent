'use strict';

// ============================================================
// GENESIS — AgentLoopPursuit.js (v7.6.9)
//
// Mixin extraction of pursue() and _executeLoop() from
// AgentLoop.js. Holds the pursuit sequence: input parsing,
// goal-creation, isolation checks, Phase 1 PLAN, Phase 1b
// SIMULATE, Phase 1c CONSCIOUSNESS, Phase 2 EXECUTE LOOP,
// post-execute cleanup.
//
// Mounted onto AgentLoop.prototype via:
//   Object.assign(AgentLoop.prototype, agentLoopPursuitMixin)
//
// Pattern note — mixin vs delegate
// ─────────────────────────────────
// AgentLoop.js historically uses the delegate-pattern
// (AgentLoopPlannerDelegate, AgentLoopStepsDelegate,
// AgentLoopCognitionDelegate, AgentLoopRecoveryDelegate) for
// isolated helper concerns. Mixin pattern is used here because
// pursue/_executeLoop are core orchestration methods with deep
// state-coupling to the AgentLoop instance: 23 distinct this.X
// reads in pursue, 19 in _executeLoop, including writes to
// running/currentGoalId/executionLog/consecutiveErrors/
// stepCount/_currentPlan/_workspace/_aborted. Delegate-pattern
// would require ~50 verbose this.agentLoop.X references and
// risks subtle this-binding bugs in arrow callbacks. Mixin
// keeps them as class-methods on AgentLoop.prototype, only the
// source location changes — same approach as Settings v7.6.7,
// GoalStack v7.6.8, ModelBridgeFailover v7.6.5.
// ============================================================

const { TIMEOUTS, LIMITS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const { CorrelationContext } = require('../core/CorrelationContext');
const { CancellationToken } = require('../core/CancellationToken');
const { NullWorkspace } = require('../ports/WorkspacePort');

const _log = createLogger('AgentLoop');

// ============================================================
// Mixin
// ============================================================

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

    // v7.4.5: Accept string OR Goal object.
    // - string  : legacy DaemonController-direct path (we'll create a stack entry below)
    // - Goal    : new GoalDriver-pickup path (already in stack, may carry preGeneratedSteps)
    const _isGoalObject = (typeof input === 'object' && input !== null
                           && typeof input.id === 'string'
                           && typeof input.description === 'string');
    const goalDescription = _isGoalObject ? input.description : input;
    const _presetGoal = _isGoalObject ? input : null;

    _log.info(`[AGENT-LOOP] starting pursuit — goal="${(goalDescription || '').slice(0, 80)}"${_presetGoal ? ` (id=${_presetGoal.id}, ${(_presetGoal.steps || []).length} preset steps)` : ' (legacy string input)'}`);

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

    // v7.6.1 audit-closeout: Self-Gate observation for 'plan-start' actionType.
    // Telemetry-only (does not block); closes the symmetry gap where
    // self-gate.js documented 'plan-start' but no call site existed.
    // Reflexivity patterns ("Ich sollte als nächstes X angehen") that
    // mund directly into a plan-pursuit (rather than a tool-call or
    // goal-push) were previously invisible to the gate.
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
    this.stepCount = 0;
    this.consecutiveErrors = 0;
    this.executionLog = [];

    // v7.4.5.fix: shared early-return helper. Every non-throw failure
    // path in pursue() must emit agent-loop:complete so observers
    // (especially GoalDriver._onPursuitComplete) clean up the
    // _currentlyPursuing lock symmetrically with the happy path.
    // Without this, an early-return failure leaves the goal locked
    // forever — exact symptom seen with "User rejected plan with
    // blockers" → next pickup bounces with "already running" because
    // running=false has not yet propagated → driver hold lock for
    // an in-flight pursue that already returned. The fix is to
    // emit the completion event from every return path.
    const _emitFailure = (errorMessage) => {
      try {
        // v7.5.8 hotfix: at this point this.currentGoalId may still be null
        // (set on Z. ~386 via _registeredGoal.id), so we synthesise a stable
        // fallback so the schema-required goalId field is never missing.
        // Live-Befund (Garrus-Win, 2026-05-03): runtime warning
        //   "agent-loop:complete missing required field goalId. Source: AgentLoop"
        // appeared when the early-return path fired before goal-registration.
        const _emittedGoalId = this.currentGoalId
          || (typeof goalDescription === 'string'
                ? `loop_early_${Date.now()}`
                : `loop_early_${Date.now()}`);
        this.bus.fire('agent-loop:complete', {
          goalId: _emittedGoalId,
          success: false,
          steps: this.stepCount,
          title: (typeof goalDescription === 'string' ? goalDescription : '').slice(0, 100),
          summary: `Failed: ${(errorMessage || '').slice(0, 200)}`,
          verificationMethod: 'early-return',
          toolsUsed: [],
        }, { source: 'AgentLoop' });
      } catch (_e) { /* never let emit break the return path */ }
    };

    // v5.2.0: Structured cancellation token for this goal.
    // Global timeout, user stop(), and step guards all use this token.
    this._cancelToken = new CancellationToken();

    // v5.2.0 (SA-P6): Fresh working memory for this goal.
    this._workspace = this._createWorkspace({
      goalId: this.currentGoalId,
      goalTitle: typeof goalDescription === 'string' ? goalDescription.slice(0, 100) : 'goal',
    });

    // v5.2.0: Wrap entire goal in correlation scope.
    // Every EventBus emit, EventStore append, and log call
    // within this async scope automatically carries the goal's
    // correlation ID. No manual threading needed.
    const _goalCorrelationId = CorrelationContext.generate('goal');
    return CorrelationContext.run(_goalCorrelationId, async () => {

    // FIX v3.5.3: Global timeout prevents unbounded goal execution.
    // 20 steps × 30s shell timeout = 10 min max theoretical, so 10 min global.
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
          goalId: this.currentGoalId,
          reason: `Global timeout (${TIMEOUTS.AGENT_LOOP_GLOBAL}ms)`,
          stepsCompleted: this.stepCount,
        }, { source: 'AgentLoop' });
      }
    }, TIMEOUTS.AGENT_LOOP_GLOBAL);
    const _clearGlobalTimeout = () => clearTimeout(globalTimeout);

    onProgress({ phase: 'planning', detail: 'Decomposing goal into steps...' });

    try {
      // ── Phase 1: PLAN ─────────────────────────────────
      // v7.4.5: If presetGoal carries preGeneratedSteps (e.g. sub-goal
      // spawned by AgentLoopRecovery in Baustein D), skip planning and
      // use those steps directly.
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
      // If the plan is complex or HTN validation had issues,
      // delegate to ColonyOrchestrator for parallel analysis.
      const _COLONY_STEP_THRESHOLD = 3;
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
            /** @type {*} */ (plan).colonyInsights = colonyRun.subtasks
              .filter(s => s.status === 'done' && s.result)
              .map(s => s.result);
            _log.info(`[AGENT-LOOP] Colony escalation succeeded — ${/** @type {*} */ (plan).colonyInsights.length} insights merged`);
            this.bus.fire('agentloop:colony-escalated', {
              runId: colonyRun.id,
              reason: 'complexity',
              subtasks: colonyRun.subtasks.length,
              insights: /** @type {*} */ (plan).colonyInsights.length,
            }, { source: 'AgentLoop' });
          } else {
            _log.debug('[AGENT-LOOP] Colony returned passthrough — using local plan');
          }
        } catch (colonyErr) {
          _log.debug(`[AGENT-LOOP] Colony escalation skipped: ${colonyErr.message}`);
        }
      }

      // v7.4.5: If we received a Goal object from GoalDriver, it's already
      // in the stack — reuse it. Otherwise (legacy string path) we now
      // run TRANSIENT — no automatic stack entry.
      //
      // v7.5.0 background: Before, the legacy string path silently called
      // goalStack.addGoal() with source='user' and priority='high'. That
      // turned every conversational message that ended up in pursue()
      // (e.g. via LLM-misclassification as 'agent-goal') into a persistent
      // stack goal. The goal would then be picked up forever by GoalDriver,
      // even though the user never asked for it to be tracked. Live-bug
      // in v7.4.9: a question containing "Welcher der drei Punkte..." was
      // routed via classifyAsync → LLM → 'agent-goal' → pursue(string),
      // which silently registered it as a high-priority user goal that
      // re-pursued every minute for 16+ minutes.
      //
      // Fix: legacy string path stays ephemeral. Pursuit still runs (so
      // explicit /agent <task> via that path still works), but no stack
      // persistence. If a caller wants persistence, they should go through
      // GoalDriver / goalStack.addGoal explicitly first, then pass the
      // Goal object to pursue.
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

      // FIX v5.0.0: Append to EventStore so FitnessEvaluator can count goals started.
      // Previously only AGENT_LOOP_COMPLETE was appended; without STARTED the
      // taskCompletion metric had no denominator and always defaulted to 0.5.
      this.eventStore?.append('AGENT_LOOP_STARTED', {
        goalId: this.currentGoalId,
        title: plan.title,
        stepCount: plan.steps.length,
        correlationId: _goalCorrelationId,
      }, 'AgentLoop');

      // ── Phase 1b: SIMULATE (Phase 9 cognitive hook) ────
      const cogResult = await this.cognition.preExecute(plan);
      if (!cogResult.proceed) {
        // FIX v6.1.1: Simulation is advisory, not a hard gate.
        // Genesis should TRY and learn from failure, not refuse to act.
        _log.warn(`[AGENT-LOOP] Simulation flagged risk: ${cogResult.reason} (score: ${cogResult.riskScore}) — proceeding anyway`);
        onProgress({ phase: 'simulation-warning', detail: `Risk flagged: ${cogResult.reason} — proceeding`, risk: cogResult.riskScore });
      }

      // ── Phase 1c: CONSCIOUSNESS CHECK (v4.12.4) ────────
      // If consciousness has concerns, inject them into plan
      // context so the LLM sees them during execution.
      if (cogResult.consciousnessConcerns?.length > 0) {
        plan._consciousnessContext = cogResult.consciousnessConcerns.join(' ');
        onProgress({ phase: 'consciousness', detail: plan._consciousnessContext });
      }
      if (cogResult.valueContext) {
        plan._valueContext = cogResult.valueContext;
      }
      if (cogResult.consciousnessWarning) {
        // Paused by ethical conflict — log prominently
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

      // v5.2.0 (SA-P6): Consolidate working memory before clearing.
      // High-salience items are emitted for DreamCycle pickup.
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

      return result;

    } catch (err) {
      const failedGoalId = this.currentGoalId;
      this.running = false;
      this.currentGoalId = null;
      _clearGlobalTimeout();
      this._workspace.clear();
      this._workspace = new NullWorkspace();
      onProgress({ phase: 'error', detail: err.message });
      // v7.4.5.fix: emit agent-loop:complete also on error-path so
      // GoalDriver._onPursuitComplete cleans up _currentlyPursuing
      // symmetrically with the happy path. Without this, a thrown
      // pursuit kept the goal stuck "in pursuit" forever, blocking
      // every later scan. The GoalDriver._beginPursuit also has a
      // defensive cleanup, but emitting the event here is the
      // architecturally clean fix — observers stay consistent.
      try {
        this.bus.fire('agent-loop:complete', {
          goalId: failedGoalId,
          success: false,
          steps: this.stepCount,
          title: (typeof goalDescription === 'string' ? goalDescription : '').slice(0, 100),
          summary: `Failed: ${(err.message || '').slice(0, 200)}`,
          verificationMethod: 'error',
          toolsUsed: [],
        }, { source: 'AgentLoop' });
      } catch (_e) { /* never let event emission break the error path */ }
      return { success: false, error: err.message, steps: this.executionLog, goalId: failedGoalId };
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
        return { success: false, aborted: true, summary: this._cancelToken?.reason || 'Stopped by user', steps: this.executionLog };
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
      // The step's pre-existence check fired and returned blocked=true.
      // Park the goal on the missing resources; abort the loop here.
      // GoalDriver will pick this goal up again on resource:available.
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
          if (stepVerification.status === 'fail') {
            result.error = `Verification failed: ${stepVerification.reason}`;
            result.verification = stepVerification;
          } else {
            result.verification = stepVerification;
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

        // FIX v5.1.0 (SA-O2): FailureTaxonomy classification extracted
        const recovery = await this.recovery.classifyAndRecover(step, result, i, onProgress);
        if (recovery.action === 'retry') {
          i--; // Retry same step
          allResults.push({ retried: true, category: recovery.category });
          continue;
        }

        // v7.4.5 Baustein D: parent goal parked on a freshly-spawned
        // sub-goal that will resolve the obstacle. End the loop here;
        // _unblockDependents (existing GoalStack mechanism) will set
        // parent back to 'active' when sub-goal completes, and
        // GoalDriver picks it up to resume.
        if (recovery.action === 'blocked-on-subgoal') {
          if (this.bus && this.bus.fire) {
            this.bus.fire('agent-loop:blocked-on-subgoal', {
              goalId: this.currentGoalId,
              stepIndex: i,
              stepType: step.type,
              subId: recovery.subId,
            }, { source: 'AgentLoop' });
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
              goalId: this.currentGoalId,
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
          // Replace remaining steps with adjusted plan
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

    this.bus.fire('agent-loop:complete', {
      goalId: this.currentGoalId,
      success: verification.success,
      steps: this.stepCount,
      title: plan.title,
      summary: verification.summary,
      verificationMethod: verification.verificationMethod,
      toolsUsed: [...new Set(this.executionLog.map(l => l.type).filter(Boolean))],
    }, { source: 'AgentLoop' });

    return {
      success: verification.success,
      summary: verification.summary,
      steps: this.executionLog,
      verification,
    };
  },

};

module.exports = { agentLoopPursuitMixin };
