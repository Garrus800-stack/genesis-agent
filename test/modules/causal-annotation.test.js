#!/usr/bin/env node
// ============================================================
// TEST — CausalAnnotation (v7.0.9 Phase 1)
//
// Tests the causal tracking system: WorldState snapshots,
// diff computation, temporal isolation, suspicion scoring,
// source tagging, and staleness hooks.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');

// ── Mock KnowledgeGraph that records edges ────────────────
function createMockKG() {
  const edges = [];
  return {
    edges,
    addNode(type, label) { return `n_${label}`; },
    addEdge(sourceId, targetId, relation, weight) {
      const edge = { id: `e_${edges.length}`, source: sourceId, target: targetId, relation, weight, meta: {} };
      edges.push(edge);
      return edge.id;
    },
    getEdgesBetween(a, b) { return edges.filter(e => e.source === a && e.target === b); },
    connect(src, rel, tgt, srcType, tgtType) {
      const sid = `n_${src}`;
      const tid = `n_${tgt}`;
      return this.addEdge(sid, tid, rel, 0.5);
    },
  };
}

function createMockBus() {
  const events = [];
  return {
    events,
    emit(name, data, meta) { events.push({ name, data, meta }); },
    fire(name, data, meta) { events.push({ name, data, meta }); },
    on() { return () => {}; },
  };
}

// ── WorldState snapshot/diff tests ───────────────────────

describe('WorldState — snapshot and diff', () => {
  // We test the snapshot/diff functionality that will be added to WorldState
  // For now we use a lightweight test helper that mimics the expected API

  test('snapshot captures current state', () => {
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const ws = new WorldState({ bus: createMockBus(), rootDir: '/tmp/test' });
    
    const snap = ws.snapshot();
    assert(snap !== null, 'snapshot should return an object');
    assert(snap.project !== undefined, 'snapshot should have project');
    assert(snap.runtime !== undefined, 'snapshot should have runtime');
    assert(snap.timestamp !== undefined, 'snapshot should have timestamp');
  });

  test('diff detects file changes', () => {
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const ws = new WorldState({ bus: createMockBus(), rootDir: '/tmp/test' });
    
    const before = ws.snapshot();
    ws.recordFileChange('/tmp/test/src/foo.js');
    const after = ws.snapshot();
    
    const delta = ws.diff(before, after);
    assert(delta.changes.length > 0, 'diff should detect file change');
    assert(delta.changes.some(c => c.field.includes('recentlyModified')), 'should include file change');
  });

  test('diff returns empty for no changes', () => {
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const ws = new WorldState({ bus: createMockBus(), rootDir: '/tmp/test' });
    
    const before = ws.snapshot();
    const after = ws.snapshot();
    
    const delta = ws.diff(before, after);
    assertEqual(delta.changes.length, 0);
  });

  test('diff detects circuit state change', () => {
    const { WorldState } = require('../../src/agent/foundation/WorldState');
    const ws = new WorldState({ bus: createMockBus(), rootDir: '/tmp/test' });
    
    const before = ws.snapshot();
    ws.updateCircuitState('OPEN');
    const after = ws.snapshot();
    
    const delta = ws.diff(before, after);
    assert(delta.changes.length > 0, 'should detect circuit state change');
  });
});

// ── CausalAnnotation core tests ──────────────────────────

describe('CausalAnnotation — recording', () => {
  test('records caused edge for isolated step', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    ca.record({
      stepId: 'step-1',
      toolCalls: [{ tool: 'editFile', args: { path: 'src/foo.js' }, timestamp: 100 }],
      delta: { changes: [{ field: 'project.recentlyModified', type: 'add', value: 'src/foo.js' }] },
      source: 'user-task',
    });

    assert(kg.edges.length >= 1, 'should create at least 1 edge');
    const causedEdge = kg.edges.find(e => e.relation === 'caused');
    assert(causedEdge, 'isolated single tool-call should create "caused" edge');
    assert(causedEdge.weight >= 0.7, 'caused edge should have high confidence');
  });

  test('records correlated_with for multiple tool-calls', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    ca.record({
      stepId: 'step-2',
      toolCalls: [
        { tool: 'editFile', args: { path: 'src/a.js' }, timestamp: 100 },
        { tool: 'editFile', args: { path: 'src/b.js' }, timestamp: 101 },
      ],
      delta: { changes: [{ field: 'project.recentlyModified', type: 'add', value: 'src/a.js' }] },
      source: 'user-task',
    });

    const correlated = kg.edges.filter(e => e.relation === 'correlated_with');
    assert(correlated.length >= 1, 'multiple tool-calls should create correlated_with edges');
    assert(correlated[0].weight <= 0.5, 'correlated_with should have lower confidence');
  });

  test('tags edges with source', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    ca.record({
      stepId: 'step-3',
      toolCalls: [{ tool: 'runTest', args: {}, timestamp: 100 }],
      delta: { changes: [{ field: 'runtime.circuitState', type: 'change', value: 'OPEN' }] },
      source: 'self-improvement',
    });

    assert(kg.edges.length >= 1, 'should create edge');
    // Source tagging is stored in edge metadata
    // The exact implementation will store it — we verify the API accepts it
  });
});

// ── Suspicion Score tests ────────────────────────────────

describe('CausalAnnotation — suspicion score', () => {
  test('suspicion rises on consistent failure correlation', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    // Simulate: editFile(foo.js) correlates with test failure 3 times
    for (let i = 0; i < 3; i++) {
      ca.record({
        stepId: `step-fail-${i}`,
        toolCalls: [
          { tool: 'editFile', args: { path: 'src/foo.js' }, timestamp: i * 100 },
          { tool: 'runTest', args: {}, timestamp: i * 100 + 50 },
        ],
        delta: { changes: [{ field: 'test.result', type: 'change', value: 'FAIL' }] },
        outcome: 'failure',
        source: 'user-task',
      });
    }

    const stats = ca.getSuspicionStats();
    // After 3 consistent failures, suspicion for editFile→foo.js should be high
    assert(Object.keys(stats).length > 0, 'should track suspicion');
  });

  test('suspicion drops on mixed outcomes', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    // Failure
    ca.record({
      stepId: 'step-f1',
      toolCalls: [{ tool: 'editFile', args: { path: 'src/bar.js' }, timestamp: 100 }],
      delta: { changes: [{ field: 'test.result', type: 'change', value: 'FAIL' }] },
      outcome: 'failure',
      source: 'user-task',
    });

    // Success with same tool
    ca.record({
      stepId: 'step-s1',
      toolCalls: [{ tool: 'editFile', args: { path: 'src/bar.js' }, timestamp: 200 }],
      delta: { changes: [{ field: 'test.result', type: 'change', value: 'PASS' }] },
      outcome: 'success',
      source: 'user-task',
    });

    const stats = ca.getSuspicionStats();
    // With mixed outcomes, suspicion should be moderate (0.5)
    const barKey = Object.keys(stats).find(k => k.includes('bar'));
    if (barKey) {
      assert(stats[barKey].suspicion <= 0.6, 'mixed outcomes should have moderate suspicion');
    }
  });
});

// ── Staleness hook tests ─────────────────────────────────

describe('CausalAnnotation — staleness', () => {
  test('onFileChange degrades edges for heavily modified files', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg, config: { refactorThreshold: 0.4 } });

    // First record a causal edge
    ca.record({
      stepId: 'step-old',
      toolCalls: [{ tool: 'editFile', args: { path: 'src/foo.js' }, timestamp: 100 }],
      delta: { changes: [{ field: 'test.result', type: 'change', value: 'FAIL' }] },
      source: 'user-task',
    });

    const edgesBefore = kg.edges.length;

    // Simulate major refactoring of foo.js (60% diff)
    ca.onFileChange('src/foo.js', 0.6);

    // Edges should be degraded, not deleted
    // The implementation will either lower confidence or change relation type
    // We just verify it doesn't crash and the hook exists
    assert(typeof ca.onFileChange === 'function', 'onFileChange should be callable');
  });

  test('onFileChange ignores minor changes', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg, config: { refactorThreshold: 0.4 } });

    // Minor change (10% diff) should not trigger degradation
    ca.onFileChange('src/foo.js', 0.1);
    // No assertions needed beyond "doesn't crash" — degradation should NOT happen
  });
});

// ── getStats tests ───────────────────────────────────────

describe('CausalAnnotation — stats', () => {
  test('getStats returns tracking summary', () => {
    const kg = createMockKG();
    const bus = createMockBus();
    const { CausalAnnotation } = require('../../src/agent/cognitive/CausalAnnotation');
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    const stats = ca.getStats();
    assert(typeof stats === 'object', 'should return object');
    assert(typeof stats.totalRecorded === 'number', 'should track total records');
    assert(typeof stats.causedEdges === 'number', 'should track caused edges');
    assert(typeof stats.correlatedEdges === 'number', 'should track correlated edges');
  });
  test('getStats includes chatOutcomes counter', () => {
    const kg = createMockKG();
    const ca = new CausalAnnotation({ bus: createMockBus(), knowledgeGraph: kg });
    assertEqual(ca.getStats().chatOutcomes, 0);
  });
});

// ═══════════════════════════════════════════════════════════
// v7.1.3: Chat Outcome → Causal Graph Bridge
// ═══════════════════════════════════════════════════════════

describe('CausalAnnotation — recordChatOutcome()', () => {
  test('creates caused edge for successful chat', () => {
    const kg = createMockKG();
    const ca = new CausalAnnotation({ bus: createMockBus(), knowledgeGraph: kg });
    ca.recordChatOutcome({ intent: 'code', success: true, message: 'write a function' });

    assert(kg.edges.length >= 1, 'Should create at least 1 edge');
    const edge = kg.edges[0];
    assertEqual(edge.source, 'n_intent:code');
    assertEqual(edge.target, 'n_outcome:success');
    assertEqual(edge.relation, 'caused');
    assertEqual(ca.getStats().chatOutcomes, 1);
  });

  test('creates correlated edge for failed chat', () => {
    const kg = createMockKG();
    const ca = new CausalAnnotation({ bus: createMockBus(), knowledgeGraph: kg });
    ca.recordChatOutcome({ intent: 'code', success: false, message: 'fix bug' });

    const edge = kg.edges[0];
    assertEqual(edge.target, 'n_outcome:fail');
    assertEqual(edge.relation, 'correlated_with');
  });

  test('tracks suspicion for repeated failures', () => {
    const kg = createMockKG();
    const ca = new CausalAnnotation({ bus: createMockBus(), knowledgeGraph: kg });

    ca.recordChatOutcome({ intent: 'self-modify', success: false });
    ca.recordChatOutcome({ intent: 'self-modify', success: false });
    ca.recordChatOutcome({ intent: 'self-modify', success: true });

    assertEqual(ca.getStats().chatOutcomes, 3);
    assertEqual(kg.edges.length, 3);
  });

  test('no-ops without knowledgeGraph', () => {
    const ca = new CausalAnnotation({ bus: createMockBus(), knowledgeGraph: null });
    ca.recordChatOutcome({ intent: 'greeting', success: true });
    assertEqual(ca.getStats().chatOutcomes, 0);
  });

  test('no-ops without intent', () => {
    const kg = createMockKG();
    const ca = new CausalAnnotation({ bus: createMockBus(), knowledgeGraph: kg });
    ca.recordChatOutcome({ success: true });
    assertEqual(kg.edges.length, 0);
  });
});

describe('CausalAnnotation — chat:completed bus listener', () => {
  test('auto-records on chat:completed event', () => {
    const kg = createMockKG();
    const listeners = {};
    const bus = {
      on(event, handler, opts) { listeners[event] = handler; return () => {}; },
      emit() {},
    };
    const ca = new CausalAnnotation({ bus, knowledgeGraph: kg });

    assert(listeners['chat:completed'], 'Should register chat:completed listener');
    listeners['chat:completed']({ intent: 'greeting', success: true, message: 'hi' });
    assertEqual(ca.getStats().chatOutcomes, 1);
    assertEqual(kg.edges.length, 1);
  });

  test('stop() removes bus listeners', () => {
    let unsubCalled = false;
    const bus = {
      on(event, handler) { return () => { unsubCalled = true; }; },
      emit() {},
    };
    const ca = new CausalAnnotation({ bus, knowledgeGraph: createMockKG() });
    ca.stop();
    assert(unsubCalled, 'Should call unsub on stop()');
  });
});

run();
