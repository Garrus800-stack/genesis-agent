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

  // Judge a single path string against rules (a)–(c) above.
  const plausibleOne = (rawPath) => {
    const p = norm(rawPath);
    // (a) exact match exists
    try {
      if (path.isAbsolute(p)) {
        if (fs.existsSync(p)) return true;
      } else {
        const abs = path.resolve(root, p);
        if (fs.existsSync(abs)) return true;
      }
    } catch (_e) { /* fs error → treat as not-exists */ }
    // (b) relative path: parent must exist under root
    if (!path.isAbsolute(p)) {
      try {
        const candidate = path.resolve(root, path.dirname(p));
        if (fs.existsSync(candidate)) return true;
      } catch (_e) { /* */ }
      return false;
    }
    // (c) absolute path: must be inside root, tmp, or home
    const normP = path.normalize(p);
    const normRoot = path.normalize(root);
    const inRoot = normP.toLowerCase().startsWith(normRoot.toLowerCase() + path.sep) ||
                   normP.toLowerCase() === normRoot.toLowerCase();
    if (inRoot) return true;
    const tmp = (process.env.TMPDIR || process.env.TEMP || '/tmp');
    const home = (process.env.HOME || process.env.USERPROFILE || '');
    if (tmp && normP.toLowerCase().startsWith(path.normalize(tmp).toLowerCase())) return true;
    if (home && normP.toLowerCase().startsWith(path.normalize(home).toLowerCase())) return true;
    return false;
  };

  for (const token of missingTokens) {
    if (typeof token !== 'string' || !token.startsWith('file:')) continue;
    const raw = token.slice('file:'.length).trim();
    if (!raw) { out.push(token); continue; }
    // v7.9.32 (F2b): defensive net — if the raw value carries a comma it is
    // a list that slipped through as one token (producer-side split exists
    // since this release, but tokens may arrive from older plans or other
    // producers). Judge the parts; the token is plausible as soon as ONE
    // part is. Live fixture from the 2026-07-05 trace pins this.
    const parts = raw.includes(',') ? raw.split(/[\s,]+/).filter(Boolean) : [raw];
    if (parts.some(plausibleOne)) continue;
    out.push(token);
  }
  return out;
}

module.exports = { _filterImplausibleFilePaths };
