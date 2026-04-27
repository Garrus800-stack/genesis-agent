// @ts-checked-v5.7
// ============================================================
// GENESIS — EnvironmentContext.js (v7.4.8)
//
// Builds the OS-specific prompt block consumed by FormalPlanner
// and ShellAgent. Single source of truth for anti-hallucination
// command rules (e.g. find /V /C ":" on Windows) so both planning
// paths give the LLM the same correctness guidance.
//
// Returns a bundle:
//   { osContext, osName, isWindows, shellName,
//     listCmd, catCmd, findCmd, pathSep, rootDir }
//
// osContext is the multi-line ENVIRONMENT block to be concatenated
// into the LLM prompt. Other fields are exposed for callers that
// need to reuse the same OS-derived values elsewhere in their
// prompts (avoids duplicating the isWindows ternary logic).
// ============================================================

'use strict';

/**
 * Build the OS-specific environment context for LLM prompts.
 *
 * @param {object} [opts]
 * @param {string} [opts.rootDir] - working directory; defaults to process.cwd()
 * @param {boolean} [opts.isWindows] - override platform detection
 * @param {string} [opts.platform] - override process.platform (for tests)
 * @returns {{
 *   osContext: string,
 *   osName: string,
 *   isWindows: boolean,
 *   shellName: string,
 *   listCmd: string,
 *   catCmd: string,
 *   findCmd: string,
 *   pathSep: string,
 *   rootDir: string,
 * }}
 */
function buildOsContext(opts = {}) {
  const platform = opts.platform || process.platform;
  const isWindows = opts.isWindows !== undefined
    ? opts.isWindows
    : platform === 'win32';
  const osName = isWindows ? 'Windows' : (platform === 'darwin' ? 'macOS' : 'Linux');
  const shellName = isWindows ? 'cmd.exe / PowerShell' : 'bash';
  const listCmd = isWindows ? 'dir' : 'ls';
  const catCmd = isWindows ? 'type' : 'cat';
  const findCmd = isWindows ? 'where' : 'which';
  const pathSep = isWindows ? '\\' : '/';
  const rootDir = opts.rootDir || process.cwd();

  const osContext = `

ENVIRONMENT:
- Operating System: ${osName} (process.platform = "${platform}")
- Default shell: ${shellName}
- Working directory (rootDir): ${rootDir}
- Path separator: "${pathSep}"
- Use these commands on this OS:
  * List files: ${listCmd}   (NOT "ls" on Windows)
  * Read file: ${catCmd}     (NOT "cat" on Windows)
  * Find binary: ${findCmd}  (NOT "which" on Windows)
${isWindows ? `- Counting lines on Windows: use \`find /V /C ":"\` (counts lines NOT containing colon — works because filenames cannot contain ':').
  * DO NOT use \`find /c "*"\` (Windows find treats * as literal text, not glob — fails)
  * DO NOT use \`find /c /v ""\` (the doubled quotes break through Node.js → cmd.exe)
  * DO NOT use \`wc -l\` (POSIX, not available on Windows)
  * Correct: \`dir /b *.js | find /V /C ":"\`
- DO NOT use "/s" with absolute paths like C:\\ — Windows blocks system folders.
` : ''}- All paths in commands MUST be relative to rootDir or absolute paths starting with "${rootDir}".
- For SHELL steps targeting Genesis files: use rootDir as the base.
`;

  return { osContext, osName, isWindows, shellName, listCmd, catCmd, findCmd, pathSep, rootDir };
}

module.exports = { buildOsContext };
