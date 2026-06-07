// ============================================================
// GENESIS — core/goal-intent.js (v7.9.19, Strang E)
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

// ============================================================
// v7.9.20 (A + §8): plan-dedup machinery, moved here from
// autonomy/activities/Plan.js so the planner activity stays under the
// RUNTIME-02 250-LOC cap. One vocabulary, one home. Plan.js imports these
// and re-exports the test symbols.
// ============================================================

// Extended stopwords for goal-token-overlap dedup: generic goal-words are
// filtered so only domain-content tokens count towards the overlap.
const _STOPWORDS = new Set([
  'activity', 'activities', 'error', 'errors', 'improve', 'improvement',
  'handle', 'handling', 'system', 'method', 'feature', 'function',
  'process', 'general', 'better', 'support', 'enable', 'allow',
]);

// plan-dedup knobs — window for "recent" terminal goals, floor + ratio for
// "redundant". Rationale in v7919-idlemind-dedup.test.js.
const FAILURE_RELEVANCE_WINDOW_DAYS = 14;
const OVERLAP_SKIP_RATIO = 0.6;
const REDUNDANCY_FLOOR = 2;
// Failed/abandoned terminal states (live stack).
const _TERMINAL_GOAL_STATUS = new Set(['obsolete', 'stalled', 'failed']);
// v7.9.20 (A): a COMPLETED goal is terminal too — it has left the live stack
// for goals/archive.json and must not be re-proposed.
const _DONE_GOAL_STATUS = new Set(['completed']);

// content-token split (lowercase; drop <4-char tokens and _STOPWORDS).
function _tokenize(s) {
  return (s || '').toLowerCase()
    .replace(/[^a-z0-9äöüß]+/g, ' ').split(/\s+/)
    .filter(t => t.length >= 4 && !_STOPWORDS.has(t));
}

// v7.9.20 (A): generic — goals of a given status set within the window.
// g.updated→g.created; undated = out. The one shared source for prompt hint
// AND skip check, for failures and completions alike.
function _recentGoalsByStatus(goals, now, windowDays, statusSet) {
  const cutoff = now - windowDays * 86400000;
  return (goals || []).filter(g => {
    if (!g || !statusSet.has(g.status)) return false;
    const t = Date.parse(g.updated || g.created || '');
    return Number.isFinite(t) && t >= cutoff;
  });
}

// terminal (failed/obsolete/stalled) goals within the window — delegates.
function _recentRelevantFailures(goals, now, windowDays) {
  return _recentGoalsByStatus(goals, now, windowDays, _TERMINAL_GOAL_STATUS);
}

// redundant iff >= REDUNDANCY_FLOOR distinct tokens overlap AND
// overlap/|titleTokens| >= ratio. Returns the count for the log.
function _overlapRedundant(titleTokens, descTokens, ratio = OVERLAP_SKIP_RATIO) {
  const descSet = descTokens instanceof Set ? descTokens : new Set(descTokens);
  let overlap = 0;
  for (const t of descSet) if (titleTokens.has(t)) overlap++;
  const size = titleTokens.size || 1;
  const redundant = overlap >= REDUNDANCY_FLOOR && (overlap / size) >= ratio;
  return { overlap, redundant };
}

/**
 * v7.9.20 (A): build the planner's "recent goals" view. Unions the live goal
 * stack with the persisted archive (goals/archive.json) so a COMPLETED goal —
 * which has left the live stack for the archive — is still seen and not
 * re-proposed. Defensive: degrades to the live stack when storage/archive are
 * missing. The dedup horizon is the archive's own window (ARCHIVE_MAX entries).
 * @param {{goalStack?:object, storage?:object, now?:number, log?:object}} args
 * @returns {{recentFailures:object[], recentCompleted:object[], failedHint:string, completedHint:string}}
 */
function buildRecentGoalContext({ goalStack, storage, now, log } = {}) {
  const live = (goalStack && goalStack.goals) || [];
  let archive = [];
  try {
    archive = (storage && typeof storage.readJSON === 'function')
      ? (storage.readJSON('goals/archive.json', []) || []) : [];
  } catch (e) {
    if (log && log.debug) log.debug('[catch] goal archive read:', e.message);
    archive = [];
  }
  const view = live.concat(Array.isArray(archive) ? archive : []);
  const when = Number.isFinite(now) ? now : Date.now();
  const recentFailures = _recentGoalsByStatus(view, when, FAILURE_RELEVANCE_WINDOW_DAYS, _TERMINAL_GOAL_STATUS);
  const recentCompleted = _recentGoalsByStatus(view, when, FAILURE_RELEVANCE_WINDOW_DAYS, _DONE_GOAL_STATUS);
  const fmt = (g) => `- ${(g.description || g.title || '').slice(0, 80)} [${g.status}]`;
  return {
    recentFailures,
    recentCompleted,
    failedHint: recentFailures.slice(-5).map(fmt).join('\n'),
    completedHint: recentCompleted.slice(-5).map(fmt).join('\n'),
  };
}

module.exports = {
  READONLY_VERBS, extractLeadingVerb, isReadOnlyGoal,
  // v7.9.20 (A + §8): dedup machinery
  _STOPWORDS, FAILURE_RELEVANCE_WINDOW_DAYS, OVERLAP_SKIP_RATIO, REDUNDANCY_FLOOR,
  _TERMINAL_GOAL_STATUS, _DONE_GOAL_STATUS,
  _tokenize, _recentGoalsByStatus, _recentRelevantFailures, _overlapRedundant,
  buildRecentGoalContext,
};
