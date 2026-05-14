// ============================================================
// GENESIS — VagueReferenceDetector
//
// Detects vague pronouns ("es", "das", "it", "that", ...) in
// open/launch/read/load-style commands that have no concrete
// referent in the same message or the last 2 conversation turns.
//
// Background: v7.5.8 backlog. When a user says "öffne das" or
// "open it" without context, downstream planners would invent a
// referent (hallucinated file paths, made-up skill names). The
// AgentLoopPlanner has prompt-level guardrails ("Reference REAL
// files only") but no early-stage detection that flagged a vague
// input AS vague before it reached the LLM.
//
// Design choice (v7.8.3): soft-hint, not hard-block. Consistent
// with the v7.8.1 explicitTool pattern — Genesis keeps autonomy
// and can choose to ask the user, or to act if context makes it
// obvious. The detector outputs a structured signal that
// PromptBuilderSectionsAwareness can surface; nothing about this
// fires automatically without the planner being prompt-extended
// to consider it.
//
// Detector logic (Unicode-safe; JavaScript \b is ASCII-only and
// would miss "öffne" entirely):
//
//   1. Message must contain an action verb (öffne/open/starte/
//      zeige/lies/lade/lösche/...).
//   2. AND a vague pronoun (es/das/dies/it/this/that/...).
//   3. AND no concrete antecedent in:
//      (a) the same message (after stripping the pronoun) — a
//          concrete noun (datei/file/ordner/path/...) or a quoted
//          string defeats the flag.
//      (b) the last 2 conversation turns — same rule.
//
// Returns { vague: true, pronoun } or null.
// ============================================================

'use strict';

const WB_START = '(?:^|[^\\w])';
const WB_END = '(?:$|[^\\w])';

const VAGUE_VERBS_RE = new RegExp(
  `${WB_START}(öffne|oeffne|open|starte|start|zeige?|show|lies|read|nimm|take|hol|fetch|lade|load|speichere|save|lösche|delete|entferne|remove)${WB_END}`,
  'i'
);

const VAGUE_PRONOUN_RE = new RegExp(
  `${WB_START}(es|das|dies|dieses|jenes|it|this|that|those|these)${WB_END}`,
  'i'
);

const ANTECEDENT_RE = new RegExp(
  `${WB_START}(datei|file|ordner|folder|verzeichnis|directory|pfad|path|dokument|document|skill|tool|projekt|project|service|module|funktion|function|klasse|class|zeile|line|buch|book|bild|image|foto|photo|video|email|mail|notiz|note|termin|appointment|nachricht|message|seite|page|link|url|adresse|address|anwendung|application|app|programm|program|fenster|window|tab|liste|list|tabelle|table|punkt|item|eintrag|entry)${WB_END}|['"][^'"]+['"]`,
  'i'
);

// v7.8.3 follow-up (F4): two additional concrete-antecedent heuristics
// beyond the whitelist. Triggered both in the current message and in
// the last-N history turns. These catch the natural-language cases
// where the user names a file or path directly without using one of
// the generic nouns in ANTECEDENT_RE — "öffne das" after "kannst du
// notes.md aufmachen?" should NOT be vague, because notes.md is
// clearly the referent.
//
// FILENAME_LIKE_RE: a word with a recognized file extension. The
// extension list is intentionally narrow (common doc/media/code
// types) so words like "u.s.a." or "z.B." don't trigger.
// PATH_LIKE_RE: a slash/backslash path fragment OR a Windows drive
// prefix (C:\) OR a home-relative path (~/). All three signal a
// concrete filesystem reference that an "öffne das" could resolve to.
const FILENAME_LIKE_RE = /\b[\w.-]+\.(?:txt|md|pdf|json|js|ts|tsx|jsx|html|css|scss|jpg|jpeg|png|gif|svg|webp|mp3|mp4|wav|doc|docx|xls|xlsx|ppt|pptx|csv|xml|yml|yaml|zip|tar|gz|log|cfg|conf|ini|sh|py|rb|go|rs|c|cpp|h|hpp|java|class|jar)\b/i;
const PATH_LIKE_RE = /(?:[\/\\][\w.-]+)|(?:^|[\s'"])[A-Z]:[\\/]|(?:^|[\s'"])~[\\/]/;

const RECENT_TURN_WINDOW = 2;

/**
 * Detect vague reference in an action-style user message.
 *
 * @param {string} message — the current user message
 * @param {Array<{role?: string, content?: string}>} history
 *   recent conversation turns (most-recent-last)
 * @returns {null | { vague: true, pronoun: string }}
 */
function detectVagueReference(message, history = []) {
  if (typeof message !== 'string' || !message) return null;
  if (!VAGUE_VERBS_RE.test(message)) return null;

  const pronounMatch = message.match(VAGUE_PRONOUN_RE);
  if (!pronounMatch) return null;

  // Strip the pronoun before scanning for antecedent in the same message
  // — otherwise "das" matches both the pronoun and the (rare) noun
  // "Das" in compound words. The pronoun regex includes "das" so the
  // strip is necessary to avoid self-matching.
  const stripped = message.replace(VAGUE_PRONOUN_RE, ' ');
  // v7.8.3 follow-up (F4): three checks per scope (current message
  // and recent history) — generic noun whitelist, filename-like
  // tokens, path-like tokens. Any one of them means there IS a
  // concrete antecedent and the message is not vague.
  if (ANTECEDENT_RE.test(stripped)) return null;
  if (FILENAME_LIKE_RE.test(stripped)) return null;
  if (PATH_LIKE_RE.test(stripped)) return null;

  // Search the last 2 turns. Older history doesn't count as context;
  // antecedents fade fast in natural conversation.
  const recentText = (history || [])
    .slice(-RECENT_TURN_WINDOW)
    .map((t) => (t && t.content) || '')
    .join(' ');
  if (ANTECEDENT_RE.test(recentText)) return null;
  if (FILENAME_LIKE_RE.test(recentText)) return null;
  if (PATH_LIKE_RE.test(recentText)) return null;

  // Match[1] is the captured pronoun (group inside boundaries).
  return { vague: true, pronoun: pronounMatch[1].toLowerCase() };
}

module.exports = { detectVagueReference, VAGUE_VERBS_RE, VAGUE_PRONOUN_RE, ANTECEDENT_RE };
