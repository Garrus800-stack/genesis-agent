// @ts-checked-v5.7
// ============================================================
// GENESIS — AgentLoopPlanner.js (v3.8.0 — Composition Delegate)
//
// v3.8.0 UPGRADE: Converted from loose functions (prototype mixin)
// to a proper delegate class. Receives a reference to the
// AgentLoop instance via constructor, accesses state via this.loop.
//
// Benefits over prototype mixin:
//   - IDE Go-to-Definition works on loop.planner._planGoal()
//   - Stack traces show AgentLoopPlannerDelegate._planGoal
//   - No method name collision risk with AgentLoopSteps
//   - TypeScript-compatible (can add .d.ts without hacks)
//
// Methods:
//   _planGoal(goalDescription)  → plan object
//   _llmPlanGoal(goalDescription) → plan via LLM
//   _salvagePlan(rawText, goal) → plan from unstructured text
//   _inferStepType(description) → step type string
// ============================================================

const { LIMITS } = require('../core/Constants');
const { createLogger } = require('../core/Logger');
const _log = createLogger('AgentLoopPlanner');

class AgentLoopPlannerDelegate {
  /**
   * @param {import('./AgentLoop').AgentLoop} loop - Parent AgentLoop instance
   */
  constructor(loop) {
    this.loop = loop;
  }

  /**
   * Top-level planning: tries FormalPlanner first, falls back to LLM.
   * @param {string} goalDescription
   * @returns {Promise<{ title, steps, successCriteria }>}
   */
  async _planGoal(goalDescription) {
    // v3.5.0: Use FormalPlanner if available (typed actions + simulation)
    if (this.loop.formalPlanner) {
      try {
        const formalPlan = await this.loop.formalPlanner.plan(goalDescription, {
          memory: this.loop.memory,
          history: [],
        });
        if (formalPlan && formalPlan.steps && formalPlan.steps.length > 0) {
          return formalPlan;
        }
      } catch (err) {
        _log.debug('[AGENT-LOOP] FormalPlanner failed, falling back to LLM planning:', err.message);
      }
    }

    // Fallback: Original LLM-based planning
    return this._llmPlanGoal(goalDescription);
  }

  /** Original LLM-based planning (v3.x fallback) */
  async _llmPlanGoal(goalDescription) {
    const loop = this.loop;

    // Build context for planning
    const modules = loop.selfModel?.getModuleSummary()?.slice(0, LIMITS.PROMPT_MODULE_SLICE) || [];
    const capabilities = loop.selfModel?.getCapabilities() || [];
    const toolNames = loop.tools?.listTools()?.map(t => t.name || t).slice(0, LIMITS.PROMPT_TOOL_SLICE) || [];

    // v3.5.0: Inject WorldState context if available
    const wsContext = loop.worldState
      ? `\nENVIRONMENT:\n${loop.worldState.buildContextSlice(['project', 'git', 'models'])}`
      : '';

    // v3.5.0: Inject episodic memory if available
    const epContext = loop.episodicMemory
      ? `\n${loop.episodicMemory.buildContext(goalDescription)}`
      : '';

    // v4.12.4: Inject BodySchema constraints — tells planner what's unavailable
    let bodyContext = '';
    try {
      // @ts-ignore — bodySchema and _container are dynamically available on AgentLoop
      const bodySchema = loop.bodySchema || (loop._container?.has?.('bodySchema') ? loop._container.resolve('bodySchema') : null);
      if (bodySchema) {
        const constraints = bodySchema.getConstraints?.() || [];
        if (constraints.length > 0) {
          bodyContext = '\nCONSTRAINTS:\n' + constraints.map(c => `- ${c}`).join('\n');
        }
        const caps = bodySchema.getCapabilities?.() || {};
        if (caps.circuitOpen) bodyContext += '\n- LLM backend is unstable — minimize LLM-heavy steps';
        if (!caps.canModifySelf) bodyContext += '\n- Self-modification is RESTRICTED — do not plan CODE steps that modify Genesis source';
        if (!caps.canExecuteCode) bodyContext += '\n- Code execution is UNAVAILABLE — skip SANDBOX and SHELL steps';
      }
    } catch (err) { _log.debug('[PLANNER] bodySchema enrichment failed:', err.message); }

    const planPrompt = `You are Genesis, an autonomous AI agent. You need to create an execution plan.

GOAL: "${goalDescription}"
${wsContext}${epContext}${bodyContext}
YOUR CAPABILITIES:
- Read/write files in your own source code
- Execute JavaScript in a sandboxed environment
- Run shell commands (npm, git, node, etc.)
- Modify your own modules (with SafeGuard protection for kernel)
- Search the web for documentation
- Use ${toolNames.length} registered tools

YOUR MODULES: ${modules.length} modules across core, foundation, intelligence, capabilities, planning, cognitive, organism, revolution, hexagonal, autonomy

Create a plan with concrete, executable steps. Each step must be ONE of:
- CODE: Write or modify a specific file
- SHELL: Run a shell command
- SANDBOX: Test code in the sandbox
- ANALYZE: Read and analyze existing code
- SEARCH: Look up documentation or information
- ASK: Ask the user for clarification (use sparingly)

Respond ONLY with this JSON format:
{
  "title": "Short plan title",
  "steps": [
    { "type": "ANALYZE", "description": "What to do", "target": "file or topic" },
    { "type": "CODE", "description": "What to write", "target": "path/to/file.js" },
    { "type": "SANDBOX", "description": "What to test", "target": "test description" },
    { "type": "SHELL", "description": "What command", "target": "npm test" }
  ],
  "successCriteria": "How to know the goal is achieved"
}

Keep it to 3-8 steps. Be specific. Each step must be independently verifiable.`;

    const response = await loop.model.chatStructured(planPrompt, [], 'analysis');

    if (response._parseError) {
      // Try to salvage a plan from raw text
      return this._salvagePlan(response._raw, goalDescription);
    }

    return response;
  }

  /** Fallback plan extraction from unstructured LLM output */
  _salvagePlan(rawText, goalDescription) {
    const steps = [];
    const lines = rawText.split('\n').filter(l => l.trim());

    for (const line of lines) {
      if (/^\d+[\.\)]/m.test(line) || /^[-*]/m.test(line)) {
        const clean = line.replace(/^[\d\.\)\-*\s]+/, '').trim();
        if (clean.length > 10) {
          steps.push({
            type: this._inferStepType(clean),
            description: clean,
            target: '',
          });
        }
      }
    }

    if (steps.length === 0) {
      // Last resort: single analysis step
      steps.push({
        type: 'ANALYZE',
        description: `Analyze requirements for: ${goalDescription.slice(0, 100)}`,
        target: '',
      });
    }

    return {
      title: goalDescription.slice(0, LIMITS.DESCRIPTION_SLICE_SHORT),
      steps: steps.slice(0, LIMITS.PLAN_MAX_STEPS),
      successCriteria: 'User confirms completion',
    };
  }

  _inferStepType(description) {
    const d = description.toLowerCase();
    if (/(?:schreib|erstell|modifiz|aender|write|create|modify|add|implement)/i.test(d)) return 'CODE';
    if (/(?:test|pruef|verifi|sandbox|check)/i.test(d)) return 'SANDBOX';
    if (/(?:npm|git|node|install|build|run|command|shell|terminal)/i.test(d)) return 'SHELL';
    if (/(?:such|find|search|look|docs|doku|web)/i.test(d)) return 'SEARCH';
    if (/(?:frag|ask|confirm|user|genehmig|approve)/i.test(d)) return 'ASK';
    if (/(?:delegat|delegier|peer|agent|auslager|outsourc)/i.test(d)) return 'DELEGATE';
    return 'ANALYZE';
  }
}

// v3.8.0: Export delegate class. Legacy bare-function exports removed.
module.exports = { AgentLoopPlannerDelegate };
