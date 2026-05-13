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
const { buildPlannerStepTypeList, normalizeStepType } = require('./step-types');
const _log = createLogger('AgentLoopPlanner');

// v7.7.9 (post-Phase-3c.4): when planning, prefer modules whose file
// path or class names actually overlap with the goal description.
// Pre-fix: every plan got the first 20 modules by manifest order,
// which made the LLM invent paths like 'src/core/goal-stack.js' for a
// goal mentioning stalled goals (real path: 'src/agent/planning/
// GoalStack.js' + 'src/agent/cognitive/StalledGoalWatchdog.js').
// Goal-tokens drawn from the description hit the actual file names
// most of the time; when fewer than 5 modules match we still fall
// back to the first 20 by manifest order so a generic goal ("clean
// up the code") never starves the prompt of context.
const _MAX_RELEVANT_MODULES = 30;
const _MIN_RELEVANT_MODULES = 5;
const _STOPWORDS = new Set([
  'the','and','for','with','from','into','that','this','your','about','some','any','all',
  'der','die','das','und','von','mit','für','aus','der','dem','den','ist','wie','was','wo','wer','warum','wann','soll','will','muss','dass','nicht','auch','nach','wenn','bei','auf','vor','zur','zum','beim','wieder',
]);

function _goalTokens(goal) {
  if (typeof goal !== 'string') return [];
  return goal.toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !_STOPWORDS.has(t));
}

function _moduleMatches(mod, tokens) {
  const file = (mod.file || '').toLowerCase();
  const classes = (mod.classes || []).map(c => String(c).toLowerCase());
  for (const t of tokens) {
    if (file.includes(t)) return true;
    for (const c of classes) {
      if (c.includes(t)) return true;
    }
  }
  return false;
}

function pickRelevantModules(allModules, goalDescription) {
  if (!Array.isArray(allModules) || allModules.length === 0) return [];
  const tokens = _goalTokens(goalDescription);
  if (tokens.length === 0) return allModules.slice(0, LIMITS.PROMPT_MODULE_SLICE);
  const matches = allModules.filter(m => _moduleMatches(m, tokens));
  if (matches.length >= _MIN_RELEVANT_MODULES) {
    return matches.slice(0, _MAX_RELEVANT_MODULES);
  }
  // Not enough goal-relevant matches — combine matches with first-N
  // manifest entries so the LLM still sees real paths but also a
  // baseline of high-level project modules.
  const seen = new Set(matches.map(m => m.file));
  const fillers = allModules.filter(m => !seen.has(m.file)).slice(0, LIMITS.PROMPT_MODULE_SLICE);
  return [...matches, ...fillers].slice(0, _MAX_RELEVANT_MODULES);
}

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

    // v7.7.9 (post-Phase-3c.4): pick goal-relevant modules instead of
    // the first 20 by manifest order — see pickRelevantModules header
    // comment for live-bug rationale.
    const allModules = loop.selfModel?.getModuleSummary() || [];
    const modules = pickRelevantModules(allModules, goalDescription);
    const capabilities = loop.selfModel?.getCapabilities() || [];
    const toolNames = loop.tools?.listTools()?.map(t => t.name || t).slice(0, LIMITS.PROMPT_TOOL_SLICE) || [];

    // v7.7.9 (post-burnin P1): consult obstacle-resolution lessons before
    // generating a plan. The planner had no awareness of past failures
    // → kept halucinating the same paths. Pull top-5 token-overlap
    // matches and inject as PAST FAILURES TO AVOID section.
    let pastFailuresHint = '';
    try {
      const lessonsStore = loop.lessonsStore || loop._lessonsStore;
      if (lessonsStore && typeof lessonsStore.recall === 'function') {
        const lessons = lessonsStore.recall('obstacle-resolution', { query: goalDescription }, 5) || [];
        if (lessons.length > 0) {
          const lines = lessons.slice(0, 5).map(l => `  - ${(l.insight || '').slice(0, 160)}`);
          pastFailuresHint = `\n\nPAST FAILURES TO AVOID (lessons from previous attempts on similar goals):\n${lines.join('\n')}\nDo NOT repeat these mistakes. Reference REAL files only, no invented paths.`;
        }
      }
    } catch (_e) { /* best-effort */ }

    // v7.7.9 (post-Phase-3c.4): expose actual file paths to the planner
    // so the LLM stops inventing paths. List is bounded by
    // pickRelevantModules above.
    const modulePathList = modules.length > 0
      ? modules.map(m => `- ${m.file}${m.classes?.length ? ` (${m.classes.slice(0, 2).join(', ')})` : ''}`).join('\n')
      : '(no module manifest available)';

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
    let canExecuteCode = true;
    let canDelegate = false;
    try {
      const bodySchema = (/** @type {any} */ (loop)).bodySchema || (loop._container?.has?.('bodySchema') ? loop._container.resolve('bodySchema') : null);
      if (bodySchema) {
        const constraints = bodySchema.getConstraints?.() || [];
        if (constraints.length > 0) {
          bodyContext = '\nCONSTRAINTS:\n' + constraints.map(c => `- ${c}`).join('\n');
        }
        const caps = bodySchema.getCapabilities?.() || {};
        if (caps.circuitOpen) bodyContext += '\n- LLM backend is unstable — minimize LLM-heavy steps';
        if (!caps.canModifySelf) bodyContext += '\n- Self-modification is RESTRICTED — do not plan CODE steps that modify Genesis source';
        if (!caps.canExecuteCode) {
          bodyContext += '\n- Code execution is UNAVAILABLE — skip SANDBOX and SHELL steps';
          canExecuteCode = false;
        }
      }
    } catch (err) { _log.debug('[PLANNER] bodySchema enrichment failed:', err.message); }

    // v7.3.5: DELEGATE only if TaskDelegation is wired
    canDelegate = !!loop.taskDelegation;

    // v7.3.5: Step-type list comes from the central catalog (step-types.js).
    // Both planner prompt and executor switch are driven by the same source.
    const stepTypeList = buildPlannerStepTypeList({ canExecuteCode, canDelegate });

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

YOUR MODULES: ${allModules.length} modules across core, foundation, intelligence, capabilities, planning, cognitive, organism, revolution, hexagonal, autonomy.

GOAL-RELEVANT MODULE PATHS (use these EXACT paths when referring to files — do not invent new ones):
${modulePathList}${pastFailuresHint}

Create a plan with concrete, executable steps. Each step must be ONE of:
${stepTypeList}

Do NOT invent new step types. If a sub-task does not fit one of these, express it as an ANALYZE step. Inventing types (e.g. "WRITE_FILE", "GIT_SNAPSHOT", "CODE_GENERATE") will make the plan fail verification.

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

    // v7.3.5: Normalize step types against the central catalog. The LLM
    // sometimes invents types (GIT_SNAPSHOT, WRITE_FILE, CODE_GENERATE).
    // Known aliases are rewritten to a valid type; unmappable types fall
    // back to ANALYZE with a note so the plan can still run (worst case
    // the executor just reads instead of writes — safer than failing mid-plan).
    if (Array.isArray(response.steps)) {
      for (const step of response.steps) {
        const normalized = normalizeStepType(step.type);
        if (normalized && normalized !== step.type) {
          _log.info(`[PLANNER] Normalized step type "${step.type}" → "${normalized}"`);
          step.type = normalized;
        } else if (!normalized) {
          _log.warn(`[PLANNER] Unknown step type "${step.type}" — falling back to ANALYZE`);
          step.description = `[was ${step.type}] ${step.description || ''}`.trim();
          step.type = 'ANALYZE';
        }
      }
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
// v7.7.9 (post-Phase-3c.4): pickRelevantModules exported for unit tests
// that exercise the goal-matching filter independently.
module.exports = { AgentLoopPlannerDelegate, pickRelevantModules };
