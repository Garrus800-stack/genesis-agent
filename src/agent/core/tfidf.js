// ============================================================
// GENESIS — core/tfidf.js (v7.3.6 #8)
//
// Minimal TF-IDF library. Pure functions, no state in the module
// itself — each caller builds its own vocabulary and vector space.
//
// Extracted from the embedding inside LocalClassifier.js so that
// non-classifier consumers (CapabilityMatcher) can share the
// algorithm without importing the classifier.
//
// API:
//   tokenize(text)                         → Array<string>
//   buildVocabulary(documents)             → { vocab, vocabIndex, idf, docCount }
//   textToVector(text, vocabIndex, idf)    → Float64Array
//   cosineSimilarity(vecA, vecB)           → number in [-1, 1]
//
// "Documents" here are short texts (goal descriptions, capability
// descriptions). Not designed for long-form prose.
// ============================================================

'use strict';

// ── Tokenization ─────────────────────────────────────────────
// Unicode-aware (v7.3.6 #10 pattern): \p{L}\p{N} splits on true
// non-letter/non-digit characters, keeping "Müller" / "café" /
// "señal" intact.

const STOP_WORDS = new Set([
  // English
  'a', 'an', 'the', 'of', 'to', 'for', 'and', 'or', 'is', 'as', 'on', 'in',
  'at', 'by', 'with', 'from', 'into', 'that', 'this', 'can', 'are', 'was',
  'be', 'has', 'its', 'it', 'all', 'any', 'not', 'but', 'also', 'when',
  'then', 'if', 'how', 'what', 'who', 'have', 'need',
  // German
  'der', 'die', 'das', 'den', 'dem', 'des',
  'ein', 'eine', 'einen', 'einer', 'eines', 'einem',
  'und', 'oder', 'aber', 'auch', 'noch', 'nur',
  'ist', 'sind', 'war', 'waren', 'wird',
  'fuer', 'für', 'mit', 'von', 'auf', 'aus', 'bei', 'nach',
  'dass', 'wenn', 'als', 'wie', 'so',
]);

/**
 * Tokenize text into a list of lowercased words, filtered by
 * length and stop-word list. Unicode-aware.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return [];
  return text.toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(w => w.length > 2 && w.length < 40 && !STOP_WORDS.has(w));
}

/**
 * Light stemming — kept from the legacy CapabilityMatcher so that
 * "homeostatic" vs "homeostasis" vs "homeostat" still align.
 * Applied to BOTH sides when comparing.
 * @param {string} word
 * @returns {string}
 */
function stem(word) {
  if (!word || word.length < 5) return word;
  const suffixes = ['ization', 'ational', 'aligned', 'ations', 'iveness',
    'tion', 'sion', 'ical', 'ing', 'ies', 'ied', 'ers', 'est', 'ized',
    'ic', 'al', 'ly', 'es', 'ed', 'er', 'is', 'us', 's'];
  for (const suf of suffixes) {
    if (word.length > suf.length + 2 && word.endsWith(suf)) {
      return word.slice(0, -suf.length);
    }
  }
  return word;
}

/**
 * Build a TF-IDF vocabulary over a corpus of documents.
 *
 * @param {string[]} documents - array of short texts
 * @param {object} [opts]
 * @param {boolean} [opts.useStemming=true]
 * @param {number}  [opts.minDocFreq=1] - drop words appearing in fewer docs
 * @returns {{ vocab: string[], vocabIndex: Object<string,number>, idf: Object<string,number>, docCount: number }}
 */
function buildVocabulary(documents, opts = {}) {
  const useStemming = opts.useStemming !== false;
  const minDocFreq = opts.minDocFreq || 1;
  const docs = Array.isArray(documents) ? documents : [];

  // Document frequencies
  const docFreq = Object.create(null);
  for (const doc of docs) {
    const tokens = tokenize(String(doc || ''));
    const seen = new Set();
    for (const tRaw of tokens) {
      const t = useStemming ? stem(tRaw) : tRaw;
      if (seen.has(t)) continue;
      seen.add(t);
      docFreq[t] = (docFreq[t] || 0) + 1;
    }
  }

  // Vocabulary: words meeting minDocFreq, sorted by descending frequency
  const vocab = Object.entries(docFreq)
    .filter(([, freq]) => freq >= minDocFreq)
    .sort((a, b) => b[1] - a[1])
    .map(([word]) => word);

  const vocabIndex = Object.create(null);
  vocab.forEach((w, i) => { vocabIndex[w] = i; });

  // IDF with smoothing (add-one style): log((N + 1) / (df + 1)) + 1
  // Always positive, avoids divide-by-zero, rewards rare terms.
  const docCount = docs.length;
  const idf = Object.create(null);
  for (const word of vocab) {
    idf[word] = Math.log((docCount + 1) / (docFreq[word] + 1)) + 1;
  }

  return { vocab, vocabIndex, idf, docCount, _useStemming: useStemming };
}

/**
 * Convert a text into its TF-IDF vector against a prebuilt vocabulary.
 * Uses augmented term frequency (0.5 + 0.5 * tf / maxTf) to prevent
 * length bias — long docs don't automatically overpower short ones.
 *
 * @param {string} text
 * @param {{vocabIndex: Object<string,number>, idf: Object<string,number>, vocab: string[], _useStemming?: boolean}} vocabulary
 * @returns {Float64Array}
 */
function textToVector(text, vocabulary) {
  const { vocabIndex, idf, vocab } = vocabulary;
  const useStemming = vocabulary._useStemming !== false;
  const vec = new Float64Array(vocab.length);
  if (!text || vocab.length === 0) return vec;

  const rawTokens = tokenize(String(text));
  if (rawTokens.length === 0) return vec;

  // Term frequencies for this document
  const tf = Object.create(null);
  for (const tRaw of rawTokens) {
    const t = useStemming ? stem(tRaw) : tRaw;
    if (vocabIndex[t] === undefined) continue;
    tf[t] = (tf[t] || 0) + 1;
  }

  const tfVals = Object.values(tf);
  if (tfVals.length === 0) return vec;
  const maxTf = Math.max(...tfVals);

  for (const [word, count] of Object.entries(tf)) {
    const idx = vocabIndex[word];
    if (idx === undefined) continue;
    // Augmented TF × IDF
    vec[idx] = (0.5 + 0.5 * count / maxTf) * (idf[word] || 1);
  }
  return vec;
}

/**
 * Cosine similarity of two equal-length vectors. Returns 0 for
 * zero vectors (safer than NaN).
 *
 * @param {Float64Array | number[]} a
 * @param {Float64Array | number[]} b
 * @returns {number} in [-1, 1]; in practice [0, 1] for TF-IDF
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

module.exports = {
  tokenize,
  stem,
  buildVocabulary,
  textToVector,
  cosineSimilarity,
  STOP_WORDS,
};
