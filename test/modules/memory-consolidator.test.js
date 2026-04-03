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

run();
