// ============================================================
// GENESIS — IntentSlashDiscipline.js (v7.9.47 "Wachstums-Wache")
//
// The slash-discipline half of the former IntentPatterns.js: the three
// sets and the one pure guard function that uses them. Split out because
// IntentPatterns.js had reached exactly 700 LOC — the file-size guard
// fires above that, and the next intent could not be added at all.
//
// The declarative INTENT_DEFINITIONS table stays where it was on
// purpose: three scripts and seven test files read that file BY PATH and
// search its TEXT for individual intent definitions. Moving the table
// would blind them, and two of them fail silently. Moving this block
// costs two readers, both taught about this file in the same commit.
//
// IntentPatterns.js re-exports everything below, so every importer keeps
// its single address.
// ============================================================

'use strict';

const { allCommandNames } = require('./slash-commands');

// slash-commands.js must NEVER be returned from classifyAsync() unless the
// user's message contains an actual '/'. The sync regex patterns in
// INTENT_DEFINITIONS already enforce this, but classifyAsync() has two
// bypass paths that don't:
//
//   1. LocalClassifier — learns from LLM-labeled samples. If the LLM ever
//      labeled "zeig mir deine settings" as 'settings' (it would, semantically),
//      LocalClassifier learns that and then returns settings on future
//      matches — without any slash in the message.
//
//   2. LLM fallback — directly returns the LLM's verdict. The LLM classifies
//      by meaning ("user wants settings → settings"), not by the slash rule.
//
// The guard below intercepts any slash-command verdict from either path and
// rewrites it to 'general' if there is no '/' anywhere in the message. That
// gives us a single chokepoint that can't be bypassed by prompt tweaks,
// model changes, or learned false-positives.
const SLASH_ONLY_INTENTS = new Set(allCommandNames());

// state (proactive-status) or set a user-visible mute (quiet). When the
// LLM/Local-classifier mis-classifies normal chat as one of these, the
// correct response is NOT a "this is slash-only" hint — that hint shows
// up confusingly on conversational text (e.g. "na, läuft alles?"). For
// these specific commands, on free-text mis-classification, we silently
// fall through to 'general' so the LLM responds normally. The slash
// pattern itself still works — typing /proactive-status still hits the
// command. We only suppress the slash-hint for the false-positive path.
//
// Rule for adding to this set: the command must be PURELY informational
// or user-controlled (no security impact, no irreversible action). If
// in doubt, leave it OUT — the slash-hint is the safer default.
const SAFE_SLASH_FALLTHROUGH = new Set([
  'quiet',
  'proactive-status',
]);

// canonical slash-commands — must REQUIRE an explicit slash trigger to fire.
// Before v7.5.1 their classifier patterns could match conversational free
// text ("lass uns das Database-Skill nutzen" → run-skill, "was ist mit
// trust level?" → trust-control), giving the LLM a path to invoke them
// from a benign exchange. This set forces enforceSlashDiscipline to
// rewrite the result to 'general' unless the message contains a `/`.
//
// To keep them reachable, every entry in this set must also have at least
// one slash-anchored pattern below (e.g. /(?:^|\s)\/run-skill\b/i).
const SECURITY_REQUIRED_SLASH = new Set([
  'run-skill',
  'execute-code',
  'execute-file',
  'trust-control',
  'shell-task',
  'shell-run',
  'memory-list',
  'memory-veto',
  'memory-mark',
  'self-recall',  // v7.5.5
  'install-software',  // v7.5.9 ZIP3 Phase 4a — fuzzy + slash; injection-relevant
  'open-software',     // v7.5.9 ZIP8 — fuzzy + slash; could be tricked into launching unintended binaries
  'cleanup-check',     // v7.8.4 — pre-deletion audit, slash-only by convention
]);

function enforceSlashDiscipline(result, message) {
  if (!result) return result;
  const isSlashOnly = SLASH_ONLY_INTENTS.has(result.type) || SECURITY_REQUIRED_SLASH.has(result.type);
  if (!isSlashOnly) return result;
  // 6-point reflection list that happened to contain a date "03/05" or a
  // markdown link slipped past, the LLM-classifier returned 'self-modify',
  // and an 18-item code-improvement plan was generated from a personal
  // values discussion. Fix: require the `/` to be in actual slash-command
  // position (start-of-message or after whitespace, followed by a word).
  // The per-intent patterns then decide WHICH slash-command was meant;
  // this guard only decides whether ANY slash-command is allowed at all.
  // v7.9.30 (4th narrowing): anchor to the START of the message, not any
  // whitespace boundary. An embedded /command after free text (a pasted log
  // line, a question with a copied /run-skill line) no longer counts as a
  // slash-command — it rewrites to general. This closes the whole
  // SECURITY_REQUIRED_SLASH class in one place: the incident message
  // ("kannst du was sehen ... /run-skill system-info") that reached shellRun
  // via run-skill would now never route there. A genuine command still
  // starts the message ("/run-skill x", "  /shell-task dir").
  if (typeof message === 'string' && /^\s*\/[a-z][\w-]*\b/i.test(message)) return result;
  // a fenced code block (```...```) is a documented alternate trigger
  // (user pasted runnable code, explicit content). This is intentionally
  // NOT extended to free-text imperatives like "fuehr aus den code"
  // (those still rewrite to general). Sandbox + Trust still hold the
  // line on actual execution.
  if (result.type === 'execute-code' && typeof message === 'string' && /^```/.test(message)) {
    return result;
  }
  // (quiet, proactive-status) the slash-hint is more confusing than
  // helpful when it fires on a false-positive ("na, läuft alles?" was
  // hitting "proactive-status"). Silently fall through to general so
  // the LLM answers normally; the slash pattern still routes correct
  // calls to the actual handler.
  if (SAFE_SLASH_FALLTHROUGH.has(result.type)) {
    return {
      type: 'general',
      confidence: 0.3,
      match: 'safe-slash-fallthrough',
    };
  }
  // route to the slash-hint handler instead of falling through to the
  // LLM (which used to confabulate refusals like "Ich kann keine
  // Software installieren" — wrong AND frustrating). Type stays
  // 'general' for backward compat with existing slash-discipline tests
  // that assert the LLM-bypass behavior; the metadata is consulted
  // by ChatOrchestrator before the general handler runs.
  return {
    type: 'general',
    confidence: 0.3,
    match: 'slash-discipline-guard',
    _wasSlashOnlyRewrite: true,
    originalIntent: result.type,
    originalMessage: message,
  };
}

module.exports = {
  SLASH_ONLY_INTENTS,
  SAFE_SLASH_FALLTHROUGH,
  SECURITY_REQUIRED_SLASH,
  enforceSlashDiscipline,
};
