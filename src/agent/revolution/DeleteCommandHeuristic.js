// @ts-checked-v7.8.4
// ============================================================
// GENESIS — DeleteCommandHeuristic.js (v7.8.4)
//
// Best-effort static detection of shell commands that intend to
// delete a single file inside the project. Feeds the pre-deletion
// audit hook in AgentLoopSteps._stepShell.
//
// Pattern coverage:
//   - Unix:        rm, unlink
//   - PowerShell:  Remove-Item
//   - Windows cmd: del, erase
//
// Returns the captured target path (relative to rootDir) or null
// when the command is not recognised as a single-file delete.
// Glob targets and paths outside rootDir return null on purpose —
// the verifier works on single files inside the repo.
// ============================================================

'use strict';

const path = require('path');

const DELETE_COMMAND_PATTERNS = [
  /\brm\s+(?:-[a-zA-Z]+\s+)*['"]?([^\s'";|&]+)['"]?/i,
  /\bunlink\s+['"]?([^\s'";|&]+)['"]?/i,
  /\bRemove-Item\s+(?:-[a-zA-Z]+(?:\s+\S+)?\s+)*['"]?([^\s'";|&]+)['"]?/i,
  /\bdel\s+(?:\/[a-zA-Z]+\s+)*['"]?([^\s'";|&]+)['"]?/i,
  /\berase\s+(?:\/[a-zA-Z]+\s+)*['"]?([^\s'";|&]+)['"]?/i,
];

/**
 * @param {string} command
 * @param {string} rootDir
 * @returns {string|null} relative path inside rootDir, or null
 */
function extractDeleteTarget(command, rootDir) {
  if (!command || !rootDir) return null;
  for (const pattern of DELETE_COMMAND_PATTERNS) {
    const m = command.match(pattern);
    if (!m || !m[1]) continue;
    let target = m[1];
    // Skip glob-style targets — verifier works on single files
    if (/[*?]/.test(target)) return null;
    // Normalise relative paths
    if (path.isAbsolute(target)) {
      const rel = path.relative(rootDir, target);
      if (rel.startsWith('..')) return null; // outside rootDir
      target = rel;
    }
    return target;
  }
  return null;
}

module.exports = { extractDeleteTarget, DELETE_COMMAND_PATTERNS };
