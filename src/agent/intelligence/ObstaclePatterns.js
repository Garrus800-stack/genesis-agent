// ============================================================
// GENESIS — ObstaclePatterns.js (v7.4.5 "Durchhalten" — Baustein D)
//
// Single source of truth for "what kinds of failures can be
// resolved by spawning a sub-goal that fixes the obstacle?"
//
// Heute scheitert Genesis bei "Cannot find module 'foo'" einfach
// und gibt auf. Mit Baustein D erkennt er das Pattern, spawnt ein
// Sub-Goal "Install missing module: foo", parkt das Parent-Goal
// bis Sub-Goal fertig ist, dann läuft das Parent weiter.
//
// Conservative scope: only deterministic, well-known patterns.
// LLM-suggested sub-goals are out-of-scope (separate follow-up plan
// with ApprovalGate considerations).
//
// Each pattern returns:
//   {
//     type: short identifier,
//     subGoalDescription: human-readable goal text for the planner,
//     contextKey: used by the loop-protection diskriminator so
//                 multiple goals can independently fix the same
//                 obstacle without triggering a false-positive loop,
//     extracted: any matched details (module name, tool name, etc.)
//   }
// ============================================================

'use strict';

// Pattern → handler. Each handler tries to extract the relevant
// detail (module name, tool name) from the error and produces a
// sub-goal description. If extraction fails, returns null and we
// move on to the next pattern.
const PATTERNS = [
  {
    type: 'module-not-found',
    // Node.js / npm
    regex: /Cannot find module ['"]([^'"]+)['"]/i,
    build: (match) => ({
      type: 'module-not-found',
      module: match[1],
      contextKey: `module:${match[1]}`,
      subGoalDescription: `Install missing npm module: ${match[1]}`,
    }),
  },
  {
    type: 'module-not-found',
    // Webpack / generic
    regex: /Module not found:.*['"]([^'"]+)['"]/i,
    build: (match) => ({
      type: 'module-not-found',
      module: match[1],
      contextKey: `module:${match[1]}`,
      subGoalDescription: `Install missing module: ${match[1]}`,
    }),
  },
  {
    type: 'python-package-missing',
    // ModuleNotFoundError: No module named 'foo'
    regex: /ModuleNotFoundError:\s*No module named ['"]([^'"]+)['"]/i,
    build: (match) => ({
      type: 'python-package-missing',
      module: match[1],
      contextKey: `pip:${match[1]}`,
      subGoalDescription: `Install missing Python package: ${match[1]}`,
    }),
  },
  {
    type: 'command-not-found',
    // Unix shell: 'foo: command not found'
    regex: /([a-zA-Z0-9_-]+):\s*command not found/i,
    build: (match) => ({
      type: 'command-not-found',
      command: match[1],
      contextKey: `cmd:${match[1]}`,
      subGoalDescription: `Install missing tool: ${match[1]}`,
    }),
  },
  {
    type: 'command-not-found',
    // Windows cmd: ''foo' is not recognized as an internal or external command'
    regex: /['"]?([a-zA-Z0-9_-]+)['"]?\s+is not recognized as an internal or external command/i,
    build: (match) => ({
      type: 'command-not-found',
      command: match[1],
      contextKey: `cmd:${match[1]}`,
      subGoalDescription: `Install missing tool: ${match[1]}`,
    }),
  },
];

// Tools/commands that we explicitly do NOT auto-spawn install
// sub-goals for, because installing them could be destructive
// or require user judgment (e.g., system-wide changes).
const BLOCKLIST = new Set([
  'sudo', 'rm', 'rmdir', 'del', 'format', 'mkfs',
  // System tools — refuse silently
  'systemctl', 'service', 'reg',
]);

/**
 * Try to match an error string against known obstacle patterns.
 * Returns the first match or null if nothing applies.
 *
 * @param {string} errorStr - error message from a failed step
 * @returns {{
 *   type: string,
 *   subGoalDescription: string,
 *   contextKey: string,
 *   module?: string,
 *   command?: string,
 * } | null}
 */
function matchObstacle(errorStr) {
  if (!errorStr || typeof errorStr !== 'string') return null;

  for (const p of PATTERNS) {
    const m = errorStr.match(p.regex);
    if (!m) continue;
    const result = p.build(m);
    if (!result) continue;

    // Blocklist — refuse to auto-spawn for dangerous targets
    const target = result.command || result.module;
    if (target && BLOCKLIST.has(target.toLowerCase())) {
      return null;
    }
    return result;
  }
  return null;
}

/**
 * Build a contextPath used by loop-protection to discriminate
 * "same goal hit same obstacle 3× → loop" from "five different
 * goals all hit module-not-found:foo → not a loop, all valid".
 *
 * @param {string} parentGoalId
 * @param {number} stepIndex
 * @param {string} obstacleContextKey - from matchObstacle().contextKey
 * @returns {string}
 */
function buildContextPath(parentGoalId, stepIndex, obstacleContextKey) {
  return `${parentGoalId}/${stepIndex}/${obstacleContextKey}`;
}

module.exports = {
  matchObstacle,
  buildContextPath,
  PATTERNS,
  BLOCKLIST,
};
