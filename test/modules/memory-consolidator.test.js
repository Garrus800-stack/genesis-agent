// ============================================================
// GENESIS — test/modules/memory-consolidator.test.js (v6.0.0)
//
// Tests MemoryConsolidator: KG merge, stale pruning, lesson
// archival, cooldown, stats, bus events, lifecycle.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const { MemoryConsolidator } = require(path.join(ROOT, 'src/agent/cognitive/MemoryConsolidator'));

// ── Mock Dependencies ───────────────────────────────────────

function mockBus() {
  const events = [];
  const handlers = {};
  return {
    on: (evt, fn) => { handlers[evt] = fn; return () => { delete handlers[evt]; }; },
    emit: (evt, data) => events.push({ evt, data }),
    _events: events,
    _handlers: handlers,
    _fire: (evt, data) => handlers[evt]?.(data),
  };
}

function mockKG() {
  const nodes = new Map();
  const edges = new Map();
  const neighborIndex = new Map();

  // Add some test nodes
  const addNode = (id, type, label, accessCount = 0, created = Date.now()) => {
    nodes.set(id, { id, type, label, properties: {}, created, accessed: created, accessCount });
  };

  addNode('n1', 'concept', 'rest api', 5);
  addNode('n2', 'concept', 'rest api design', 3);
  addNode('n3', 'concept', 'graphql', 2);
  addNode('n4', 'file', 'server.js', 0, Date.now() - 30 * 24 * 60 * 60 * 1000); // stale

  return {
    graph: {
      nodes,
      edges,
      neighborIndex,
      removeNode: (id) => { nodes.delete(id); return true; },
    },
    pruneStale: (days) => {
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      let count = 0;
      for (const [id, node] of nodes) {
        if (node.accessed < cutoff && node.accessCount === 0) {
          nodes.delete(id);
          count++;
        }
      }
      return count;
    },
    getStats: () => ({ nodes: nodes.size, edges: edges.size }),
    _save: () => {},
  };
}

function mockLessonsStore(tmpDir) {
  const now = Date.now();
  const lessons = [
    { id: 'l1', category: 'code', insight: 'Use async/await', createdAt: now, lastUsed: now, useCount: 5 },
    { id: 'l2', category: 'code', insight: 'Old unused lesson', createdAt: now - 60 * 24 * 60 * 60 * 1000, lastUsed: now - 60 * 24 * 60 * 60 * 1000, useCount: 0 },
    { id: 'l3', category: 'debug', insight: 'Another old one', createdAt: now - 45 * 24 * 60 * 60 * 1000, lastUsed: now - 45 * 24 * 60 * 60 * 1000, useCount: 1 },
    { id: 'l4', category: 'debug', insight: 'Frequently used old', createdAt: now - 90 * 24 * 60 * 60 * 1000, lastUsed: now - 2 * 24 * 60 * 60 * 1000, useCount: 10 },
  ];

  return {
    _lessons: lessons,
    _globalDir: tmpDir,
    _dirty: false,
    getAll: () => [...lessons],
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('MemoryConsolidator', () => {

  test('constructs with minimal deps', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    assert(mc.bus === bus, 'bus assigned');
    assertEqual(mc._stats.totalRuns, 0);
    assertEqual(mc._running, false);
  });

  test('start() subscribes to bus events', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.start();
    assert(bus._handlers['idle:consolidate-memory'], 'subscribes to consolidation trigger');
    assert(bus._handlers['workspace:slot-evicted'], 'subscribes to slot eviction');
  });

  test('stop() unsubscribes all listeners', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.start();
    assertEqual(mc._unsubs.length, 2);
    mc.stop();
    assertEqual(mc._unsubs.length, 0);
  });

  test('consolidate() runs KG merge when knowledgeGraph available', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 0, kgMergeThreshold: 0.6 } });
    mc.knowledgeGraph = mockKG();

    const report = await mc.consolidate();
    assert(!report.skipped, 'should not skip');
    assert(report.kg.merged >= 1, 'should merge similar nodes (rest api + rest api design)');
    assert(report.kg.pruned >= 0, 'should prune stale nodes');
    assert(report.durationMs >= 0, 'should have duration');
    assertEqual(mc._stats.totalRuns, 1);
  });

  test('consolidate() archives old lessons', async () => {
    const tmpDir = path.join(os.tmpdir(), `genesis-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 0, archivalAgeDays: 30, archivalMinUseCount: 2 } });
    mc.lessonsStore = mockLessonsStore(tmpDir);

    const report = await mc.consolidate();
    assert(report.lessons.archived >= 1, 'should archive at least 1 old lesson');
    assert(report.lessons.beforeCount === 4, 'started with 4 lessons');

    // Verify archive file created
    const archiveDir = path.join(tmpDir, 'archive');
    if (fs.existsSync(archiveDir)) {
      const files = fs.readdirSync(archiveDir);
      assert(files.length >= 1, 'archive file created');
    }

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('consolidate() respects cooldown', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 60000 } });

    const r1 = await mc.consolidate();
    assert(!r1.skipped, 'first run should not skip');

    const r2 = await mc.consolidate();
    assert(r2.skipped, 'second run should skip');
    assertEqual(r2.reason, 'cooldown');
  });

  test('consolidate() prevents concurrent runs', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 0 } });
    mc._running = true;

    const report = await mc.consolidate();
    assert(report.skipped, 'should skip concurrent run');
    assertEqual(report.reason, 'already-running');
  });

  test('consolidate() emits completion event', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 0 } });

    await mc.consolidate();
    const completionEvent = bus._events.find(e => e.evt === 'memory:consolidation-complete');
    assert(completionEvent, 'should emit completion event');
    assert(completionEvent.data.durationMs >= 0, 'event has duration');
  });

  test('getReport() returns stats and config', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.knowledgeGraph = mockKG();

    const report = mc.getReport();
    assert(report.stats, 'has stats');
    assert(report.config, 'has config');
    assert(report.currentState, 'has currentState');
    assertEqual(report.stats.totalRuns, 0);
  });

  test('_labelSimilarity() computes Jaccard correctly', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });

    assertEqual(mc._labelSimilarity('rest api', 'rest api'), 1.0);
    assertEqual(mc._labelSimilarity('', ''), 1.0); // identical strings → 1.0
    assertEqual(mc._labelSimilarity('', 'something'), 0.0);
    assert(mc._labelSimilarity('rest api', 'rest api design') > 0.5, 'overlapping labels similar');
    assert(mc._labelSimilarity('rest api', 'graphql') === 0, 'unrelated labels dissimilar');
  });

  test('_findKGMergeCandidates() groups similar nodes', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { kgMergeThreshold: 0.5 } });
    const kg = mockKG();

    const groups = mc._findKGMergeCandidates(kg.graph);
    assert(groups.length >= 1, 'should find at least one merge group');
    // n1 (rest api) and n2 (rest api design) should be grouped
    const group = groups.find(g => g.some(n => n.id === 'n1'));
    assert(group, 'n1 should be in a group');
    assert(group.some(n => n.id === 'n2'), 'n2 should be in same group as n1');
  });

  test('bus trigger fires consolidation', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 0 } });
    mc.start();

    // Simulate IdleMind trigger
    let ran = false;
    const origConsolidate = mc.consolidate.bind(mc);
    mc.consolidate = async () => { ran = true; return origConsolidate(); };

    bus._fire('idle:consolidate-memory', {});
    // Give async handler time to execute
    await new Promise(r => setTimeout(r, 10));
    assert(ran, 'consolidation should have been triggered');
  });

  test('handles missing deps gracefully', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus, config: { cooldownMs: 0 } });
    // No knowledgeGraph, no lessonsStore

    const report = await mc.consolidate();
    assert(!report.skipped, 'should run even without deps');
    assertEqual(report.kg.merged, 0);
    assertEqual(report.lessons.archived, 0);
  });
});

// ── v7.1.2: Coverage expansion ───────────────────────────────

describe('MemoryConsolidator — start / stop', () => {
  test('start subscribes to bus events', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.start();
    assert(Object.keys(bus._handlers).length >= 1, 'should register handlers');
    mc.stop();
  });

  test('stop clears unsubs', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.start();
    assert(mc._unsubs.length > 0);
    mc.stop();
    assertEqual(mc._unsubs.length, 0);
  });

  test('stop is safe without start', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.stop(); // should not throw
    assert(true);
  });

  test('idle:consolidate-memory event triggers consolidation', async () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.start();
    let ran = false;
    mc.consolidate = async () => { ran = true; return {}; };
    bus._fire('idle:consolidate-memory', {});
    await new Promise(r => setTimeout(r, 10));
    assert(ran, 'consolidate should have been called');
    mc.stop();
  });
});

describe('MemoryConsolidator — _mergeKGNodes()', () => {
  test('merges properties of victim into survivor', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });

    const nodes = new Map();
    const edges = new Map();
    const neighborIndex = new Map();
    const removedNodes = [];

    nodes.set('n1', { type: 'concept', label: 'rest api', properties: { source: 'manual' }, accessCount: 5 });
    nodes.set('n2', { type: 'concept', label: 'rest api', properties: { origin: 'auto' }, accessCount: 2 });

    const graph = {
      nodes, edges, neighborIndex,
      removeNode: (id) => { removedNodes.push(id); nodes.delete(id); },
    };

    const group = [
      { id: 'n1', label: 'rest api', node: nodes.get('n1') },
      { id: 'n2', label: 'rest api', node: nodes.get('n2') },
    ];

    const result = mc._mergeKGNodes(graph, group);
    assert(result === true, 'merge should succeed');
    assert(removedNodes.includes('n2'), 'victim n2 should be removed');
    assert(nodes.has('n1'), 'survivor n1 should remain');
    assert(nodes.get('n1').accessCount >= 7, 'accessCount should be summed');
  });

  test('redirects edges from victim to survivor', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });

    const nodes = new Map();
    const edges = new Map();
    const neighborIndex = new Map();

    nodes.set('n1', { type: 'concept', label: 'api', properties: {}, accessCount: 3 });
    nodes.set('n2', { type: 'concept', label: 'api', properties: {}, accessCount: 1 });
    nodes.set('n3', { type: 'concept', label: 'other', properties: {}, accessCount: 1 });

    edges.set('e1', { source: 'n2', target: 'n3', type: 'relates' });
    neighborIndex.set('n2', new Set(['e1']));

    const removedNodes = [];
    const graph = {
      nodes, edges, neighborIndex,
      removeNode: (id) => { removedNodes.push(id); nodes.delete(id); },
    };

    const group = [
      { id: 'n1', label: 'api', node: nodes.get('n1') },
      { id: 'n2', label: 'api', node: nodes.get('n2') },
    ];

    mc._mergeKGNodes(graph, group);
    assertEqual(edges.get('e1').source, 'n1', 'edge source should be redirected to survivor');
  });

  test('removes self-loop edges created by merge', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });

    const nodes = new Map();
    const edges = new Map();
    const neighborIndex = new Map();

    nodes.set('n1', { type: 'concept', label: 'api', properties: {}, accessCount: 3 });
    nodes.set('n2', { type: 'concept', label: 'api', properties: {}, accessCount: 1 });

    // Edge between n1 and n2 — becomes self-loop after merge
    edges.set('e1', { source: 'n2', target: 'n1', type: 'relates' });
    neighborIndex.set('n2', new Set(['e1']));

    const graph = {
      nodes, edges, neighborIndex,
      removeNode: (id) => { nodes.delete(id); },
    };

    const group = [
      { id: 'n1', label: 'api', node: nodes.get('n1') },
      { id: 'n2', label: 'api', node: nodes.get('n2') },
    ];

    mc._mergeKGNodes(graph, group);
    assert(!edges.has('e1'), 'self-loop edge should be deleted');
  });

  test('returns false on exception', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    const graph = { nodes: new Map(), edges: new Map(), neighborIndex: new Map(), removeNode() { throw new Error('fail'); } };
    const group = [
      { id: 'x', label: 'a', node: { type: 'c', properties: {}, accessCount: 0 } },
      { id: 'y', label: 'a', node: { type: 'c', properties: {}, accessCount: 0 } },
    ];
    const result = mc._mergeKGNodes(graph, group);
    assertEqual(result, false);
  });
});

describe('MemoryConsolidator — _consolidateLessons()', () => {
  test('returns zeroed report when no lessons are old enough', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.lessonsStore = {
      getAll: () => [
        { id: 'l1', createdAt: Date.now(), lastUsed: Date.now(), useCount: 10 },
      ],
    };
    const r = mc._consolidateLessons();
    assertEqual(r.archived, 0);
    assertEqual(r.beforeCount, 1);
  });

  test('archives old low-use lessons', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    const oldTs = Date.now() - (400 * 24 * 60 * 60 * 1000); // 400 days ago

    const archived = [];
    mc.lessonsStore = {
      getAll: () => [{ id: 'old1', createdAt: oldTs, lastUsed: oldTs, useCount: 0 }],
      _globalDir: os.tmpdir(),
      _lessons: [{ id: 'old1' }],
      get _dirty() { return false; },
      set _dirty(_) {},
    };
    mc._archiveLessons = (lessons) => { archived.push(...lessons); };
    const r = mc._consolidateLessons();
    assert(archived.length > 0, 'should call _archiveLessons');
    assert(r.archived > 0);
  });
});

describe('MemoryConsolidator — _archiveLessons()', () => {
  test('writes archive file and removes lessons from store', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    const tmpDir = path.join(os.tmpdir(), `mc-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    mc.lessonsStore = {
      _globalDir: tmpDir,
      _lessons: [{ id: 'l1' }, { id: 'l2' }, { id: 'l3' }],
      get _dirty() { return false; },
      set _dirty(_) {},
    };
    mc.storage = null;

    mc._archiveLessons([{ id: 'l1' }, { id: 'l2' }]);

    // Archive file should exist in tmpDir/archive/
    const archiveDir = path.join(tmpDir, 'archive');
    const files = fs.readdirSync(archiveDir);
    assert(files.length > 0, 'archive file should be created');

    // Lessons l1 and l2 should be removed from store
    assertEqual(mc.lessonsStore._lessons.length, 1);
    assertEqual(mc.lessonsStore._lessons[0].id, 'l3');

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true });
  });

  test('handles write errors gracefully', () => {
    const bus = mockBus();
    const mc = new MemoryConsolidator({ bus });
    mc.lessonsStore = { _globalDir: '/nonexistent/path/that/cannot/exist' };
    mc.storage = null;
    mc._archiveLessons([{ id: 'x' }]); // should not throw
    assert(true);
  });
});

run();
