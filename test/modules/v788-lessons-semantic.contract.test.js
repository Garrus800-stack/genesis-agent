// ============================================================
// GENESIS — test/modules/v788-lessons-semantic.contract.test.js
// Contract test for v7.8.8 semantic-recall in LessonsStore:
//   • Embedding component in _scoreRelevance with floor τ=0.6
//   • Cross-category dampening (only when category requested)
//   • effective_confidence multiplier (sampleSize × confidence)
//   • Quarantine at contradicted ≥ 3 && confirmed ≤ 1
//   • recall(null, ...) routing through embedding instead of category
//   • Lazy embed-on-first-retrieve (fire-and-forget, sync recall)
//   • embedding:ready listener backfill
//   • record() writes embedding=null synchronously
//   • Regression: behavior preserved when embeddings absent
//   • Integration: shell-success lesson surfaces in plan-context
// Every test name carries `lessons-v788 contract:` prefix.
// ============================================================

'use strict';

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { LessonsStore } = require(path.join(ROOT, 'src/agent/cognitive/LessonsStore'));

// ── Helpers ───────────────────────────────────────────────

function makeBus() {
  const subs = new Map();
  return {
    on: (event, fn) => {
      if (!subs.has(event)) subs.set(event, new Set());
      subs.get(event).add(fn);
      return () => subs.get(event).delete(fn);
    },
    fire: (event, data) => {
      const set = subs.get(event);
      if (set) for (const fn of set) try { fn(data); } catch (_e) {}
    },
    emit: function () { return this.fire.apply(this, arguments); },
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-lessons-v788-'));
}

function cleanup(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

// Mock EmbeddingService — synchronous embed for deterministic tests.
// Embeds text into a small fixed-dimension vector based on token hashing.
function mockEmbeddingService(opts = {}) {
  const available = opts.available !== false;
  const calls = { embed: 0, embedBatch: 0, isAvailable: 0 };
  function embedSync(text) {
    if (!text) return null;
    // Simple deterministic 8-d vector: token-based bag-of-features.
    // Identical strings → identical vectors → cosine = 1.
    const tokens = String(text).toLowerCase().split(/\s+/).filter(Boolean);
    const vec = new Array(8).fill(0);
    for (const tok of tokens) {
      let h = 0;
      for (let i = 0; i < tok.length; i++) h = ((h << 5) - h + tok.charCodeAt(i)) | 0;
      const idx = Math.abs(h) % 8;
      vec[idx] += 1;
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return mag > 0 ? vec.map(v => v / mag) : vec;
  }
  return {
    isAvailable: () => { calls.isAvailable++; return available; },
    embed: async (text) => { calls.embed++; return embedSync(text); },
    embedBatch: async (texts) => { calls.embedBatch++; return texts.map(embedSync); },
    cosineSimilarity: (a, b) => {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
      return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
    },
    _calls: calls,
    _embedSync: embedSync,
  };
}

function makeStore(opts = {}) {
  return new LessonsStore({
    bus: opts.bus || makeBus(),
    globalDir: opts.globalDir || tmpDir(),
    embeddingService: opts.embeddingService || null,
    intervalManager: opts.intervalManager || null,
    config: opts.config || {},
  });
}

// Wait helper for fire-and-forget promises
function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Tests ─────────────────────────────────────────────────

describe('lessons-v788 contract: record writes embedding=null synchronously', () => {

  test('lessons-v788 contract: record() does NOT block on embed and stores embedding=null initially', async () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    const id = store.record({ category: 'shell-success', insight: 'cmd npm install works on Windows', source: 'test' });
    const lesson = store._lessons.find(l => l.id === id);
    assert(lesson, 'lesson stored');
    assertEqual(lesson.embedding, null, 'embedding initialized to null');
    assertEqual(lesson.quarantined, false, 'quarantined initialized to false');
    assertEqual(emb._calls.embed, 0, 'no synchronous embed call during record()');
  });

});

describe('lessons-v788 contract: _scoreRelevance embedding component', () => {

  test('lessons-v788 contract: embedding cosine ≥ 0.6 boosts score; identical text → high relevance', () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    const text = 'configure ssl certificate for nginx';
    const lesson = { id: 'l1', category: 'deployment', insight: text, evidence: { confidence: 0.8, sampleSize: 5 }, tags: [], embedding: emb._embedSync(text), lastUsed: Date.now(), useCount: 0 };
    const ctx = { queryEmbedding: emb._embedSync(text) };
    const score = store._scoreRelevance(lesson, null, ctx);
    assert(score > 0.5, `identical-text embedding should produce score > 0.5, got ${score}`);
  });

  test('lessons-v788 contract: embedding cosine < 0.6 contributes 0 (floor τ=0.6)', () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    const lesson = { id: 'l1', category: 'general', insight: 'apple banana cherry', evidence: { confidence: 0.5, sampleSize: 1 }, tags: [], embedding: emb._embedSync('apple banana cherry'), lastUsed: Date.now(), useCount: 0 };
    // Use orthogonal-ish text
    const ctx = { queryEmbedding: emb._embedSync('quantum entanglement collider physics') };
    const score = store._scoreRelevance(lesson, null, ctx);
    // No category match, no tags, no model — only confidence boost (0.05) + recency (0.1)
    assert(score < 0.25, `below-floor embedding should not contribute, got score ${score}`);
  });

  test('lessons-v788 contract: cross-category dampening ×0.7 only when category requested', () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    const text = 'compile typescript with strict mode';
    const lesson = { id: 'l1', category: 'code-gen', insight: text, evidence: { confidence: 1.0, sampleSize: 100 }, tags: [], embedding: emb._embedSync(text), lastUsed: Date.now(), useCount: 0 };
    const ctx = { queryEmbedding: emb._embedSync(text) };
    // category=null → no dampening
    const scoreNoCat = store._scoreRelevance(lesson, null, ctx);
    // category='debug' (mismatch) → dampening
    const scoreMismatch = store._scoreRelevance(lesson, 'debug', ctx);
    assert(scoreNoCat > scoreMismatch, `null category should yield higher score than mismatch: ${scoreNoCat} vs ${scoreMismatch}`);
  });

  test('lessons-v788 contract: effective_confidence reduces embedding contribution for low sampleSize', () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    const text = 'restart redis after config change';
    const baseLesson = { id: 'l', category: 'deployment', insight: text, tags: [], embedding: emb._embedSync(text), lastUsed: Date.now(), useCount: 0 };
    const ctx = { queryEmbedding: emb._embedSync(text) };
    const lowSample = { ...baseLesson, evidence: { confidence: 0.5, sampleSize: 1 } };
    const highSample = { ...baseLesson, evidence: { confidence: 0.5, sampleSize: 10 } };
    const sLow = store._scoreRelevance(lowSample, null, ctx);
    const sHigh = store._scoreRelevance(highSample, null, ctx);
    assert(sHigh > sLow, `high sampleSize should score higher than low: ${sHigh} vs ${sLow}`);
  });

});

describe('lessons-v788 contract: recall accepts category=null', () => {

  test('lessons-v788 contract: recall(null, {query}, 5) ranks across all categories via embedding', async () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    // Pre-populate with diverse categories, embeddings set
    const insights = [
      ['shell-success', 'npm install updates package json on Windows'],
      ['dream-insight', 'build artifacts grow unnoticed in dist folder'],
      ['general', 'completely unrelated philosophical musing'],
    ];
    for (const [cat, ins] of insights) {
      const id = store.record({ category: cat, insight: ins, source: 'test' });
      const l = store._lessons.find(x => x.id === id);
      l.embedding = emb._embedSync(ins);
    }
    // Query semantically close to first lesson, no category hint
    const results = store.recall(null, { query: 'npm install package json windows', queryEmbedding: emb._embedSync('npm install package json windows') }, 5);
    assert(results.length >= 1, 'recall returned at least one result');
    assertEqual(results[0].category, 'shell-success', 'top match comes from semantically closest lesson regardless of category');
  });

});

describe('lessons-v788 contract: quarantine', () => {

  test('lessons-v788 contract: updateLessonOutcome quarantines at contradicted≥3 && confirmed≤1', () => {
    const bus = makeBus();
    let quarantineFired = null;
    bus.on('lesson:quarantined', (data) => { quarantineFired = data; });
    const store = makeStore({ bus });
    const id = store.record({ category: 'debug', insight: 'use sudo for failed installs', source: 'test' });
    // Three contradictions, no confirmations
    store.updateLessonOutcome(id, false);
    store.updateLessonOutcome(id, false);
    store.updateLessonOutcome(id, false);
    const lesson = store._lessons.find(l => l.id === id);
    assertEqual(lesson.quarantined, true, 'lesson flagged as quarantined');
    assert(quarantineFired != null, 'lesson:quarantined event fired');
    assertEqual(quarantineFired.id, id);
  });

  test('lessons-v788 contract: quarantined lessons are filtered out of recall()', () => {
    const store = makeStore();
    const id1 = store.record({ category: 'debug', insight: 'try restarting the service first', source: 'test' });
    const id2 = store.record({ category: 'debug', insight: 'check the proxy configuration', source: 'other' });
    assert(id1 !== id2, 'distinct lessons stored (no dedup merge)');
    // Quarantine id2
    store.updateLessonOutcome(id2, false);
    store.updateLessonOutcome(id2, false);
    store.updateLessonOutcome(id2, false);
    const results = store.recall('debug', { query: 'debugging' }, 10);
    const ids = results.map(r => r.id);
    assert(ids.includes(id1), 'good lesson recalled');
    assert(!ids.includes(id2), 'quarantined lesson excluded');
  });

  test('lessons-v788 contract: lesson with confirmed≥2 NOT quarantined even at contradicted=3', () => {
    const store = makeStore();
    const id = store.record({ category: 'debug', insight: 'context-dependent lesson', source: 'test' });
    store.updateLessonOutcome(id, true);
    store.updateLessonOutcome(id, true);
    store.updateLessonOutcome(id, false);
    store.updateLessonOutcome(id, false);
    store.updateLessonOutcome(id, false);
    const lesson = store._lessons.find(l => l.id === id);
    assertEqual(lesson.quarantined, false, 'lesson with confirmed≥2 is not quarantined');
  });

});

describe('lessons-v788 contract: backfill and lazy embed', () => {

  test('lessons-v788 contract: _scheduleBackfillTick embeds pending lessons via embedBatch', async () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    store.record({ category: 'shell-success', insight: 'command A works', source: 'test' });
    store.record({ category: 'shell-success', insight: 'command B works', source: 'test' });
    // Trigger backfill
    store._scheduleBackfillTick();
    await waitMs(20); // allow promise to resolve
    const all = store._lessons;
    assert(all.every(l => Array.isArray(l.embedding) && l.embedding.length > 0), 'all lessons embedded after backfill');
    assertEqual(emb._calls.embedBatch, 1, 'embedBatch called exactly once');
  });

  test('lessons-v788 contract: lazy embed-on-first-retrieve fills missing embedding fire-and-forget', async () => {
    const emb = mockEmbeddingService();
    const store = makeStore({ embeddingService: emb });
    store.record({ category: 'general', insight: 'lazy lesson example here', source: 'test' });
    const lessonBefore = store._lessons[0];
    assertEqual(lessonBefore.embedding, null);
    // Trigger recall which has a query → lazy embed scheduled (fire-and-forget)
    store.recall(null, { query: 'lazy lesson example here' }, 5);
    await waitMs(20);
    const lessonAfter = store._lessons[0];
    assert(Array.isArray(lessonAfter.embedding) && lessonAfter.embedding.length > 0, 'embedding populated after recall + tick');
  });

});

describe('lessons-v788 contract: regression — behavior preserved without embeddings', () => {

  test('lessons-v788 contract: pre-v7.8.8 behavior preserved when no embeddingService present', () => {
    const store = makeStore();   // no embeddingService
    const id = store.record({ category: 'code-gen', insight: 'avoid let inside for loop', source: 'test' });
    const lesson = store._lessons.find(l => l.id === id);
    assertEqual(lesson.embedding, null);
    // recall with category — category-match boost (+0.4) drives result
    const results = store.recall('code-gen', { query: 'something' }, 5);
    assert(results.length === 1, 'category match still works without embeddings');
  });

});

if (require.main === module) run();
