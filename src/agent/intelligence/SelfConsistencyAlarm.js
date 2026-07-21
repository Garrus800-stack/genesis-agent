// ============================================================
// GENESIS — src/agent/intelligence/SelfConsistencyAlarm.js
// v7.9.43 W2 (B4): four checks at context-build time. On the FIRST
// discrepancy (fixed order) exactly ONE gentle line; otherwise silence
// that is byte-identical to before. Only present sources are checked —
// a missing wire is not an inconsistency. Never repairs, never cascades.
// ============================================================
'use strict';

/**
 * @param {object} p
 * @param {object|null} p.goalStack   - if present: getOpenGoals() must return an array
 * @param {object|null} p.idleMind    - if present: thoughtCount must be a number
 * @param {number|null} p.dreamMs     - ms since last dream (from getTimeSinceLastDream)
 * @param {number}      p.upMs        - current process uptime in ms
 * @param {number|null} p.lastUpMs    - uptime seen at the previous build (null on first)
 * @returns {string|null} the one gentle line, or null for silence
 */
function checkSelfConsistency({ goalStack, idleMind, dreamMs, upMs, lastUpMs }) {
  let source = null;
  if (goalStack) {
    try { if (!Array.isArray(goalStack.getOpenGoals())) source = 'Ziele'; }
    catch (_e) { source = 'Ziele'; }
  }
  if (!source && idleMind && typeof idleMind.thoughtCount !== 'number') source = 'Idle-Status';
  if (!source && dreamMs !== null && dreamMs !== undefined) {
    if (!isFinite(dreamMs) || dreamMs < -(5 * 60 * 1000)) source = 'Traumzeit';
  }
  if (!source && typeof lastUpMs === 'number' && typeof upMs === 'number') {
    if (upMs + 5000 < lastUpMs) source = 'Wachzeit';
  }
  if (!source) return null;
  return '\u26a0 Selbstbild unvollst\u00e4ndig: ' + source + ' \u2014 nachfragen lohnt.';
}

module.exports = { checkSelfConsistency };
