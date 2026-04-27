// @ts-checked-v5.7
// ============================================================
// GENESIS — FormalPlanner.js (v3.5.0 — Cognitive Agent)
//
// THE PLANNING REVOLUTION: Plans are no longer just LLM text.
// Every action is typed, has preconditions and effects, and
// the entire plan is SIMULATED against WorldState before
// execution begins.
//
// Architecture:
//   1. LLM decomposes goal into natural language steps (creative)
//   2. FormalPlanner typifies each step → Action Library match
//   3. Preconditions checked against WorldState clone
//   4. Effects applied to simulated state
//   5. If simulation fails → LLM replans with constraint context
//   6. Cost calculated, dependencies ordered
//
// Action Library: ANALYZE, CODE_GENERATE, WRITE_FILE, RUN_TESTS,
//   SHELL_EXEC, SEARCH, ASK_USER, DELEGATE, GIT_SNAPSHOT, SELF_MODIFY
//
// Replaces: HTNPlanner.js (which only did dryRun validation)
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { buildOsContext } = require('../core/EnvironmentContext');
const _log = createLogger('FormalPlanner');

class FormalPlanner {
  // NOTE: containerConfig is informational only — this module is registered
  // via the phase manifest, not via ModuleRegistry auto-discovery.
  // Real lateBindings are declared in the manifest entry.
  constructor({ bus, worldState, verifier, toolRegistry, model, selfModel, sandbox, guard, eventStore, storage, rootDir }) {
    this.bus = bus || NullBus;
    this.worldState = worldState;
    this.verifier = verifier;
    this.tools = toolRegistry;
    this.model = model;
    this.selfModel = selfModel;
    this.sandbox = sandbox;
    this.guard = guard;
    this.eventStore = eventStore;
    this.storage = storage || null;
    this.rootDir = rootDir;

    // v4.10.0: EmotionalSteering — set via late-binding
    this._emotionalSteering = null;

    // ── Action Library ─────────────────────────────────────
    this.actions = new Map();
    this._registerBuiltinActions();

    // ── Planning stats ─────────────────────────────────────
    this._stats = { plans: 0, replans: 0, simFailures: 0 };
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Plan a goal. Returns a validated, cost-estimated plan.
   *
   * @param {string} goalDescription - Natural language goal
   * @param {object} context - { history, memory }
   * @returns {Promise<object>}
   */
  async plan(goalDescription, context = {}) {
    this._stats.plans++;

    this.bus.emit('planner:started', {
      goal: goalDescription.slice(0, 100),
    }, { source: 'FormalPlanner' });

    // 1. LLM decomposes (creative part — the LLM's strength)
    const rawPlan = await this._llmDecompose(goalDescription, context);
    if (!rawPlan || !rawPlan.steps || rawPlan.steps.length === 0) {
      return { steps: [], valid: false, issues: [{ reason: 'LLM could not decompose goal' }], cost: 0 };
    }

    // v4.10.0: EmotionalSteering — limit plan length if energy is low
    let steps = rawPlan.steps;
    if (this._emotionalSteering) {
      try {
        const signals = this._emotionalSteering.getSignals();
        if (signals.planLengthLimit && steps.length > signals.planLengthLimit) {
          steps = steps.slice(0, signals.planLengthLimit);
          this.bus.emit('planner:truncated', {
            original: rawPlan.steps.length,
            limited: steps.length,
            reason: 'Low energy — plan shortened',
          }, { source: 'FormalPlanner' });
        }
      } catch (_e) { _log.debug('[catch] steering not available:', _e.message); }
    }

    // 2. Typify each step → Action Library match
    const typedSteps = steps.map((step, i) => this._typifyStep(step, i));

    // 3. Simulate against WorldState clone
    let simulation = this._simulatePlan(typedSteps);

    // 4. If simulation fails → replan with constraints
    if (!simulation.valid && simulation.issues.length > 0) {
      this._stats.replans++;

      this.bus.emit('planner:replanning', {
        issues: simulation.issues.length,
      }, { source: 'FormalPlanner' });

      const replanned = await this._replanWithConstraints(goalDescription, simulation.issues, context);
      if (replanned && replanned.steps.length > 0) {
        const retypedSteps = replanned.steps.map((step, i) => this._typifyStep(step, i));
        simulation = this._simulatePlan(retypedSteps);

        if (simulation.valid) {
          return this._buildPlanResult(retypedSteps, simulation, rawPlan.title || goalDescription);
        }
      }

      // Replan also failed — return with issues
      this._stats.simFailures++;
      return {
        steps: typedSteps,
        valid: false,
        issues: simulation.issues,
        cost: simulation.totalCost,
        estimatedTimeMs: simulation.totalCost * 15000,
        title: rawPlan.title || goalDescription.slice(0, 80),
      };
    }

    return this._buildPlanResult(typedSteps, simulation, rawPlan.title || goalDescription);
  }

  /**
   * Register a custom action in the library.
   * Skills and MCP tools can register their own actions.
   */
  registerAction(spec) {
    this.actions.set(spec.name, {
      name: spec.name,
      preconditions: spec.preconditions || [],
      effects: spec.effects || [],
      cost: spec.cost || (() => 1),
      verifierType: spec.verifierType || null,
      requiresApproval: spec.requiresApproval || false,
      description: spec.description || '',
    });
  }

  /** Get available action types */
  getActionTypes() {
    return Array.from(this.actions.keys());
  }

  getStats() { return { ...this._stats }; }

  // ════════════════════════════════════════════════════════
  // ACTION LIBRARY
  // ════════════════════════════════════════════════════════

  _registerBuiltinActions() {
    this.registerAction({
      name: 'ANALYZE',
      description: 'Read and analyze code, files, or data',
      preconditions: [],
      effects: [],
      cost: () => 2,
      verifierType: null, // Subjective — goes to LLM
    });

    this.registerAction({
      name: 'CODE_GENERATE',
      description: 'Generate code using the LLM',
      preconditions: [
        (_params, state) => state.canUseModel(),
      ],
      effects: [],
      cost: () => 3,
      verifierType: 'code',
    });

    this.registerAction({
      name: 'WRITE_FILE',
      description: 'Write content to a file',
      preconditions: [
        (params, state) => state.canWriteFile(params.target || params.path),
      ],
      effects: [
        (params, state) => state.markFileModified(params.target || params.path),
      ],
      cost: () => 1,
      verifierType: 'file',
      requiresApproval: true,
    });

    this.registerAction({
      name: 'RUN_TESTS',
      description: 'Execute the test suite',
      preconditions: [
        (_params, state) => state.canRunTests(),
      ],
      effects: [],
      cost: () => 5,
      verifierType: 'test',
    });

    this.registerAction({
      name: 'SHELL_EXEC',
      description: 'Execute a shell command',
      preconditions: [
        (params, state) => state.canRunShell(params.command),
      ],
      effects: [],
      cost: (params) => {
        const cmd = (params.command || '').toLowerCase();
        if (cmd.includes('npm install')) return 8;
        if (cmd.includes('git')) return 2;
        return 3;
      },
      verifierType: 'shell',
      requiresApproval: true,
    });

    this.registerAction({
      name: 'SEARCH',
      description: 'Search for information (web, memory, knowledge graph)',
      preconditions: [],
      effects: [],
      cost: () => 2,
      verifierType: null,
    });

    this.registerAction({
      name: 'ASK_USER',
      description: 'Ask the user for a decision or information',
      preconditions: [],
      effects: [],
      cost: () => 1,
      verifierType: null,
    });

    this.registerAction({
      name: 'DELEGATE',
      description: 'Delegate a sub-task to a peer agent',
      preconditions: [],
      effects: [],
      cost: () => 4,
      verifierType: null,
      requiresApproval: true,
    });

    this.registerAction({
      name: 'GIT_SNAPSHOT',
      description: 'Create a git commit as a safety snapshot',
      preconditions: [],
      effects: [],
      cost: () => 1,
      verifierType: 'shell',
    });

    this.registerAction({
      name: 'SELF_MODIFY',
      description: 'Modify Genesis own source code',
      preconditions: [
        (params, state) => !state.isKernelFile(params.target),
        (params, state) => state.canWriteFile(params.target),
      ],
      effects: [
        (params, state) => state.markFileModified(params.target),
      ],
      cost: () => 6,
      verifierType: 'code',
      requiresApproval: true,
    });
  }

  // ════════════════════════════════════════════════════════
  // PLAN CONSTRUCTION
  // ════════════════════════════════════════════════════════

  async _llmDecompose(goalDescription, context) {
    const capabilities = this.selfModel?.getCapabilities() || [];
    const actionTypes = this.getActionTypes().join(', ');
    const recentFiles = this.worldState?.getRecentlyModified()
      .slice(0, 5).map(f => f.path).join(', ') || 'none';

    // v7.4.5.fix #27: tell the LLM what OS Genesis runs on and where
    // its working directory is. Without this, the planner generated
    // POSIX commands ("ls", "cat") on Windows, leading to "command
    // not recognized" errors. Also: planner needs to know the absolute
    // rootDir so it can target files inside Genesis instead of guessing.
    // v7.4.8: extracted to EnvironmentContext helper — single source
    // of truth shared with ShellAgent.plan().
    const { osContext, osName } = buildOsContext({ rootDir: this.rootDir });

    const prompt = `You are Genesis, an autonomous AI agent. Decompose this goal into concrete steps.

GOAL: ${goalDescription}
${osContext}
AVAILABLE ACTION TYPES: ${actionTypes}
YOUR CAPABILITIES: ${capabilities.join(', ')}
RECENTLY MODIFIED FILES: ${recentFiles}
${context.memory ? `MEMORY CONTEXT: ${context.memory.buildContext?.(goalDescription) || ''}` : ''}

Respond with JSON only:
{
  "title": "Short goal title",
  "steps": [
    {
      "type": "ACTION_TYPE",
      "description": "What this step does",
      "target": "optional file path or resource",
      "command": "optional shell command",
      "dependencies": [0, 1]  // indices of steps this depends on
    }
  ],
  "successCriteria": "How to verify the goal is complete"
}

Rules:
- Each step must have a type from AVAILABLE ACTION TYPES
- Keep steps atomic — one action per step
- Include GIT_SNAPSHOT before any WRITE_FILE or SELF_MODIFY
- Include RUN_TESTS after code changes
- Maximum 15 steps
- Use ANALYZE before CODE_GENERATE to understand existing code
- For SHELL steps, use commands appropriate for ${osName} (see ENVIRONMENT above)
- For file operations, use paths relative to or absolute under rootDir`;

    try {
      const response = await this.model.chatStructured(prompt, [], 'planning');
      return response;
    } catch (_e) { _log.debug("[catch] chatStructured fallback:", _e.message);
      // Fallback: try plain text parsing
      try {
        const raw = await this.model.chat(prompt, [], 'planning');
        return this._parseRawPlan(raw);
      } catch (err) {
        _log.warn('[FORMAL-PLANNER] LLM decomposition failed:', err.message);
        return null;
      }
    }
  }

  _typifyStep(rawStep, index) {
    const type = this._normalizeType(rawStep.type || rawStep.action || 'ANALYZE');
    const action = this.actions.get(type) || this.actions.get('ANALYZE');

    return {
      index,
      type: action.name,
      description: rawStep.description || rawStep.task || `Step ${index + 1}`,
      target: rawStep.target || rawStep.file || null,
      command: rawStep.command || null,
      dependencies: rawStep.dependencies || [],
      params: {
        target: rawStep.target || rawStep.file,
        command: rawStep.command,
        code: rawStep.code,
      },
      verifierType: action.verifierType,
      requiresApproval: action.requiresApproval,
      cost: typeof action.cost === 'function' ? action.cost(rawStep) : action.cost,
    };
  }

  _normalizeType(type) {
    const mapping = {
      'analyze': 'ANALYZE', 'analysis': 'ANALYZE', 'read': 'ANALYZE', 'inspect': 'ANALYZE',
      'code': 'CODE_GENERATE', 'generate': 'CODE_GENERATE', 'implement': 'CODE_GENERATE', 'write_code': 'CODE_GENERATE',
      'write': 'WRITE_FILE', 'file': 'WRITE_FILE', 'save': 'WRITE_FILE',
      'test': 'RUN_TESTS', 'tests': 'RUN_TESTS', 'verify': 'RUN_TESTS',
      'shell': 'SHELL_EXEC', 'command': 'SHELL_EXEC', 'exec': 'SHELL_EXEC', 'run': 'SHELL_EXEC',
      'search': 'SEARCH', 'find': 'SEARCH', 'lookup': 'SEARCH',
      'ask': 'ASK_USER', 'confirm': 'ASK_USER', 'question': 'ASK_USER',
      'delegate': 'DELEGATE', 'peer': 'DELEGATE',
      'git': 'GIT_SNAPSHOT', 'snapshot': 'GIT_SNAPSHOT', 'commit': 'GIT_SNAPSHOT',
      'modify': 'SELF_MODIFY', 'self-modify': 'SELF_MODIFY', 'self_modify': 'SELF_MODIFY',
    };

    const upper = (type || '').toUpperCase();
    if (this.actions.has(upper)) return upper;

    const lower = (type || '').toLowerCase();
    return mapping[lower] || 'ANALYZE';
  }

  // ════════════════════════════════════════════════════════
  // PLAN SIMULATION
  // ════════════════════════════════════════════════════════

  _simulatePlan(typedSteps) {
    if (!this.worldState) {
      return { valid: true, issues: [], totalCost: typedSteps.reduce((s, t) => s + (t.cost || 1), 0) };
    }

    const simState = this.worldState.clone();
    const issues = [];
    let totalCost = 0;

    for (let i = 0; i < typedSteps.length; i++) {
      const step = typedSteps[i];
      const action = this.actions.get(step.type);
      if (!action) continue;

      // Check preconditions
      for (const precondition of action.preconditions) {
        try {
          const result = precondition(step.params, simState);
          if (result === false) {
            issues.push({
              stepIndex: i,
              type: step.type,
              description: step.description,
              reason: `Precondition failed for ${step.type}`,
              target: step.target,
            });
          }
        } catch (err) {
          issues.push({
            stepIndex: i,
            type: step.type,
            description: step.description,
            reason: `Precondition error: ${err.message}`,
          });
        }
      }

      // Apply effects (even if preconditions failed — for simulation completeness)
      for (const effect of action.effects) {
        try {
          effect(step.params, simState);
        } catch (_e) { _log.debug('[catch] effects are best-effort in simulation:', _e.message); }
      }

      totalCost += step.cost || 1;
    }

    return {
      valid: issues.length === 0,
      issues,
      totalCost,
      simulatedChanges: simState.getSimulatedChanges(),
    };
  }

  async _replanWithConstraints(goalDescription, issues, context) {
    const constraintText = issues.map(i =>
      `Step ${i.stepIndex + 1} (${i.type}): ${i.reason}${i.target ? ' [target: ' + i.target + ']' : ''}`
    ).join('\n');

    const prompt = `Your previous plan for this goal had issues:

GOAL: ${goalDescription}

ISSUES:
${constraintText}

Please create a revised plan that avoids these issues.
- Don't write to kernel files (main.js, preload.js, src/kernel/)
- Don't write to node_modules or .git
- Ensure shell commands are safe
- Include test steps after code changes

Respond with JSON: { "steps": [...] } using the same format as before.`;

    try {
      return await this.model.chatStructured(prompt, [], 'planning');
    } catch (_e) {
      _log.debug('[catch] this.model.chatStructuredprompt,:', _e.message);
      return null;
    }
  }

  // ════════════════════════════════════════════════════════
  // HELPERS
  // ════════════════════════════════════════════════════════

  _buildPlanResult(typedSteps, simulation, title) {
    // Order by dependencies (topological sort)
    const orderedSteps = this._topologicalSort(typedSteps);

    this.bus.emit('planner:complete', {
      title: title.slice(0, 80),
      steps: orderedSteps.length,
      cost: simulation.totalCost,
      valid: simulation.valid,
    }, { source: 'FormalPlanner' });

    return {
      steps: orderedSteps,
      valid: simulation.valid,
      issues: simulation.issues,
      cost: simulation.totalCost,
      estimatedTimeMs: simulation.totalCost * 15000,
      title: title.slice(0, 80),
      successCriteria: simulation.successCriteria,
    };
  }

  _topologicalSort(steps) {
    // Simple: if dependencies exist, reorder. Otherwise keep original order.
    const hasDeps = steps.some(s => s.dependencies && s.dependencies.length > 0);
    if (!hasDeps) return steps;

    const sorted = [];
    const visited = new Set();
    const visiting = new Set();

    const visit = (index) => {
      if (visited.has(index)) return;
      if (visiting.has(index)) return; // Cycle — skip
      visiting.add(index);

      const step = steps[index];
      if (step.dependencies) {
        for (const dep of step.dependencies) {
          if (dep < steps.length) visit(dep);
        }
      }

      visiting.delete(index);
      visited.add(index);
      sorted.push(step);
    };

    for (let i = 0; i < steps.length; i++) visit(i);
    return sorted;
  }

  _parseRawPlan(raw) {
    // Try to extract JSON from raw text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]); }
      catch (_e) { _log.debug('[catch] context enrichment:', _e.message); }
    }

    // Parse numbered list
    const lines = raw.split('\n');
    const steps = lines
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length > 10)
      .map(description => ({ type: 'ANALYZE', description }));

    return { title: 'Parsed plan', steps };
  }
}

module.exports = { FormalPlanner };
