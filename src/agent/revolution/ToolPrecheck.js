'use strict';
/**
 * ToolPrecheck — proactive, one-time "is this tool installed?" check BEFORE a
 * shell step runs (v7.9.28, Baustein C). A thin layer on the existing reactive
 * missing-tool detection: surface the gap before the step fails, not after.
 *
 * extractToolFromShellStep is pure/sync (no I/O): strips a leading `cd X &&`,
 * returns the first bare command token, null if it's a path/operator. The
 * availability check is best-effort via which/where; on any error it resolves
 * true (assume present) so the precheck never blocks legitimate work.
 */
const { execFile } = require('child_process');

const _OPERATORS = new Set(['|', '||', '&&', '>', '>>', '<', ';', '&']);

function extractToolFromShellStep(step) {
  if (!step || typeof step !== 'string') return null;
  let s = step.trim();
  // Strip a leading `cd <something> &&`
  s = s.replace(/^cd\s+[^\r\n&]+&&\s*/i, '').trim();
  const first = s.split(/\s+/)[0];
  if (!first) return null;
  if (_OPERATORS.has(first)) return null;
  // A path (has a separator) is not a bare tool name we can `which`.
  if (/[\\/]/.test(first) || first.includes(':')) return null;
  // Strip a trailing operator glued to the token.
  const tool = first.replace(/[;&|<>]+$/, '');
  return tool || null;
}

/**
 * Resolve true if the tool is on PATH (or on any error — never block).
 * Uses `where` on win32, `which` elsewhere; 3s timeout.
 */
function checkToolAvailable(tool, platform = process.platform) {
  return new Promise((resolve) => {
    if (!tool) return resolve(true);
    const finder = platform === 'win32' ? 'where' : 'which';
    try {
      execFile(finder, [tool], { timeout: 3000 }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(Boolean(stdout && stdout.trim()));
      });
    } catch {
      resolve(true); // best-effort: never block on precheck failure
    }
  });
}

module.exports = { extractToolFromShellStep, checkToolAvailable };
