// ============================================================
// GENESIS — LocalClassifier.js (Phase 10 — Persistent Agency)
//
// PROBLEM: IntentRouter falls back to LLM for classification
// when regex + fuzzy fail. On gemma2:9b this costs 2-3 seconds
// per message. Most of these LLM calls classify to the same
// few intents repeatedly.
//
// SOLUTION: A lightweight TF-IDF + cosine similarity classifier
// trained from IntentRouter's own _llmFallbackLog. After N
// samples per intent, the local classifier takes over and the
// LLM fallback is only used for truly novel messages.
//
// No external dependencies. Pure JS implementation.
// Accuracy target: 80%+ on trained intents (vs LLM baseline).
//
// Integration:
//   IntentRouter._llmClassify() records to LocalClassifier
//   IntentRouter.classifyAsync() tries LocalClassifier before LLM
//   LearningService feeds learned patterns periodically
// ============================================================

const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const _log = createLogger('LocalClassifier');

class LocalClassifier {
  // NOTE: containerConfig is informational only — this module is registered
  // via the phase manifest, not via ModuleRegistry auto-discovery.
  // Real lateBindings are declared in the manifest entry.
  constructor({ bus, storage, config }) {
    this.bus = bus || NullBus;
    this.storage = storage || null;

    const cfg = config || {};
    this._minSamplesPerIntent = cfg.minSamples || 8;
    this._confidenceThreshold = cfg.confidenceThreshold || 0.55;
    this._maxVocab = cfg.maxVocab || 3000;

    // ── Training Data ────────────────────────────────────
    this._samples = [];        // { text, intent, timestamp }
    this._maxSamples = 2000;

    // ── TF-IDF Model ────────────────────────────────────
    this._idf = {};            // word → IDF score
    this._intentVectors = {};  // intent → averaged TF-IDF vector
    this._vocab = [];          // ordered vocabulary
    this._vocabIndex = {};     // word → index
    this._trained = false;
    this._lastTrainSize = 0;
    this._retrainThreshold = 20; // Retrain after N new samples

    // ── Stats ────────────────────────────────────────────
    this._stats = {
      predictions: 0,
      correct: 0,     // When we can verify (LLM confirms our prediction)
      trained: 0,
      samplesTotal: 0,
    };
  }

  async asyncLoad() {
    try {
      const saved = await this.storage?.readJSON('local-classifier.json');
      if (saved) {
        this._samples = saved.samples || [];
        this._stats = { ...this._stats, ...saved.stats };
        if (this._samples.length >= this._minSamplesPerIntent) {
          this._train();
        }
      }
    } catch (_e) { _log.debug('[catch] no saved model:', _e.message); }
  }

  // ════════════════════════════════════════════════════════
  // PUBLIC API
  // ════════════════════════════════════════════════════════

  /**
   * Add a training sample (from LLM fallback observation).
   * @param {string} text — The user message
   * @param {string} intent — The LLM-classified intent
   */
  addSample(text, intent) {
    if (!text || !intent) return;

    this._samples.push({ text, intent, timestamp: Date.now() });
    this._stats.samplesTotal++;

    // Cap samples
    if (this._samples.length > this._maxSamples) {
      this._samples = this._samples.slice(-this._maxSamples);
    }

    // Auto-retrain if enough new data
    if (this._samples.length - this._lastTrainSize >= this._retrainThreshold) {
      this._train();
    }

    // Persist periodically
    if (this._stats.samplesTotal % 50 === 0) {
      this._save().catch(() => { /* best effort */ });
    }
  }

  /**
   * Classify a message using the local TF-IDF model.
   * Returns null if not trained or confidence too low.
   *
   * @param {string} text — Message to classify
   * @returns {{ type: string, confidence: number, source: 'local' } | null}
   */
  classify(text) {
    if (!this._trained) return null;
    if (!text || text.length < 3) return null;

    this._stats.predictions++;
    const tokens = this._tokenize(text);
    const vector = this._textToVector(tokens);

    // Compare against all intent vectors
    let bestIntent = null;
    let bestSim = -1;

    for (const [intent, intentVec] of Object.entries(this._intentVectors)) {
      const sim = this._cosineSimilarity(vector, intentVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestIntent = intent;
      }
    }

    if (bestSim < this._confidenceThreshold || !bestIntent) {
      return null; // Not confident enough → fall through to LLM
    }

    return {
      type: bestIntent,
      confidence: Math.round(bestSim * 100) / 100,
      source: 'local',
    };
  }

  /**
   * Record that our prediction was correct (for accuracy tracking).
   */
  recordCorrect() {
    this._stats.correct++;
  }

  /**
   * Is the classifier ready to make predictions?
   */
  isReady() {
    return this._trained;
  }

  /**
   * Get accuracy and stats.
   */
  getStats() {
    return {
      ...this._stats,
      accuracy: this._stats.predictions > 0
        ? Math.round((this._stats.correct / this._stats.predictions) * 100) / 100
        : 0,
      trained: this._trained,
      vocabSize: this._vocab.length,
      intentCount: Object.keys(this._intentVectors).length,
      samplesPerIntent: this._getSamplesPerIntent(),
    };
  }

  // ════════════════════════════════════════════════════════
  // TF-IDF IMPLEMENTATION
  // ════════════════════════════════════════════════════════

  _train() {
    if (this._samples.length < this._minSamplesPerIntent * 2) return;

    // Group samples by intent
    const byIntent = {};
    for (const s of this._samples) {
      if (!byIntent[s.intent]) byIntent[s.intent] = [];
      byIntent[s.intent].push(s.text);
    }

    // Need at least minSamples per intent for 2+ intents
    const validIntents = Object.entries(byIntent)
      .filter(([, texts]) => texts.length >= this._minSamplesPerIntent);

    if (validIntents.length < 2) return;

    // ── Build vocabulary ────────────────────────────────
    const docFreq = {};
    const allTokenized = [];
    let totalDocs = 0;

    for (const [intent, texts] of validIntents) {
      for (const text of texts) {
        const tokens = this._tokenize(text);
        allTokenized.push({ intent, tokens });
        totalDocs++;

        const seen = new Set(tokens);
        for (const t of seen) {
          docFreq[t] = (docFreq[t] || 0) + 1;
        }
      }
    }

    // Sort vocab by frequency, take top N
    this._vocab = Object.entries(docFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, this._maxVocab)
      .map(([word]) => word);

    this._vocabIndex = {};
    this._vocab.forEach((w, i) => { this._vocabIndex[w] = i; });

    // ── Compute IDF ─────────────────────────────────────
    this._idf = {};
    for (const word of this._vocab) {
      this._idf[word] = Math.log((totalDocs + 1) / (docFreq[word] + 1)) + 1;
    }

    // ── Compute intent centroids ────────────────────────
    this._intentVectors = {};
    const intentVecSums = {};
    const intentCounts = {};

    for (const { intent, tokens } of allTokenized) {
      if (!validIntents.find(([i]) => i === intent)) continue;

      const vec = this._textToVector(tokens);
      if (!intentVecSums[intent]) {
        intentVecSums[intent] = new Float64Array(this._vocab.length);
        intentCounts[intent] = 0;
      }

      for (let i = 0; i < vec.length; i++) {
        intentVecSums[intent][i] += vec[i];
      }
      intentCounts[intent]++;
    }

    for (const [intent, sum] of Object.entries(intentVecSums)) {
      const count = intentCounts[intent];
      const avg = new Float64Array(sum.length);
      for (let i = 0; i < sum.length; i++) {
        avg[i] = sum[i] / count;
      }
      this._intentVectors[intent] = avg;
    }

    this._trained = true;
    this._lastTrainSize = this._samples.length;
    this._stats.trained++;

    this.bus.emit('classifier:trained', {
      intents: Object.keys(this._intentVectors).length,
      vocabSize: this._vocab.length,
      samples: this._samples.length,
    }, { source: 'LocalClassifier' });
  }

  _tokenize(text) {
    // v7.3.6 #10 — Unicode-aware. Was [^a-z0-9äöüß\s] which covered German
    // but dropped é/à/ñ/ó/ø etc. Now \p{L}\p{N} covers all letters/digits
    // across scripts with /u flag. Preserves tokens in any language
    // Genesis might encounter via user input or research content.
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 && t.length < 30);
  }

  _textToVector(tokens) {
    const tf = {};
    for (const t of tokens) {
      if (this._vocabIndex[t] !== undefined) {
        tf[t] = (tf[t] || 0) + 1;
      }
    }

    const vec = new Float64Array(this._vocab.length);
    const maxTf = Math.max(...Object.values(tf), 1);

    for (const [word, count] of Object.entries(tf)) {
      const idx = this._vocabIndex[word];
      if (idx !== undefined) {
        // Augmented TF × IDF
        vec[idx] = (0.5 + 0.5 * count / maxTf) * (this._idf[word] || 1);
      }
    }

    return vec;
  }

  _cosineSimilarity(a, b) {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }

  _getSamplesPerIntent() {
    const counts = {};
    for (const s of this._samples) {
      counts[s.intent] = (counts[s.intent] || 0) + 1;
    }
    return counts;
  }

  async _save() {
    try {
      await this.storage?.writeJSON('local-classifier.json', {
        samples: this._samples,
        stats: this._stats,
      });
    } catch (err) {
      _log.warn('[CLASSIFIER] Save failed:', err.message);
    }
  }
}

module.exports = { LocalClassifier };
