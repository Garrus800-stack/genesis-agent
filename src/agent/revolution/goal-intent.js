// ============================================================
// GENESIS — revolution/goal-intent.js (v7.9.19, Strang E)
//
// Single source of truth for "is this goal read-only?".
//
// The idle-mind plan activity (autonomy/activities/Plan.js) already
// constrains every self-proposed goal title to a fixed set of read-only /
// verification verbs — code-modification verbs (Implement, Fix, Refactor,
// Build, Add, Optimize) are refused by being absent from the set. That same
// list is the authority for read-only intent at plan time: a goal whose
// leading verb is in this set must not produce code-generation or file-write
// steps. Hoisted here (out of Plan.js) so the planner and the activity share
// ONE vocabulary rather than drifting two copies.
// ============================================================

'use strict';

// Read-only / verification verbs. Code-modification verbs are intentionally
// absent — their absence is what marks a goal as NOT read-only.
const READONLY_VERBS = new Set([
  'document', 'reflect', 'summarise', 'summarize', 'research',
  'test', 'verify', 'list', 'compare', 'investigate',
  'map', 'index', 'explore', 'catalog', 'catalogue', 'inspect',
]);

/**
 * First alphabetic token of a title, lowercased, leading punctuation stripped.
 * @param {string} title
 * @returns {string|null} the verb, or null if none could be extracted
 */
function extractLeadingVerb(title) {
  if (!title || typeof title !== 'string') return null;
  // Strip leading punctuation / brackets, take first alphabetic token.
  const match = title.trim().match(/^[\[\(\{"'`*]*([A-Za-z]+)/);
  if (!match) return null;
  return match[1].toLowerCase();
}

/**
 * Ternary read-only classification of a goal by its leading verb.
 *   true  — leading verb is a read-only verb → no mutating steps
 *   false — leading verb exists but is NOT read-only (a write verb) → allow code
 *   null  — no leading verb could be determined → no intervention (back-compat)
 * @param {string} title
 * @returns {boolean|null}
 */
function isReadOnlyGoal(title) {
  const verb = extractLeadingVerb(title);
  if (!verb) return null;
  return READONLY_VERBS.has(verb);
}

module.exports = { READONLY_VERBS, extractLeadingVerb, isReadOnlyGoal };
