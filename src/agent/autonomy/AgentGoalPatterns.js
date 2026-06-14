'use strict';
// ============================================================
// GENESIS — autonomy/AgentGoalPatterns.js (v7.9.22)
//
// The agent-goal intent's regex patterns and fuzzy keywords, extracted from
// AgentCoreBoot.js (Item 11) into one requirable source so the producer and the
// registration test share a single definition and cannot drift (the G2b drift lesson).
//
// Item 11 fix for the autonomous-work patterns:
//   - require the qualifier near the verb with a bounded gap instead of a greedy `.*`
//     that bridged two tokens co-occurring anywhere in a sentence;
//   - key on the verb "arbeite/arbeiten/arbeitest", not the noun "arbeit";
//   - \b on each verb group rejects an embedded match (German "bearbeiten", English
//     "framework"); a trailing \b plus "alleine?" on the German qualifier rejects the
//     inflected adjective ("autonomen"); the English side takes the adverb form
//     ("autonomously"/"independently") so "work on autonomous systems" does not match,
//     while German keeps the bare adverb "autonom" (German adds no adverb suffix);
//   - \S rather than \w in the gap because JS \w without the /u flag misses umlauts.
// "alleine"/"alone" are dropped from the fuzzy list as high-frequency casual words.
// ============================================================

const AGENT_GOAL_PATTERNS = [
  /(?:mach|bau|erstell|implementier|refaktor|schreib).*(?:fuer mich|komplett|fertig|ganz|vollstaendig)/i,
  /(?:kuemmer|sorg).*(?:dich|du).*(?:um|darum)/i,
  /(?:erledige?|ausfuehr|fuehr).*(?:das|diese?n?|alles|aufgabe|task)/i,
  /\b(?:arbeite(?:n|st)?)\s+(?:\S+\s+){0,2}(?:autonom|selbststaendig|eigenstaendig|alleine?)\b/i,
  /(?:build|create|implement|refactor|write).*(?:for me|complete|entire|whole)/i,
  /(?:take care|handle|manage|do).*(?:for me|it all|everything|autonomously)/i,
  /\b(?:work|operate|execute)\s+(?:\S+\s+){0,2}(?:autonomously|independently|on your own)/i,
  /(?:ich will|i want|i need).*(?:dass du|you to).*(?:komplett|complete|entire|fully)/i,
];

const AGENT_GOAL_FUZZY = [
  'autonom', 'autonomous', 'eigenstaendig', 'independent',
  'erledigen', 'handle', 'komplett', 'complete', 'aufgabe',
  'task', 'implementieren', 'implement',
  'bauen', 'build', 'erstellen', 'create',
];

module.exports = { AGENT_GOAL_PATTERNS, AGENT_GOAL_FUZZY };
