#!/usr/bin/env node
// ============================================================
// Test: Metabolism.js — Discrete energy pool (v5.0.0 extension)
// Tests consume(), canAfford(), energy states, regeneration,
// genome-scaled regen, and the original cost computation.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { Metabolism } = require('../../src/agent/organism/Metabolism');

function mockBus() {
  const events = [];
  return {
    emit: (name, data, meta) => events.push({ name, data, meta }),
    fire: (name, data, meta) => events.push({ name, data, meta }),
    on: () => {},
    events,
  };
}

function createMetabolism(overrides = {}) {
  const bus = mockBus();
  const m = new Metabolism({
    bus,
    storage: null,
    intervals: null,
    config: overrides,
  });
  return { metabolism: m, bus };
}

// ════════════════════════════════════════════════════════════
// ENERGY POOL INITIALIZATION
// ════════════════════════════════════════════════════════════

describe('Metabolism — Energy Pool Init', () => {
  test('starts with 500 AU by default', () => {
    const { metabolism } = createMetabolism();
    const level = metabolism.getEnergyLevel();
    assertEqual(level.max, 500);
    assertEqual(level.current, 500);
    assertEqual(level.percent, 100);
  });

  test('custom maxEnergy via config', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 1000 } });
    assertEqual(metabolism.getEnergyLevel().max, 1000);
  });

  test('initial state is full', () => {
    const { metabolism } = createMetabolism();
    assertEqual(metabolism.getEnergyState(), 'full');
  });
});

// ════════════════════════════════════════════════════════════
// canAfford()
// ════════════════════════════════════════════════════════════

describe('Metabolism — canAfford()', () => {
  test('can afford cheap activities at full energy', () => {
    const { metabolism } = createMetabolism();
    assertEqual(metabolism.canAfford('idleMindCycle'), true);
    assertEqual(metabolism.canAfford('llmCall'), true);
    assertEqual(metabolism.canAfford('selfModification'), true);
  });

  test('cannot afford expensive activity when depleted', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 10, startEnergy: 5 } });
    assertEqual(metabolism.canAfford('selfModification'), false); // costs 50
    assertEqual(metabolism.canAfford('idleMindCycle'), true);     // costs 2
  });

  test('unknown activity costs 0 so always affordable', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 1, startEnergy: 0 } });
    assertEqual(metabolism.canAfford('unknownActivity'), true);
  });
});

// ════════════════════════════════════════════════════════════
// consume()
// ════════════════════════════════════════════════════════════

describe('Metabolism — consume()', () => {
  test('consume reduces energy', () => {
    const { metabolism } = createMetabolism();
    const result = metabolism.consume('llmCall');
    assertEqual(result.ok, true);
    assertEqual(result.cost, 10);
    assertEqual(result.remaining, 490);
  });

  test('consume returns ok:false when insufficient', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 20, startEnergy: 5 } });
    const result = metabolism.consume('llmCall'); // costs 10
    assertEqual(result.ok, false);
    assertEqual(result.remaining, 5); // unchanged
  });

  test('consume accepts costOverride', () => {
    const { metabolism } = createMetabolism();
    const result = metabolism.consume('llmCall', 42);
    assertEqual(result.cost, 42);
    assertEqual(result.remaining, 500 - 42);
  });

  test('multiple consumes drain energy additively', () => {
    const { metabolism } = createMetabolism();
    metabolism.consume('llmCall');          // -10
    metabolism.consume('sandboxExec');      // -5
    metabolism.consume('idleMindCycle');    // -2
    const level = metabolism.getEnergyLevel();
    assertEqual(level.current, 500 - 10 - 5 - 2);
  });

  test('energy does not go below 0', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 15, startEnergy: 12 } });
    metabolism.consume('llmCall'); // -10 → 2
    assertEqual(metabolism.getEnergyLevel().current, 2);
    metabolism.consume('idleMindCycle'); // -2 → 0
    assertEqual(metabolism.getEnergyLevel().current, 0);
  });

  test('consume emits metabolism:consumed event', () => {
    const { metabolism, bus } = createMetabolism();
    metabolism.consume('sandboxExec');
    const evt = bus.events.find(e => e.name === 'metabolism:consumed');
    assert(evt !== undefined, 'should emit metabolism:consumed');
    assertEqual(evt.data.activity, 'sandboxExec');
    assertEqual(evt.data.cost, 5);
  });

  test('consume emits metabolism:insufficient when blocked', () => {
    const { metabolism, bus } = createMetabolism({ energyPool: { maxEnergy: 5, startEnergy: 3 } });
    metabolism.consume('llmCall');
    const evt = bus.events.find(e => e.name === 'metabolism:insufficient');
    assert(evt !== undefined, 'should emit metabolism:insufficient');
    assertEqual(evt.data.activity, 'llmCall');
  });
});

// ════════════════════════════════════════════════════════════
// ENERGY STATES
// ════════════════════════════════════════════════════════════

describe('Metabolism — Energy States', () => {
  test('full at 80%+', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 80 } });
    assertEqual(metabolism.getEnergyState(), 'full');
  });

  test('normal at 40-79%', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 50 } });
    assertEqual(metabolism.getEnergyState(), 'normal');
  });

  test('low at 15-39%', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 20 } });
    assertEqual(metabolism.getEnergyState(), 'low');
  });

  test('depleted at 0-14%', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 10 } });
    assertEqual(metabolism.getEnergyState(), 'depleted');
  });

  test('state transition emits metabolism:state-changed', () => {
    const { metabolism, bus } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 82 } });
    // 82% = full. Consume 5 → 77% = normal → state change
    metabolism.consume('sandboxExec'); // -5 → 77
    const evt = bus.events.find(e => e.name === 'metabolism:state-changed');
    assert(evt !== undefined, 'should emit state change');
    assertEqual(evt.data.from, 'full');
    assertEqual(evt.data.to, 'normal');
  });
});

// ════════════════════════════════════════════════════════════
// REGENERATION
// ════════════════════════════════════════════════════════════

describe('Metabolism — Regeneration', () => {
  test('regenerate increases energy', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 50 } });
    const before = metabolism.getEnergyLevel().current;
    metabolism.regenerate(0.5);
    const after = metabolism.getEnergyLevel().current;
    assert(after > before, `energy should increase: ${before} → ${after}`);
  });

  test('regenerate does not exceed max', () => {
    const { metabolism } = createMetabolism({ energyPool: { maxEnergy: 100, startEnergy: 99 } });
    metabolism.regenerate(0.5);
    assert(metabolism.getEnergyLevel().current <= 100, 'should not exceed max');
  });

  test('regenerate is no-op at max energy', () => {
    const { metabolism } = createMetabolism();
    const before = metabolism.getEnergyLevel().current;
    metabolism.regenerate(0.5);
    assertEqual(metabolism.getEnergyLevel().current, before);
  });

  test('genome consolidation trait scales regen', () => {
    const { metabolism: m1 } = createMetabolism({ energyPool: { maxEnergy: 500, startEnergy: 100, regenPerMinute: 10 } });
    const { metabolism: m2 } = createMetabolism({ energyPool: { maxEnergy: 500, startEnergy: 100, regenPerMinute: 10 } });
    m1.regenerate(0.1);  // low consolidation → 0.6x multiplier
    m2.regenerate(0.9);  // high consolidation → 1.4x multiplier
    assert(m2.getEnergyLevel().current > m1.getEnergyLevel().current,
      'high consolidation should regen more');
  });
});

// ════════════════════════════════════════════════════════════
// REPORT
// ════════════════════════════════════════════════════════════

describe('Metabolism — Report', () => {
  test('getReport includes energy level', () => {
    const { metabolism } = createMetabolism();
    const report = metabolism.getReport();
    assert(report.energy !== undefined, 'report should include energy');
    assertEqual(report.energy.max, 500);
    assertEqual(report.energy.state, 'full');
  });

  test('getEnergyHistory tracks events', () => {
    const { metabolism } = createMetabolism();
    metabolism.consume('llmCall');
    metabolism.consume('sandboxExec');
    const history = metabolism.getEnergyHistory();
    assert(history.length >= 2, `expected at least 2 history entries, got ${history.length}`);
  });
});

// ════════════════════════════════════════════════════════════
// ORIGINAL COST COMPUTATION (backward compat)
// ════════════════════════════════════════════════════════════

describe('Metabolism — Cost Computation (legacy)', () => {
  test('computeCost returns value in range', () => {
    const { metabolism } = createMetabolism();
    const cost = metabolism.computeCost({ tokens: 2000, latencyMs: 3000 }, 10);
    assert(cost >= 0.005, `cost too low: ${cost}`);
    assert(cost <= 0.15, `cost too high: ${cost}`);
  });

  test('higher tokens = higher cost', () => {
    const { metabolism } = createMetabolism();
    const low = metabolism.computeCost({ tokens: 500, latencyMs: 1000 }, 2);
    const high = metabolism.computeCost({ tokens: 10000, latencyMs: 10000 }, 50);
    assert(high > low, `heavy call should cost more: ${low} vs ${high}`);
  });
});

run();
