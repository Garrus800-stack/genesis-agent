'use strict';
// v7.9.22 Item 5 — kgNodeCount reflects the real graph: 0 at construction (the graph
// loads later), the real N after asyncLoad, node-added mirrors the grown size (no
// free-running double-count), and a prune to M reads M. Without a graph it falls back
// to the increment.
const path = require('path');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..', '..');
const { Homeostasis } = require(path.join(ROOT, 'src/agent/organism/Homeostasis'));
let passed = 0, failed = 0;
function test(n, fn) { try { fn(); console.log('    \u2705 ' + n); passed++; } catch (e) { console.log('    \u274c ' + n + ': ' + e.message); failed++; } }

function makeBus() {
  const h = {};
  return { on(e, f) { (h[e] = h[e] || []).push(f); return () => {}; },
           fire(e, d) { (h[e] || []).forEach(f => f(d)); },
           emit(e, d) { this.fire(e, d); } };
}
function makeKg(n) { const nodes = new Map(); for (let i = 0; i < n; i++) nodes.set('n' + i, {}); return { graph: { nodes } }; }

test('production order: 0 at construction, real N after asyncLoad', () => {
  const kg = makeKg(0);
  const ho = new Homeostasis({ bus: makeBus(), knowledgeGraph: kg, storage: null });
  assert.strictEqual(ho.vitals.kgNodeCount.value, 0, 'constructor must not seed from an empty graph');
  for (let i = 0; i < 12; i++) kg.graph.nodes.set('n' + i, {});   // KG loads its nodes
  ho.asyncLoad();   // async, but body is synchronous (no await)
  assert.strictEqual(ho.vitals.kgNodeCount.value, 12, 'asyncLoad seeds the real size');
});
test('node-added mirrors the real grown size, not a free-running count', () => {
  const kg = makeKg(12);
  const bus = makeBus();
  const ho = new Homeostasis({ bus, knowledgeGraph: kg, storage: null });
  bus.fire('knowledge:node-added');
  assert.strictEqual(ho.vitals.kgNodeCount.value, 12, 'mirrors size — no double-count');
  kg.graph.nodes.set('n12', {});
  bus.fire('knowledge:node-added');
  assert.strictEqual(ho.vitals.kgNodeCount.value, 13);
});
test('a prune to M reads M, not a stale higher value', () => {
  const kg = makeKg(20);
  const bus = makeBus();
  const ho = new Homeostasis({ bus, knowledgeGraph: kg, storage: null });
  ho.asyncLoad();
  assert.strictEqual(ho.vitals.kgNodeCount.value, 20);
  for (let i = 5; i < 20; i++) kg.graph.nodes.delete('n' + i);
  bus.fire('knowledge:nodes-pruned', { remaining: 5 });
  assert.strictEqual(ho.vitals.kgNodeCount.value, 5);
});
test('without a graph injected, node-added falls back to the increment', () => {
  const bus = makeBus();
  const ho = new Homeostasis({ bus, storage: null });
  const before = ho.vitals.kgNodeCount.value;
  bus.fire('knowledge:node-added');
  assert.strictEqual(ho.vitals.kgNodeCount.value, before + 1);
});

console.log('\n    ' + passed + ' passed \u00b7 ' + failed + ' failed \u00b7 v7.9.22 Item 5 kgNodeCount');
process.exit(failed > 0 ? 1 : 0);
