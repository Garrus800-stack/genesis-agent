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
// Error recovery, verification, reflection (extracted from AgentLoop)
const { AgentLoopRecoveryDelegate } = require('./AgentLoopRecovery');
// Approval lifecycle (extracted from AgentLoop)
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

    // v7.9.7-fix (P5 high-risk-on-retry): per-goal pursuit attempt counter,
    // incremented at the start of each pursue() call, deleted on success.
    // Pursuit code consults this to decide whether to honour the simulation
    // advisory or hard-gate it: first attempt always proceeds (advisory),
    // second+ attempt with high risk score (>=5.0) aborts so Genesis
    // doesn't burn pursuits 2/3/4 on the same risky plan that just failed.
    /** @type {Map<string, number>} */
    this._pursuitAttempts = new Map();

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

    // v3.8.0: Composition delegates (replace prototype mixins)
    this.planner = new AgentLoopPlannerDelegate(this);
    this.steps = new AgentLoopStepsDelegate(this);
    this.cognition = new AgentLoopCognitionDelegate(this); // v4.0: Phase 9
    this.recovery = new AgentLoopRecoveryDelegate(this);   // repair + verify
    this.approval = new ApprovalGate({                     // approval lifecycle
      bus: this.bus,
      parent: this,            // v7.2.2: Lazy-read trustLevelSystem after late-binding
      timeoutMs: this._approvalTimeoutMs,
    });
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════


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
  // STEP EXECUTION (delegated to AgentLoopSteps.js)
  // ════════════════════════════════════════════════════════
  // _executeStep, _stepAnalyze, _stepCode, _stepSandbox,
  // _stepShell, _stepSearch, _stepAsk, _stepDelegate, _extractSkills
  // → delegated via composition (this.steps, this.planner,
  //   this.cognition, this.recovery — see bottom of file)

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

// v7.6.9: pursue() and _executeLoop() are mixin-mounted from AgentLoopPursuit.js.
// Pattern note: existing splits (planner/steps/cognition/recovery) use the
// delegate-pattern. Mixin pattern is used for pursue/_executeLoop because
// they have deep state-coupling (23+/19+ this.X references with writes)
// where delegate-pattern would force ~50 verbose this.agentLoop.X
// references and risk subtle this-binding bugs in arrow callbacks.
// Same approach as Settings v7.6.7, GoalStack v7.6.8, ModelBridgeFailover v7.6.5.
const { agentLoopPursuitMixin } = require('./AgentLoopPursuit');
Object.assign(AgentLoop.prototype, agentLoopPursuitMixin);

module.exports = { AgentLoop };
