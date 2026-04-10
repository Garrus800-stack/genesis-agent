#!/usr/bin/env node
// ============================================================
// TEST — GraphStore Causal Operations + GraphReasoner Causal Reasoning
// v7.0.9 Phase 1
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { GraphStore } = require('../../src/agent/foundation/GraphStore');

// ════════════════════════════════════════════════════════
// GraphStore — Causal Operations
// ════════════════════════════════════════════════════════

describe('GraphStore — promoteEdge', () => {
  test('changes relation and weight', () => {
    const g = new GraphStore();
    const a = g.addNode('action', 'editFile');
    const b = g.addNode('effect', 'testFail');
    const eid = g.addEdge(a, b, 'correlated_with', 0.4);
    const ok = g.promoteEdge(eid, 'caused', 0.8);
    assert(ok, 'should return true');
    const edge = g.edges.get(eid);
    assertEqual(edge.relation, 'caused');
    assertEqual(edge.weight, 0.8);
  });

  test('returns false for nonexistent edge', () => {
    const g = new GraphStore();
    assert(!g.promoteEdge('fake-id', 'caused', 0.9), 'should return false');
  });

  test('clamps weight to 1.0', () => {
    const g = new GraphStore();
    const a = g.addNode('a', 'A'), b = g.addNode('b', 'B');
    const eid = g.addEdge(a, b, 'correlated_with', 0.5);
    g.promoteEdge(eid, 'caused', 1.5);
    assertEqual(g.edges.get(eid).weight, 1.0);
  });
});

describe('GraphStore — degradeEdges', () => {
  test('degrades matching edges', () => {
    const g = new GraphStore();
    const a = g.addNode('action', 'editFile(src/foo.js)');
    const b = g.addNode('effect', 'testFail');
    g.addEdge(a, b, 'caused', 0.8);
    const count = g.degradeEdges({
      sourceContains: 'foo.js',
      fromRelation: 'caused',
      toRelation: 'correlated_with',
      confMultiplier: 0.5,
    });
    assertEqual(count, 1);
    const edge = Array.from(g.edges.values())[0];
    assertEqual(edge.relation, 'correlated_with');
    assertEqual(edge.weight, 0.4);
  });

  test('skips non-matching edges', () => {
    const g = new GraphStore();
    const a = g.addNode('action', 'editFile(src/bar.js)');
    const b = g.addNode('effect', 'testFail');
    g.addEdge(a, b, 'caused', 0.8);
    const count = g.degradeEdges({
      sourceContains: 'foo.js',
      fromRelation: 'caused',
      toRelation: 'correlated_with',
      confMultiplier: 0.5,
    });
    assertEqual(count, 0);
  });

  test('respects fromRelation filter', () => {
    const g = new GraphStore();
    const a = g.addNode('action', 'editFile(src/foo.js)');
    const b = g.addNode('effect', 'testFail');
    g.addEdge(a, b, 'depends_on', 0.8);
    const count = g.degradeEdges({
      sourceContains: 'foo.js',
      fromRelation: 'caused',
      toRelation: 'correlated_with',
      confMultiplier: 0.5,
    });
    assertEqual(count, 0);
  });
});

describe('GraphStore — getEdgesByRelation', () => {
  test('filters correctly', () => {
    const g = new GraphStore();
    const a = g.addNode('a', 'A'), b = g.addNode('b', 'B'), c = g.addNode('c', 'C');
    g.addEdge(a, b, 'caused', 0.8);
    g.addEdge(a, c, 'correlated_with', 0.4);
    assertEqual(g.getEdgesByRelation('caused').length, 1);
    assertEqual(g.getEdgesByRelation('correlated_with').length, 1);
    assertEqual(g.getEdgesByRelation('unknown').length, 0);
  });
});

describe('GraphStore — pruneEdges', () => {
  test('removes below confidence threshold', () => {
    const g = new GraphStore();
    const a = g.addNode('a', 'A'), b = g.addNode('b', 'B'), c = g.addNode('c', 'C');
    g.addEdge(a, b, 'caused', 0.1);
    g.addEdge(a, c, 'caused', 0.9);
    const pruned = g.pruneEdges({ minConfidence: 0.3 });
    assertEqual(pruned, 1);
    assertEqual(g.edges.size, 1);
  });

  test('respects relation filter', () => {
    const g = new GraphStore();
    const a = g.addNode('a', 'A'), b = g.addNode('b', 'B'), c = g.addNode('c', 'C');
    g.addEdge(a, b, 'caused', 0.1);
    g.addEdge(a, c, 'correlated_with', 0.1);
    const pruned = g.pruneEdges({ minConfidence: 0.3, relation: 'caused' });
    assertEqual(pruned, 1);
    assertEqual(g.edges.size, 1);
    assertEqual(Array.from(g.edges.values())[0].relation, 'correlated_with');
  });

  test('cleans up neighbor index', () => {
    const g = new GraphStore();
    const a = g.addNode('a', 'A'), b = g.addNode('b', 'B');
    g.addEdge(a, b, 'caused', 0.05);
    g.pruneEdges({ minConfidence: 0.1 });
    assertEqual(g.getNeighbors(a).length, 0);
  });

  test('returns 0 when nothing to prune', () => {
    const g = new GraphStore();
    const a = g.addNode('a', 'A'), b = g.addNode('b', 'B');
    g.addEdge(a, b, 'caused', 0.9);
    assertEqual(g.pruneEdges({ minConfidence: 0.3 }), 0);
  });
});

// ════════════════════════════════════════════════════════
// GraphReasoner — Causal Reasoning
// ════════════════════════════════════════════════════════

describe('GraphReasoner — predictEffects', () => {
  test('returns known effects for an action', () => {
    const g = new GraphStore();
    const action = g.addNode('causal-action', 'editFile(src/foo.js)');
    const eff1 = g.addNode('causal-effect', 'test.result:FAIL');
    const eff2 = g.addNode('causal-effect', 'lint.result:WARN');
    g.addEdge(action, eff1, 'caused', 0.9);
    g.addEdge(action, eff2, 'caused', 0.6);

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });

    const effects = reasoner.predictEffects('editFile(src/foo.js)');
    assert(effects.length >= 2, 'should find 2 effects');
    assertEqual(effects[0].effect, 'test.result:FAIL'); // highest confidence first
    assert(effects[0].confidence >= 0.6, 'should have confidence');
  });

  test('returns empty for unknown action', () => {
    const g = new GraphStore();
    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    assertEqual(reasoner.predictEffects('nonexistent').length, 0);
  });

  test('filters by minConfidence', () => {
    const g = new GraphStore();
    const a = g.addNode('causal-action', 'runTest');
    const e1 = g.addNode('causal-effect', 'high-conf-effect');
    const e2 = g.addNode('causal-effect', 'low-conf-effect');
    g.addEdge(a, e1, 'caused', 0.9);
    g.addEdge(a, e2, 'caused', 0.1);

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    const effects = reasoner.predictEffects('runTest', { minConfidence: 0.5 });
    assertEqual(effects.length, 1);
  });
});

describe('GraphReasoner — causalChain', () => {
  test('finds direct causal link', () => {
    const g = new GraphStore();
    const a = g.addNode('causal-action', 'editFoo');
    const b = g.addNode('causal-effect', 'testFail');
    g.addEdge(a, b, 'caused', 0.8);

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    const result = reasoner.causalChain('editFoo', 'testFail');
    assert(result.found, 'should find direct chain');
    assertEqual(result.depth, 1);
  });

  test('finds transitive causal chain', () => {
    const g = new GraphStore();
    const a = g.addNode('causal-action', 'renameFunc');
    const b = g.addNode('causal-effect', 'importBroken');
    const c = g.addNode('causal-effect', 'buildFail');
    g.addEdge(a, b, 'caused', 0.8);
    g.addEdge(b, c, 'caused', 0.7);

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    const result = reasoner.causalChain('renameFunc', 'buildFail');
    assert(result.found, 'should find transitive chain');
    assertEqual(result.depth, 2);
    assertEqual(result.chain.length, 2);
  });

  test('returns not found for disconnected nodes', () => {
    const g = new GraphStore();
    g.addNode('causal-action', 'actionA');
    g.addNode('causal-effect', 'effectB');

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    const result = reasoner.causalChain('actionA', 'effectB');
    assert(!result.found, 'should not find chain');
  });

  test('ignores correlated_with edges', () => {
    const g = new GraphStore();
    const a = g.addNode('causal-action', 'editBar');
    const b = g.addNode('causal-effect', 'maybeRelated');
    g.addEdge(a, b, 'correlated_with', 0.4);

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    const result = reasoner.causalChain('editBar', 'maybeRelated');
    assert(!result.found, 'should not follow correlated_with');
  });

  test('respects maxDepth', () => {
    const g = new GraphStore();
    const nodes = [];
    for (let i = 0; i < 10; i++) {
      nodes.push(g.addNode('causal-effect', `chain${i}`));
    }
    for (let i = 0; i < 9; i++) {
      g.addEdge(nodes[i], nodes[i + 1], 'caused', 0.8);
    }

    const { GraphReasoner } = require('../../src/agent/intelligence/GraphReasoner');
    const reasoner = new GraphReasoner({ bus: { emit() {} }, knowledgeGraph: { graph: g } });
    const result = reasoner.causalChain('chain0', 'chain9', { maxDepth: 3 });
    assert(!result.found, 'should not find chain beyond maxDepth');
  });
});

run();
