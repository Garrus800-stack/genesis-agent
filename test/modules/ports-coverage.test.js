// Test: v6.1.0 Coverage Push Part 1 — Ports + Core Helpers
// Targets: PeerHealth, CorrelationContext, Port base classes, swallow/utils

const { describe, test, assert, assertEqual, run } = require('../harness');

// ── PeerHealth ─────────────────────────────────────────────

describe('PeerHealth — full API', () => {
  const { PeerHealth } = require('../../src/agent/hexagonal/PeerHealth');

  test('constructor initializes defaults', () => {
    const ph = new PeerHealth();
    assertEqual(ph.failures, 0);
    assertEqual(ph.successes, 0);
    assertEqual(ph.backoffMs, 1000);
    assert(ph.latencies.length === 0, 'no latencies');
  });

  test('recordSuccess tracks latency and resets failures', () => {
    const ph = new PeerHealth();
    ph.failures = 2;
    ph.backoffMs = 4000;
    ph.recordSuccess(50);
    assertEqual(ph.successes, 1);
    assertEqual(ph.failures, 0);
    assertEqual(ph.backoffMs, 1000);
    assertEqual(ph.latencies.length, 1);
    assertEqual(ph.latencies[0], 50);
  });

  test('recordSuccess caps at 10 latencies', () => {
    const ph = new PeerHealth();
    for (let i = 0; i < 15; i++) ph.recordSuccess(i * 10);
    assertEqual(ph.latencies.length, 10);
    assertEqual(ph.latencies[0], 50); // shifted out 0-40
  });

  test('recordFailure increments and doubles backoff', () => {
    const ph = new PeerHealth();
    ph.recordFailure();
    assertEqual(ph.failures, 1);
    assertEqual(ph.backoffMs, 2000);
    ph.recordFailure();
    assertEqual(ph.failures, 2);
    assertEqual(ph.backoffMs, 4000);
  });

  test('backoff caps at 60s', () => {
    const ph = new PeerHealth();
    for (let i = 0; i < 20; i++) ph.recordFailure();
    assert(ph.backoffMs <= 60000, 'backoff should cap at 60000');
  });

  test('avgLatency with no data returns Infinity', () => {
    const ph = new PeerHealth();
    assertEqual(ph.avgLatency, Infinity);
  });

  test('avgLatency computes mean', () => {
    const ph = new PeerHealth();
    ph.recordSuccess(100);
    ph.recordSuccess(200);
    assertEqual(ph.avgLatency, 150);
  });

  test('isHealthy true when fresh and no failures', () => {
    const ph = new PeerHealth();
    assert(ph.isHealthy === true, 'should be healthy initially');
  });

  test('isHealthy false after 3+ failures', () => {
    const ph = new PeerHealth();
    ph.recordFailure(); ph.recordFailure(); ph.recordFailure();
    assert(ph.isHealthy === false, 'should be unhealthy after 3 failures');
  });

  test('score increases with failures', () => {
    const ph = new PeerHealth();
    ph.recordSuccess(50);
    const baseScore = ph.score;
    ph.recordFailure();
    assert(ph.score > baseScore, 'score should increase with failures');
  });
});

// ── CorrelationContext ──────────────────────────────────────

describe('CorrelationContext — scoped tracing', () => {
  const { CorrelationContext } = require('../../src/agent/core/CorrelationContext');

  test('getId returns null outside scope', () => {
    assert(CorrelationContext.getId() === null, 'should be null outside run()');
  });

  test('run() provides correlation ID inside scope', async () => {
    let capturedId = null;
    await CorrelationContext.run('test-123', () => {
      capturedId = CorrelationContext.getId();
    });
    assertEqual(capturedId, 'test-123');
  });

  test('run() auto-generates ID when null', async () => {
    let capturedId = null;
    await CorrelationContext.run(null, () => {
      capturedId = CorrelationContext.getId();
    });
    assert(capturedId !== null, 'should auto-generate');
    assert(typeof capturedId === 'string', 'should be a string');
  });

  test('getContext returns full context with timing', async () => {
    let ctx = null;
    await CorrelationContext.run('ctx-test', () => {
      ctx = CorrelationContext.getContext();
    });
    assertEqual(ctx.correlationId, 'ctx-test');
    assert(typeof ctx.startedAt === 'number', 'should have startedAt');
    assert(typeof ctx.elapsedMs === 'number', 'should have elapsedMs');
  });

  test('getContext returns null outside scope', () => {
    assert(CorrelationContext.getContext() === null, 'should be null');
  });

  test('fork creates child scope with parent prefix', async () => {
    let childId = null;
    await CorrelationContext.run('parent-1', async () => {
      await CorrelationContext.fork(() => {
        childId = CorrelationContext.getId();
      }, 'child');
    });
    assert(childId.startsWith('parent-1/child-'), `should start with parent prefix, got ${childId}`);
  });

  test('fork outside scope creates standalone ID', async () => {
    let childId = null;
    await CorrelationContext.fork(() => {
      childId = CorrelationContext.getId();
    }, 'orphan');
    assert(childId.startsWith('orphan-'), `should be standalone, got ${childId}`);
  });

  test('inject adds correlationId to object', async () => {
    const obj = { foo: 'bar' };
    await CorrelationContext.run('inject-test', () => {
      CorrelationContext.inject(obj);
    });
    assertEqual(obj.correlationId, 'inject-test');
    assertEqual(obj.foo, 'bar');
  });

  test('inject does nothing outside scope', () => {
    const obj = { a: 1 };
    CorrelationContext.inject(obj);
    assert(!obj.correlationId, 'should not add correlationId');
  });

  test('generate creates unique IDs', () => {
    const a = CorrelationContext.generate('test');
    const b = CorrelationContext.generate('test');
    assert(a !== b, 'should be unique');
    assert(a.startsWith('test-'), 'should have prefix');
  });
});

// ── Port base classes ───────────────────────────────────────

describe('SandboxPort — interface stubs', () => {
  const { SandboxPort } = require('../../src/agent/ports/SandboxPort');

  test('constructor and base methods exist', () => {
    const port = new SandboxPort();
    assert(typeof port.getAuditLog === 'function', 'getAuditLog should exist');
    assert(typeof port.cleanup === 'function', 'cleanup should exist');
    assert(Array.isArray(port.getAuditLog()), 'getAuditLog should return array');
  });
});

describe('WorkspacePort — NullWorkspace + factory', () => {
  const { NullWorkspace, nullWorkspaceFactory } = require('../../src/agent/ports/WorkspacePort');

  test('NullWorkspace all methods are safe no-ops', () => {
    const ws = new NullWorkspace();
    const stored = ws.store();
    assert(stored.stored === false, 'store should return stored:false');
    assert(ws.recall() === null, 'recall should return null');
    assert(ws.has() === false, 'has should return false');
    assert(ws.remove() === false, 'remove should return false');
    assert(Array.isArray(ws.snapshot()), 'snapshot should return array');
    assertEqual(ws.buildContext(), '');
    const stats = ws.getStats();
    assertEqual(stats.slots, 0);
  });

  test('nullWorkspaceFactory creates NullWorkspace', () => {
    const ws = nullWorkspaceFactory({ goalId: 'test' });
    assert(ws instanceof NullWorkspace, 'should be NullWorkspace');
  });
});

describe('KnowledgePort — interface stubs', () => {
  const { KnowledgePort } = require('../../src/agent/ports/KnowledgePort');

  test('constructor creates instance', () => {
    const port = new KnowledgePort();
    assert(port !== null, 'should construct');
  });
});

describe('MemoryPort — interface stubs', () => {
  const { MemoryPort } = require('../../src/agent/ports/MemoryPort');

  test('constructor and core methods exist', () => {
    const port = new MemoryPort();
    assert(typeof port.addEpisode === 'function', 'addEpisode should exist');
    assert(typeof port.search === 'function', 'search should exist');
    assert(typeof port.getStats === 'function', 'getStats should exist');
    assert(typeof port.flush === 'function', 'flush should exist');
    // Base getStats returns empty object
    const stats = port.getStats();
    assert(typeof stats === 'object', 'getStats should return object');
  });
});

describe('KnowledgePort — adapters and mocks', () => {
  const { KnowledgePort, KnowledgeGraphAdapter, MockKnowledge } = require('../../src/agent/ports/KnowledgePort');

  test('MockKnowledge addTriple and getStats', () => {
    const m = new MockKnowledge();
    m.addTriple('A', 'rel', 'B', {});
    m.addTriple('C', 'rel', 'D', {});
    assertEqual(m.getStats().triples, 2);
  });

  test('MockKnowledge search returns results', () => {
    const m = new MockKnowledge();
    m.setSearchResults(['x', 'y', 'z']);
    assertEqual(m.search('query', 2).length, 2);
  });

  test('MockKnowledge query returns empty array', () => {
    assert(Array.isArray(new MockKnowledge().query({})));
  });

  test('MockKnowledge flush does not throw', () => {
    new MockKnowledge().flush();
    assert(true);
  });

  test('KnowledgeGraphAdapter delegates to inner graph', () => {
    const kg = { addTriple: (s,p,o) => 'ok', search: (q,l) => ['r1'], query: () => [], getStats: () => ({n:1}), flush: () => {}, setEmbeddingService: () => {} };
    const a = new KnowledgeGraphAdapter(kg);
    a.addTriple('A','rel','B');
    a.search('q', 3);
    a.query({});
    a.getStats();
    a.flush();
    a.setEmbeddingService({});
    const m = a.getMetrics();
    assertEqual(m.triples, 1);
    assertEqual(m.searches, 1);
    assertEqual(m.queries, 1);
  });

  test('KnowledgeGraphAdapter connect method', () => {
    const kg = { connect: (s,r,t) => 'connected', search: ()=>[], getStats: ()=>({}), flush: ()=>{} };
    const a = new KnowledgeGraphAdapter(kg);
    a.connect('A', 'links', 'B');
    assertEqual(a.getMetrics().triples, 1);
  });

  test('KnowledgeGraphAdapter raw getter', () => {
    const kg = { getStats: ()=>({}), flush: ()=>{} };
    assert(new KnowledgeGraphAdapter(kg).raw === kg);
  });
});

describe('MemoryPort — adapters and mocks', () => {
  const { MemoryPort, EpisodicMemoryAdapter, MockMemory } = require('../../src/agent/ports/MemoryPort');

  test('MockMemory search returns results', () => {
    const m = new MockMemory();
    m.setSearchResults([{ text: 'r1' }]);
    assertEqual(m.search('q', 5).length, 1);
  });

  test('MockMemory addSemantic and getSemantic', () => {
    const m = new MockMemory();
    m.addSemantic('key', 'value');
    assertEqual(m.getSemantic('key'), 'value');
  });

  test('MockMemory getStats', () => {
    const m = new MockMemory();
    assert(typeof m.getStats() === 'object');
  });

  test('MockMemory flush does not throw', () => {
    new MockMemory().flush();
    assert(true);
  });
});

run();
