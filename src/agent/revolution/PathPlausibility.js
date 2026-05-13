// @ts-checked-v5.7
// ============================================================
// GENESIS — PathPlausibility.js (v7.7.9 Phase 3)
//
// Pre-Step path-plausibility helper. Used by AgentLoopSteps to
// distinguish "legitimate resource wait" from "hallucinated path
// that will never exist". Without it, the LLM-step-generator can
// produce paths like `logs\self-statement.log` (live-Befund
// 2026-05-10) that never resolve, and the goal sits in the
// blocked state forever, bypassing the failure-reflection path
// entirely.
//
// A path is plausible if any of these hold:
//   (a) The file already exists at that absolute path
//   (b) Relative path whose parent directory exists within rootDir
//       (step could legitimately CREATE the file there)
//   (c) Absolute path inside rootDir, tmp, or home
//
// Otherwise: implausible. Implausible paths fail the step instead
// of blocking it, and the standard plan-failure-reflection path
// runs as it would for any other step error.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');

/**
 * Filter resource tokens to those whose file:-path is implausible.
 *
 * @param {string[]} missingTokens - tokens from ResourceRegistry.requireAll missing
 * @param {string} rootDir         - project root (for relative resolution)
 * @returns {string[]} subset of missingTokens that are implausible
 */
function _filterImplausibleFilePaths(missingTokens, rootDir) {
  if (!Array.isArray(missingTokens) || missingTokens.length === 0) return [];
  const out = [];
  const norm = (p) => p.replace(/[\\/]+/g, path.sep);
  const root = norm(rootDir || process.cwd());
  for (const token of missingTokens) {
    if (typeof token !== 'string' || !token.startsWith('file:')) continue;
    const raw = token.slice('file:'.length).trim();
    if (!raw) { out.push(token); continue; }
    const p = norm(raw);
    // (a) exact match exists
    try {
      if (path.isAbsolute(p)) {
        if (fs.existsSync(p)) continue;
      } else {
        const abs = path.resolve(root, p);
        if (fs.existsSync(abs)) continue;
      }
    } catch (_e) { /* fs error → treat as not-exists */ }
    // (b) relative path: parent must exist under root
    if (!path.isAbsolute(p)) {
      try {
        const candidate = path.resolve(root, path.dirname(p));
        if (fs.existsSync(candidate)) continue;
      } catch (_e) { /* */ }
      out.push(token);
      continue;
    }
    // (c) absolute path: must be inside root, tmp, or home
    const normP = path.normalize(p);
    const normRoot = path.normalize(root);
    const inRoot = normP.toLowerCase().startsWith(normRoot.toLowerCase() + path.sep) ||
                   normP.toLowerCase() === normRoot.toLowerCase();
    if (inRoot) continue;
    const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp');
    const home = (process.env.HOME || process.env.USERPROFILE || '');
    if (tmp && normP.toLowerCase().startsWith(path.normalize(tmp).toLowerCase())) continue;
    if (home && normP.toLowerCase().startsWith(path.normalize(home).toLowerCase())) continue;
    out.push(token);
  }
  return out;
}

module.exports = { _filterImplausibleFilePaths };
