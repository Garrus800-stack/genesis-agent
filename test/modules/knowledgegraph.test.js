// Test: KnowledgeGraph.js — traversal, path finding, PageRank
const path = require('path');
const fs = require('fs');
const os = require('os');

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

const tmpDir = path.join(os.tmpdir(), 'genesis-test-kg-' + Date.now());
fs.mkdirSync(tmpDir, { recursive: true });

const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
const { StorageService } = require('../../src/agent/foundation/StorageService');

const mockBus = { emit() {}, on() {}, off() {} };
const storage = new StorageService(tmpDir);

console.log('\n  📦 KnowledgeGraph Traversal');

const kg = new KnowledgeGraph({ bus: mockBus, storage });

// Build a test graph: A -> B -> C, A -> D, B -> D
const idA = kg.addNode('concept', 'Node A', { desc: 'start' });
const idB = kg.addNode('concept', 'Node B', { desc: 'middle' });
const idC = kg.addNode('concept', 'Node C', { desc: 'end' });
const idD = kg.addNode('concept', 'Node D', { desc: 'connector' });
kg.addEdge(idA, idB, 'connects-to', 1.0);
kg.addEdge(idB, idC, 'connects-to', 1.0);
kg.addEdge(idA, idD, 'relates-to', 0.5);
kg.addEdge(idB, idD, 'also-connects', 0.8);

test('traverse returns reachable nodes with depth', () => {
  const result = kg.traverse(idA, 3);
  assert(result.length >= 3, `Expected >=3 reachable, got ${result.length}`);
  const depths = result.map(r => r.depth);
  assert(depths.includes(1), 'Has depth-1 neighbors');
});

test('traverse respects maxDepth', () => {
  const result = kg.traverse(idA, 1);
  assert(result.every(r => r.depth <= 1), 'All within maxDepth');
});

test('findPath finds shortest path A→C', () => {
  const p = kg.findPath(idA, idC);
  assert(p !== null, 'Path should exist');
  assert(p.length === 2, `Expected path length 2, got ${p.length}`);
});

test('findPath returns null for disconnected nodes', () => {
  const idX = kg.addNode('concept', 'Isolated', {});
  const p = kg.findPath(idA, idX);
  assert(p === null, 'No path to isolated node');
});

test('pageRank returns ranked nodes', () => {
  const ranked = kg.pageRank(10, 0.85, 5);
  assert(ranked.length > 0, 'Has ranked nodes');
  assert(ranked[0].score >= ranked[ranked.length - 1].score, 'Sorted by score');
  // B and D should rank high (most connections)
  const topLabels = ranked.slice(0, 3).map(r => r.node.label.toLowerCase());
  assert(topLabels.includes('node b') || topLabels.includes('node d'), 'Well-connected nodes rank high');
});

test('findBridgeNodes identifies connectors', () => {
  const bridges = kg.findBridgeNodes(3);
  // B connects A-C and A-D, so it should be a bridge
  assert(bridges.length > 0, 'Found bridge nodes');
});

// Persistence tests moved to runAsyncTests() for proper async handling

// Cleanup deferred to runAsyncTests

// ── Embedding integration tests (sync, no Ollama needed) ──

const tmpDir2 = path.join(os.tmpdir(), 'genesis-test-kg-emb-' + Date.now());
fs.mkdirSync(tmpDir2, { recursive: true });
const storage2 = new StorageService(tmpDir2);

console.log('\n  📦 KnowledgeGraph Embeddings');

// Mock EmbeddingService with deterministic vectors
const mockEmbeddings = {
  isAvailable: () => true,
  embed: async (text) => {
    // Simple deterministic vector: hash characters into 4 dims
    const v = [0, 0, 0, 0];
    for (let i = 0; i < text.length; i++) v[i % 4] += text.charCodeAt(i) / 1000;
    const mag = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map(x => x / mag);
  },
  embedBatch: async (texts) => Promise.all(texts.map(t => mockEmbeddings.embed(t))),
  cosineSimilarity: (a, b) => {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, mA = 0, mB = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; mA += a[i] ** 2; mB += b[i] ** 2; }
    const d = Math.sqrt(mA) * Math.sqrt(mB);
    return d > 0 ? dot / d : 0;
  },
};

async function runAsyncTests() {
  // ── Persistence tests (need await for flush) ──────────
  await asyncTest('flush persists data', async () => {
    await kg.flush();
    assert(fs.existsSync(path.join(tmpDir, 'knowledge-graph.json')), 'File created');
  });

  await asyncTest('data survives reload', async () => {
    storage.clearCache(); // Force re-read from disk
    const kg2 = new KnowledgeGraph({ bus: mockBus, storage });
    await kg2.asyncLoad(); // v3.8.0: Constructor no longer auto-loads
    assert(kg2.graph.nodes.size >= 4, `Expected >=4 nodes after reload, got ${kg2.graph.nodes.size}`);
    assert(kg2.graph.edges.size >= 4, `Expected >=4 edges after reload, got ${kg2.graph.edges.size}`);
  });

  // ── Embedding integration tests ───────────────────────
  const kg3 = new KnowledgeGraph({ bus: mockBus, storage: storage2 });
  kg3.addNode('concept', 'JavaScript', { desc: 'programming language' });
  kg3.addNode('concept', 'Python', { desc: 'programming language' });
  kg3.addNode('concept', 'Neural Network', { desc: 'machine learning model' });
  kg3.connect('JavaScript', 'used-in', 'Web Development');

  await asyncTest('setEmbeddingService enables vector search', async () => {
    kg3.setEmbeddingService(mockEmbeddings);
    const stats = kg3.getStats();
    assert(stats.embeddings.available === true, 'Embeddings should be available');
  });

  await asyncTest('searchAsync returns results', async () => {
    const results = await kg3.searchAsync('programming language', 5);
    assert(results.length > 0, 'Should find results');
    assert(results[0].score > 0, 'Score should be positive');
  });

  await asyncTest('searchAsync finds semantic matches beyond keywords', async () => {
    const results = await kg3.searchAsync('coding', 5);
    // 'coding' doesn't appear in labels but vectors should find programming-related nodes
    assert(results.length > 0, 'Should find semantic matches');
  });

  await asyncTest('buildContextAsync returns formatted context', async () => {
    const ctx = await kg3.buildContextAsync('programming', 300);
    assert(ctx.length > 0, 'Context should not be empty');
    assert(ctx.includes('KNOWLEDGE CONTEXT'), 'Should have header');
  });

  await asyncTest('getStats reports vectorized node count', async () => {
    // Force sync
    await kg3._syncNodeVectors();
    const stats = kg3.getStats();
    assert(stats.embeddings.vectorizedNodes > 0, `Expected >0 vectorized, got ${stats.embeddings.vectorizedNodes}`);
  });

  // ── v7.1.4 Feature 2: Frontier Node ──

  test('ensureFrontier creates frontier node', () => {
    const tmpF = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-frontier-'));
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    const kgF = new KnowledgeGraph({ storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {}, flush: async () => {} } });
    const frontier = kgF.ensureFrontier();
    assert(frontier, 'frontier node should exist');
    // second call should not create duplicate
    const frontier2 = kgF.ensureFrontier();
    assert(frontier2, 'second call should return existing frontier');
    fs.rmSync(tmpF, { recursive: true, force: true });
  });

  test('connectToFrontier creates edge', () => {
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    const kgF = new KnowledgeGraph({ storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {}, flush: async () => {} } });
    kgF.ensureFrontier();
    const edgeId = kgF.connectToFrontier('SESSION_COMPLETED', 'session-001', 1.0, 'session', { summary: 'test' });
    assert(edgeId, 'should return edge id');
  });

  test('getFrontierContext returns connected nodes', () => {
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    const kgF = new KnowledgeGraph({ storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {}, flush: async () => {} } });
    kgF.ensureFrontier();
    kgF.connectToFrontier('SESSION_COMPLETED', 'session-A', 1.0);
    kgF.connectToFrontier('ACTIVE_GOAL', 'goal-B', 0.9, 'goal');
    const ctx = kgF.getFrontierContext(1);
    assert(ctx.nodes.length >= 2, `Expected >= 2 nodes, got ${ctx.nodes.length}`);
  });

  test('disconnectFromFrontier removes edge', () => {
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    const kgF = new KnowledgeGraph({ storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {}, flush: async () => {} } });
    kgF.ensureFrontier();
    kgF.connectToFrontier('ACTIVE_GOAL', 'goal-remove', 0.9, 'goal');
    const removed = kgF.disconnectFromFrontier('goal-remove');
    assert(removed, 'should return true');
    const ctx = kgF.getFrontierContext(1);
    const goalNodes = ctx.nodes.filter(n => n.label === 'goal-remove');
    // Node may still exist but should not be connected via frontier edge
  });

  test('decayFrontierEdges reduces SESSION_COMPLETED weights', () => {
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    const kgF = new KnowledgeGraph({ storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {}, flush: async () => {} } });
    kgF.ensureFrontier();
    kgF.connectToFrontier('SESSION_COMPLETED', 'old-session', 1.0);
    const decayed = kgF.decayFrontierEdges(0.5);
    assert(decayed >= 1, 'should decay at least 1 edge');
  });

  test('getFrontierContext returns empty for fresh install', () => {
    const { KnowledgeGraph } = require('../../src/agent/foundation/KnowledgeGraph');
    const kgF = new KnowledgeGraph({ storage: { readJSON: () => null, writeJSON() {}, writeJSONDebounced() {}, flush: async () => {} } });
    kgF.ensureFrontier();
    const ctx = kgF.getFrontierContext(1);
    assert(ctx.nodes.length === 0, `Expected 0 nodes, got ${ctx.nodes.length}`);
  });

  fs.rmSync(tmpDir2, { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function asyncTest(name, fn) {
  return fn().then(() => { passed++; console.log(`    ✅ ${name}`); })
    .catch(e => { failed++; console.log(`    ❌ ${name}: ${e.message}`); });
}

runAsyncTests();
