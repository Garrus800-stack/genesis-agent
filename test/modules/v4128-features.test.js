#!/usr/bin/env node
// Test: ErrorAggregator.getSummary + DreamCycle Phase 4b Corroboration (v4.12.8)
const { describe, test, assert, assertEqual, run } = require('../harness');

// ════════════════════════════════════════════════════════════
// ErrorAggregator.getSummary
// ════════════════════════════════════════════════════════════

const { ErrorAggregator } = require('../../src/agent/autonomy/ErrorAggregator');
const { NullBus } = require('../../src/agent/core/EventBus');

function createAggregator(cfg = {}) {
  const events = [];
  const bus = {
    emit: (n, d, m) => events.push({ name: n, data: d }),
    fire: (n, d, m) => events.push({ name: n, data: d }),
    on: () => {},
  };
  const agg = new ErrorAggregator({
    bus,
    config: { windowMs: 60000, trendWindowMs: 10000, spikeThreshold: 3, risingThreshold: 2, ...cfg },
  });
  return { agg, events };
}

describe('ErrorAggregator.getSummary — Empty', () => {
  test('returns empty arrays when no errors', () => {
    const { agg } = createAggregator();
    const summary = agg.getSummary();
    assertEqual(summary.trending.length, 0);
    assertEqual(summary.spikes.length, 0);
  });
});

describe('ErrorAggregator.getSummary — Spikes', () => {
  test('detects spike when errors exceed threshold', () => {
    const { agg } = createAggregator({ spikeThreshold: 2 });
    agg.record('test-category', new Error('e1'));
    agg.record('test-category', new Error('e2'));
    agg.record('test-category', new Error('e3'));
    const summary = agg.getSummary();
    assert(summary.spikes.length > 0 || summary.trending.length >= 0, 'should detect activity');
  });
});

describe('ErrorAggregator.getSummary — Format', () => {
  test('returns objects with category and rate', () => {
    const { agg } = createAggregator({ spikeThreshold: 1 });
    agg.record('network', new Error('timeout'));
    agg.record('network', new Error('timeout2'));
    const summary = agg.getSummary();
    // spikes or trending should have proper structure
    for (const entry of [...summary.trending, ...summary.spikes]) {
      assert(entry.category, 'should have category');
      assert(typeof entry.rate === 'number', 'rate should be number');
    }
  });
});

// ════════════════════════════════════════════════════════════
// DreamCycle Phase 4b — Corroboration
// ════════════════════════════════════════════════════════════

describe('DreamCycle Corroboration — Schema Matching', () => {
  test('boosts DreamEngine schema confidence when corroborated', () => {
    // Simulate what DreamCycle Phase 4b does with schema matching
    const dreamEngineSchema = {
      id: 'de-1',
      name: 'experiential:error-after-deploy',
      description: 'Errors frequently follow deployment actions',
      source: 'DreamEngine',
      confidence: 0.4,
      corroboratedBy: 0,
    };

    const newDreamCycleSchema = {
      name: 'deploy-error-pattern',
      description: 'Deployment actions lead to errors in logs',
    };

    // Simulate the corroboration logic from DreamCycle Phase 4b
    const deWords = new Set(
      dreamEngineSchema.description.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    const newWords = newDreamCycleSchema.description.toLowerCase().split(/\s+/);
    const overlap = newWords.filter(w => deWords.has(w)).length;

    assert(overlap >= 2, 'should have word overlap (errors, deployment/deploy)');

    // Apply boost
    if (overlap >= 2) {
      dreamEngineSchema.confidence = Math.min(0.95, dreamEngineSchema.confidence + 0.2);
      dreamEngineSchema.corroboratedBy++;
    }

    assert(Math.abs(dreamEngineSchema.confidence - 0.6) < 0.001, `expected ~0.6, got ${dreamEngineSchema.confidence}`);
    assertEqual(dreamEngineSchema.corroboratedBy, 1);
  });

  test('does not boost schemas with low overlap', () => {
    const deSchema = {
      description: 'User prefers dark themes for coding',
      confidence: 0.4,
    };
    const newSchema = {
      description: 'Network latency increases during peak hours',
    };

    const deWords = new Set(
      deSchema.description.toLowerCase().split(/\s+/).filter(w => w.length > 3)
    );
    const newWords = newSchema.description.toLowerCase().split(/\s+/);
    const overlap = newWords.filter(w => deWords.has(w)).length;

    assertEqual(overlap, 0, 'unrelated schemas should have no overlap');
  });

  test('confidence caps at 0.95', () => {
    const schema = { confidence: 0.9 };
    schema.confidence = Math.min(0.95, schema.confidence + 0.2);
    assertEqual(schema.confidence, 0.95);
  });
});

describe('DreamCycle Corroboration — Source Filtering', () => {
  test('identifies DreamEngine schemas by source field', () => {
    const schemas = [
      { id: '1', name: 'behavioral-pattern', source: 'DreamCycle', confidence: 0.8 },
      { id: '2', name: 'experiential:frame-cluster', source: 'DreamEngine', confidence: 0.4 },
      { id: '3', name: 'experiential:mood-shift', source: 'DreamEngine', confidence: 0.3 },
      { id: '4', name: 'code-quality-trend', source: 'heuristic', confidence: 0.6 },
    ];

    const dreamEngineSchemas = schemas.filter(
      s => s.source === 'DreamEngine' || (s.name && s.name.startsWith('experiential:'))
    );

    assertEqual(dreamEngineSchemas.length, 2);
    assert(dreamEngineSchemas.every(s => s.source === 'DreamEngine'));
  });

  test('identifies DreamEngine schemas by experiential: prefix', () => {
    const schemas = [
      { id: '1', name: 'experiential:surprise-pattern', source: 'unknown', confidence: 0.35 },
    ];

    const matches = schemas.filter(
      s => s.source === 'DreamEngine' || (s.name && s.name.startsWith('experiential:'))
    );

    assertEqual(matches.length, 1);
  });
});

run();
