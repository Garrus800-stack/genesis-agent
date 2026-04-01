// ============================================================
// Test: GraphStore — pure graph data structure
// ============================================================
let passed = 0, failed = 0;
const failures = [];
// v3.5.2: Fixed — queue-based async-safe test runner
const _testQueue = [];
function test(name, fn) { _testQueue.push({ name, fn }); }
function assert(c, m) { if (!c) throw new Error(m || 'Assertion failed'); }
const { GraphStore } = require('../../src/agent/foundation/GraphStore');

console.log('\n  📊 GraphStore');

test('addNode creates and returns id', () => {
  const g = new GraphStore();
  const id = g.addNode('concept', 'JavaScript', { desc: 'lang' });
  assert(id.startsWith('n_')); assert(g.nodes.size === 1);
});
test('addNode deduplicates by label', () => {
  const g = new GraphStore();
  const id1 = g.addNode('concept', 'Rust');
  const id2 = g.addNode('concept', 'rust');
  assert(id1 === id2); assert(g.nodes.size === 1);
});
test('addEdge connects two nodes', () => {
  const g = new GraphStore();
  const a = g.addNode('concept', 'A'); const b = g.addNode('concept', 'B');
  const e = g.addEdge(a, b, 'relates-to', 0.5);
  assert(e.startsWith('e_')); assert(g.edges.size === 1);
});
test('addEdge strengthens duplicate', () => {
  const g = new GraphStore();
  const a = g.addNode('concept', 'X'); const b = g.addNode('concept', 'Y');
  g.addEdge(a, b, 'uses', 0.5); g.addEdge(a, b, 'uses', 0.5);
  assert(g.edges.size === 1);
  const edge = g.edges.values().next().value;
  assert(edge.weight === 0.6, `Expected 0.6 got ${edge.weight}`);
});
test('addEdge rejects dangling', () => {
  const g = new GraphStore();
  assert(g.addEdge('fake1', 'fake2', 'x') === null);
});
test('connect creates nodes + edge', () => {
  const g = new GraphStore();
  g.connect('Cat', 'is', 'Animal');
  assert(g.nodes.size === 2); assert(g.edges.size === 1);
});
test('getNeighbors returns sorted by weight', () => {
  const g = new GraphStore();
  const a = g.addNode('c', 'A'); const b = g.addNode('c', 'B'); const c = g.addNode('c', 'C');
  g.addEdge(a, b, 'r', 0.3); g.addEdge(a, c, 'r', 0.9);
  const n = g.getNeighbors(a);
  assert(n.length === 2); assert(n[0].node.label === 'C');
});
test('getNeighbors respects filter', () => {
  const g = new GraphStore();
  const a = g.addNode('c', 'A'); const b = g.addNode('c', 'B'); const c = g.addNode('c', 'C');
  g.addEdge(a, b, 'uses', 0.5); g.addEdge(a, c, 'extends', 0.5);
  assert(g.getNeighbors(a, 'uses').length === 1);
});
test('findNode exact match', () => {
  const g = new GraphStore();
  g.addNode('concept', 'Electron');
  assert(g.findNode('electron').label === 'Electron');
});
test('findNode partial match', () => {
  const g = new GraphStore();
  g.addNode('concept', 'Knowledge Graph');
  assert(g.findNode('knowledge').label === 'Knowledge Graph');
});
test('traverse BFS returns distances', () => {
  const g = new GraphStore();
  const a = g.addNode('c', 'A'); const b = g.addNode('c', 'B'); const c = g.addNode('c', 'C');
  g.addEdge(a, b, 'r'); g.addEdge(b, c, 'r');
  const result = g.traverse(a, 3);
  assert(result.length === 2);
  assert(result[0].depth === 1); assert(result[1].depth === 2);
});
test('findPath returns shortest path', () => {
  const g = new GraphStore();
  const a = g.addNode('c', 'A'); const b = g.addNode('c', 'B'); const c = g.addNode('c', 'C');
  g.addEdge(a, b, 'r'); g.addEdge(b, c, 'r');
  const path = g.findPath(a, c);
  assert(path !== null && path.length === 2);
});
test('findPath returns null for disconnected', () => {
  const g = new GraphStore();
  const a = g.addNode('c', 'X'); g.addNode('c', 'Y');
  assert(g.findPath(a, 'fake') === null);
});
test('pageRank returns ranked nodes', () => {
  const g = new GraphStore();
  const hub = g.addNode('c', 'Hub');
  for (let i = 0; i < 5; i++) { const n = g.addNode('c', `Spoke${i}`); g.addEdge(hub, n, 'r'); }
  const ranks = g.pageRank(10, 0.85, 3);
  assert(ranks.length === 3); assert(ranks[0].score > 0);
});
test('findBridgeNodes identifies bridges', () => {
  const g = new GraphStore();
  const a = g.addNode('c', 'A'); const b = g.addNode('c', 'B'); const bridge = g.addNode('c', 'Bridge');
  const d = g.addNode('c', 'D'); const e = g.addNode('c', 'E');
  g.addEdge(a, bridge, 'r'); g.addEdge(b, bridge, 'r');
  g.addEdge(bridge, d, 'r'); g.addEdge(bridge, e, 'r');
  const bridges = g.findBridgeNodes(3);
  assert(bridges.length > 0); assert(bridges[0].node.label === 'Bridge');
});
test('serialize/deserialize roundtrip', () => {
  const g = new GraphStore();
  g.addNode('concept', 'Alpha', { x: 1 }); g.addNode('concept', 'Beta');
  g.connect('Alpha', 'links', 'Beta');
  const data = g.serialize();
  const g2 = new GraphStore();
  g2.deserialize(data);
  assert(g2.nodes.size === 2); assert(g2.edges.size === 1);
  assert(g2.findNode('alpha').label === 'Alpha');
  assert(g2.getNodesByType('concept').length === 2);
});
test('getStats returns correct counts', () => {
  const g = new GraphStore();
  g.addNode('concept', 'X'); g.addNode('entity', 'Y'); g.connect('X', 'r', 'Y');
  const s = g.getStats();
  // connect() calls addNode('concept', 'X') (dedup) + addNode('concept', 'Y') (new, different type key)
  assert(s.nodes === 3); assert(s.edges === 1);
  assert(s.types.concept === 2); assert(s.types.entity === 1);
});

// v3.5.2: Async-safe runner — properly awaits all tests
(async () => {
  for (const t of _testQueue) {
    try {
      const r = t.fn(); if (r && r.then) await r;
      passed++; console.log(`    ✅ ${t.name}`);
    } catch (err) {
      failed++; console.log(`    ❌ ${t.name}: ${err.message}`);
    }
  }
  console.log(`\n    ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
})();
