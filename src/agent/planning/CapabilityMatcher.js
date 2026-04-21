// @ts-checked-v5.7
// ============================================================
// GENESIS — CapabilityMatcher.js (v7.3.1)
// ------------------------------------------------------------
// Matches a goal description against known capabilities.
// Used by GoalStack.addGoal() to detect duplicate proposals.
//
// ALGORITHM (staged):
//   1. Extract keywords from goal text (title + description)
//   2. For each capability, compute Jaccard overlap of keywords
//   3. Rank capabilities by overlap score [0..1]
//   4. Return top match + score
//
// DECISION (in GoalStack.addGoal):
//   score < 0.4           → pass (goal is novel-ish)
//   score > 0.8           → block (duplicate) — except source='user' (warn only)
//   0.4 <= score <= 0.8   → grey zone (caller may invoke LLM classifier)
//
// OVERRIDE:
//   If goal has `novel: { reason, contrasting }`, the block is bypassed
//   and a 'novel-claimed' lesson is recorded.
// ============================================================

'use strict';

// v7.3.6 #8: TF-IDF-based similarity. Replaces Jaccard with cosine
// similarity on TF-IDF vectors built from the goal description +
// all capability descriptions+keywords as the corpus.
const tfidf = require('../core/tfidf');

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'is', 'as', 'on', 'in', 'at', 'by',
  'via', 'with', 'from', 'into', 'that', 'this', 'can', 'are', 'was', 'be', 'has', 'its',
  'it', 'all', 'any', 'not', 'but', 'also', 'when', 'then', 'if', 'how', 'what', 'who',
  'add', 'new', 'use', 'make', 'create', 'build', 'write', 'get', 'set', 'have', 'need',
  'implement', 'feature', 'support', 'improve',
]);

const THRESHOLDS = {
  PASS: 0.4,   // below → clearly novel (low cosine)
  BLOCK: 0.75, // v7.3.6 #8: lowered from 0.8 (Jaccard) to 0.75 (cosine)
};

/**
 * Light stemming: strip common English/German suffixes so related word
 * forms match. "Homeostatic" → "homeostat", "homeostasis" → "homeostas".
 * Not linguistically perfect, but catches the common case of v7.2.8's
 * Homeostatic-Throttling-Duplikat pattern: noun (homeostasis) vs adjective
 * form (homeostatic), verb (throttle) vs gerund (throttling).
 *
 * Applied to BOTH sides of comparison for symmetry.
 */
function stem(word) {
  if (!word || word.length < 5) return word;
  // Order matters: longer suffixes first
  const suffixes = ['ization', 'ational', 'aligned', 'ations', 'iveness', 'tion', 'sion',
    'ical', 'ing', 'ies', 'ied', 'ers', 'est', 'ized', 'ic', 'al', 'ly',
    'es', 'ed', 'er', 'is', 'us', 's'];
  for (const suf of suffixes) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

/**
 * Extract keywords from text: lowercased, deduplicated, stop-words removed,
 * length >= 3 for non-technical terms. Unicode-safe for German umlauts.
 * Returns STEMMED keywords for broader matching.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractKeywords(text) {
  if (!text || typeof text !== 'string') return [];
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}0-9\s-]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !STOP_WORDS.has(w))
    .map(stem);
  return [...new Set(tokens)].filter(w => w.length >= 3);
}

/**
 * Jaccard similarity: |A ∩ B| / |A ∪ B|.
 * Returns 0 if either set is empty.
 */
function jaccard(setA, setB) {
  if (setA.length === 0 || setB.length === 0) return 0;
  const a = new Set(setA);
  const b = new Set(setB);
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Common-prefix ratio: how much of the shorter word is a prefix of the
 * longer one. "homeostat" vs "homeostasis" → 9/11 = 0.82.
 * Used as a fuzzy-match signal for word-form variation after stemming.
 */
function prefixSimilarity(a, b) {
  if (!a || !b) return 0;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length > b.length ? a : b;
  if (shorter.length < 4) return a === b ? 1 : 0;
  let common = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] === longer[i]) common++;
    else break;
  }
  return common / shorter.length;
}

/**
 * Fuzzy set-overlap: A-tokens match B-tokens either exactly OR via prefix
 * similarity >= 0.7. Handles word-form variations better than pure Jaccard
 * (e.g. homeostatic/homeostasis after stemming both to homeostat/homeostas).
 */
function fuzzyOverlap(setA, setB) {
  if (setA.length === 0 || setB.length === 0) return 0;
  const a = [...new Set(setA)];
  const b = [...new Set(setB)];
  let intersection = 0;
  for (const x of a) {
    if (b.includes(x)) { intersection++; continue; }
    const matched = b.some(y => prefixSimilarity(x, y) >= 0.7);
    if (matched) intersection++;
  }
  const union = a.length + b.length - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Match a goal description against a capability list using TF-IDF cosine.
 *
 * v7.3.6 #8: replaces the Jaccard/fuzzy-overlap approach. Corpus is
 * built from the goal description + one document per capability (its
 * description plus keywords joined). Rare-but-distinctive words
 * (e.g. "homeostasis", "dream-cycle") weigh more than common ones
 * (e.g. "system", "add") because of IDF weighting.
 *
 * API unchanged: returns {score, matched, decision}.
 *
 * @param {string} description - Goal text (title + description)
 * @param {Array<object>} capabilities - getCapabilitiesDetailed() output
 * @returns {{ score: number, matched: object|null, decision: string }}
 *   decision: 'pass' | 'grey' | 'block'
 */
function match(description, capabilities) {
  if (!description || !Array.isArray(capabilities) || capabilities.length === 0) {
    return { score: 0, matched: null, decision: 'pass' };
  }

  // Build one document per capability combining description + keywords.
  // Keywords carry domain-specific terms (homeostasis, dream-cycle)
  // that the description may not repeat.
  const capDocs = capabilities.map(cap => {
    const desc = String(cap.description || cap.name || cap.id || '');
    const kws  = Array.isArray(cap.keywords) ? cap.keywords.join(' ') : '';
    return `${desc} ${kws}`.trim();
  });

  // Corpus = goal + all capability docs, so IDF reflects what's rare
  // across this goal-vs-capability comparison specifically.
  const corpus = [String(description), ...capDocs];
  const vocabulary = tfidf.buildVocabulary(corpus, { useStemming: true });

  // If vocabulary is empty (all stop-words, too-short tokens), fall back
  // gracefully: no match, decision=pass.
  if (vocabulary.vocab.length === 0) {
    return { score: 0, matched: null, decision: 'pass' };
  }

  const goalVec = tfidf.textToVector(String(description), vocabulary);

  let best = { score: 0, matched: null };
  for (let i = 0; i < capabilities.length; i++) {
    const capDoc = capDocs[i];
    if (!capDoc) continue;
    const capVec = tfidf.textToVector(capDoc, vocabulary);
    const sim = tfidf.cosineSimilarity(goalVec, capVec);
    if (sim > best.score) {
      best = { score: sim, matched: capabilities[i] };
    }
  }

  // Prefix-rescue for short goals: TF-IDF treats "homeostat" (from
  // stemming "homeostatic") and "homeostas" (from "homeostasis") as
  // different words. For short goals (≤5 tokens) where cosine stays
  // low, run the legacy fuzzy-overlap as a fallback. Real duplicates
  // with stem-divergent forms still get caught; genuinely novel goals
  // stay low because fuzzyOverlap would be low too.
  const goalTokens = extractKeywords(String(description));
  const isShortGoal = goalTokens.length <= 5;
  if (isShortGoal && best.score < THRESHOLDS.PASS) {
    for (const cap of capabilities) {
      const capKws = (cap.keywords || []).map(k => k.toLowerCase()).map(stem).filter(k => k.length >= 3);
      if (capKws.length === 0) continue;
      const fuzzy = fuzzyOverlap(goalTokens, capKws);
      if (fuzzy > best.score) {
        best = { score: fuzzy, matched: cap };
      }
    }
  }

  let decision;
  if (best.score < THRESHOLDS.PASS)       decision = 'pass';
  else if (best.score >= THRESHOLDS.BLOCK) decision = 'block';
  else                                     decision = 'grey';

  return {
    score: Math.round(best.score * 100) / 100,
    matched: best.matched,
    decision,
  };
}

/**
 * Validate an override claim. Goal's `novel` field must have both
 * `reason` (non-empty string) and `contrasting` (non-empty string).
 * This prevents the LLM from setting `novel: true` as a mechanical bypass.
 *
 * @param {object} novel - The goal.novel field
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateNovelOverride(novel) {
  if (!novel || typeof novel !== 'object') {
    return { valid: false, violations: ['novel field missing or not object'] };
  }
  const violations = [];
  if (!novel.reason || typeof novel.reason !== 'string' || novel.reason.trim().length < 10) {
    violations.push('novel.reason missing or too short (<10 chars)');
  }
  if (!novel.contrasting || typeof novel.contrasting !== 'string' || novel.contrasting.trim().length === 0) {
    violations.push('novel.contrasting missing');
  }
  return { valid: violations.length === 0, violations };
}

/**
 * v7.3.3: LLM-based resolver for grey-zone duplicate candidates.
 *
 * When Jaccard similarity lands in the grey band (0.4–0.8), lexical matching
 * alone can't tell whether two goals with shared vocabulary are actually
 * duplicates. This resolver asks the LLM with a tightly scoped prompt.
 *
 * Returns:
 *   { decision: 'block', reason: <llm-explanation> } — LLM said DUPLICATE
 *   { decision: 'pass',  reason: <llm-explanation> } — LLM said NOT_DUPLICATE
 *   { decision: 'grey',  reason: <failure-cause>    } — LLM unavailable / broken / unparseable / timed out
 *
 * The caller decides what to do with 'grey' (usually: fall back to the
 * existing jaccard-based thresholds).
 *
 * @param {object} params
 * @param {string} params.description   - The new goal's description
 * @param {object|null} params.matched  - The existing capability (description, name, keywords)
 * @param {number} params.score         - The jaccard score that put us in grey zone
 * @param {object|null} params.model    - LLM adapter with .chat(prompt, msgs?, role?)
 * @param {number} [params.timeoutMs=5000]
 * @returns {Promise<{decision: 'block'|'pass'|'grey', reason: string}>}
 */
async function resolveGreyWithLLM({ description, matched, score, model, timeoutMs = 5000 }) {
  if (!model || typeof model.chat !== 'function') {
    return { decision: 'grey', reason: 'no-llm' };
  }
  if (!matched) {
    return { decision: 'grey', reason: 'no-matched-capability' };
  }

  const newDesc = String(description || '').slice(0, 400);
  const capName = String(matched.name || matched.id || 'unknown').slice(0, 100);
  const capDesc = String(matched.description || '').slice(0, 400);
  const capKeywords = Array.isArray(matched.keywords) ? matched.keywords.slice(0, 8).join(', ') : '';

  const prompt = [
    'DUPLICATE DETECTION — are these two goals actually duplicates?',
    '',
    'IMPORTANT: Two goals sharing vocabulary are NOT automatically duplicates.',
    'Terms like "homeostasis", "cache", "refactor" can appear in goals that',
    'pursue different outcomes on different subsystems. Judge by OUTCOME, not',
    'by shared words.',
    '',
    `EXISTING CAPABILITY: ${capName}`,
    `  Description: ${capDesc}`,
    capKeywords ? `  Keywords: ${capKeywords}` : '',
    '',
    `NEW GOAL: ${newDesc}`,
    `  (Lexical similarity score: ${score.toFixed(2)})`,
    '',
    'Answer with this exact format (two lines):',
    'VERDICT: DUPLICATE  (or NOT_DUPLICATE)',
    'REASON: <one short sentence explaining why>',
  ].filter(Boolean).join('\n');

  try {
    const chatPromise = Promise.resolve(model.chat(prompt, [], 'user'));
    const timeoutPromise = new Promise((_, rej) =>
      setTimeout(() => rej(new Error('timeout')), timeoutMs));
    const response = await Promise.race([chatPromise, timeoutPromise]);
    const text = String(response?.content || response?.text || response || '');

    // Parse VERDICT line
    const verdictMatch = text.match(/VERDICT\s*:\s*(NOT_DUPLICATE|NOT\s+DUPLICATE|DUPLICATE)/i);
    const reasonMatch = text.match(/REASON\s*:\s*(.+?)(?:\n|$)/i);
    if (!verdictMatch) {
      return { decision: 'grey', reason: 'llm-parse-failed' };
    }
    const verdict = verdictMatch[1].toUpperCase().replace(/\s+/g, '_');
    const reason = reasonMatch ? reasonMatch[1].trim().slice(0, 300) : 'llm-decision';
    if (verdict === 'DUPLICATE') return { decision: 'block', reason };
    if (verdict === 'NOT_DUPLICATE') return { decision: 'pass', reason };
    return { decision: 'grey', reason: 'llm-parse-failed' };
  } catch (err) {
    if (err.message === 'timeout') {
      return { decision: 'grey', reason: 'timeout' };
    }
    return { decision: 'grey', reason: `llm-error:${err.message}` };
  }
}

module.exports = {
  match,
  extractKeywords,
  jaccard,
  fuzzyOverlap,
  prefixSimilarity,
  stem,
  validateNovelOverride,
  resolveGreyWithLLM,
  THRESHOLDS,
  STOP_WORDS,
};
