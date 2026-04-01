// ============================================================
// Test: UnifiedMemory.js — Multi-store recall, ranking, dedup
// ============================================================
let passed = 0, failed = 0;
const failures = [];

function test(name, fn) {
  // v3.5.2: Fixed — try/catch around fn() for sync errors
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(() => {
        passed++; console.log(`    ✅ ${name}`);
      }).catch(err => {
        failed++; failures.push({ name, error: err.message });
        console.log(`    ❌ ${name}: ${err.message}`);
      });
    }
    passed++; console.log(`    ✅ ${name}`);
  } catch (err) {
    failed++; failures.push({ name, error: err.message });
    console.log(`    ❌ ${name}: ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }

const { UnifiedMemory } = require('../../src/agent/hexagonal/UnifiedMemory');

function createMockUM(overrides = {}) {
  return new UnifiedMemory({
    memory: {
      recallEpisodes: (q, limit) => overrides.episodes || [
        { id: 'ep1', summary: 'Discussed React hooks', topics: ['react'], score: 0.8, turnCount: 5 },
        { id: 'ep2', summary: 'Talked about Node.js', topics: ['node'], score: 0.6, turnCount: 3 },
      ],
      recallEpisodesAsync: async (q, limit) => overrides.episodes || [
        { id: 'ep1', summary: 'Discussed React hooks', topics: ['react'], score: 0.8, turnCount: 5 },
      ],
      db: {
        semantic: overrides.semantic || {
          'user.name': { value: 'Garrus', confidence: 0.9, learned: '2025-01-01' },
          'user.language': { value: 'German', confidence: 0.8, learned: '2025-01-01' },
          'project.name': { value: 'Genesis', confidence: 0.95, learned: '2025-01-15' },
        },
      },
      getStats: () => ({ episodes: 10 }),
      storeFact: (k, v, c) => {},
    },
    knowledgeGraph: {
      search: (q, limit) => overrides.kgResults || [
        { node: { id: 'react', label: 'React', type: 'technology', properties: {} }, score: 0.7 },
      ],
      getNeighbors: (id) => overrides.kgNeighbors || [
        { node: { id: 'hooks', label: 'hooks', type: 'concept' }, edge: { relation: 'uses' } },
      ],
      connect: () => 'edge_1',
      getStats: () => ({ nodes: 5, edges: 3 }),
    },
    embeddingService: overrides.embeddings || null,
    eventStore: { append: () => {} },
  });
}

console.log('\n  📦 UnifiedMemory');

async function runAsync() {

  // ── Basic Recall ──────────────────────────────────────────

  await test('recall returns results from all sources', async () => {
    const um = createMockUM();
    const results = await um.recall('React hooks');
    assert(results.length > 0, 'Should return results');
    const sources = new Set(results.map(r => r.source));
    assert(sources.has('episodic'), 'Should include episodic');
    assert(sources.has('knowledge'), 'Should include knowledge graph');
  });

  await test('recall results are sorted by score (descending)', async () => {
    const um = createMockUM();
    const results = await um.recall('React');
    for (let i = 1; i < results.length; i++) {
      assert(results[i].score <= results[i - 1].score,
        `Results not sorted: ${results[i - 1].score} then ${results[i].score}`);
    }
  });

  await test('recall respects limit parameter', async () => {
    const um = createMockUM();
    const results = await um.recall('test', { limit: 2 });
    assert(results.length <= 2, `Expected <=2, got ${results.length}`);
  });

  await test('recall filters by minScore', async () => {
    const um = createMockUM();
    const results = await um.recall('test', { minScore: 0.9 });
    for (const r of results) {
      assert(r.score >= 0.9, `Score ${r.score} below minScore 0.9`);
    }
  });

  // ── Source Filtering ──────────────────────────────────────

  await test('recall with sources filter only queries selected stores', async () => {
    const um = createMockUM();
    const results = await um.recall('test', { sources: ['episodic'] });
    for (const r of results) {
      assert(r.source === 'episodic', `Expected only episodic, got ${r.source}`);
    }
  });

  await test('recall with sources=["semantic"] returns only facts', async () => {
    const um = createMockUM();
    const results = await um.recall('Garrus', { sources: ['semantic'] });
    assert(results.length > 0, 'Should find semantic facts');
    assert(results.every(r => r.source === 'semantic'));
  });

  // ── Semantic Fact Search ──────────────────────────────────

  await test('_searchSemanticFacts finds matching keys', () => {
    const um = createMockUM();
    const results = um._searchSemanticFacts('name Garrus');
    assert(results.length > 0, 'Should find name fact');
    assert(results.some(r => r.key === 'user.name'));
  });

  await test('_searchSemanticFacts returns empty for no match', () => {
    const um = createMockUM();
    const results = um._searchSemanticFacts('xyzzyfoobar');
    assert(results.length === 0, 'Should find nothing');
  });

  // ── Context Block ─────────────────────────────────────────

  await test('buildContextBlock returns formatted string', async () => {
    const um = createMockUM();
    const block = await um.buildContextBlock('What do I know about React?');
    assert(typeof block === 'string');
    assert(block.length > 0, 'Should produce non-empty context');
  });

  await test('buildContextBlock respects token budget', async () => {
    const um = createMockUM();
    const block = await um.buildContextBlock('test', 50);
    // 50 tokens ≈ 175 chars
    assert(block.length < 300, `Expected <300 chars for 50 token budget, got ${block.length}`);
  });

  await test('buildContextBlock returns empty for no results', async () => {
    const um = createMockUM({ episodes: [], kgResults: [], semantic: {} });
    const block = await um.buildContextBlock('nonexistent topic');
    assert(block === '' || block.length < 10, 'Should be empty for no results');
  });

  // ── Cache ─────────────────────────────────────────────────

  await test('recall caches results', async () => {
    let callCount = 0;
    const um = createMockUM({
      episodes: [{ id: 'ep', summary: 'cached', score: 0.5, topics: [] }],
    });
    const origRecall = um.memory.recallEpisodes;
    um.memory.recallEpisodes = (q, l) => { callCount++; return origRecall(q, l); };

    await um.recall('cache test');
    await um.recall('cache test'); // Should hit cache
    assert(callCount === 1, `Expected 1 memory call (cached), got ${callCount}`);
  });

  await test('clearCache removes cached entries', async () => {
    const um = createMockUM();
    await um.recall('test');
    assert(um._cache.size > 0);
    um.clearCache();
    assert(um._cache.size === 0);
  });

  // ── storeFact ─────────────────────────────────────────────

  await test('storeFact writes to both memory and KG', () => {
    let memoryWritten = false;
    let kgConnected = false;
    const um = createMockUM();
    um.memory.storeFact = () => { memoryWritten = true; };
    um.kg.connect = () => { kgConnected = true; return 'e1'; };

    um.storeFact('user.hobby', 'coding', 0.9);
    assert(memoryWritten, 'Should write to memory');
    assert(kgConnected, 'Should connect in KG');
  });

  // ── Stats ─────────────────────────────────────────────────

  await test('getStats returns combined statistics', () => {
    const um = createMockUM();
    const stats = um.getStats();
    assert(typeof stats.episodic === 'object');
    assert(typeof stats.knowledge === 'object');
    assert(typeof stats.weights === 'object');
  });

  // ── Error Resilience ──────────────────────────────────────

  await test('recall succeeds even if KG throws', async () => {
    const um = createMockUM();
    um.kg.search = () => { throw new Error('KG down'); };
    const results = await um.recall('test');
    // Should still return episodic + semantic results
    assert(results.length > 0, 'Should have results from other sources');
  });

  await test('recall succeeds even if memory throws', async () => {
    const um = createMockUM();
    um.memory.recallEpisodes = () => { throw new Error('Memory corrupted'); };
    const results = await um.recall('test');
    // Should still return KG + semantic results
    assert(Array.isArray(results));
  });
}

runAsync().then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) failures.forEach(f => console.log(`    FAIL: ${f.name} — ${f.error}`));
  process.exit(failed > 0 ? 1 : 0);
});
