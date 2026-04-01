#!/usr/bin/env node
// ============================================================
// Test: MemoryFacade.js — Unified memory query + store
// v4.13.1 (Audit P3)
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { MemoryFacade } = require('../../src/agent/hexagonal/MemoryFacade');

// ── Mock Memory Backends ──────────────────────────────────

const mockUnified = {
  recall: async (query, opts) => [
    { source: 'episodic', score: 0.9, content: `unified result for: ${query}` },
    { source: 'knowledge', score: 0.7, content: 'known fact' },
  ],
};

const mockEpisodic = {
  recall: async (query, opts) => [
    { relevance: 0.8, summary: 'episodic result', timestamp: Date.now() },
  ],
  record: (content, meta) => {},
};

const mockVector = {
  search: async (query, limit) => [
    { score: 0.85, text: 'vector result', meta: { type: 'fact' } },
  ],
  index: async (content, meta) => {},
};

const mockKG = {
  addFact: (content, meta) => {},
};

const mockConversation = {
  add: (role, content) => {},
};

// ── Tests ─────────────────────────────────────────────────

describe('MemoryFacade — Construction', () => {
  test('constructs without backends', () => {
    const mf = new MemoryFacade();
    assert(mf, 'should construct');
    assertEqual(mf._stats.queries, 0);
  });

  test('getStats reports no active backends when unbound', () => {
    const mf = new MemoryFacade();
    const stats = mf.getStats();
    assertEqual(stats.activeCount, 0);
    assertEqual(stats.backends.unified, false);
  });
});

describe('MemoryFacade — Recall', () => {
  test('recall from unified backend', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = mockUnified;
    const results = await mf.recall('test query');
    assert(results.length >= 2, 'should have unified results');
    assertEqual(mf._stats.queries, 1);
    assertEqual(mf._stats.backendHits.unified, 1);
  });

  test('recall from multiple backends', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = mockUnified;
    mf.vectorMemory = mockVector;
    mf.episodicMemory = mockEpisodic;
    const results = await mf.recall('multi query');
    assert(results.length >= 3, `Expected >=3 results, got ${results.length}`);
  });

  test('recall handles backend failure gracefully', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = { recall: async () => { throw new Error('crash'); } };
    mf.vectorMemory = mockVector;
    const results = await mf.recall('error test');
    assert(results.length >= 1, 'should still have vector results');
  });

  test('recall respects limit', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = mockUnified;
    mf.vectorMemory = mockVector;
    mf.episodicMemory = mockEpisodic;
    const results = await mf.recall('limited', { limit: 2 });
    assert(results.length <= 2, `Expected <=2, got ${results.length}`);
  });

  test('recall with no backends returns empty', async () => {
    const mf = new MemoryFacade();
    const results = await mf.recall('nothing');
    assertEqual(results.length, 0);
  });

  test('results sorted by score descending', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = mockUnified;
    mf.vectorMemory = mockVector;
    const results = await mf.recall('sorted');
    for (let i = 1; i < results.length; i++) {
      assert(results[i - 1].score >= results[i].score,
        `Score at ${i - 1} (${results[i - 1].score}) should >= score at ${i} (${results[i].score})`);
    }
  });

  test('deduplication removes identical content', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = {
      recall: async () => [
        { source: 'a', score: 0.9, content: 'duplicate content here' },
        { source: 'b', score: 0.8, content: 'duplicate content here' },
      ],
    };
    const results = await mf.recall('dedup');
    assertEqual(results.length, 1);
  });
});

describe('MemoryFacade — Store', () => {
  test('store fact routes to KnowledgeGraph', async () => {
    let stored = false;
    const mf = new MemoryFacade();
    mf.knowledgeGraph = { addFact: () => { stored = true; } };
    const result = await mf.store('test fact', 'fact');
    assert(stored, 'should have called KG.addFact');
    assert(result.stored.includes('knowledgeGraph'));
  });

  test('store episode routes to EpisodicMemory', async () => {
    let stored = false;
    const mf = new MemoryFacade();
    mf.episodicMemory = { record: () => { stored = true; } };
    const result = await mf.store('test episode', 'episode');
    assert(stored, 'should have called episodic.record');
  });

  test('store message routes to ConversationMemory', async () => {
    let stored = false;
    const mf = new MemoryFacade();
    mf.conversationMemory = { add: () => { stored = true; } };
    const result = await mf.store('test message', 'message');
    assert(stored, 'should have called conversation.add');
  });

  test('store also indexes in VectorMemory when content long enough', async () => {
    let vectored = false;
    const mf = new MemoryFacade();
    mf.knowledgeGraph = mockKG;
    mf.vectorMemory = { index: async () => { vectored = true; } };
    await mf.store('a fact that is long enough to be indexed in vector', 'fact');
    assert(vectored, 'should have indexed in vector');
  });

  test('store with missing backend does not throw', async () => {
    const mf = new MemoryFacade();
    const result = await mf.store('nothing to store', 'fact');
    assertEqual(result.stored.length, 0);
  });
});

describe('MemoryFacade — Stats', () => {
  test('stats track queries and stores', async () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = mockUnified;
    await mf.recall('q1');
    await mf.recall('q2');
    await mf.store('s1', 'message');
    const stats = mf.getStats();
    assertEqual(stats.queries, 2);
    assertEqual(stats.stores, 1);
  });

  test('activeCount reflects bound backends', () => {
    const mf = new MemoryFacade();
    mf.unifiedMemory = mockUnified;
    mf.vectorMemory = mockVector;
    const stats = mf.getStats();
    assertEqual(stats.activeCount, 2);
    assertEqual(stats.backends.unified, true);
    assertEqual(stats.backends.vector, true);
    assertEqual(stats.backends.episodic, false);
  });
});

run();
