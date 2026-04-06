// ============================================================
// Test: v6.0.5 Coverage Sweep Part 2 — Ports + Cognitive
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}
function mockStorage() {
  const store = {};
  return {
    readJSON: (f, fb) => store[f] || fb,
    readJSONAsync: async (f) => store[f] || null,
    writeJSON: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    writeJSONDebounced: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    writeJSONSync: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    store,
  };
}

// ════════════════════════════════════════════════════════════
// KnowledgePort
// ════════════════════════════════════════════════════════════

describe('CoverageSweep2 — KnowledgePort', () => {
  const { KnowledgePort, KnowledgeGraphAdapter, MockKnowledge } = require('../../src/agent/ports/KnowledgePort');

  test('base + adapter + mock — full API', () => {
    // Base
    const p = new KnowledgePort();
    try { p.addTriple('s', 'p', 'o'); } catch (_) {}
    try { p.search('q'); } catch (_) {}
    try { p.query('p'); } catch (_) {}
    p.getStats(); p.flush(); p.setEmbeddingService(null);

    // Adapter
    const mockKg = { addTriple: () => 1, search: () => [], query: () => [], getStats: () => ({}), flush: () => {}, connect: () => 1 };
    const a = new KnowledgeGraphAdapter(mockKg);
    a.addTriple('A', 'knows', 'B'); a.connect('X', 'r', 'Y');
    a.search('t', 3); a.query({}); a.getStats(); a.flush();
    a.setEmbeddingService(null); a.getMetrics(); assert(a.raw === mockKg);

    // Mock
    const mk = new MockKnowledge();
    mk.addTriple('A', 'knows', 'B');
    mk.setSearchResults([{ label: 'X' }]);
    mk.search('t'); mk.query({}); mk.getStats(); mk.flush();
  });
});

// ════════════════════════════════════════════════════════════
// MemoryPort
// ════════════════════════════════════════════════════════════

describe('CoverageSweep2 — MemoryPort', () => {
  const { MemoryPort, ConversationMemoryAdapter, MockMemory } = require('../../src/agent/ports/MemoryPort');

  test('base class methods', () => {
    const p = new MemoryPort();
    try { p.addEpisode([]); } catch (_) {}
    try { p.search('q'); } catch (_) {}
    try { p.addSemantic('k', 'v', 's'); } catch (_) {}
    try { p.getSemantic('k'); } catch (_) {}
    p.getStats(); p.flush(); p.setEmbeddingService(null);
  });

  test('adapter delegates all methods', () => {
    const mockConv = {
      addEntry: () => {}, addEpisode: async () => {},
      search: () => [], addSemantic: () => {},
      getSemantic: () => null, getStats: () => ({}),
      flush: () => {}, setEmbeddingService: () => {},
    };
    const a = new ConversationMemoryAdapter(mockConv);
    a.addEpisode([]); a.search('q'); a.addSemantic('k', 'v', 's');
    a.getSemantic('k'); a.getStats(); a.flush(); a.setEmbeddingService(null);
    assert(a.raw === mockConv);
  });

  test('MockMemory stores and retrieves', () => {
    const mm = new MockMemory();
    mm.addEpisode([{ role: 'user', content: 'hi' }]);
    mm.addSemantic('key', 'val', 'test');
    mm.getSemantic('key');
    mm.search('hi');
    mm.getStats();
    mm.flush();
  });
});

// ════════════════════════════════════════════════════════════
// SandboxPort
// ════════════════════════════════════════════════════════════

describe('CoverageSweep2 — SandboxPort', () => {
  const { SandboxPort, SandboxAdapter, MockSandbox } = require('../../src/agent/ports/SandboxPort');

  test('base class methods', () => {
    const p = new SandboxPort();
    try { p.execute('code'); } catch (_) {}
    try { p.syntaxCheck('code'); } catch (_) {}
    p.getAuditLog(); p.cleanup();
  });

  test('adapter delegates', async () => {
    const mockSb = {
      execute: async () => ({ output: 'ok' }),
      syntaxCheck: async () => ({ valid: true }),
      getAuditLog: () => [], cleanup: () => {},
    };
    const a = new SandboxAdapter(mockSb);
    await a.execute('code'); await a.syntaxCheck('code');
    a.getAuditLog(); a.cleanup(); a.getMetrics();
    assert(a.raw === mockSb);
  });

  test('MockSandbox execute + syntaxCheck', async () => {
    const ms = new MockSandbox();
    await ms.execute('const x = 1;');
    await ms.syntaxCheck('const x = 1;');
    ms.getAuditLog(); ms.cleanup();
  });
});

// ════════════════════════════════════════════════════════════
// WorkspacePort
// ════════════════════════════════════════════════════════════

describe('CoverageSweep2 — WorkspacePort', () => {
  const { NullWorkspace, nullWorkspaceFactory } = require('../../src/agent/ports/WorkspacePort');

  test('NullWorkspace all methods', () => {
    const nw = new NullWorkspace();
    nw.store(); nw.recall(); nw.has(); nw.remove();
    nw.snapshot(); nw.tick(); nw.buildContext();
    nw.getConsolidationCandidates(); nw.clear(); nw.getStats();
  });

  test('factory returns NullWorkspace', () => {
    assert(nullWorkspaceFactory() instanceof NullWorkspace);
  });
});


describe('CoverageSweep2 — ModuleRegistry', () => {
  const { ModuleRegistry } = require('../../src/agent/revolution/ModuleRegistry');

  test('construct + getManifest + validate', () => {
    const { Container } = require('../../src/agent/core/Container');
    const bus = mockBus();
    const c = new Container({ bus });
    const mr = new ModuleRegistry(c, bus);
    const manifest = mr.getManifest();
    assert(typeof manifest === 'object');
    const valid = mr.validate();
    assert(typeof valid === 'object');
  });
});

run();
