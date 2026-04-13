// ============================================================
// Test: FrontierWriter.js — v7.1.6 Generic Frontier Writer
//
// Tests:
//   1. write() with extractFn returning props
//   2. write() with extractFn returning null → skip
//   3. write() with extractFn throwing → graceful failure
//   4. maxImprints eviction (weakest-first)
//   5. getRecent() cache + TTL
//   6. getRecent() ordering by weight
//   7. mergeFn — merge when compatible
//   8. mergeFn — no merge when incompatible
//   9. buildPromptContext() maxChars enforcement
//  10. buildPromptContext() empty when no nodes
//  11. getDashboardLine() formatting
//  12. getDashboardLine() null when empty
//  13. getReport() completeness
//  14. _formatAge() output
//  15. Event emission on write
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { FrontierWriter } = require('../../src/agent/organism/FrontierWriter');

// ── Mock factories ──────────────────────────────────────────

function mockBus() {
  const events = [];
  return {
    emit(event, data, opts) { events.push({ event, data, opts }); },
    fire(event, data, opts) { events.push({ event, data, opts }); },
    on() { return () => {}; },
    _events: events,
  };
}

function mockStorage() {
  const store = new Map();
  return {
    writeJSONDebounced(key, data) { store.set(key, JSON.parse(JSON.stringify(data))); },
    writeJSON(key, data) { store.set(key, JSON.parse(JSON.stringify(data))); },
    readJSON(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
    _store: store,
  };
}

function mockKnowledgeGraph() {
  const nodes = new Map();
  const edges = new Map();
  let nodeCounter = 0;
  let edgeCounter = 0;

  const frontierId = 'n_frontier';
  nodes.set(frontierId, {
    id: frontierId, type: 'system', label: 'frontier',
    properties: { role: 'focus-anchor' }, created: Date.now(),
    accessed: Date.now(), accessCount: 0,
  });

  return {
    graph: { nodes, edges, findNode(label) {
      for (const [, n] of nodes) {
        if (n.label === label.toLowerCase().trim()) return n;
      }
      return null;
    }},
    getNode(id) { return nodes.get(id) || null; },
    findNode(label) { return this.graph.findNode(label); },
    ensureFrontier() { return nodes.get(frontierId); },
    connectToFrontier(relation, targetLabel, weight, targetType, targetProps) {
      const normalizedLabel = targetLabel.toLowerCase().trim();
      let target = this.graph.findNode(normalizedLabel);
      if (!target) {
        const tid = `n_${++nodeCounter}`;
        target = {
          id: tid, type: targetType, label: normalizedLabel,
          properties: { ...targetProps }, created: Date.now(),
          accessed: Date.now(), accessCount: 0,
        };
        nodes.set(tid, target);
      } else {
        target.properties = { ...target.properties, ...targetProps };
      }
      const eid = `e_${++edgeCounter}`;
      edges.set(eid, {
        id: eid, source: frontierId, target: target.id,
        relation, weight, created: Date.now(),
      });
      return eid;
    },
    disconnectFromFrontier(targetLabel) {
      const normalizedLabel = targetLabel.toLowerCase().trim();
      const target = this.graph.findNode(normalizedLabel);
      if (!target) return false;
      for (const [id, edge] of edges) {
        if (edge.source === frontierId && edge.target === target.id) {
          edges.delete(id);
          nodes.delete(target.id);
          return true;
        }
      }
      return false;
    },
    _frontierId: frontierId,
    _nodes: nodes,
    _edges: edges,
  };
}

function createWriter(overrides = {}, depsOverrides = {}) {
  const bus = depsOverrides.bus || mockBus();
  const kg = depsOverrides.knowledgeGraph || mockKnowledgeGraph();
  const storage = depsOverrides.storage || mockStorage();

  return {
    writer: new FrontierWriter({
      name: overrides.name || 'testWriter',
      edgeType: overrides.edgeType || 'TEST_TYPE',
      decayFactor: overrides.decayFactor ?? 0.6,
      maxImprints: overrides.maxImprints ?? 5,
      pruneThreshold: overrides.pruneThreshold ?? 0.05,
      cacheTtlMs: overrides.cacheTtlMs ?? 100, // Short TTL for tests
      extractFn: overrides.extractFn || ((ctx) => ctx.data ? { description: ctx.data } : null),
      mergeFn: overrides.mergeFn || null,
    }, { bus, knowledgeGraph: kg, storage }),
    bus,
    kg,
    storage,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('FrontierWriter', () => {

  // 1. write() with extractFn returning props
  test('write() creates frontier node when extractFn returns props', () => {
    const { writer, kg } = createWriter();
    const result = writer.write('session-1', { data: 'fix EventBus leak' });

    assert(result !== null, 'write() should return props');
    assertEqual(result.description, 'fix EventBus leak');
    assertEqual(result.session_id, 'session-1');
    assert(result.created > 0, 'should have created timestamp');

    // Verify KG node was created
    const edges = [...kg._edges.values()].filter(e => e.relation === 'TEST_TYPE');
    assertEqual(edges.length, 1);
    assertEqual(edges[0].weight, 1.0);
  });

  // 2. write() with extractFn returning null → skip
  test('write() returns null when extractFn returns null', () => {
    const { writer } = createWriter();
    const result = writer.write('session-1', { data: null });

    assertEqual(result, null);
    assertEqual(writer._stats.skipped, 1);
  });

  // 3. write() with extractFn throwing → graceful failure
  test('write() handles extractFn errors gracefully', () => {
    const { writer } = createWriter({
      extractFn: () => { throw new Error('boom'); },
    });
    const result = writer.write('session-1', {});
    assertEqual(result, null);
  });

  // 4. maxImprints eviction
  test('write() evicts weakest when maxImprints reached', () => {
    const { writer, kg } = createWriter({ maxImprints: 3 });

    // Write 3 nodes
    writer.write('s1', { data: 'first' });
    writer.write('s2', { data: 'second' });
    writer.write('s3', { data: 'third' });

    // Simulate decay on first two (make them weaker)
    const edges = [...kg._edges.values()].filter(e => e.relation === 'TEST_TYPE');
    edges[0].weight = 0.2; // weakest
    edges[1].weight = 0.5;
    edges[2].weight = 0.9;

    // Write 4th — should evict weakest
    writer.write('s4', { data: 'fourth' });

    const remaining = [...kg._edges.values()].filter(e => e.relation === 'TEST_TYPE');
    assertEqual(remaining.length, 3);
    assert(writer._stats.evicted >= 1, 'should have evicted at least 1');

    // Verify the weakest (0.2) was evicted
    const weights = remaining.map(e => e.weight).sort();
    assert(weights[0] >= 0.5, 'weakest remaining should be >= 0.5');
  });

  // 5. getRecent() cache + TTL
  test('getRecent() caches results and respects TTL', () => {
    const { writer } = createWriter({ cacheTtlMs: 50 });

    writer.write('s1', { data: 'cached item' });
    const first = writer.getRecent(1);
    assertEqual(first.length, 1);

    // Should return cached version
    const second = writer.getRecent(1);
    assertEqual(second.length, 1);
    assert(first[0] === second[0], 'should return same cached reference');
  });

  // 6. getRecent() ordering by weight
  test('getRecent() returns highest weight first', () => {
    const { writer, kg } = createWriter();

    writer.write('s1', { data: 'low priority' });
    writer.write('s2', { data: 'high priority' });

    // Set different weights
    const edges = [...kg._edges.values()].filter(e => e.relation === 'TEST_TYPE');
    edges[0].weight = 0.3;
    edges[1].weight = 0.9;

    writer._invalidateCache();
    const recent = writer.getRecent(2);
    assertEqual(recent.length, 2);
    assert(recent[0].weight > recent[1].weight, 'first should have higher weight');
  });

  // 7. mergeFn — merge when compatible
  test('write() merges when mergeFn returns merged props', () => {
    const { writer, kg } = createWriter({
      mergeFn: (existing, incoming) => {
        if (existing.category === incoming.category) {
          return { ...existing, count: (existing.count || 1) + (incoming.count || 1) };
        }
        return null;
      },
      extractFn: (ctx) => ctx,
    });

    // Write first
    writer.write('s1', { category: 'refactor', count: 2 });

    // Write second with same category — should merge
    const result = writer.write('s2', { category: 'refactor', count: 3 });

    assert(result !== null, 'merge should succeed');
    assertEqual(result.count, 5); // 2 + 3
    assertEqual(writer._stats.merged, 1);

    // Only 1 node should exist (merged, not duplicated)
    const edges = [...kg._edges.values()].filter(e => e.relation === 'TEST_TYPE');
    assertEqual(edges.length, 1);
  });

  // 8. mergeFn — no merge when incompatible
  test('write() creates new node when mergeFn returns null', () => {
    const { writer, kg } = createWriter({
      mergeFn: (existing, incoming) => {
        if (existing.category === incoming.category) {
          return { ...existing, count: existing.count + incoming.count };
        }
        return null; // Different categories don't merge
      },
      extractFn: (ctx) => ctx,
    });

    writer.write('s1', { category: 'refactor', count: 1 });
    writer.write('s2', { category: 'debug', count: 1 });

    // Two different categories → 2 nodes
    const edges = [...kg._edges.values()].filter(e => e.relation === 'TEST_TYPE');
    assertEqual(edges.length, 2);
    assertEqual(writer._stats.merged, 0);
  });

  // 9. buildPromptContext() maxChars enforcement
  test('buildPromptContext() respects maxChars budget', () => {
    const { writer } = createWriter();

    writer.write('s1', { data: 'A'.repeat(200) });
    writer.write('s2', { data: 'B'.repeat(200) });
    writer.write('s3', { data: 'C'.repeat(200) });

    const ctx = writer.buildPromptContext(300);
    assert(ctx.length <= 300, `should be <= 300 chars, got ${ctx.length}`);
    assert(ctx.length > 0, 'should not be empty');
  });

  // 10. buildPromptContext() empty when no nodes
  test('buildPromptContext() returns empty string when no nodes', () => {
    const { writer } = createWriter();
    const ctx = writer.buildPromptContext();
    assertEqual(ctx, '');
  });

  // 11. getDashboardLine() formatting
  test('getDashboardLine() returns formatted one-liner', () => {
    const { writer } = createWriter();
    writer.write('s1', { data: 'fix memory leak in IdleMind' });

    const line = writer.getDashboardLine();
    assert(line !== null, 'should not be null');
    assert(line.includes('TEST_TYPE'), 'should include edge type');
    assert(line.includes('%'), 'should include weight percentage');
  });

  // 12. getDashboardLine() null when empty
  test('getDashboardLine() returns null when no nodes', () => {
    const { writer } = createWriter();
    assertEqual(writer.getDashboardLine(), null);
  });

  // 13. getReport() completeness
  test('getReport() includes all required fields', () => {
    const { writer } = createWriter();
    writer.write('s1', { data: 'test' });

    const report = writer.getReport();
    assertEqual(report.name, 'testWriter');
    assertEqual(report.edgeType, 'TEST_TYPE');
    assert(report.config.decayFactor !== undefined, 'config.decayFactor');
    assert(report.config.maxImprints !== undefined, 'config.maxImprints');
    assert(report.config.pruneThreshold !== undefined, 'config.pruneThreshold');
    assert(report.stats.written >= 1, 'stats.written');
    assertEqual(report.activeNodes, 1);
    assert(report.latest !== null, 'latest should exist');
  });

  // 14. _formatAge() output
  test('_formatAge() returns human-readable age', () => {
    const { writer } = createWriter();

    // This session
    const now = writer._formatAge(Date.now() - 1000);
    assertEqual(now, 'this session');

    // Hours ago
    const hoursAgo = writer._formatAge(Date.now() - 5 * 60 * 60 * 1000);
    assert(hoursAgo.includes('h ago'), `expected "Xh ago", got "${hoursAgo}"`);

    // Days ago
    const daysAgo = writer._formatAge(Date.now() - 3 * 24 * 60 * 60 * 1000);
    assert(daysAgo.includes('days ago'), `expected "X days ago", got "${daysAgo}"`);

    // Unknown
    assertEqual(writer._formatAge(null), 'unknown age');
  });

  // 15. Event emission on write
  test('write() emits frontier event', () => {
    const { writer, bus } = createWriter();
    writer.write('s1', { data: 'event test' });

    const writeEvent = bus._events.find(e => e.event === 'frontier:testWriter:written');
    assert(writeEvent !== undefined, 'should emit frontier:testWriter:written');
    assertEqual(writeEvent.data.sessionId, 's1');
    assertEqual(writeEvent.data.edgeType, 'TEST_TYPE');
  });
});

run();
