// ============================================================
// GENESIS — step-types.js (v7.3.5)
//
// Single source of truth for AgentLoop step types. The executor
// (AgentLoopSteps._executeStep switch) and the planner
// (AgentLoopPlanner prompt + validation) both read from here.
//
// Before v7.3.5, planner and executor had their own informal
// lists of step types. The planner listed 6 in its prompt (no
// DELEGATE), the executor handled 7. The LLM, not strictly bound
// by the prompt list, occasionally invented new types like
// GIT_SNAPSHOT, CODE_GENERATE, or WRITE_FILE. These reached the
// executor as "Unknown step type" and failed the step — burning
// thousands of tokens on goals that could not progress.
//
// Keeping this list the ONLY definition means:
//   - The executor switch is generated/driven from it
//   - The planner prompt is generated from the list (incl. description)
//   - Validation rejects LLM-invented types deterministically
//
// ── Scope note (v7.3.6) ─────────────────────────────────────
// This file is SoT for the AgentLoop executor pipeline specifically.
// FormalPlanner operates on its own STRIPS-style action domain with
// preconditions, effects, and verifier types (see FormalPlanner.js).
// Its action names (CODE_GENERATE, WRITE_FILE, RUN_TESTS, SHELL_EXEC,
// SEARCH) are mapped to canonical step types via normalizeStepType()
// when a FormalPlanner-produced plan reaches AgentLoopSteps for
// execution. A full vocabulary harmonization between the two would
// be a design decision about the plan-action domain, not a refactor,
// and belongs in a dedicated planner-refactor release.
// ============================================================

// v7.9.21: TIMEOUTS for the test-run default timeout (TEST_RUN_EXEC).
// core/ -> core/, no cycle (Constants.js requires nothing from here).
const { TIMEOUTS } = require('./Constants');

/**
 * The complete catalog of step types Genesis knows how to execute.
 * Each entry has an id (the canonical type string used in plan steps),
 * a one-line description for the planner prompt, and a remap hint
 * used to rewrite common LLM hallucinations back to a real type.
 */
const STEP_TYPES = Object.freeze({
  ANALYZE: Object.freeze({
    id: 'ANALYZE',
    description: 'Read and analyze existing code or data',
  }),
  CODE: Object.freeze({
    id: 'CODE',
    description: 'Write or modify a specific file',
  }),
  SHELL: Object.freeze({
    id: 'SHELL',
    description: 'Run a shell command (npm, git, node, etc.)',
  }),
  SANDBOX: Object.freeze({
    id: 'SANDBOX',
    description: 'Test code in the sandbox',
  }),
  SEARCH: Object.freeze({
    id: 'SEARCH',
    description: 'Look up documentation or information on the web',
  }),
  ASK: Object.freeze({
    id: 'ASK',
    description: 'Ask the user for clarification (use sparingly)',
  }),
  DELEGATE: Object.freeze({
    id: 'DELEGATE',
    description: 'Send a sub-task to a peer agent (requires peer network)',
  }),
});

/** Set of valid type strings — cheap for `has()` lookups. */
const VALID_STEP_TYPES = new Set(Object.keys(STEP_TYPES));

/**
 * Common LLM hallucinations mapped to the nearest real step type.
 * If the LLM invents one of these, we rewrite rather than reject —
 * the plan can still run. If an invented type has no mapping here,
 * it is rejected in validation and the plan is salvaged or aborted.
 *
 * Derived from observed failures on real Windows runs (v7.3.4
 * session, 2026-04-20: "Bessere Fehlerbehandlung einbauen" goal
 * produced GIT_SNAPSHOT, CODE_GENERATE, WRITE_FILE).
 */
const STEP_TYPE_ALIASES = Object.freeze({
  // file mutation variants → CODE
  'WRITE_FILE':    'CODE',
  'WRITE':         'CODE',
  'EDIT':          'CODE',
  'EDIT_FILE':     'CODE',
  'MODIFY':        'CODE',
  'MODIFY_FILE':   'CODE',
  'CREATE_FILE':   'CODE',
  'CODE_GENERATE': 'CODE',
  'GENERATE_CODE': 'CODE',
  // v7.9.7 P2b: broader LLM-idiomatic code-mutation verbs. Pre-fix these
  // fell through to ANALYZE via the unknown-type fallback, losing the
  // path-hint and routing file-mutating intent to a read-only handler.
  'REFACTOR':      'CODE',
  'IMPLEMENT':     'CODE',
  'INTEGRATE':     'CODE',
  'ADD':           'CODE',
  'ADD_FEATURE':   'CODE',
  'ADD_DEPENDENCY':'CODE',
  'FIX':           'CODE',
  'FIX_FILE':      'CODE',
  'UPDATE':        'CODE',
  'UPDATE_FILE':   'CODE',
  'PATCH':         'CODE',
  'PATCH_FILE':    'CODE',
  'WIRE':          'CODE',
  // reading variants → ANALYZE
  'READ':          'ANALYZE',
  'READ_FILE':     'ANALYZE',
  'INSPECT':       'ANALYZE',
  'REVIEW':        'ANALYZE',
  'AUDIT':         'ANALYZE',
  // shell variants → SHELL
  'RUN':           'SHELL',
  'EXEC':          'SHELL',
  'EXECUTE':       'SHELL',
  'COMMAND':       'SHELL',
  'BASH':          'SHELL',
  // v7.4.5.fix: legacy/FormalPlanner step types → SHELL
  'SHELL_EXEC':    'SHELL',
  'RUN_COMMAND':   'SHELL',
  'EXECUTE_SHELL': 'SHELL',
  // git & snapshot variants → SHELL (git is a shell command)
  'GIT_SNAPSHOT':  'SHELL',
  'GIT_COMMIT':    'SHELL',
  'GIT':           'SHELL',
  'SNAPSHOT':      'SHELL',
  'BACKUP':        'SHELL',
  // v7.9.21: running the test SUITE is a shell command (npm test), not a
  // sandbox snippet. RUN_TESTS reaches here from FormalPlanner; SANDBOX would
  // only run an improvised snippet (a facade), SHELL runs the real suite.
  'RUN_TESTS':     'SHELL',
  'RUN_TEST':      'SHELL',
  'TESTS':         'SHELL',
  // test & verification variants → SANDBOX
  'TEST':          'SANDBOX',
  'VERIFY':        'SANDBOX',
  'VALIDATE':      'SANDBOX',
  // search variants → SEARCH
  'LOOKUP':        'SEARCH',
  'RESEARCH':      'SEARCH',
  'WEB_SEARCH':    'SEARCH',
  // question variants → ASK
  'QUESTION':      'ASK',
  'CLARIFY':       'ASK',
  // v7.9.7 P4: LLM idiomatically writes ASK_USER. TrustLevelSystem already
  // classifies 'ASK_USER' as 'safe', but the alias table was missing it so
  // normalizeStepType returned null and the fallback rewrote to ANALYZE.
  'ASK_USER':      'ASK',
});

/**
 * Normalize a step type from potentially-hallucinated LLM output.
 * Returns the valid type string if the input is either canonical or
 * a known alias; returns null if the type cannot be mapped.
 *
 * @param {string} rawType
 * @returns {string|null}
 */
function normalizeStepType(rawType) {
  if (typeof rawType !== 'string') return null;
  const upper = rawType.trim().toUpperCase();
  if (VALID_STEP_TYPES.has(upper)) return upper;
  if (STEP_TYPE_ALIASES[upper]) return STEP_TYPE_ALIASES[upper];
  return null;
}

/**
 * Default command + timeout for raw step types that denote running the test
 * suite. Keyed by the RAW (pre-normalization) type, because the alias rewrites
 * RUN_TESTS -> SHELL and the raw type is otherwise lost. applyStepTypeDefaults()
 * fills these in so a RUN_TESTS step actually runs `npm test` to completion
 * instead of degrading to a read-only fallback or timing out at the 30s shell
 * default.
 */
const STEP_TYPE_DEFAULTS = Object.freeze({
  RUN_TESTS: Object.freeze({ command: 'npm test', timeoutMs: TIMEOUTS.TEST_RUN_EXEC }),
  RUN_TEST:  Object.freeze({ command: 'npm test', timeoutMs: TIMEOUTS.TEST_RUN_EXEC }),
  TESTS:     Object.freeze({ command: 'npm test', timeoutMs: TIMEOUTS.TEST_RUN_EXEC }),
});

/**
 * Apply the default command + timeout for a test-run step. Called at both
 * normalization choke points (AgentLoopSteps._executeStep and
 * plan-context.normalizeStepTypes) with the RAW type captured before it is
 * rewritten to SHELL. For a test-run type: default the command to `npm test`
 * when none was given, always set the extended timeout, and clear `target` --
 * a RUN_TESTS `target` is a test-file hint, not a shell command, and _stepShell
 * resolves `step.target || step.command`.
 *
 * @param {object} step - the plan step (mutated in place)
 * @param {string} rawType - the step type BEFORE normalization
 */
function applyStepTypeDefaults(step, rawType) {
  if (!step || typeof step !== 'object') return;
  const d = STEP_TYPE_DEFAULTS[String(rawType || '').trim().toUpperCase()];
  if (!d) return;
  if (!step.command) step.command = d.command;
  step.timeoutMs = d.timeoutMs;
  step.target = null;
}

/**
 * Build the step-type section of the planner prompt. Listed in a
 * deterministic order so the prompt is stable across runs. Excludes
 * types the current body-schema says are unavailable.
 *
 * @param {object} [options]
 * @param {boolean} [options.canExecuteCode=true] - if false, SANDBOX and SHELL are hidden
 * @param {boolean} [options.canDelegate=false]   - if true, DELEGATE is listed
 * @returns {string}
 */
function buildPlannerStepTypeList({ canExecuteCode = true, canDelegate = false, readOnlyGoal = false } = {}) {
  const order = ['ANALYZE', 'CODE', 'SHELL', 'SANDBOX', 'SEARCH', 'ASK', 'DELEGATE'];
  const lines = [];
  for (const id of order) {
    if (!canExecuteCode && (id === 'SANDBOX' || id === 'SHELL' || id === 'CODE')) continue;
    // v7.9.19 (Strang E): a read-only/inspection goal drops code generation
    // (CODE) and code execution (SANDBOX), but keeps SHELL — read-only shell
    // commands (listing, reading, running tests) are how it inspects.
    if (readOnlyGoal && (id === 'CODE' || id === 'SANDBOX')) continue;
    if (!canDelegate && id === 'DELEGATE') continue;
    lines.push(`- ${id}: ${STEP_TYPES[id].description}`);
  }
  return lines.join('\n');
}

// ── v7.4.5 Baustein C: Resource requirements per step type ──
//
// What external resources does this step type need to succeed?
// Tokens are checked by ResourceRegistry.requireAll() before the
// step runs. If any are missing, the goal is BLOCKED (not failed)
// and re-pursued automatically when the resource comes back.
//
// 'service:llm' is abstract — ResourceRegistry resolves it to
// the active backend (service:ollama / service:anthropic / ...)
//
// SHELL, SANDBOX, ASK have no external requirements (local-only).
// LLM-driven steps need 'service:llm'.
// SEARCH and DELEGATE additionally need network/peer.
const STEP_REQUIREMENTS = Object.freeze({
  ANALYZE:  ['service:llm'],
  CODE:     ['service:llm'],
  SEARCH:   ['service:llm', 'network'],
  DELEGATE: ['network', 'peer'],
  SHELL:    [],
  SANDBOX:  [],
  ASK:      [],
});

/**
 * Get the resource tokens this step needs.
 * If step.target looks like a file path AND the type reads files
 * (ANALYZE), append a file:<path> requirement so ResourceRegistry
 * can probe existence at execution time.
 *
 * @param {string} stepType - canonical step type
 * @param {object} [step] - optional step object for context
 * @returns {string[]} resource tokens required
 */
function getStepRequirements(stepType, step = null) {
  const base = STEP_REQUIREMENTS[stepType] || [];
  const out = [...base];
  // ANALYZE on a file target → also need the file to exist
  if (stepType === 'ANALYZE' && step?.target && typeof step.target === 'string'
      && !step.target.includes('*') && !step.target.includes('?')   // v7.9.22 Item 1: a glob is not a file to require
        && (step.target.includes('/') || step.target.includes('\\') || step.target.endsWith('.js') || step.target.endsWith('.json') || step.target.endsWith('.md'))) {
    out.push(`file:${step.target}`);
  }
  return out;
}

module.exports = {
  STEP_TYPES,
  VALID_STEP_TYPES,
  STEP_TYPE_ALIASES,
  STEP_REQUIREMENTS,
  normalizeStepType,
  buildPlannerStepTypeList,
  getStepRequirements,
  STEP_TYPE_DEFAULTS,
  applyStepTypeDefaults,
};
