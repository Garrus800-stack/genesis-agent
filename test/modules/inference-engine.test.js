#!/usr/bin/env node
// ============================================================
// TEST — InferenceEngine (v7.0.9 Phase 2)
//
// Tests the rule-based inference system: hardcoded rules,
// learned rules with minObservations, rule indexing,
// contradiction detection, and LLM-free reasoning.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { GraphStore } = require('../../src/agent/foundation/GraphStore');

function createTestGraph() {
  const g = new GraphStore();
  // Build a small causal graph
  const editFoo = g.addNode('causal-action', 'editFile(foo.js)');
  const testFail = g.addNode('causal-effect', 'test.result:FAIL');
  const buildFail = g.addNode('causal-effect', 'build:FAIL');
  const editBar = g.addNode('causal-action', 'editFile(bar.js)');
  const lintWarn = g.addNode('causal-effect', 'lint:WARN');

  g.addEdge(editFoo, testFail, 'caused', 0.9);
  g.addEdge(testFail, buildFail, 'caused', 0.7);
  g.addEdge(editBar, lintWarn, 'correlated_with', 0.4);

  return g;
}

function createBus() {
  const events = [];
  return { events, emit(n, d, m) { events.push({ n, d, m }); }, on() { return () => {}; } };
}

// ════════════════════════════════════════════════════════
// InferenceEngine — Core
// ════════════════════════════════════════════════════════

describe('InferenceEngine — construction', () => {
  test('creates with default rules', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const engine = new InferenceEngine({ bus: createBus(), graph: createTestGraph() });
    const stats = engine.getStats();
    assert(stats.ruleCount > 0, 'should have starter rules');
    assert(stats.ruleCount >= 4, 'should have at least 4 hardcoded rules');
  });
});

describe('InferenceEngine — hardcoded rules', () => {
  test('transitive causation: A→B→C ⟹ A→C', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const g = createTestGraph();
    const engine = new InferenceEngine({ bus: createBus(), graph: g });

    const results = engine.infer({ from: 'editFile(foo.js)', relation: 'caused' });
    // editFoo caused testFail, testFail caused buildFail
    // → transitive: editFoo caused buildFail
    assert(results.length > 0, 'should find inferred effects');
    const buildEffect = results.find(r => r.target.includes('build'));
    assert(buildEffect, 'should infer transitive causal link to buildFail');
  });

  test('hardcoded rules fire immediately (minObservations=0)', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const g = createTestGraph();
    const engine = new InferenceEngine({ bus: createBus(), graph: g });
    const results = engine.infer({ from: 'editFile(foo.js)', relation: 'caused' });
    assert(results.length >= 1, 'hardcoded rules should fire on first query');
  });
});

describe('InferenceEngine — learned rules', () => {
  test('learned rule does not fire below minObservations', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const g = createTestGraph();
    const engine = new InferenceEngine({ bus: createBus(), graph: g });

    engine.addRule({
      id: 'test-learned',
      type: 'learned',
      minObservations: 5,
      antecedent: [{ from: '?A', to: '?B', relation: 'caused' }],
      consequent: { from: '?A', to: '?B', relation: 'validated', confidence: 0.9 },
    });

    // Record only 2 observations (below threshold of 5)
    engine.recordRuleObservation('test-learned');
    engine.recordRuleObservation('test-learned');

    const stats = engine.getRuleStats('test-learned');
    assert(stats.observations === 2, 'should track observations');
    assert(stats.status === 'candidate', 'should be candidate, not active');
  });

  test('learned rule fires after reaching minObservations', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const g = createTestGraph();
    const engine = new InferenceEngine({ bus: createBus(), graph: g });

    engine.addRule({
      id: 'test-learned-active',
      type: 'learned',
      minObservations: 3,
      antecedent: [{ from: '?A', to: '?B', relation: 'caused' }],
      consequent: { from: '?A', to: '?B', relation: 'validated', confidence: 0.9 },
    });

    for (let i = 0; i < 3; i++) engine.recordRuleObservation('test-learned-active');

    const stats = engine.getRuleStats('test-learned-active');
    assertEqual(stats.status, 'active');
  });
});

describe('InferenceEngine — rule index', () => {
  test('rules are indexed by relation type', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const engine = new InferenceEngine({ bus: createBus(), graph: createTestGraph() });
    const stats = engine.getStats();
    assert(stats.indexSize > 0, 'rule index should have entries');
  });

  test('infer only checks relevant rules', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const engine = new InferenceEngine({ bus: createBus(), graph: createTestGraph() });

    // Query for 'caused' should not check rules indexed under 'depends_on'
    const before = engine.getStats().evaluations;
    engine.infer({ from: 'editFile(foo.js)', relation: 'caused' });
    const after = engine.getStats().evaluations;
    assert(after > before, 'should have evaluated some rules');
  });
});

describe('InferenceEngine — contradiction detection', () => {
  test('detects caused + prevented contradiction', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const g = new GraphStore();
    const a = g.addNode('action', 'actionX');
    const b = g.addNode('effect', 'effectY');
    g.addEdge(a, b, 'caused', 0.8);
    g.addEdge(a, b, 'prevented', 0.6);

    const engine = new InferenceEngine({ bus: createBus(), graph: g });
    const contradictions = engine.findContradictions();
    assert(contradictions.length >= 1, 'should detect contradiction');
  });

  test('no contradiction for consistent edges', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const g = createTestGraph();
    const engine = new InferenceEngine({ bus: createBus(), graph: g });
    const contradictions = engine.findContradictions();
    assertEqual(contradictions.length, 0);
  });
});

describe('InferenceEngine — getStats', () => {
  test('returns tracking summary', () => {
    const { InferenceEngine } = require('../../src/agent/cognitive/InferenceEngine');
    const engine = new InferenceEngine({ bus: createBus(), graph: createTestGraph() });
    const stats = engine.getStats();
    assert(typeof stats.ruleCount === 'number');
    assert(typeof stats.indexSize === 'number');
    assert(typeof stats.evaluations === 'number');
    assert(typeof stats.inferences === 'number');
  });
});

run();
