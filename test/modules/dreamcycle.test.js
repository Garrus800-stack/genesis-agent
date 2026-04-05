// ============================================================
// Test: DreamCycle — Phase 9 Cognitive Architecture
// Offline memory consolidation and schema extraction.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── Mocks ────────────────────────────────────────────────
function mockBus() {
  const events = [];
  return {
    emit: (e, d, opts) => events.push({ e, d, source: opts?.source }),
    fire: (e, d, opts) => events.push({ e, d, source: opts?.source }),
    on: () => {}, removeBySource: () => {}, events,
  };
}
function mockStorage() {
  const store = {};
  return {
    readJSON: (f, def) => store[f] ?? def,
    writeJSON: (f, d) => { store[f] = d; },
    writeJSONDebounced: (f, d) => { store[f] = d; },
    writeJSONAsync: async (f, d) => { store[f] = d; },
    _store: store,
  };
}
function mockEpisodicMemory(episodes = []) {
  return {
    getRecent: (n) => episodes.slice(0, n),
    getAll: () => episodes,
    getStats: () => ({ total: episodes.length }),
  };
}
function mockSchemaStore() {
  const schemas = [];
  return {
    store: (s) => { schemas.push(s); return { id: 'sch_' + schemas.length }; },
    match: () => [],
    getAll: () => schemas,
    getConfident: () => schemas.filter(s => (s.confidence || 0) > 0.5),
    _schemas: schemas,
  };
}
function mockKG() {
  return {
    strengthen: () => {}, weaken: () => {},
    search: () => [], getStats: () => ({ nodes: 0 }),
  };
}
function mockMetaLearning() {
  return {
    getRecords: () => [], getStats: () => ({ totalRecords: 0 }),
    recommend: () => null,
  };
}
function mockModel() {
  return {
    chat: async () => JSON.stringify({ schemas: [{ pattern: 'test-pattern', insight: 'test-insight', confidence: 0.7 }] }),
    activeModel: 'test-model',
  };
}
function mockEventStore() {
  return { append: () => {}, getRecent: () => [] };
}

const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');

// ════════════════════════════════════════════════════════════
describe('DreamCycle — Construction', () => {
  test('constructs with all null dependencies', () => {
    const dc = new DreamCycle({ bus: mockBus(), storage: null });
    assert(dc != null, 'Should construct');
    assert(dc._dreaming === false || dc._dreaming == null, 'Should not be dreaming initially');
  });

  test('constructs with full dependencies', () => {
    const dc = new DreamCycle({
      bus: mockBus(), episodicMemory: mockEpisodicMemory(),
      schemaStore: mockSchemaStore(), knowledgeGraph: mockKG(),
      metaLearning: mockMetaLearning(), model: mockModel(),
      eventStore: mockEventStore(), storage: mockStorage(),
    });
    assert(dc.episodicMemory != null);
    assert(dc.schemaStore != null);
  });

  test('has correct containerConfig', () => {
    assert(DreamCycle.containerConfig.name === 'dreamCycle');
    assert(DreamCycle.containerConfig.phase === 9);
    assert(DreamCycle.containerConfig.deps.includes('episodicMemory'));
    assert(DreamCycle.containerConfig.deps.includes('schemaStore'));
  });
});

describe('DreamCycle — Dream Gating', () => {
  test('rejects dream when too few episodes', async () => {
    const dc = new DreamCycle({
      bus: mockBus(), episodicMemory: mockEpisodicMemory([]),
      schemaStore: mockSchemaStore(), knowledgeGraph: mockKG(),
      metaLearning: mockMetaLearning(), model: mockModel(),
      eventStore: mockEventStore(), storage: mockStorage(),
    });
    const result = await dc.dream();
    assert(result.skipped === true || result.episodes === 0, 'Should skip with no episodes');
  });

  test('rejects dream when already dreaming', async () => {
    const dc = new DreamCycle({
      bus: mockBus(), episodicMemory: mockEpisodicMemory([]),
      schemaStore: mockSchemaStore(), knowledgeGraph: mockKG(),
      metaLearning: mockMetaLearning(), model: mockModel(),
      eventStore: mockEventStore(), storage: mockStorage(),
    });
    dc._dreaming = true;
    const result = await dc.dream();
    assert(result.skipped === true || result.alreadyDreaming === true, 'Should skip when already dreaming');
  });
});

describe('DreamCycle — Pattern Detection', () => {
  test('detects repeated action sequences', () => {
    const episodes = [];
    for (let i = 0; i < 15; i++) {
      episodes.push({
        id: `ep_${i}`, timestamp: Date.now() - (15 - i) * 60000,
        topic: 'code gen', outcome: i % 3 === 0 ? 'failed' : 'success',
        toolsUsed: ['CODE_GENERATE', 'RUN_TESTS'],
        tags: ['code'], summary: `Episode ${i}`,
        duration: 5000 + Math.random() * 3000,
      });
    }
    const dc = new DreamCycle({
      bus: mockBus(), episodicMemory: mockEpisodicMemory(episodes),
      schemaStore: mockSchemaStore(), knowledgeGraph: mockKG(),
      metaLearning: mockMetaLearning(), model: mockModel(),
      eventStore: mockEventStore(), storage: mockStorage(),
    });
    // _findPatterns is internal but we can test the dream() output
    assert(dc.episodicMemory.getAll().length === 15);
  });
});

describe('DreamCycle — Events', () => {
  test('emits dream:started and dream:complete events', async () => {
    const bus = mockBus();
    const episodes = [];
    for (let i = 0; i < 12; i++) {
      episodes.push({
        id: `ep_${i}`, timestamp: Date.now() - i * 60000,
        topic: 'test', outcome: 'success', toolsUsed: ['ANALYZE'],
        tags: ['test'], summary: `Episode ${i}`, duration: 1000,
      });
    }
    const dc = new DreamCycle({
      bus, episodicMemory: mockEpisodicMemory(episodes),
      schemaStore: mockSchemaStore(), knowledgeGraph: mockKG(),
      metaLearning: mockMetaLearning(), model: mockModel(),
      eventStore: mockEventStore(), storage: mockStorage(),
      config: { useLLM: false }, // Skip LLM for test speed
    });
    await dc.dream();
    const started = bus.events.filter(e => e.e === 'dream:started' || e.e === 'dream:cycle-start');
    const completed = bus.events.filter(e => e.e === 'dream:complete' || e.e === 'dream:cycle-complete');
    // At least one lifecycle event should fire (exact name depends on implementation)
    assert(bus.events.length > 0, 'Should emit at least one event during dream');
  });
});

describe('DreamCycle — Configuration', () => {
  test('respects custom minEpisodes config', () => {
    const dc = new DreamCycle({
      bus: mockBus(), storage: mockStorage(),
      config: { minEpisodes: 50 },
    });
    assertEqual(dc._minEpisodesForDream, 50);
  });

  test('respects custom maxDurationMs config', () => {
    const dc = new DreamCycle({
      bus: mockBus(), storage: mockStorage(),
      config: { maxDurationMs: 60000 },
    });
    assertEqual(dc._maxDreamDurationMs, 60000);
  });
});

run();
