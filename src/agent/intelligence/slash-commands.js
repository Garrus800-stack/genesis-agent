// ============================================================
// GENESIS — intelligence/slash-commands.js (v7.3.6 #1)
//
// Single Source of Truth for all slash-triggered command handlers.
// Before v7.3.6 there were two kinds of slash-only handlers:
//
//   (a) settings, journal, plans, self-repair-reset
//       → already slash-only since v7.3.5
//
//   (b) self-inspect, self-reflect, self-modify, self-repair,
//       daemon, peer, clone, create-skill, analyze-code
//       → matched ALSO on keywords/imperatives, breaking chat flow
//          (Garrus: "es nervt im Chat, es bringt ihn durcheinander")
//
// v7.3.6 #1 moves group (b) to slash-only, matching the rule
// already in place for group (a): the handler triggers if and
// only if `/<name>` appears anywhere in the message — at the
// start, or preceded by whitespace.
//
// Rationale (Variant A from the plan):
// The regex  /(^|\s)\/(name)\b/i  allows:
//   "/self-inspect"                               ← start
//   "kannst du mal /self-inspect machen"          ← embedded
// but does NOT trigger on:
//   "ich analysiere gerade meinen code"           ← no slash
//   "show me the modules"                         ← imperative
//   "Der Struktur halber..."                      ← keyword
//
// Garrus explicit: "in Satz kann ich / machen dann soll er das
// erkennen". That is exactly Variant A.
// ============================================================

'use strict';

/**
 * The complete list of slash-triggered command handlers in v7.3.6.
 * Each entry has a canonical name (used both as the `/` command and
 * as the IntentRouter intent type), an optional list of aliases
 * that also accept `/<alias>`, and a short description for docs/help.
 */
const SLASH_COMMANDS = [
  // Inspection & introspection
  {
    name: 'self-inspect',
    aliases: ['self-model'],
    description: 'List modules / show source structure / show self-model',
    sinceVersion: 'v5.0',
  },
  {
    name: 'self-reflect',
    aliases: [],
    description: 'Reflect on own improvements, gaps, weaknesses',
    sinceVersion: 'v5.9',
  },

  // Mutation & repair
  {
    name: 'self-modify',
    aliases: [],
    description: 'Modify own source code',
    sinceVersion: 'v5.0',
  },
  {
    name: 'self-repair',
    aliases: [],
    description: 'Run diagnostic self-repair',
    sinceVersion: 'v5.0',
  },
  {
    name: 'self-repair-reset',
    aliases: ['unfreeze'],
    description: 'Reset circuit breaker after self-mod freeze',
    sinceVersion: 'v7.3.5',
  },

  // Skills & code
  {
    name: 'create-skill',
    aliases: [],
    description: 'Create a new Genesis skill/plugin',
    sinceVersion: 'v6.0',
  },
  {
    name: 'analyze-code',
    aliases: [],
    description: 'Analyze / review source code',
    sinceVersion: 'v7.0',
  },

  // Autonomy & networking
  {
    name: 'clone',
    aliases: [],
    description: 'Create a new agent clone',
    sinceVersion: 'v6.5',
  },
  {
    name: 'peer',
    aliases: [],
    description: 'Peer network operations (scan, trust, import)',
    sinceVersion: 'v7.0',
  },
  {
    name: 'daemon',
    aliases: [],
    description: 'Control autonomous daemon (start/stop/pause/status)',
    sinceVersion: 'v6.0',
  },

  // Pre-v7.3.6 slash-only (already locked down in v7.3.5)
  {
    name: 'settings',
    aliases: ['einstellungen'],
    description: 'Open settings panel',
    sinceVersion: 'v7.3.5',
  },
  {
    name: 'journal',
    aliases: ['tagebuch'],
    description: 'Open journal',
    sinceVersion: 'v7.3.5',
  },
  {
    name: 'plans',
    aliases: ['plaene', 'pläne'],
    description: 'Show current plans',
    sinceVersion: 'v7.3.5',
  },

  // v7.5.0 — Goals slash-discipline. Before v7.5.0, the goals handler
  // matched on free-text patterns like "set me a goal to ..." or
  // "lösche alle ziele", which collided with conversational mentions
  // of "goal/ziel" and could trigger destructive actions (e.g. cancel-all)
  // from a question that merely contained the word "cancel" near "goal".
  // v7.5.0 makes goals slash-only matching the policy already in place
  // for settings/journal/plans/self-* etc.
  {
    name: 'goals',
    aliases: ['goal', 'ziele', 'ziel'],
    description: 'Goal management: /goal add <text>, /goal list, /goal cancel <n>, /goal clear (asks confirmation)',
    sinceVersion: 'v7.5.0',
  },

  // v7.5.6 — Model availability marker reset. Genesis tracks models that
  // failed with auth/rate-limit/timeout (markUnavailable) and skips them
  // for a TTL window. /model-reset clears those markers manually so a
  // recovered model can be used again before TTL expires.
  {
    name: 'model-reset',
    aliases: [],
    description: 'Clear unavailable-markers for one or all models: /model-reset [modelName]',
    sinceVersion: 'v7.5.6',
  },

  // v7.7.9 Phase 2 — ProactiveSelfExpression user controls.
  // /quiet mutes self-initiated chat messages. Hard mute, no soft-decay,
  //        no adaptive learning from this signal — it's user sovereignty.
  // /proactive-status shows current settings, last-message info, daily
  //        count, mute state, and the last 10 suppressed candidates with
  //        their reason — so Garrus can see what was attempted but blocked.
  {
    name: 'quiet',
    aliases: ['silence'],
    description: 'Mute proactive self-messages: /quiet [30m|2h|today|off] (default 60m)',
    sinceVersion: 'v7.7.9',
  },
  {
    name: 'proactive-status',
    aliases: [],
    description: 'Show ProactiveSelfExpression status: settings, counts, recent suppressions',
    sinceVersion: 'v7.7.9',
  },
  {
    name: 'affect-trail',
    aliases: ['affekt-trail'],
    description: 'Show recent AgentLoop boundaries with affect snapshot, gate status, and θ',
    sinceVersion: 'v7.8.9',
  },
];

/** All canonical command names (no aliases). */
function allCommandNames() {
  return SLASH_COMMANDS.map(c => c.name);
}

// v7.5.9 cleanup: removed three never-called exports that were leftover
// from a planned IntentRouter consolidation that never happened —
// `slashPatternFor`, `detectSlashCommand`, `getCommand`. They had zero
// callers across src/, test/, scripts/, and main.js. The actual slash
// detection lives inline in IntentPatterns.js (`enforceSlashDiscipline`
// + per-intent `/(?:^|\s)\/<name>\b/i` patterns) and IntentRouter
// regex/fuzzy classification, neither of which uses these helpers.

module.exports = {
  SLASH_COMMANDS,
  allCommandNames,
};
