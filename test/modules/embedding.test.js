// Test: EmbeddingService.js — cosine similarity, cache, findSimilar, fallback
const path = require('path');

let passed = 0, failed = 0;
function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; (typeof failures !== "undefined" ? failures : []).push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; (typeof failures !== "undefined" ? failures : []).push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { EmbeddingService } = require('../../src/agent/foundation/EmbeddingService');

console.log('\n  📦 EmbeddingService');

async function runTests() {
  // ── cosineSimilarity ───────────────────────────────────

  test('cosineSimilarity returns 1 for identical vectors', () => {
    const emb = new EmbeddingService();
    const vec = [1, 2, 3, 4, 5];
    const sim = emb.cosineSimilarity(vec, vec);
    assert(Math.abs(sim - 1.0) < 0.0001, `Expected ~1.0, got ${sim}`);
  });

  test('cosineSimilarity returns 0 for orthogonal vectors', () => {
    const emb = new EmbeddingService();
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    const sim = emb.cosineSimilarity(a, b);
    assert(Math.abs(sim) < 0.0001, `Expected ~0, got ${sim}`);
  });

  test('cosineSimilarity handles null/mismatched gracefully', () => {
    const emb = new EmbeddingService();
    assert(emb.cosineSimilarity(null, [1, 2]) === 0, 'null input should return 0');
    assert(emb.cosineSimilarity([1], [1, 2]) === 0, 'mismatched lengths should return 0');
    assert(emb.cosineSimilarity([], []) === 0, 'empty vectors should return 0');
  });

  // ── findSimilar ────────────────────────────────────────

  test('findSimilar returns ranked results', () => {
    const emb = new EmbeddingService();
    const query = [1, 0, 0];
    const items = [
      { vec: [1, 0, 0], data: 'exact' },
      { vec: [0.9, 0.1, 0], data: 'close' },
      { vec: [0, 1, 0], data: 'orthogonal' },
      { vec: [0.5, 0.5, 0], data: 'mid' },
    ];
    const results = emb.findSimilar(query, items, 3);
    assert(results.length >= 2, `Expected ≥2 results, got ${results.length}`);
    assert(results[0].data === 'exact', `Expected 'exact' first, got '${results[0].data}'`);
    assert(results[0].similarity > results[1].similarity, 'Results should be sorted by similarity');
  });

  test('findSimilar returns empty for null query', () => {
    const emb = new EmbeddingService();
    const results = emb.findSimilar(null, [{ vec: [1, 0], data: 'x' }]);
    assert(results.length === 0, 'Should return empty for null query');
  });

  // ── embed fallback (no Ollama) ─────────────────────────

  await test('embed returns null when Ollama unavailable', async () => {
    const emb = new EmbeddingService('http://127.0.0.1:99999');
    // Don't call init — simulates unavailable
    assert(emb.isAvailable() === false, 'Should be unavailable');
    const result = await emb.embed('test text');
    assert(result === null, 'Should return null without init');
  });

  // ── getStats ───────────────────────────────────────────

  test('getStats reports correct initial state', () => {
    const emb = new EmbeddingService();
    const stats = emb.getStats();
    assert(stats.available === false, 'Should be unavailable initially');
    assert(stats.model === null, 'No model initially');
    assert(stats.dimensions === 0, 'Zero dimensions initially');
    assert(stats.cacheSize === 0, 'Empty cache initially');
  });

  // ── embedBatch ─────────────────────────────────────────

  await test('embedBatch returns nulls when unavailable', async () => {
    const emb = new EmbeddingService('http://127.0.0.1:99999');
    const results = await emb.embedBatch(['hello', 'world', 'test']);
    assert(results.length === 3, `Expected 3 results, got ${results.length}`);
    assert(results.every(r => r === null), 'All should be null');
  });

  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error(err); process.exit(1); });
