// @ts-checked-v7.6.0
// ============================================================
// GENESIS — CommandHandlersHelpers.js
// v7.6.0 Track A #3 — shared helpers for command handlers.
//
// Pure async functions, no `this`. Anyone who needs them can
// require + call them directly. Files in this module:
//
//   fileExists(shell, filePath) → Promise<boolean>
//     Platform-aware existence check via shell. Returns false on
//     any error or when shell is null/undefined. Used by the open
//     and install handlers to verify resolved paths actually point
//     at something on disk before launching/reporting them.
//
// Design note: this is a deliberately small, focused module.
// Helpers added here should be (1) genuinely shared between two
// or more handlers, (2) `this`-free, and (3) side-effect-free
// beyond the shell call itself. Anything stateful or handler-
// specific belongs in the relevant Detect/Resolver mixin.
// ============================================================

'use strict';

/**
 * Check whether a file or directory exists at the given path.
 * Cross-platform: uses `if exist` on Windows, `test -e` elsewhere.
 *
 * @param {object} shell  Shell adapter with .run({tier,timeout}) method
 * @param {string} filePath  Absolute path to test
 * @returns {Promise<boolean>}
 */
async function fileExists(shell, filePath) {
  if (!shell) return false;
  if (process.platform === 'win32') {
    try {
      const r = await shell.run(`if exist "${filePath}" echo FOUND`, { tier: 'read' });
      return /FOUND/.test(r.stdout || '');
    } catch { return false; }
  }
  try {
    const r = await shell.run(`test -e "${filePath}" && echo FOUND`, { tier: 'read' });
    return /FOUND/.test(r.stdout || '');
  } catch { return false; }
}

module.exports = { fileExists };
