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
// ============================================================

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
  // git & snapshot variants → SHELL (git is a shell command)
  'GIT_SNAPSHOT':  'SHELL',
  'GIT_COMMIT':    'SHELL',
  'GIT':           'SHELL',
  'SNAPSHOT':      'SHELL',
  'BACKUP':        'SHELL',
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
 * Build the step-type section of the planner prompt. Listed in a
 * deterministic order so the prompt is stable across runs. Excludes
 * types the current body-schema says are unavailable.
 *
 * @param {object} [options]
 * @param {boolean} [options.canExecuteCode=true] — if false, SANDBOX and SHELL are hidden
 * @param {boolean} [options.canDelegate=false]   — if true, DELEGATE is listed
 * @returns {string}
 */
function buildPlannerStepTypeList({ canExecuteCode = true, canDelegate = false } = {}) {
  const order = ['ANALYZE', 'CODE', 'SHELL', 'SANDBOX', 'SEARCH', 'ASK', 'DELEGATE'];
  const lines = [];
  for (const id of order) {
    if (!canExecuteCode && (id === 'SANDBOX' || id === 'SHELL' || id === 'CODE')) continue;
    if (!canDelegate && id === 'DELEGATE') continue;
    lines.push(`- ${id}: ${STEP_TYPES[id].description}`);
  }
  return lines.join('\n');
}

module.exports = {
  STEP_TYPES,
  VALID_STEP_TYPES,
  STEP_TYPE_ALIASES,
  normalizeStepType,
  buildPlannerStepTypeList,
};
