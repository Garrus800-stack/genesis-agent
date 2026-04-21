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
];

/**
 * Build a regex that matches `/name` or `/alias` at the start of a
 * message or preceded by whitespace. Case-insensitive.
 *
 * Example for name='self-inspect', aliases=['self-model']:
 *   /(^|\s)\/(?:self-inspect|self-model)\b/i
 *
 * @param {string} name
 * @param {string[]} [aliases]
 * @returns {RegExp}
 */
function slashPatternFor(name, aliases = []) {
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const alternatives = [name, ...aliases].map(escape).join('|');
  return new RegExp(`(^|\\s)\\/(?:${alternatives})\\b`, 'i');
}

/**
 * Extract the slash-command triplet from a message, if any. Returns
 * the handler name on match, or null. Matches embedded slashes too.
 *
 * @param {string} message
 * @returns {string|null}  canonical handler name, e.g. 'self-inspect'
 */
function detectSlashCommand(message) {
  if (!message || typeof message !== 'string') return null;
  for (const cmd of SLASH_COMMANDS) {
    const re = slashPatternFor(cmd.name, cmd.aliases);
    if (re.test(message)) return cmd.name;
  }
  return null;
}

/**
 * Lookup a command by name or alias.
 * @param {string} nameOrAlias
 * @returns {object|null}
 */
function getCommand(nameOrAlias) {
  const n = String(nameOrAlias || '').toLowerCase();
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === n) return cmd;
    if (cmd.aliases.some(a => a.toLowerCase() === n)) return cmd;
  }
  return null;
}

/** All canonical command names (no aliases). */
function allCommandNames() {
  return SLASH_COMMANDS.map(c => c.name);
}

module.exports = {
  SLASH_COMMANDS,
  slashPatternFor,
  detectSlashCommand,
  getCommand,
  allCommandNames,
};
