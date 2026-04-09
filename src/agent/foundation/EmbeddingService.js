// @ts-checked-v5.7
// ============================================================
// GENESIS — EmbeddingService.js
// Local vector embeddings via Ollama. Falls back to TF-IDF
// if Ollama embeddings are unavailable.
//
// Usage:
//   const emb = new EmbeddingService();
//   await emb.init(); // probes Ollama for embedding model
//   const vec = await emb.embed("some text");
//   const sim = emb.cosineSimilarity(vecA, vecB);
//
// Supported models: nomic-embed-text, mxbai-embed-large,
// all-minilm, or any Ollama model with /api/embeddings.
// ============================================================

const http = require('http');
const { NullBus } = require('../core/EventBus');
const { createLogger } = require('../core/Logger');
const { TIMEOUTS } = require('../core/Constants');
const _log = createLogger('EmbeddingService');
const PREFERRED_MODELS = [
  'nomic-embed-text',
  'mxbai-embed-large',
  'all-minilm',
];

class EmbeddingService {
  constructor(optionsOrUrl = 'http://127.0.0.1:11434', bus) {
    // Support both: new EmbeddingService({ bus }) and new EmbeddingService(url, bus)
    if (typeof optionsOrUrl === 'object' && optionsOrUrl !== null) {
      // @ts-ignore — genuine TS error, fix requires type widening
      this.bus = optionsOrUrl.bus || NullBus;
      // @ts-ignore — genuine TS error, fix requires type widening
      this.baseUrl = optionsOrUrl.baseUrl || 'http://127.0.0.1:11434';
    } else {
      this.bus = bus || NullBus;
      this.baseUrl = optionsOrUrl;
    }
    this.model = null;
    this.available = false;
    this.dimensions = 0;
    this._cache = new Map(); // text hash → float array
    this._cacheMaxSize = 500;
  }

  /** Probe Ollama for an embedding model. Non-blocking, non-fatal. */
  async init() {
    try {
      const models = await this._httpGet(`${this.baseUrl}/api/tags`);
      const names = (models.models || []).map(m => m.name.split(':')[0]);

      // Find first preferred model that's available
      for (const preferred of PREFERRED_MODELS) {
        if (names.some(n => n.includes(preferred))) {
          this.model = names.find(n => n.includes(preferred));
          break;
        }
      }

      // Fallback: any model name containing 'embed' or 'minilm'
      if (!this.model) {
        this.model = names.find(n => /embed|minilm/i.test(n));
      }

      if (this.model) {
        // Test embedding to get dimensions
        const test = await this._getEmbedding('test');
        if (test && test.length > 0) {
          this.dimensions = test.length;
          this.available = true;
          _log.info(`[EMBEDDING] ${this.model} ready (${this.dimensions}d)`);
          this.bus.fire('embedding:ready', { model: this.model, dimensions: this.dimensions }, { source: 'EmbeddingService' });
        }
      }

      if (!this.available) {
        _log.info('[EMBEDDING] No embedding model found — using TF-IDF fallback');
      }
    } catch (err) {
      _log.debug('[EMBEDDING] Ollama not available for embeddings:', err.message);
      this.available = false;
    }
  }

  /**
   * Embed text into a vector.
   * Returns Float64Array if Ollama is available, null otherwise.
   */
  async embed(text) {
    if (!this.available || !text) return null;

    // Check cache
    const key = this._hash(text.slice(0, 500));
    if (this._cache.has(key)) return this._cache.get(key);

    const vec = await this._getEmbedding(text);
    if (vec) {
      this._cache.set(key, vec);
      if (this._cache.size > this._cacheMaxSize) {
        // Evict oldest
        const firstKey = this._cache.keys().next().value;
        this._cache.delete(firstKey);
      }
    }
    return vec;
  }

  /**
   * Batch embed multiple texts.
   * Runs up to `concurrency` embeddings in parallel.
   * Returns array of vectors (some may be null on failure).
   */
  async embedBatch(texts, concurrency = 4) {
    if (!this.available) return texts.map(() => null);

    const results = new Array(texts.length).fill(null);
    let idx = 0;

    const worker = async () => {
      while (idx < texts.length) {
        const i = idx++;
        results[i] = await this.embed(texts[i]);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, texts.length) }, () => worker());
    await Promise.all(workers);
    return results;
  }

  /**
   * Cosine similarity between two float arrays.
   */
  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom > 0 ? dot / denom : 0;
  }

  /**
   * Find the most similar text from a list of pre-embedded items.
   * @param {Array} queryVec - The query vector
   * @param {Array<{vec, data}>} items - Items with pre-computed vectors
   * @param {number} topK - Number of results
   * @returns {Array<{data, similarity}>}
   */
  findSimilar(queryVec, items, topK = 5) {
    if (!queryVec) return [];
    return items
      .map(item => ({ data: item.data, similarity: this.cosineSimilarity(queryVec, item.vec) }))
      .filter(r => r.similarity > 0.1)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  /** Check if embedding service is usable */
  isAvailable() { return this.available; }

  getStats() {
    return {
      available: this.available,
      model: this.model,
      dimensions: this.dimensions,
      cacheSize: this._cache.size,
    };
  }

  // ── Internal ─────────────────────────────────────────────

  async _getEmbedding(text) {
    try {
      const body = JSON.stringify({ model: this.model, prompt: text.slice(0, 2000) });
      const data = await this._httpPost(`${this.baseUrl}/api/embeddings`, body);
      return data?.embedding || null;
    } catch (err) {
      _log.debug('[EMBED] Embedding request failed:', err.message);
      return null;
    }
  }

  _httpGet(urlStr) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { _log.debug('[catch] JSON parse:', _e.message); reject(new Error('Invalid JSON')); }
        });
      });
      req.setTimeout(TIMEOUTS.EMBEDDING_LOCAL, () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
    });
  }

  _httpPost(urlStr, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(urlStr);
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (_e) { _log.debug('[catch] JSON parse:', _e.message); reject(new Error('Invalid JSON')); }
        });
      });
      req.setTimeout(TIMEOUTS.EMBEDDING_REMOTE, () => { req.destroy(); reject(new Error('Timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _hash(text) {
    // Simple fast hash for cache keys
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h + text.charCodeAt(i)) | 0;
    }
    return h.toString(36);
  }

  // ── v3.8.0: Boot-time auto-init ──────────────────────────
  // Called by Container.bootAll(). Absorbs the manual init + wiring
  // previously in AgentCore._resolveAndInit():
  //   - init() (probe Ollama for embedding model)
  //   - setEmbeddingService() on memory + knowledgeGraph
  // _memory and _knowledgeGraph are set by the manifest factory.

  /** @internal Called by Container.bootAll() */
  async asyncLoad() {
    try {
      await this.init();
      if (this.isAvailable()) {
        // @ts-ignore — genuine TS error, fix requires type widening
        if (/** @type {any} */ (this)._memory) this._memory.setEmbeddingService(this);
        // @ts-ignore — genuine TS error, fix requires type widening
        if (/** @type {any} */ (this)._knowledgeGraph) this._knowledgeGraph.setEmbeddingService(this);
        _log.info(`  [+] Embeddings: ${this.model} (${this.dimensions}d)`);
      }
    } catch (err) {
      _log.debug('  [+] Embeddings: not available -', err.message);
    }
  }
}

module.exports = { EmbeddingService };
