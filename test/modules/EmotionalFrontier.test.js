// ============================================================
// Test: EmotionalFrontier.js — v7.1.5 Emotional Continuity
//
// Tests all three components:
//   A. Frontier Emotion Writer (writeImprint, peaks, sustained)
//   B. Boot Emotion Restore (restoreAtBoot, dampening)
//   C. Imprint Query API (getRecentImprints, cache, dashboard)
//
// Plus: max-imprint pruning, edge decay integration, config tunables.
// ============================================================

const { describe, test, assert, assertEqual, run } = require('../harness');
const { EmotionalFrontier } = require('../../src/agent/organism/EmotionalFrontier');
const { EmotionalState } = require('../../src/agent/organism/EmotionalState');

// ── Mock factories ──────────────────────────────────────────

function mockBus() {
  const events = [];
  return {
    emit(event, data, opts) { events.push({ event, data, opts }); },
    on() { return () => {}; },
    _events: events,
  };
}

function mockStorage() {
  const store = new Map();
  return {
    writeJSONDebounced(key, data) { store.set(key, JSON.parse(JSON.stringify(data))); },
    writeJSON(key, data) { store.set(key, JSON.parse(JSON.stringify(data))); },
    readJSON(key, fallback) { return store.has(key) ? store.get(key) : fallback; },
    _store: store,
  };
}

/**
 * Create a minimal KnowledgeGraph mock that implements the
 * frontier API: connectToFrontier, disconnectFromFrontier,
 * getNode, findNode, ensureFrontier, graph.edges/nodes.
 */
function mockKnowledgeGraph() {
  const nodes = new Map();
  const edges = new Map();
  let nodeCounter = 0;
  let edgeCounter = 0;

  // Ensure frontier exists
  const frontierId = `n_frontier`;
  nodes.set(frontierId, {
    id: frontierId, type: 'system', label: 'frontier',
    properties: { role: 'focus-anchor' }, created: Date.now(),
    accessed: Date.now(), accessCount: 0,
  });

  return {
    graph: { nodes, edges, findNode(label) {
      for (const [, n] of nodes) { if (n.label === label.toLowerCase().trim()) return n; }
      return null;
    }},
    getNode(id) { return nodes.get(id) || null; },
    findNode(label) { return this.graph.findNode(label); },
    ensureFrontier() { return nodes.get(frontierId); },
    connectToFrontier(relation, targetLabel, weight, targetType, targetProps) {
      const normalizedLabel = targetLabel.toLowerCase().trim();
      let target = this.graph.findNode(normalizedLabel);
      if (!target) {
        const tid = `n_${++nodeCounter}`;
        target = {
          id: tid, type: targetType, label: normalizedLabel,
          properties: { ...targetProps }, created: Date.now(),
          accessed: Date.now(), accessCount: 0,
        };
        nodes.set(tid, target);
      } else {
        target.properties = { ...target.properties, ...targetProps };
      }
      const eid = `e_${++edgeCounter}`;
      edges.set(eid, { id: eid, source: frontierId, target: target.id, relation, weight, created: Date.now() });
      return eid;
    },
    disconnectFromFrontier(targetLabel) {
      const normalizedLabel = targetLabel.toLowerCase().trim();
      const target = this.graph.findNode(normalizedLabel);
      if (!target) return false;
      for (const [eid, edge] of edges) {
        if (edge.source === frontierId && edge.target === target.id) {
          edges.delete(eid);
          return true;
        }
      }
      return false;
    },
    _frontierId: frontierId,
  };
}

/**
 * Create an EmotionalState with controllable mood history.
 */
function mockEmotionalState(overrides = {}) {
  const es = new EmotionalState({ bus: null, storage: null, intervals: null, config: {} });
  // Override mood history if provided
  if (overrides.moodHistory) {
    es._moodHistory = overrides.moodHistory;
  }
  return es;
}

/**
 * Generate mock mood history with a frustration spike.
 */
function historyWithFrustrationPeak(peakValue = 0.82, count = 20) {
  const history = [];
  for (let i = 0; i < count; i++) {
    history.push({
      curiosity: 0.6, satisfaction: 0.5,
      frustration: i === Math.floor(count / 2) ? peakValue : 0.15,
      energy: 0.7, loneliness: 0.3,
      mood: 'calm', ts: Date.now() - (count - i) * 60000,
    });
  }
  return history;
}

/**
 * Generate mood history with sustained high curiosity.
 */
function historyWithSustainedCuriosity(avgCuriosity = 0.85, count = 20) {
  return Array.from({ length: count }, (_, i) => ({
    curiosity: avgCuriosity + (Math.random() - 0.5) * 0.1,
    satisfaction: 0.5, frustration: 0.15,
    energy: 0.7, loneliness: 0.3,
    mood: 'curious', ts: Date.now() - (count - i) * 60000,
  }));
}

// ══════════════════════════════════════════════════════════
// TEST SUITES
// ══════════════════════════════════════════════════════════

describe('EmotionalFrontier — Construction', () => {

  test('creates with default config', () => {
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    assert(ef._restoreFactor === 0.15, `restoreFactor should be 0.15, got ${ef._restoreFactor}`);
    assert(ef._maxImprints === 10, `maxImprints should be 10, got ${ef._maxImprints}`);
    assert(ef._peakThreshold === 0.3, `peakThreshold should be 0.3`);
  });

  test('accepts custom config overrides', () => {
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
      config: { restoreFactor: 0.25, maxImprints: 5, peakThreshold: 0.2 },
    });
    assert(ef._restoreFactor === 0.25, 'custom restoreFactor');
    assert(ef._maxImprints === 5, 'custom maxImprints');
    assert(ef._peakThreshold === 0.2, 'custom peakThreshold');
  });

  test('handles null dependencies gracefully', () => {
    const ef = new EmotionalFrontier({
      bus: null, emotionalState: null,
      knowledgeGraph: null, storage: null,
    });
    assert(ef.writeImprint('s-test') === null, 'writeImprint should return null with no deps');
    // restoreAtBoot should not throw
    ef.restoreAtBoot();
    assert(ef.getRecentImprints().length === 0, 'getRecentImprints should return empty');
  });
});

describe('EmotionalFrontier — Peak Extraction', () => {

  test('detects frustration peak above threshold', () => {
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    const peaks = ef._extractPeaks();
    const frustPeak = peaks.find(p => p.dim === 'frustration');
    assert(frustPeak !== undefined, 'should find frustration peak');
    assert(frustPeak.value === 0.82, `peak value should be 0.82, got ${frustPeak.value}`);
    assert(frustPeak.baseline === 0.1, `baseline should be 0.1, got ${frustPeak.baseline}`);
  });

  test('ignores peaks below threshold', () => {
    // Frustration at 0.35 — only 0.25 above baseline 0.1, below threshold 0.3
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.35) });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    const peaks = ef._extractPeaks();
    const frustPeak = peaks.find(p => p.dim === 'frustration');
    assert(frustPeak === undefined, 'should not find frustration peak below threshold');
  });

  test('returns max 5 peaks', () => {
    // All dimensions spiked high
    const history = Array.from({ length: 20 }, (_, i) => ({
      curiosity: 0.95, satisfaction: 0.95, frustration: 0.95,
      energy: 0.95, loneliness: 0.95,
      mood: 'extreme', ts: Date.now() - i * 60000,
    }));
    const es = mockEmotionalState({ moodHistory: history });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    const peaks = ef._extractPeaks();
    assert(peaks.length <= 5, `should cap at 5 peaks, got ${peaks.length}`);
  });

  test('returns empty for empty mood history', () => {
    const es = mockEmotionalState({ moodHistory: [] });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    assert(ef._extractPeaks().length === 0, 'empty history → no peaks');
  });
});

describe('EmotionalFrontier — Sustained Extraction', () => {

  test('detects sustained high curiosity', () => {
    const es = mockEmotionalState({ moodHistory: historyWithSustainedCuriosity(0.85) });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    const sustained = ef._extractSustained();
    const curiSus = sustained.find(s => s.dim === 'curiosity');
    assert(curiSus !== undefined, 'should find sustained curiosity');
    assert(curiSus.ratio >= 0.6, `ratio should be >= 0.6, got ${curiSus.ratio}`);
  });

  test('returns empty for insufficient history', () => {
    const es = mockEmotionalState({ moodHistory: [{ curiosity: 0.9, satisfaction: 0.5, frustration: 0.1, energy: 0.7, loneliness: 0.3, ts: Date.now() }] });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    assert(ef._extractSustained().length === 0, 'need at least 5 snapshots');
  });
});

describe('EmotionalFrontier — writeImprint', () => {

  test('writes imprint to KnowledgeGraph frontier', () => {
    const bus = mockBus();
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const ef = new EmotionalFrontier({ bus, emotionalState: es, knowledgeGraph: kg, storage: mockStorage() });

    const result = ef.writeImprint('s-test-123');
    assert(result !== null, 'should return imprint data');
    assert(result.peaks.length > 0, 'should have peaks');
    assert(result.dominantMood !== undefined, 'should have dominantMood');

    // Check KG was updated
    const imprintNode = kg.graph.findNode('imprint-s-test-123');
    assert(imprintNode !== null, 'imprint node should exist in KG');

    // Check event was emitted
    const emitted = bus._events.find(e => e.event === 'emotional-frontier:imprint-written');
    assert(emitted !== undefined, 'should emit imprint-written event');
  });

  test('skips imprint when no emotional activity', () => {
    const es = mockEmotionalState({ moodHistory: [] });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    assert(ef.writeImprint('s-quiet') === null, 'should skip for empty history');
  });

  test('includes session context in imprint', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const ef = new EmotionalFrontier({ bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage() });

    ef.writeImprint('s-ctx', { topics: ['refactoring', 'tests'], errors: ['SyntaxError'] });
    const node = kg.graph.findNode('imprint-s-ctx');
    assert(node !== null, 'node should exist');
    assert(Array.isArray(node.properties.topics), 'should have topics');
    assert(node.properties.error_count === 1, 'should have error_count');
  });

  test('increments stats on write', () => {
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const ef = new EmotionalFrontier({ bus: mockBus(), emotionalState: es, knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage() });
    ef.writeImprint('s-1');
    assert(ef._stats.imprintsWritten === 1, 'imprintsWritten should be 1');
    assert(ef._stats.peaksFound > 0, 'peaksFound should be > 0');
  });
});

describe('EmotionalFrontier — Max-Imprint Pruning', () => {

  test('evicts weakest imprint when at max', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage(),
      config: { maxImprints: 3 },
    });

    // Write 3 imprints
    ef.writeImprint('s-1');
    ef.writeImprint('s-2');
    ef.writeImprint('s-3');

    // Manually decay first two edges to make them weaker
    for (const [, edge] of kg.graph.edges) {
      if (edge.relation === 'EMOTIONAL_IMPRINT') {
        const target = kg.getNode(edge.target);
        if (target && (target.label === 'imprint-s-1' || target.label === 'imprint-s-2')) {
          edge.weight = 0.1; // Weakened
        }
      }
    }

    // Write 4th — should evict weakest
    ef.writeImprint('s-4');

    // Count remaining EMOTIONAL_IMPRINT edges
    let imprintEdgeCount = 0;
    for (const [, edge] of kg.graph.edges) {
      if (edge.relation === 'EMOTIONAL_IMPRINT') imprintEdgeCount++;
    }
    assert(imprintEdgeCount <= 3, `should have <= 3 imprint edges, got ${imprintEdgeCount}`);
  });
});

describe('EmotionalFrontier — Boot Emotion Restore', () => {

  test('restoreAtBoot shifts frustration value correctly', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState();

    // Manually create an imprint in the frontier
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-s-prev', 1.0, 'emotional_imprint', {
      peaks: [{ dim: 'frustration', value: 0.82, baseline: 0.1, ts: Date.now() - 3600000 }],
      sustained: [],
      dominant_mood: 'frustrated',
      session_id: 's-prev',
      created: Date.now() - 3600000,
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage(),
    });

    const beforeFrustration = es.dimensions.frustration.value;
    ef.restoreAtBoot();
    const afterFrustration = es.dimensions.frustration.value;

    // Expected delta: (0.82 - 0.1) * 0.15 = 0.108
    const expectedDelta = (0.82 - 0.1) * 0.15;
    const actualDelta = afterFrustration - beforeFrustration;

    assert(
      Math.abs(actualDelta - expectedDelta) < 0.02,
      `delta should be ~${expectedDelta.toFixed(3)}, got ${actualDelta.toFixed(3)}`
    );
  });

  test('restoreAtBoot does nothing with no imprints', () => {
    const es = mockEmotionalState();
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es,
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });

    const before = { ...es.getState() };
    ef.restoreAtBoot();
    const after = es.getState();

    // All values should be unchanged
    for (const dim of Object.keys(before)) {
      assert(before[dim] === after[dim], `${dim} should be unchanged`);
    }
  });

  test('restoreAtBoot respects dimension min/max clamping', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState();

    // Set energy at max already
    es.dimensions.energy.value = 1.0;

    // Create imprint with energy peak
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-s-max', 1.0, 'emotional_imprint', {
      peaks: [{ dim: 'energy', value: 0.99, baseline: 0.7, ts: Date.now() }],
      sustained: [],
      dominant_mood: 'energized',
      session_id: 's-max',
      created: Date.now(),
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage(),
    });
    ef.restoreAtBoot();

    assert(es.dimensions.energy.value <= 1.0, `energy should stay <= 1.0, got ${es.dimensions.energy.value}`);
  });

  test('restoreAtBoot applies sustained at half factor', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState();

    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-s-sus', 1.0, 'emotional_imprint', {
      peaks: [],
      sustained: [{ dim: 'curiosity', avg: 0.85, ratio: 0.8 }],
      dominant_mood: 'curious',
      session_id: 's-sus',
      created: Date.now(),
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage(),
    });

    const before = es.dimensions.curiosity.value;
    ef.restoreAtBoot();
    const after = es.dimensions.curiosity.value;

    // Expected: (0.85 - 0.6) * 0.15 * 0.5 = 0.01875
    const expectedDelta = (0.85 - 0.6) * 0.15 * 0.5;
    const actualDelta = after - before;

    assert(
      Math.abs(actualDelta - expectedDelta) < 0.01,
      `sustained delta should be ~${expectedDelta.toFixed(4)}, got ${actualDelta.toFixed(4)}`
    );
  });

  test('restoreAtBoot emits event on successful restore', () => {
    const bus = mockBus();
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState();

    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-s-evt', 1.0, 'emotional_imprint', {
      peaks: [{ dim: 'frustration', value: 0.82, baseline: 0.1 }],
      sustained: [],
      session_id: 's-evt',
      created: Date.now(),
    });

    const ef = new EmotionalFrontier({ bus, emotionalState: es, knowledgeGraph: kg, storage: mockStorage() });
    ef.restoreAtBoot();

    const emitted = bus._events.find(e => e.event === 'emotional-frontier:boot-restored');
    assert(emitted !== undefined, 'should emit boot-restored event');
    assert(emitted.data.shifted > 0, 'shifted count should be > 0');
  });
});

describe('EmotionalFrontier — Imprint Query API', () => {

  test('getRecentImprints returns sorted by weight', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState();

    // Create two imprints with different weights
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-old', 0.3, 'emotional_imprint', {
      peaks: [], sustained: [], session_id: 's-old', created: Date.now() - 86400000,
    });
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-new', 1.0, 'emotional_imprint', {
      peaks: [{ dim: 'curiosity', value: 0.9 }], sustained: [], session_id: 's-new', created: Date.now(),
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage(),
    });

    const imprints = ef.getRecentImprints(2);
    assert(imprints.length === 2, `should return 2 imprints, got ${imprints.length}`);
    assert(imprints[0].weight >= imprints[1].weight, 'should be sorted by weight descending');
  });

  test('getRecentImprints uses cache', () => {
    const kg = mockKnowledgeGraph();
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-cached', 1.0, 'emotional_imprint', {
      peaks: [], sustained: [], session_id: 's-cache', created: Date.now(),
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: kg, storage: mockStorage(),
    });

    // First call populates cache
    const first = ef.getRecentImprints();
    assert(ef._imprintCache !== null, 'cache should be populated');

    // Second call should return from cache
    const second = ef.getRecentImprints();
    assert(first.length === second.length, 'cached result should match');
  });

  test('cache invalidated after writeImprint', () => {
    const kg = mockKnowledgeGraph();
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const ef = new EmotionalFrontier({ bus: mockBus(), emotionalState: es, knowledgeGraph: kg, storage: mockStorage() });

    // Populate cache
    ef.getRecentImprints();
    assert(ef._imprintCache !== null, 'cache should exist');

    // Write new imprint — should invalidate
    ef.writeImprint('s-invalidate');
    assert(ef._imprintCache === null, 'cache should be invalidated after write');
  });

  test('buildPromptContext returns empty for no imprints', () => {
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    assertEqual(ef.buildPromptContext(), '', 'should return empty string');
  });

  test('buildPromptContext includes mood and peaks', () => {
    const kg = mockKnowledgeGraph();
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-prompt', 1.0, 'emotional_imprint', {
      peaks: [{ dim: 'frustration', value: 0.82 }],
      sustained: [{ dim: 'curiosity', avg: 0.75 }],
      dominant_mood: 'frustrated',
      session_id: 's-prompt',
      created: Date.now(),
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: kg, storage: mockStorage(),
    });

    const ctx = ef.buildPromptContext();
    assert(ctx.includes('EMOTIONAL MEMORY'), 'should include header');
    assert(ctx.includes('frustrated'), 'should include mood');
  });

  test('getDashboardLine returns formatted string', () => {
    const kg = mockKnowledgeGraph();
    kg.connectToFrontier('EMOTIONAL_IMPRINT', 'imprint-dash', 1.0, 'emotional_imprint', {
      peaks: [{ dim: 'frustration', value: 0.82, trigger: 'multi-file refactor' }],
      sustained: [],
      dominant_mood: 'frustrated',
      session_id: 's-dash',
      created: Date.now() - 3600000,
    });

    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: kg, storage: mockStorage(),
    });

    const line = ef.getDashboardLine();
    assert(line !== null, 'should return a line');
    assert(line.includes('frustrated'), 'should include mood');
    assert(line.includes('100% weight'), 'should include weight');
  });

  test('getDashboardLine returns null for no imprints', () => {
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });
    assert(ef.getDashboardLine() === null, 'should return null');
  });
});

describe('EmotionalFrontier — getReport', () => {

  test('returns complete report structure', () => {
    const ef = new EmotionalFrontier({
      bus: mockBus(), emotionalState: mockEmotionalState(),
      knowledgeGraph: mockKnowledgeGraph(), storage: mockStorage(),
    });

    const report = ef.getReport();
    assert(report.stats !== undefined, 'should have stats');
    assert(report.config !== undefined, 'should have config');
    assert(report.config.restoreFactor === 0.15, 'should show restoreFactor');
    assert(typeof report.activeImprints === 'number', 'should have activeImprints count');
  });
});

describe('EmotionalState — v7.1.5 API Extensions', () => {

  test('exportMoodHistory returns copy of history', () => {
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak() });
    const exported = es.exportMoodHistory();
    assert(Array.isArray(exported), 'should return array');
    assert(exported.length === 20, 'should have 20 entries');
    // Verify it's a copy, not a reference
    exported.push({ fake: true });
    assert(es._moodHistory.length === 20, 'original should be unchanged');
  });

  test('getPeaks finds frustration peak', () => {
    const es = mockEmotionalState({ moodHistory: historyWithFrustrationPeak(0.82) });
    const peaks = es.getPeaks(0.3);
    const frustPeak = peaks.find(p => p.dim === 'frustration');
    assert(frustPeak !== undefined, 'should find frustration peak');
    assert(frustPeak.value === 0.82, `value should be 0.82, got ${frustPeak.value}`);
  });

  test('getSustained finds sustained curiosity', () => {
    const es = mockEmotionalState({ moodHistory: historyWithSustainedCuriosity(0.85) });
    const sustained = es.getSustained(0.6, 0.6);
    const curiSus = sustained.find(s => s.dim === 'curiosity');
    assert(curiSus !== undefined, 'should find sustained curiosity');
  });

  test('getSustained returns empty for short history', () => {
    const es = mockEmotionalState({ moodHistory: [{ curiosity: 0.9, satisfaction: 0.5, frustration: 0.1, energy: 0.7, loneliness: 0.3, ts: Date.now() }] });
    assert(es.getSustained().length === 0, 'need at least 5 snapshots');
  });
});

run();
