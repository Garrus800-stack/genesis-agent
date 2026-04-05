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
    lateBindings: [],
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
    // When the agent needs user approval, it pauses and emits an event.
    // The UI can then show a confirmation dialog.
    this._pendingApproval = null;  // { action, description, resolve, reject }

    // v3.5.0: Multi-agent delegation (late-bound by Container)
    this.taskDelegation = null;

    // v3.5.0: HTN Planner for pre-validation (late-bound)
    this.htnPlanner = null;

    // v3.5.0: Cognitive Agent modules (late-bound by Container)
    this.verifier = null;        // VerificationEngine — programmatic truth
    this.formalPlanner = null;   // FormalPlanner — typed actions + simulation
    this.worldState = null;      // WorldState — environment model
    this.episodicMemory = null;  // EpisodicMemory — temporal memory
    this.metaLearning = null;    // MetaLearning — prompt strategy optimization

    // v6.0.7: Earned Autonomy — trust-gated approval bypass
    this.trustLevelSystem = null; // late-bound from phase 11

    // v6.0.8: Symbolic resolution — bypass LLM for known solutions
    this._symbolicResolver = null; // late-bound from phase 2

    // v6.0.8: Consciousness-driven step boost — productive tension extends patience
    this._unsubs = [];
    this._unsubs.push(this.bus.on('consciousness:insight', (insight) => {
      if (insight?.type === 'productive-tension' && this.running) {
        this.maxStepsPerGoal += LIMITS.AGENT_LOOP_STEP_EXTENSION;
        _log.info(`[LOOP] Productive tension detected — step limit raised to ${this.maxStepsPerGoal}`);
      }
    }));

    // v3.8.0: Composition delegates (replace prototype mixins)
    this.planner = new AgentLoopPlannerDelegate(this);
    this.steps = new AgentLoopStepsDelegate(this);
    this.cognition = new AgentLoopCognitionDelegate(this); // v4.0: Phase 9
  }

  // ════════════════════════════════════════════════════════
  // COGNITIVE LEVEL DIAGNOSTIC (v3.5.3)
  // ════════════════════════════════════════════════════════

  /**
   * FIX v3.5.3: Report cognitive level after late-bindings are wired.
   * All 7 cognitive services are optional — if any fail to bind,
   * the loop silently degrades to pre-v3.5.0 behavior (raw LLM
   * planning without verification). This method logs the actual
   * cognitive level so degradation is never silent.
   */
  _reportCognitiveLevel() {
    const core = { verifier: this.verifier, formalPlanner: this.formalPlanner, worldState: this.worldState };
    const extended = { episodicMemory: this.episodicMemory, metaLearning: this.metaLearning };
    const auxiliary = { htnPlanner: this.htnPlanner, taskDelegation: this.taskDelegation };

    const coreBound = Object.entries(core).filter(([, v]) => v != null).map(([k]) => k);
    const extBound = Object.entries(extended).filter(([, v]) => v != null).map(([k]) => k);
    const auxBound = Object.entries(auxiliary).filter(([, v]) => v != null).map(([k]) => k);
    const coreMissing = Object.entries(core).filter(([, v]) => v == null).map(([k]) => k);

    const level = coreBound.length === Object.keys(core).length ? 'FULL'
      : coreBound.length > 0 ? 'PARTIAL' : 'NONE';

    this._cognitiveLevel = level;

    if (level !== 'FULL') {
      _log.warn(`[AGENT-LOOP] Cognitive level: ${level} — bound: [${coreBound.join(', ')}], missing: [${coreMissing.join(', ')}]`);
      this.bus.emit('agent:status', {
        state: 'warning',
        detail: `AgentLoop cognitive level: ${level} — missing: ${coreMissing.join(', ')}`,
      }, { source: 'AgentLoop' });
    } else {
      _log.info(`[AGENT-LOOP] Cognitive level: FULL — core: [${coreBound.join(', ')}], extended: [${extBound.join(', ')}], aux: [${auxBound.join(', ')}]`);
    }
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
  // @ts-ignore — TS strict
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
      // @ts-ignore — TS strict
      goalTitle: typeof goal === 'string' ? goal.slice(0, 100) : 'goal',
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
      const plan = await this.planner._planGoal(goalDescription);

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
            const proceed = await this._requestApproval(
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
      this.currentGoalId = this.goalStack.addGoal({
        title: plan.title || goalDescription.slice(0, 80),
        description: goalDescription,
        steps: plan.steps,
        source: 'agent-loop',
      });

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
        onProgress({ phase: 'simulation-replan', detail: cogResult.reason, risk: cogResult.riskScore });
        this.running = false;
        _clearGlobalTimeout();
        return { success: false, error: `Simulation recommends replan: ${cogResult.reason}`, simulation: cogResult.simulation };
      }

      // ── Phase 1c: CONSCIOUSNESS CHECK (v4.12.4) ────────
      // If consciousness has concerns, inject them into plan
      // context so the LLM sees them during execution.
      if (cogResult.consciousnessConcerns?.length > 0) {
        // @ts-ignore — TS strict
        plan._consciousnessContext = cogResult.consciousnessConcerns.join(' ');
        // @ts-ignore — TS strict
        onProgress({ phase: 'consciousness', detail: plan._consciousnessContext });
      }
      if (cogResult.valueContext) {
        // @ts-ignore — TS strict
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
    if (this._pendingApproval) {
      this._pendingApproval.reject(new Error('Agent loop stopped by user'));
      this._pendingApproval = null;
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
    if (this._pendingApproval) {
      this._pendingApproval.resolve(true);
      this._pendingApproval = null;
    }
  }

  /** Reject a pending action */
  reject(reason = 'User rejected') {
    if (this._pendingApproval) {
      this._pendingApproval.resolve(false);
      this._pendingApproval = null;
    }
  }

  /** Get current status */
  getStatus() {
    return {
      running: this.running,
      goalId: this.currentGoalId,
      stepCount: this.stepCount,
      consecutiveErrors: this.consecutiveErrors,
      pendingApproval: this._pendingApproval ? {
        action: this._pendingApproval.action,
        description: this._pendingApproval.description,
      } : null,
      recentLog: this.executionLog.slice(-5),
    };
  }

  // ════════════════════════════════════════════════════════
  // PHASE 1: PLANNING (delegated to AgentLoopPlanner.js)
  // ════════════════════════════════════════════════════════
  // _planGoal, _llmPlanGoal, _salvagePlan, _inferStepType
  // → mixed in via prototype at bottom of file

  // ════════════════════════════════════════════════════════
  // PHASE 2: EXECUTION LOOP
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
        const shouldContinue = await this._requestApproval(
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
      const context = await this._buildStepContext(step, i, steps, allResults);

      // ── ACT: Execute the step ─────────────────────────
      const result = await this.steps._executeStep(step, context, onProgress);

      // ── v3.5.0: VERIFY — programmatic verification ────
      if (this.verifier && result && !result.error) {
        try {
          const stepVerification = await this.verifier.verify(
            step.type || step.verifierType, step, result
          );
          if (stepVerification.status === 'fail') {
            result.error = `Verification failed: ${stepVerification.reason}`;
            // @ts-ignore — TS strict
            result.verification = stepVerification;
          } else {
            // @ts-ignore — TS strict
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
        // @ts-ignore — TS strict
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
        const recovery = await this._classifyAndRecover(step, result, i, onProgress);
        if (recovery.action === 'retry') {
          i--; // Retry same step
          allResults.push({ retried: true, category: recovery.category });
          continue;
        }

        if (this.consecutiveErrors >= this.maxConsecutiveErrors) {
          // ── REFLECT: Too many errors — attempt self-repair ──
          const repairResult = await this._attemptRepair(step, result, allResults, onProgress);
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
        const adjustment = await this._reflectOnProgress(plan, allResults, i);
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
    const verification = await this._verifyGoal(plan, allResults);

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
  // REFLECTION & REPAIR
  // ════════════════════════════════════════════════════════

  _buildStepContext(step, stepIndex, allSteps, previousResults) {
    const recentResults = previousResults.slice(-3).map((r, i) => {
      const stepNum = stepIndex - previousResults.slice(-3).length + i + 1;
      return `Step ${stepNum}: ${r.error ? 'ERROR: ' + r.error : (r.output || '').slice(0, 200)}`;
    }).join('\n');

    // v4.12.4: Find the plan object to access consciousness context
    const plan = this._currentPlan || {};
    const consciousnessHint = plan._consciousnessContext
      ? `\n${plan._consciousnessContext}`
      : '';
    const valueHint = plan._valueContext
      ? `\nRELEVANT VALUES: ${plan._valueContext}`
      : '';
    // v5.2.0 (SA-P6): Working memory contents
    // @ts-ignore — TS strict
    const workspaceHint = this._workspace.buildContext(5);

    return `You are Genesis, executing step ${stepIndex + 1}/${allSteps.length} of an autonomous plan.
${recentResults ? '\nRecent results:\n' + recentResults : ''}${consciousnessHint}${valueHint}${workspaceHint ? '\n' + workspaceHint : ''}
Current step: ${step.type} — ${step.description}
${step.target ? 'Target: ' + step.target : ''}`;
  }

  async _reflectOnProgress(plan, results, currentStep) {
    const recentErrors = results.slice(-3).filter(r => r.error);
    if (recentErrors.length === 0) return null; // All going well

    const prompt = `You are Genesis. You're ${currentStep + 1}/${plan.steps.length} steps into a plan.

Goal: "${plan.title}"
Success criteria: ${plan.successCriteria || 'Complete all steps'}

Recent errors: ${recentErrors.map(r => r.error).join('; ')}

Should the plan be adjusted? If yes, provide new remaining steps.
Respond with JSON: { "adjust": true/false, "reason": "why", "newSteps": [...] }
If no adjustment needed: { "adjust": false }`;

    try {
      const response = await this.model.chatStructured(prompt, [], 'analysis');
      if (response.adjust && response.newSteps) {
        return { reason: response.reason, newSteps: response.newSteps };
      }
    } catch (err) { _log.debug('[AGENT-LOOP] Persist error:', err.message); }
    return null;
  }

  /**
   * FIX v5.1.0 (SA-O2): Extracted from _executeLoop to reduce CC.
   * Classifies the error via FailureTaxonomy and applies recovery strategy.
   * @returns {Promise<*>}
   */
  // @ts-ignore — TS strict
  async _classifyAndRecover(step, result, stepIndex, onProgress) {
    try {
      const ft = this.bus._container?.resolve?.('failureTaxonomy')
        // @ts-ignore — TS strict
        || (this._failureTaxonomy || null);
      if (!ft) return { action: 'none' };

      const taxonomy = ft.classify(result.error, {
        actionType: step.type,
        stepIndex,
        goalId: this.currentGoalId,
        model: this.model?.activeModel,
        attempt: this.consecutiveErrors - 1,
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
          const ws = this.bus._container?.resolve?.('worldState');
          if (ws) await ws.refresh();
        } catch (_e) { _log.debug('[catch] worldState refresh:', _e.message); }
      } else if (taxonomy.strategy === 'escalate_model' && taxonomy.escalation) {
        try {
          const mr = this.bus._container?.resolve?.('modelRouter');
          if (mr) mr.escalate?.(step.type);
        } catch (_e) { _log.debug('[catch] model escalation:', _e.message); }
      }
    } catch (_e) { _log.debug('[catch] FailureTaxonomy not available:', _e.message); }

    return { action: 'none' };
  }

  async _attemptRepair(failedStep, failedResult, allResults, onProgress) {
    onProgress({ phase: 'repairing', detail: `Attempting to fix: ${failedResult.error}` });

    const prompt = `You are Genesis. A step in your autonomous execution failed.

Failed step: ${failedStep.type} — ${failedStep.description}
Error: ${failedResult.error}
Output: ${(failedResult.output || '').slice(0, 500)}

What went wrong and how can you fix it? Provide a corrected approach.
If the error is unfixable (e.g., missing dependency, permission denied), say "UNFIXABLE: reason".`;

    const analysis = await this.model.chat(prompt, [], 'analysis');

    if (analysis.includes('UNFIXABLE')) {
      return { recovered: false, output: analysis };
    }

    // Try the step again with the repair context
    const repairedStep = { ...failedStep };
    const repairContext = `REPAIR ATTEMPT: Previous error was "${failedResult.error}". Fix: ${analysis.slice(0, 500)}`;

    const retryResult = await this.steps._executeStep(repairedStep, repairContext, onProgress);
    return {
      recovered: !retryResult.error,
      output: retryResult.output,
      error: retryResult.error,
    };
  }

  async _verifyGoal(plan, allResults) {
    const errors = allResults.filter(r => r.error);
    const successRate = (allResults.length - errors.length) / allResults.length;

    // v3.5.0: Count programmatic verification results
    const verified = allResults.filter(r => r.verification);
    const programmaticPasses = verified.filter(r => r.verification.status === 'pass').length;
    const programmaticFails = verified.filter(r => r.verification.status === 'fail').length;
    const ambiguous = verified.filter(r => r.verification.status === 'ambiguous').length;

    // If we have programmatic verification data, trust it over heuristics
    if (verified.length > 0 && programmaticFails === 0 && successRate >= 0.7) {
      const summary = [
        `Goal "${plan.title}" completed.`,
        `${allResults.length} steps: ${programmaticPasses} verified, ${ambiguous} ambiguous, ${errors.length} errors.`,
        `Success rate: ${Math.round(successRate * 100)}%.`,
      ].join(' ');
      return { success: true, summary, verificationMethod: 'programmatic' };
    }

    // High success rate without verification data — trust the numbers
    if (successRate >= 0.8 && programmaticFails === 0) {
      return {
        success: true,
        summary: `Goal "${plan.title}" completed. ${allResults.length} steps, ${errors.length} errors. Success rate: ${Math.round(successRate * 100)}%.`,
        verificationMethod: 'heuristic',
      };
    }

    // Ambiguous: Ask LLM to evaluate (only for cases programmatic checks can't resolve)
    const verificationContext = verified.length > 0
      ? `\nProgrammatic verification: ${programmaticPasses} pass, ${programmaticFails} fail, ${ambiguous} ambiguous`
      : '';

    const prompt = `Goal: "${plan.title}"
Success criteria: ${plan.successCriteria || 'All steps complete'}
Steps completed: ${allResults.length}
Errors: ${errors.length}
Error details: ${errors.map(e => e.error).join('; ')}${verificationContext}

Was this goal achieved? Respond with: SUCCESS or PARTIAL or FAILED, followed by a brief explanation.`;

    const evaluation = await this.model.chat(prompt, [], 'analysis');

    // v3.5.0: Record episode if EpisodicMemory is available
    if (this.episodicMemory) {
      try {
        const success = evaluation.toUpperCase().startsWith('SUCCESS');
        this.episodicMemory.recordEpisode({
          topic: plan.title || 'Agent goal execution',
          summary: evaluation.slice(0, 200),
          outcome: success ? 'success' : 'failed',
          toolsUsed: [...new Set(allResults.map(r => r.type).filter(Boolean))],
          artifacts: allResults
            .filter(r => r.target)
            .map(r => ({ type: 'file-modified', path: r.target })),
          tags: this._extractTags(plan.title + ' ' + (plan.successCriteria || '')),
        });
      } catch (err) { _log.debug('[AGENT-LOOP] Episode recording failed:', err.message); }
    }

    return {
      success: evaluation.toUpperCase().startsWith('SUCCESS'),
      summary: evaluation.slice(0, 300),
      verificationMethod: 'llm-fallback',
    };
  }

  /** Extract topic tags from text for episodic memory */
  _extractTags(text) {
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

  // ════════════════════════════════════════════════════════
  // APPROVAL MECHANISM
  // ════════════════════════════════════════════════════════

  /**
   * Request user approval. Pauses the loop until approved/rejected.
   * If no response within 60s, auto-reject (safety).
   *
   * v6.0.7: Consults TrustLevelSystem first. If the action is auto-approved
   * at the current trust level, the user is never asked.
   */
  _requestApproval(action, description) {
    // v6.0.7: Trust-gated bypass — skip user prompt if auto-approved
    if (this.trustLevelSystem) {
      const trust = this.trustLevelSystem.checkApproval(action);
      if (trust.approved) {
        _log.info(`[TRUST] Auto-approved "${action}" — ${trust.reason}`);
        this.bus.fire('agent-loop:auto-approved', {
          action,
          description,
          reason: trust.reason,
          goalId: this.currentGoalId,
        }, { source: 'AgentLoop' });
        return Promise.resolve(true);
      }
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this._pendingApproval = null;
        resolve(false); // Auto-reject after timeout
      }, this._approvalTimeoutMs);

      this._pendingApproval = {
        action,
        description,
        resolve: (approved) => {
          clearTimeout(timeout);
          this._pendingApproval = null;
          resolve(approved);
        },
        reject: () => {
          clearTimeout(timeout);
          this._pendingApproval = null;
          resolve(false);
        },
      };

      this.bus.fire('agent-loop:approval-needed', {
        action,
        description,
        goalId: this.currentGoalId,
      }, { source: 'AgentLoop' });
    });
  }

  // ════════════════════════════════════════════════════════
  // CHATorchestrator INTEGRATION
  // ════════════════════════════════════════════════════════

  /**
   * Register this as a handler in ChatOrchestrator.
   * Detects goal-oriented messages and routes them to pursue().
   */
  registerHandlers(orchestrator) {
    // FIX v3.5.3: Report cognitive level after late-bindings are wired
    this._reportCognitiveLevel();

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

// ═══════════════════════════════════════════════════════════
// v3.8.0: Prototype mixins removed. Planning and step-execution
// are now composition delegates (this.planner, this.steps).
// See AgentLoopPlanner.js and AgentLoopSteps.js for the
// AgentLoopPlannerDelegate and AgentLoopStepsDelegate classes.
// ═══════════════════════════════════════════════════════════

module.exports = { AgentLoop };
