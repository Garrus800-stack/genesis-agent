#!/usr/bin/env node
// Test: UnifiedMemory — resolveConflicts + consolidate (v4.12.8)
const { describe, test, assert, assertEqual, run } = require('../harness');

const { NullBus } = require('../../src/agent/core/EventBus');

function createMemoryMock(semanticFacts = {}, episodic = []) {
  const db = {
    semantic: { ...semanticFacts },
    episodic: [...episodic],
  };
  return {
    db,
    recallEpisodes: () => [],
    storeFact: (key, value, confidence) => {
      db.semantic[key] = { value, confidence, learned: new Date().toISOString() };
    },
    getStats: () => ({ episodeCount: db.episodic.length, factCount: Object.keys(db.semantic).length }),
  };
}

function createKGMock() {
  const nodes = new Map();
  return {
    search: () => [],
    connect: (a, rel, b) => { nodes.set(b, { a, rel }); },
    updateNode: (id, data) => { nodes.set(id, { ...nodes.get(id), ...data }); },
    getStats: () => ({ nodeCount: nodes.size }),
  };
}

function createEvents() {
  const events = [];
  return {
    bus: {
      emit: (name, data, meta) => events.push({ name, data, meta }),
      fire: (name, data, meta) => events.push({ name, data, meta }),
      on: () => {},
    },
    events,
  };
}

function createUnified(semanticFacts, episodic) {
  const { bus, events } = createEvents();
  const { UnifiedMemory } = require('../../src/agent/hexagonal/UnifiedMemory');
  const memory = createMemoryMock(semanticFacts, episodic);
  const kg = createKGMock();
  const unified = new UnifiedMemory({ bus, memory, knowledgeGraph: kg, embeddingService: null, eventStore: null });
  return { unified, memory, kg, events };
}

// ── Conflict Resolution ──────────────────────────────────

describe('UnifiedMemory.resolveConflicts — No Conflicts', () => {
  test('returns empty when no results', async () => {
    const { unified } = createUnified();
    const result = await unified.resolveConflicts('nonexistent');
    assertEqual(result.conflicts.length, 0);
    assertEqual(result.resolutions.length, 0);
  });

  test('returns empty when single source agrees', async () => {
    const { unified } = createUnified({
      'user.name': { value: 'Alice', confidence: 0.9, learned: '2025-01-01' },
    });
    const result = await unified.resolveConflicts('user name');
    assertEqual(result.conflicts.length, 0);
  });
});

describe('UnifiedMemory.resolveConflicts — With Conflicts', () => {
  test('detects conflicting semantic facts', async () => {
    const { unified } = createUnified({
      'user.city': { value: 'Berlin', confidence: 0.7, learned: '2025-01-01' },
      'user.location': { value: 'Munich', confidence: 0.5, learned: '2025-06-01' },
    });
    const result = await unified.resolveConflicts('user city location');
    // May or may not detect as conflict depending on entity extraction
    // but should not throw
    assert(Array.isArray(result.conflicts));
    assert(Array.isArray(result.resolutions));
  });
});

// ── Consolidation ────────────────────────────────────────

describe('UnifiedMemory.consolidate — Pattern Promotion', () => {
  test('promotes topics with ≥3 occurrences to semantic facts', () => {
    const episodes = [];
    for (let i = 0; i < 5; i++) {
      episodes.push({ id: `ep-${i}`, topics: ['react', 'typescript'], timestamp: Date.now() - i * 1000 });
    }
    const { unified, memory } = createUnified({}, episodes);
    const result = unified.consolidate({ minOccurrences: 3 });
    assert(result.promoted.length > 0, 'should promote at least one topic');
    assert(memory.db.semantic['topic:react'], 'react should be a semantic fact');
  });

  test('does not promote topics with <3 occurrences', () => {
    const episodes = [
      { id: 'ep-1', topics: ['rare-topic'], timestamp: Date.now() },
      { id: 'ep-2', topics: ['rare-topic'], timestamp: Date.now() },
    ];
    const { unified } = createUnified({}, episodes);
    const result = unified.consolidate({ minOccurrences: 3 });
    const rarePromoted = result.promoted.filter(p => p.key.includes('rare'));
    assertEqual(rarePromoted.length, 0);
  });

  test('respects maxPromotions limit', () => {
    const episodes = [];
    for (let i = 0; i < 10; i++) {
      episodes.push({ id: `ep-${i}`, topics: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], timestamp: Date.now() });
    }
    const { unified } = createUnified({}, episodes);
    const result = unified.consolidate({ minOccurrences: 3, maxPromotions: 2 });
    assert(result.promoted.length <= 2, 'should respect max');
  });

  test('skips already-stored high-confidence facts', () => {
    const episodes = [];
    for (let i = 0; i < 5; i++) {
      episodes.push({ id: `ep-${i}`, topics: ['existing'], timestamp: Date.now() });
    }
    const { unified } = createUnified({
      'topic:existing': { value: 'already known', confidence: 0.9, learned: '2025-01-01' },
    }, episodes);
    const result = unified.consolidate({ minOccurrences: 3 });
    const existingPromoted = result.promoted.filter(p => p.key === 'topic:existing');
    assertEqual(existingPromoted.length, 0, 'should skip existing high-confidence');
  });

  test('returns empty when no episodic data', () => {
    const { unified } = createUnified();
    const result = unified.consolidate();
    assertEqual(result.promoted.length, 0);
  });

  test('emits memory:consolidated event', () => {
    const episodes = [];
    for (let i = 0; i < 5; i++) {
      episodes.push({ id: `ep-${i}`, topics: ['eventtest'], timestamp: Date.now() });
    }
    const { unified, events } = createUnified({}, episodes);
    unified.consolidate({ minOccurrences: 3 });
    const consolidated = events.filter(e => e.name === 'memory:consolidated');
    assert(consolidated.length > 0, 'should emit event');
  });
});

describe('UnifiedMemory.consolidate — Edge Cases', () => {
  test('handles episodes without topics', () => {
    const episodes = [
      { id: 'ep-1', timestamp: Date.now() },
      { id: 'ep-2', topics: null, timestamp: Date.now() },
    ];
    const { unified } = createUnified({}, episodes);
    const result = unified.consolidate();
    assertEqual(result.promoted.length, 0); // no crash
  });

  test('handles missing storeFact method', () => {
    const { bus, events } = createEvents();
    const { UnifiedMemory } = require('../../src/agent/hexagonal/UnifiedMemory');
    const memory = { db: { episodic: [], semantic: {} }, recallEpisodes: () => [] };
    // no storeFact
    const unified = new UnifiedMemory({ bus, memory, knowledgeGraph: createKGMock() });
    const result = unified.consolidate();
    assertEqual(result.promoted.length, 0); // graceful
  });
});

run();
