// ============================================================
// GENESIS — tool-call-verification.js (v7.3.5)
//
// Detects agentic hallucination: Genesis claiming in prose to have
// performed an action when no actual tool call fired in the turn.
//
// Motivating example: a chat turn where Genesis writes "Ich habe
// die Datei gespeichert und die Tests laufen lassen" without
// having called any file-write tool or sandbox tool in the same
// turn. The user sees a confident report of completed work; the
// work never happened.
//
// The check is detective, not preventative — it annotates a
// response after the fact rather than blocking it. A block would
// be too aggressive (legitimate prose often describes past work
// or uses ambiguous language). An annotation lets the user see
// that Genesis claimed action without tool evidence, so they can
// verify before trusting the claim.
//
// Scope: this first version uses shallow phrase matching. Good
// enough to catch blatant cases; misses subtle claims. Future
// versions (v7.4+) can use LLM-based verification with the full
// turn context.
// ============================================================

/**
 * Phrases that assert the assistant just performed a concrete action.
 * These are strong enough that their presence warrants checking the
 * tool-call trace. Ambiguous phrases like "I can" or "I would" are
 * deliberately excluded — they describe capability or intent, not
 * completed action.
 *
 * Each entry is a regex. Bilingual coverage (DE + EN) mirrors
 * Genesis' primary interaction language and its core prompts.
 */
const ACTION_CLAIM_PATTERNS = [
  // German — past tense claims of concrete action
  /\bich habe\s+(?:die|den|das|eine[rns]?)?\s*\S+\s*(?:gespeichert|geschrieben|erstellt|geändert|modifiziert|gelöscht|committed?|deployed?|ausgeführt|getestet|analysiert|heruntergeladen|installiert)/i,
  /\bhabe\s+(?:ich\s+)?(?:die|den|das)\s*\S+\s*(?:gespeichert|geschrieben|erstellt|geändert|gelöscht|ausgeführt)/i,
  /\b(?:datei|file|code|test|commit|änderung)\s+\S*\s*(?:gespeichert|geschrieben|erstellt|ausgeführt|committed?)/i,
  /\bich\s+(?:habe|hab')\s+(?:den\s+)?(?:plan|goal|ziel)\s+(?:angelegt|erstellt|gestartet)/i,
  // English — past tense claims
  /\bI\s+(?:just\s+)?(?:saved|wrote|created|modified|deleted|committed|deployed|executed|tested|analyzed|ran|installed)\s+(?:the|a|your|my)/i,
  /\bI(?:'ve|\s+have)\s+(?:just\s+)?(?:saved|written|created|modified|deleted|committed|deployed|executed|tested|analyzed|ran|installed)/i,
  /\b(?:file|test|commit|change|update)\s+(?:has\s+been|was)\s+(?:saved|written|created|deployed|executed|committed)/i,
];

/**
 * Specific tool categories and the claim phrases that imply them.
 * If a response contains claims from category X but no tool call
 * from category X fired, the mismatch is strong evidence of
 * hallucination.
 */
const TOOL_CLAIM_MAP = [
  {
    category: 'file-write',
    toolNames: ['file-write', 'write-file', 'create-file', 'edit-file'],
    patterns: [
      // German: "Datei X gespeichert" or "X als Y gespeichert" or "X.ext gespeichert"
      /\bdatei\s+\S*\.?\w*\s*(?:gespeichert|geschrieben|erstellt|angelegt)/i,
      /\bals\s+\S+\.\w{1,5}\s+(?:gespeichert|geschrieben|erstellt|angelegt)/i,
      /\b\S+\.\w{1,5}\s+(?:gespeichert|geschrieben|erstellt|angelegt)/i,
      // English: "saved the file", "saved ... to X.ext"
      /\bsaved\s+(?:the\s+|a\s+|your\s+)?(?:file|config|\S+\.\w{1,5})/i,
      /\bsaved\s+(?:it\s+)?(?:to|into|at|as)\s+\S+/i,
      /\bwrote\s+(?:to\s+)?\S+\.\w{1,5}\b/i,
      /\bcreated\s+(?:the\s+|a\s+)?file\s+\S+/i,
    ],
  },
  // NOTE: shell must come before sandbox so "npm test ausgeführt" counts
  // as shell (which it is — npm is a shell invocation), not sandbox.
  {
    category: 'shell',
    toolNames: ['shell', 'execute-shell', 'run-command'],
    patterns: [
      // German: "npm X ausgeführt", "X befehl ausgeführt"
      /\b(?:npm|git|node|yarn|pip|cargo|docker)\s+\S+\s+(?:ausgeführt|gelaufen|lief|ran|executed|launched)/i,
      // Also: "Ich habe npm test ausgeführt" — verb AFTER
      /\bich\s+habe\s+(?:npm|git|node|yarn|pip|cargo|docker)\s+\S+\s+ausgeführt/i,
      /\bran\s+(?:npm|git|node|yarn|pip|cargo)\s+\S+/i,
      /\bden?\s+befehl\s+\S+\s+(?:ausgeführt|lief|gelaufen)/i,
    ],
  },
  {
    category: 'sandbox',
    toolNames: ['execute-code', 'syntax-check', 'sandbox'],
    patterns: [
      // German: "Tests sind gelaufen" / "Tests sind alle grün" / "Tests ausgeführt"
      // Allow up to ~20 chars of fillers between "tests" and the verb.
      /\btests?\s+(?:sind\s+|haben\s+|\w+\s+){0,3}(?:ausgeführt|gelaufen|durchgelaufen|passed|grün|green)/i,
      /\btests?\s+(?:laufen|liefen)\s+(?:alle\s+)?grün/i,
      /\bcode\s+(?:getestet|tested|validated|geprüft)/i,
    ],
  },
];

/**
 * Check a response for action-claim phrases without corresponding
 * tool calls. First-match-wins: once a category's pattern matches,
 * later categories aren't also checked against the same phrase.
 * This prevents "npm test ausgeführt" from being flagged as both
 * shell (correct) and sandbox (spurious — "test" overlap).
 *
 * @param {string} response - Full assistant response text
 * @param {Array<{name: string}>} toolCalls - Tool calls that fired this turn
 * @returns {Array<{category: string, match: string, expectedTools: string[]}>}
 */
function detectHallucinatedClaims(response, toolCalls = []) {
  if (typeof response !== 'string' || !response.trim()) return [];
  const firedNames = new Set((toolCalls || []).map(tc => (tc.name || tc.tool || '').toLowerCase()));
  const flags = [];
  // Track offsets of phrases already attributed to a category to avoid
  // double-counting overlap (e.g. "npm test" matches both shell and
  // sandbox, but only shell should own it — shell entry is listed first).
  const claimedRanges = [];

  for (const { category, toolNames, patterns } of TOOL_CLAIM_MAP) {
    let claimedMatch = null;
    let claimedIndex = -1;
    for (const p of patterns) {
      const m = response.match(p);
      if (!m) continue;
      // Skip if this match overlaps with an already-claimed range
      const start = m.index;
      const end = start + m[0].length;
      const overlaps = claimedRanges.some(r => !(end <= r.start || start >= r.end));
      if (overlaps) continue;
      claimedMatch = m[0];
      claimedIndex = start;
      break;
    }
    if (!claimedMatch) continue;

    // Mark this range as claimed so subsequent categories can't re-claim it
    claimedRanges.push({ start: claimedIndex, end: claimedIndex + claimedMatch.length });

    // Did a matching tool actually fire?
    const firedInCategory = toolNames.some(n => firedNames.has(n.toLowerCase()));
    if (!firedInCategory) {
      flags.push({
        category,
        match: claimedMatch.slice(0, 120),
        expectedTools: toolNames,
      });
    }
  }

  return flags;
}

/**
 * Heuristic check for general action claims (not tied to a specific
 * tool category). Detects broad "I just did X" phrasing which, if
 * combined with zero tool calls in the turn, is very suspicious.
 *
 * @param {string} response
 * @returns {{ hasActionClaim: boolean, match: string|null }}
 */
function hasGeneralActionClaim(response) {
  if (typeof response !== 'string' || !response.trim()) {
    return { hasActionClaim: false, match: null };
  }
  for (const p of ACTION_CLAIM_PATTERNS) {
    const m = response.match(p);
    if (m) return { hasActionClaim: true, match: m[0] };
  }
  return { hasActionClaim: false, match: null };
}

/**
 * Full verification: combines category-specific detection with the
 * general-claim fallback. If either triggers and no tool calls
 * fired in the turn, the response is annotated.
 *
 * @param {string} response
 * @param {Array} toolCalls
 * @returns {{ verdict: 'verified'|'suspicious'|'unverified', flags: Array, reason: string|null }}
 */
function verifyToolClaims(response, toolCalls = []) {
  const flags = detectHallucinatedClaims(response, toolCalls);
  const hasTools = (toolCalls || []).length > 0;

  if (flags.length > 0) {
    return {
      verdict: 'suspicious',
      flags,
      reason: `claims ${flags.map(f => f.category).join(', ')} but matching tools did not fire`,
    };
  }

  // General-claim fallback: if no tools fired at all but the response
  // makes a concrete action claim, mark unverified.
  if (!hasTools) {
    const general = hasGeneralActionClaim(response);
    if (general.hasActionClaim) {
      return {
        verdict: 'unverified',
        flags: [{ category: 'general', match: general.match, expectedTools: [] }],
        reason: 'general action claim but no tool calls fired',
      };
    }
  }

  return { verdict: 'verified', flags: [], reason: null };
}

/**
 * Format a short user-facing annotation for a suspicious response.
 * Kept deliberately brief and neutral — no alarmism, no technical
 * jargon. The user should see it as a helpful note, not an error.
 *
 * @param {{ verdict: string, flags: Array }} verification
 * @returns {string}
 */
function formatVerificationNote(verification) {
  if (verification.verdict === 'verified') return '';
  const count = verification.flags.length;
  if (verification.verdict === 'suspicious') {
    const cats = verification.flags.map(f => f.category).join(', ');
    return `\n\n_(Hinweis: Genesis hat ${cats}-Aktion${count > 1 ? 'en' : ''} beschrieben, aber die passenden Tools sind in diesem Zug nicht gelaufen. Bitte verifiziere vor dem Vertrauen.)_`;
  }
  return '\n\n_(Hinweis: die Antwort beschreibt eine Aktion, aber in diesem Zug lief kein Tool. Bitte verifiziere.)_';
}

module.exports = {
  detectHallucinatedClaims,
  hasGeneralActionClaim,
  verifyToolClaims,
  formatVerificationNote,
  // exported for tests
  ACTION_CLAIM_PATTERNS,
  TOOL_CLAIM_MAP,
};
