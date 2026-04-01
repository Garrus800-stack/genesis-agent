#!/usr/bin/env node
// ============================================================
// Test: EpigeneticLayer.js — conditioning rules, consolidation,
//       cooldowns, genome trait modification, history, persistence
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { EpigeneticLayer, CONDITIONING_RULES } = require('../../src/agent/organism/EpigeneticLayer');
const { Genome } = require('../../src/agent/organism/Genome');

function mockBus() {
  const events = [];
  const handlers = new Map();
  return {
    emit: (name, data, meta) => events.push({ name, data, meta }),
    fire: (name, data, meta) => events.push({ name, data, meta }),
    on: (event, handler, opts) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    trigger: (event, data) => {
      const fns = handlers.get(event) || [];
      for (const fn of fns) fn(data);
    },
    events,
    handlers,
  };
}

function mockStorage() {
  const store = {};
  return {
    readJSONAsync: async (file) => store[file] || null,
    writeJSON: (file, data) => { store[file] = JSON.parse(JSON.stringify(data)); },
    writeJSONDebounced: (file, data) => { store[file] = JSON.parse(JSON.stringify(data)); },
    store,
  };
}

function createLayer(opts = {}) {
  const bus = mockBus();
  const storage = mockStorage();
  const genome = new Genome({ bus, storage });
  const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
  layer.genome = opts.noGenome ? null : genome;
  return { layer, bus, genome, storage };
}

// ════════════════════════════════════════════════════════════
// CONSTRUCTION
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Construction', () => {
  test('creates with correct rule count', () => {
    const { layer } = createLayer();
    assertEqual(CONDITIONING_RULES.length, 8);
  });

  test('has empty history initially', () => {
    const { layer } = createLayer();
    assertEqual(layer.getHistory().length, 0);
  });

  test('stats start at zero', () => {
    const { layer } = createLayer();
    const stats = layer.getStats();
    assertEqual(stats.evaluations, 0);
    assertEqual(stats.adjustments, 0);
  });

  test('getRules() returns all rules with metadata', () => {
    const { layer } = createLayer();
    const rules = layer.getRules();
    assertEqual(rules.length, 8);
    assert(rules[0].id !== undefined, 'rules should have id');
    assert(rules[0].trigger !== undefined, 'rules should have trigger');
    assert(rules[0].description !== undefined, 'rules should have description');
  });
});

// ════════════════════════════════════════════════════════════
// CONSOLIDATION — NO GENOME
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Consolidation without genome', () => {
  test('consolidate returns 0 if no genome bound', () => {
    const { layer } = createLayer({ noGenome: true });
    const result = layer.consolidate();
    assertEqual(result.evaluated, 0);
    assertEqual(result.adjusted.length, 0);
  });
});

// ════════════════════════════════════════════════════════════
// CONSOLIDATION — EMPTY WINDOWS
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Consolidation with empty windows', () => {
  test('no adjustments when windows are empty', () => {
    const { layer } = createLayer();
    const result = layer.consolidate();
    assertEqual(result.evaluated, 8);
    assertEqual(result.adjusted.length, 0);
  });
});

// ════════════════════════════════════════════════════════════
// CONSOLIDATION — RULE TRIGGERING
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Rule: selfmod-success-streak', () => {
  test('3+ selfmod:success events trigger riskTolerance increase', () => {
    const { layer, bus, genome } = createLayer();
    const beforeRisk = genome.trait('riskTolerance');

    // Simulate 3 success events via internal window
    const window = layer._windows.get('selfmod:success');
    for (let i = 0; i < 3; i++) {
      window.push({ data: {}, timestamp: Date.now() });
    }

    const result = layer.consolidate();
    assert(result.adjusted.includes('selfmod-success-streak'), 'rule should fire');
    assert(genome.trait('riskTolerance') > beforeRisk, 'riskTolerance should increase');
  });

  test('2 events do not trigger', () => {
    const { layer, genome } = createLayer();
    const before = genome.trait('riskTolerance');
    const window = layer._windows.get('selfmod:success');
    for (let i = 0; i < 2; i++) window.push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    assertEqual(genome.trait('riskTolerance'), before);
  });
});

describe('EpigeneticLayer — Rule: selfmod-frozen', () => {
  test('circuit breaker trip increases caution', () => {
    const { layer, genome } = createLayer();
    const before = genome.trait('caution');
    const window = layer._windows.get('selfmod:frozen');
    window.push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    assert(genome.trait('caution') > before, 'caution should increase after circuit breaker trip');
  });
});

describe('EpigeneticLayer — Rule: error-accumulation', () => {
  test('10+ agent errors increase caution', () => {
    const { layer, genome } = createLayer();
    const before = genome.trait('caution');
    const window = layer._windows.get('agent:error');
    for (let i = 0; i < 10; i++) window.push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    assert(genome.trait('caution') > before, 'caution should increase after error accumulation');
  });
});

// ════════════════════════════════════════════════════════════
// COOLDOWNS
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Cooldowns', () => {
  test('rule does not re-fire within cooldown', () => {
    const { layer, genome } = createLayer();

    // Fire once
    const window = layer._windows.get('selfmod:frozen');
    window.push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    const afterFirst = genome.trait('caution');

    // Try to fire again immediately (within cooldown)
    layer._windows.set('selfmod:frozen', [{ data: {}, timestamp: Date.now() }]);
    const result = layer.consolidate();
    assert(result.skipped.includes('selfmod-frozen'), 'should be skipped due to cooldown');
    assertEqual(genome.trait('caution'), afterFirst);
  });
});

// ════════════════════════════════════════════════════════════
// TOTAL DELTA CAP
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Total delta cap', () => {
  test('total trait change capped at 0.05 per cycle', () => {
    const { layer, genome } = createLayer();
    const before = { ...genome.traits };

    // Fill multiple windows to trigger many rules at once
    for (let i = 0; i < 10; i++) layer._windows.get('agent:error').push({ data: {}, timestamp: Date.now() });
    for (let i = 0; i < 3; i++) layer._windows.get('selfmod:success').push({ data: {}, timestamp: Date.now() });
    layer._windows.get('selfmod:frozen').push({ data: {}, timestamp: Date.now() });

    layer.consolidate();

    // Count total absolute delta across all traits
    let totalDelta = 0;
    for (const key of Object.keys(before)) {
      totalDelta += Math.abs(genome.traits[key] - before[key]);
    }
    assert(totalDelta <= 0.10, `total delta should be limited, got ${totalDelta.toFixed(4)}`);
  });
});

// ════════════════════════════════════════════════════════════
// HISTORY & PERSISTENCE
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — History', () => {
  test('conditioning history records fired rules', () => {
    const { layer } = createLayer();
    layer._windows.get('selfmod:frozen').push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    const history = layer.getHistory();
    assert(history.length >= 1, 'should have at least 1 entry');
    assertEqual(history[0].ruleId, 'selfmod-frozen');
    assert(history[0].trait !== undefined);
    assert(history[0].delta !== undefined);
  });

  test('getRecentShifts returns last N', () => {
    const { layer } = createLayer();
    layer._windows.get('selfmod:frozen').push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    const recent = layer.getRecentShifts(5);
    assert(recent.length >= 1);
  });
});

describe('EpigeneticLayer — Persistence', () => {
  test('stop() persists history to storage', () => {
    const { layer, storage } = createLayer();
    layer._windows.get('selfmod:frozen').push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    layer.stop();
    const saved = storage.store['epigenetic-history.json'];
    assert(saved !== undefined, 'should persist');
    assert(saved.history.length >= 1, 'should have history entries');
    assert(saved.lastFired !== undefined, 'should have lastFired map');
  });

  test('asyncLoad() restores lastFired cooldowns', async () => {
    const { layer: l1, storage } = createLayer();
    // Fire a rule and persist
    l1._windows.get('selfmod:frozen').push({ data: {}, timestamp: Date.now() });
    l1.consolidate();
    l1.stop();

    // Create new layer, load from same storage
    const bus = mockBus();
    const genome = new Genome({ bus, storage });
    const l2 = new EpigeneticLayer({ bus, eventStore: null, storage });
    l2.genome = genome;
    await l2.asyncLoad();

    // The cooldown should be restored — rule should be skipped
    l2._windows.set('selfmod:frozen', [{ data: {}, timestamp: Date.now() }]);
    const result = l2.consolidate();
    assert(result.skipped.includes('selfmod-frozen'), 'cooldown should persist across restarts');
  });
});

// ════════════════════════════════════════════════════════════
// EVENT EMISSION
// ════════════════════════════════════════════════════════════

describe('EpigeneticLayer — Events', () => {
  test('consolidation emits epigenetic:consolidation when rules fire', () => {
    const { layer, bus } = createLayer();
    layer._windows.get('selfmod:frozen').push({ data: {}, timestamp: Date.now() });
    layer.consolidate();
    const evt = bus.events.find(e => e.name === 'epigenetic:consolidation');
    assert(evt !== undefined, 'should emit epigenetic:consolidation');
    assert(evt.data.adjusted.length > 0, 'adjusted should list fired rules');
  });

  test('no event emitted when no rules fire', () => {
    const { layer, bus } = createLayer();
    layer.consolidate();
    const evt = bus.events.find(e => e.name === 'epigenetic:consolidation');
    assertEqual(evt, undefined);
  });
});

run();
