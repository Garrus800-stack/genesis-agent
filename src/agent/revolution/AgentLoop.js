// @ts-checked-v5.8
// ============================================================
// GENESIS — AgentLoop.js (v3.8.0 — Composition over Mixins)
//
// v3.8.0 UPGRADE: Prototype mixins replaced with composition.
// AgentLoopPlanner and AgentLoopSteps are now instantiated as
// delegates (this.planner, this.steps) instead of being mixed
// into the prototype. Benefits:
//   - IDE navigation works (Go-to-Definition on this.planner.plan)
//   - No method name collision risk
//   - Clear stack traces (AgentLoopPlanner._planGoal vs AgentLoop._planGoal)
//   - TypeScript-compatible
//
// The delegates receive a reference to the AgentLoop instance
// via their constructor, so they retain full access to all
// AgentLoop state (this.model, this.sandbox, etc.).
//
// The loop follows the Cognitive Pattern:
//   Perceive (WorldState) → Plan (FormalPlanner) →
//   Act (execute) → Verify (VerificationEngine) →
//   Learn (MetaLearning + EpisodicMemory) → Loop
//
// Integration:
// - ChatOrchestrator detects goal-oriented messages → routes to AgentLoop
// - AgentLoop uses GoalStack for planning, Sandbox for execution,
//   SelfModPipeline for code changes, ShellAgent for shell commands
// - Progress is streamed to UI in real-time
// - User can interrupt, redirect, or approve at any step
// ============================================================

const { NullBus } = require('../core/EventBus');
const { TIMEOUTS, LIMITS } = require('../core/Constants');

// v3.8.0: Composition — delegates instead of prototype mixins
const { AgentLoopPlannerDelegate } = require('./AgentLoopPlanner');
const { AgentLoopStepsDelegate } = require('./AgentLoopSteps');
// v4.0: Phase 9 cognitive hooks (graceful degradation if services missing)
const { AgentLoopCognitionDelegate } = require('./AgentLoopCognition');
// v7.6.0: Error recovery, verification, reflection (extracted from AgentLoop)
const { AgentLoopRecoveryDelegate } = require('./AgentLoopRecovery');
// v7.6.0: Approval lifecycle (extracted from AgentLoop)
const { ApprovalGate } = require('./ApprovalGate');
const { createLogger } = require('../core/Logger');
const { CorrelationContext } = require('../core/CorrelationContext');
const { CancellationToken } = require('../core/CancellationToken');
// v5.5.0: WorkspacePort replaces direct import from cognitive/ (cross-phase coupling fix).
// Real CognitiveWorkspace factory injected via late-binding from phase 9 manifest.
const { NullWorkspace, nullWorkspaceFactory } = require('../ports/WorkspacePort');
const _log = createLogger('AgentLoop');

class AgentLoop {
  // ModuleRegistry auto-discovery config
  static containerConfig = {
    name: 'agentLoop',
    phase: 8,
    deps: ['model', 'goalStack', 'sandbox', 'selfModel', 'memory', 'knowledgeGraph', 'tools', 'eventStore', 'shellAgent', 'selfModPipeline', 'storage'],
    tags: ['revolution', 'autonomy'],
    lateBindings: [
      { prop: '_colonyOrchestrator', service: 'colonyOrchestrator', optional: true },
    ],
  };

  constructor({
    bus, model, goalStack, sandbox, selfModel, memory, knowledgeGraph,
    tools, guard, eventStore, shellAgent, selfModPipeline, lang,
    storage, rootDir, approvalTimeoutMs, strictCognitiveMode,
  }) {
    this.bus = bus || NullBus;
    this.model = model;
    this.goalStack = goalStack;
    this.sandbox = sandbox;
    this.selfModel = selfModel;
    this.memory = memory;
    this.kg = knowledgeGraph;
    this.tools = tools;
    this.guard = guard;
    this.eventStore = eventStore;
    this.shell = shellAgent;
    this.selfMod = selfModPipeline;
    this.lang = lang || { t: (k) => k };
    this.storage = storage || null;
    this.rootDir = rootDir;

    // v3.7.0: Strict cognitive mode — blocks pursue() if core services missing
    this._strictCognitiveMode = strictCognitiveMode || false;

    // ── Loop State ───────────────────────────────────────
    this.running = false;
    this.currentGoalId = null;
    this.stepCount = 0;
    this.maxStepsPerGoal = LIMITS.AGENT_LOOP_MAX_STEPS;
    this.maxConsecutiveErrors = LIMITS.AGENT_LOOP_MAX_ERRORS;
    this.consecutiveErrors = 0;
    this._aborted = false;
    this._approvalTimeoutMs = approvalTimeoutMs || TIMEOUTS.APPROVAL_DEFAULT;

    // v5.2.0: Structured cancellation — replaces raw _aborted boolean.
    // Steps can check token.isCancelled or call token.throwIfCancelled().
    // Child tokens per step enable fine-grained cancellation.
    this._cancelToken = null;

    // v5.2.0 (SA-P6): Working memory — transient scratchpad per goal.
    // Created fresh on each pursue(), cleared on completion.
    // Steps auto-store summaries, PromptBuilder includes in context.
    // v5.5.0: Working memory via WorkspacePort — factory injected from phase 9.
    // Defaults to NullWorkspace when cognitive layer not loaded.
    this._workspace = new NullWorkspace();
    this._createWorkspace = nullWorkspaceFactory;

    // ── Execution Log (for the current goal) ─────────────
    // FIX v4.0.0 (F-05): Cap executionLog to prevent unbounded growth
    // during long-running goals with many steps + extensions.
    this.executionLog = [];  // { step, action, result, timestamp }
    this._maxExecutionLogEntries = (LIMITS.AGENT_LOOP_MAX_STEPS + LIMITS.AGENT_LOOP_STEP_EXTENSION * 3) * 2; // generous cap

    // FIX v3.5.3: Track in-flight step for graceful shutdown
    this._currentStepPromise = null;

    // ── Approval Queue ───────────────────────────────────
    // ── Late-bound services (injected by Container) ─────
    this.taskDelegation = null;     // Multi-agent delegation
    this.htnPlanner = null;         // HTN pre-validation
    this.verifier = null;           // VerificationEngine
    this.formalPlanner = null;      // FormalPlanner
    this.worldState = null;         // WorldState
    this.episodicMemory = null;     // EpisodicMemory
    this.metaLearning = null;       // MetaLearning
    this.trustLevelSystem = null;   // EarnedAutonomy (v6.0.7)
    this._symbolicResolver = null;  // SymbolicResolver (v6.0.8)
    /** @type {*} */ this._failureTaxonomy = null;    // v7.0.5
    /** @type {*} */ this._colonyOrchestrator = null;  // v7.0.3
    /** @type {*} */ this.colonyInsights = null;

    /** @type {function(string, string): Promise<boolean>} */
    this._requestApproval = async () => true;
    this._unsubs = [];

    // v3.8.0: Composition delegates (replace prototype mixins)
    this.planner = new AgentLoopPlannerDelegate(this);
    this.steps = new AgentLoopStepsDelegate(this);
    this.cognition = new AgentLoopCognitionDelegate(this); // v4.0: Phase 9
    this.recovery = new AgentLoopRecoveryDelegate(this);   // v7.6.0: repair + verify
    this.approval = new ApprovalGate({                     // v7.6.0: approval lifecycle
      bus: this.bus,
      trustLevelSystem: this.trustLevelSystem,
      timeoutMs: this._approvalTimeoutMs,
    });
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Start pursuing a goal. This is the main entry point.
   * Called by ChatOrchestrator when it detects a goal-oriented message.
   *
   * @param {string} goalDescription - Natural language goal from user
   * @param {Function} onProgress - (update) => void — streams progress to UI
   * @returns {Promise<*>}
   */
  async pursue(goalDescription, onProgress = () => {}) {
    if (this.running) {
      return { success: false, error: 'Agent loop already running. Use stop() first.' };
    }

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

    this.running = true;
    this._aborted = false;
    this.stepCount = 0;
    this.consecutiveErrors = 0;
    this.executionLog = [];

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
      /** @type {*} */ const plan = await this.planner._planGoal(goalDescription);

      if (!plan || !plan.steps || plan.steps.length === 0) {
        this.running = false;
        _clearGlobalTimeout();
        return { success: false, error: 'Could not decompose goal into actionable steps.' };
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
              return { success: false, error: 'User rejected plan with blockers' };
            }
          }
        } catch (err) {
          if (err.message && err.message.includes('rejected')) {
            this.running = false;
            _clearGlobalTimeout();
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

      const _registeredGoal = await this.goalStack.addGoal(
        goalDescription.slice(0, 200),
        'agent-loop',
        'high',
      );
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
      return { success: false, error: err.message, steps: this.executionLog, goalId: failedGoalId };
    }
    }); // end of CorrelationContext.run
  }

  /**
   * Stop the current goal execution.
   * FIX v3.5.3: Returns a promise that resolves when the current
   * in-flight step finishes (max 5s wait), preventing interrupted
   * file writes during shutdown.
   */
  stop() {
    this._aborted = true;
    this._cancelToken?.cancel('Stopped by user');
    this.running = false;
    for (const unsub of this._unsubs) { if (typeof unsub === 'function') unsub(); }
    this._unsubs = [];
    if (this.approval.isPending) {
      this.approval.cancel();
    }
    // Wait for in-flight step to complete (with timeout)
    if (this._currentStepPromise) {
      return Promise.race([
        this._currentStepPromise.catch(() => { /* best effort */ }),
        new Promise(r => setTimeout(r, TIMEOUTS.AGENT_LOOP_DRAIN)),
      ]);
    }
    return Promise.resolve();
  }

  /** Approve a pending action */
  approve() {
    this.approval.approve();
  }

  /** Reject a pending action */
  reject(reason = 'User rejected') {
    this.approval.reject(reason);
  }

  /** Get current status */
  getStatus() {
    return {
      running: this.running,
      goalId: this.currentGoalId,
      stepCount: this.stepCount,
      consecutiveErrors: this.consecutiveErrors,
      pendingApproval: this.approval.pendingAction,
      recentLog: this.executionLog.slice(-5),
    };
  }

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
        this.bus.emit('agent-loop:step-failed', {
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
        this.bus.emit('agent-loop:step-complete', {
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
  }

  // ════════════════════════════════════════════════════════
  // STEP EXECUTION (delegated to AgentLoopSteps.js)
  // ════════════════════════════════════════════════════════
  // _executeStep, _stepAnalyze, _stepCode, _stepSandbox,
  // _stepShell, _stepSearch, _stepAsk, _stepDelegate, _extractSkills
  // → mixed in via prototype at bottom of file

  // ════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════
  // CHATorchestrator INTEGRATION
  // ════════════════════════════════════════════════════════

  /**
   * Register this as a handler in ChatOrchestrator.
   * Detects goal-oriented messages and routes them to pursue().
   */
  registerHandlers(orchestrator) {
    // FIX v3.5.3: Report cognitive level after late-bindings are wired
    this.cognition.reportCognitiveLevel();

    orchestrator.registerHandler('agent-goal', async (message, { history }) => {
      let fullResponse = '';

      const result = await this.pursue(message, (update) => {
        const line = `\n[${update.phase}] ${update.detail || ''}`;
        fullResponse += line;
        // Could also stream via bus events
      });

      if (result.success) {
        fullResponse += `\n\n**Goal completed.** ${result.summary}`;
      } else {
        fullResponse += `\n\n**Goal ${result.aborted ? 'aborted' : 'failed'}.** ${result.summary || result.error}`;
      }

      return fullResponse;
    });
  }
}

// v3.8.0: Composition delegates (this.planner, this.steps, this.recovery, this.cognition).
module.exports = { AgentLoop };
