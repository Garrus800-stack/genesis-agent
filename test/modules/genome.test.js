#!/usr/bin/env node
// ============================================================
// Test: Genome.js — traits, clamping, mutation, reproduction,
//       adjustTrait, hash identity, persistence
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const { Genome, DEFAULT_TRAITS } = require('../../src/agent/organism/Genome');

// ── Mock helpers ──────────────────────────────────────────
function mockBus() {
  const events = [];
  return {
    emit: (name, data, meta) => events.push({ name, data, meta }),
    fire: (name, data, meta) => events.push({ name, data, meta }),
    on: () => {},
    events,
  };
}

function mockStorage() {
  const store = {};
  return {
    readJSONAsync: async (file) => store[file] || null,
    writeJSON: (file, data) => { store[file] = JSON.parse(JSON.stringify(data)); },
    // FIX v5.0.0: Genome._persist() uses writeJSONDebounced — mock it synchronously
    writeJSONDebounced: (file, data) => { store[file] = JSON.parse(JSON.stringify(data)); },
    store,
  };
}

function createGenome(overrides = {}) {
  const bus = mockBus();
  const storage = mockStorage();
  const genome = new Genome({ bus, storage, ...overrides });
  return { genome, bus, storage };
}

// ════════════════════════════════════════════════════════════
// CONSTRUCTION
// ════════════════════════════════════════════════════════════

describe('Genome — Construction', () => {
  test('creates with default traits', () => {
    const { genome } = createGenome();
    for (const [key, val] of Object.entries(DEFAULT_TRAITS)) {
      assertEqual(genome.traits[key], val, `trait ${key} should match default`);
    }
  });

  test('has 6 traits', () => {
    const { genome } = createGenome();
    assertEqual(Object.keys(genome.traits).length, 6);
  });

  test('starts at generation 1', () => {
    const { genome } = createGenome();
    assertEqual(genome.generation, 1);
  });

  test('starts with genesis-root lineage', () => {
    const { genome } = createGenome();
    assertEqual(genome.lineage.length, 1);
    assertEqual(genome.lineage[0], 'genesis-root');
  });

  test('parentGenomeHash is null for root', () => {
    const { genome } = createGenome();
    assertEqual(genome.parentGenomeHash, null);
  });
});

// ════════════════════════════════════════════════════════════
// TRAIT ACCESS
// ════════════════════════════════════════════════════════════

describe('Genome — Trait Access', () => {
  test('trait() returns correct value', () => {
    const { genome } = createGenome();
    assertEqual(genome.trait('curiosity'), 0.6);
    assertEqual(genome.trait('riskTolerance'), 0.3);
  });

  test('trait() returns 0.5 for unknown traits', () => {
    const { genome } = createGenome();
    assertEqual(genome.trait('nonexistent'), 0.5);
  });

  test('getTraits() returns frozen snapshot', () => {
    const { genome } = createGenome();
    const traits = genome.getTraits();
    assert(Object.isFrozen(traits), 'getTraits() should return frozen object');
    assertEqual(traits.curiosity, genome.traits.curiosity);
  });

  test('getFullGenome() includes all fields', () => {
    const { genome } = createGenome();
    const full = genome.getFullGenome();
    assert(full.traits !== undefined, 'should have traits');
    assert(full.generation !== undefined, 'should have generation');
    assert(full.lineage !== undefined, 'should have lineage');
    assert(full.hash !== undefined, 'should have hash');
    assert(full.mutationRate !== undefined, 'should have mutationRate');
  });
});

// ════════════════════════════════════════════════════════════
// TRAIT ADJUSTMENT
// ════════════════════════════════════════════════════════════

describe('Genome — Trait Adjustment', () => {
  test('adjustTrait changes value', () => {
    const { genome } = createGenome();
    const before = genome.trait('curiosity');
    genome.adjustTrait('curiosity', +0.03, 'test');
    const after = genome.trait('curiosity');
    assert(Math.abs(after - (before + 0.03)) < 0.001, `expected ${before + 0.03}, got ${after}`);
  });

  test('adjustTrait caps at ±0.05', () => {
    const { genome } = createGenome();
    const before = genome.trait('curiosity');
    const result = genome.adjustTrait('curiosity', +0.20, 'test-overcap');
    assert(result.applied, 'should apply');
    const delta = result.after - result.before;
    assert(Math.abs(delta) <= 0.051, `delta should be capped, got ${delta}`);
  });

  test('adjustTrait clamps to bounds', () => {
    const { genome } = createGenome();
    // Push curiosity up many times
    for (let i = 0; i < 30; i++) {
      genome.adjustTrait('curiosity', +0.05, 'push');
    }
    assert(genome.trait('curiosity') <= 0.95, `should not exceed 0.95, got ${genome.trait('curiosity')}`);
    assert(genome.trait('curiosity') >= 0.05, `should not go below 0.05`);
  });

  test('adjustTrait on unknown trait returns applied:false', () => {
    const { genome } = createGenome();
    const result = genome.adjustTrait('nonexistent', +0.01, 'test');
    assertEqual(result.applied, false);
  });

  test('adjustTrait emits genome:trait-adjusted event', () => {
    const { genome, bus } = createGenome();
    genome.adjustTrait('caution', +0.02, 'test-event');
    const evt = bus.events.find(e => e.name === 'genome:trait-adjusted');
    assert(evt !== undefined, 'should emit genome:trait-adjusted');
    assertEqual(evt.data.trait, 'caution');
    assert(evt.data.delta > 0, 'delta should be positive');
  });

  test('adjustment history is recorded', () => {
    const { genome } = createGenome();
    genome.adjustTrait('curiosity', +0.01, 'reason-a');
    genome.adjustTrait('caution', -0.01, 'reason-b');
    const history = genome.getAdjustmentHistory();
    assertEqual(history.length, 2);
    assertEqual(history[0].trait, 'curiosity');
    assertEqual(history[1].trait, 'caution');
    assertEqual(history[0].reason, 'reason-a');
  });
});

// ════════════════════════════════════════════════════════════
// REPRODUCTION
// ════════════════════════════════════════════════════════════

describe('Genome — Reproduction', () => {
  test('reproduce() returns offspring with incremented generation', () => {
    const { genome } = createGenome();
    const offspring = genome.reproduce();
    assertEqual(offspring.generation, 2);
  });

  test('offspring has all trait keys', () => {
    const { genome } = createGenome();
    const offspring = genome.reproduce();
    for (const key of Object.keys(DEFAULT_TRAITS)) {
      assert(offspring.traits[key] !== undefined, `offspring should have trait ${key}`);
    }
  });

  test('offspring traits are within [0.05, 0.95]', () => {
    const { genome } = createGenome();
    // Run many reproductions to exercise mutations
    for (let i = 0; i < 50; i++) {
      const offspring = genome.reproduce();
      for (const [key, val] of Object.entries(offspring.traits)) {
        assert(val >= 0.05 && val <= 0.95, `trait ${key}=${val} out of bounds`);
      }
    }
  });

  test('offspring lineage extends parent', () => {
    const { genome } = createGenome();
    const parentHash = genome.hash();
    const offspring = genome.reproduce();
    assert(offspring.lineage.length > genome.lineage.length, 'offspring lineage should be longer');
    assertEqual(offspring.lineage[offspring.lineage.length - 1], parentHash);
  });

  test('offspring parentGenomeHash matches parent hash', () => {
    const { genome } = createGenome();
    const offspring = genome.reproduce();
    assertEqual(offspring.parentGenomeHash, genome.hash());
  });

  test('reproduce emits genome:reproduced event', () => {
    const { genome, bus } = createGenome();
    genome.reproduce();
    const evt = bus.events.find(e => e.name === 'genome:reproduced');
    assert(evt !== undefined, 'should emit genome:reproduced');
    assertEqual(evt.data.childGeneration, 2);
  });

  test('with mutationRate=0 offspring traits equal parent', () => {
    const { genome } = createGenome({ config: { mutationRate: 0 } });
    const offspring = genome.reproduce();
    for (const [key, val] of Object.entries(genome.traits)) {
      assertEqual(offspring.traits[key], val, `trait ${key} should be unchanged`);
    }
  });

  test('with mutationRate=1 some traits differ', () => {
    const { genome } = createGenome({ config: { mutationRate: 1, mutationStrength: 0.2 } });
    const offspring = genome.reproduce();
    let diffs = 0;
    for (const key of Object.keys(genome.traits)) {
      if (Math.abs(offspring.traits[key] - genome.traits[key]) > 0.001) diffs++;
    }
    // With rate=1 and strength=0.2, overwhelmingly likely that at least some differ
    assert(diffs > 0, `expected mutations but got 0 diffs`);
  });
});

// ════════════════════════════════════════════════════════════
// IDENTITY HASH
// ════════════════════════════════════════════════════════════

describe('Genome — Hash', () => {
  test('hash is a 16-char hex string', () => {
    const { genome } = createGenome();
    const h = genome.hash();
    assertEqual(h.length, 16);
    assert(/^[0-9a-f]{16}$/.test(h), `hash should be hex, got ${h}`);
  });

  test('same traits produce same hash', () => {
    const { genome: g1 } = createGenome();
    const { genome: g2 } = createGenome();
    assertEqual(g1.hash(), g2.hash());
  });

  test('different traits produce different hash', () => {
    const { genome: g1 } = createGenome();
    const { genome: g2 } = createGenome();
    g2.adjustTrait('curiosity', +0.05, 'diverge');
    assert(g1.hash() !== g2.hash(), 'hashes should differ after trait change');
  });
});

// ════════════════════════════════════════════════════════════
// PERSISTENCE
// ════════════════════════════════════════════════════════════

describe('Genome — Persistence', () => {
  test('stop() persists to storage', () => {
    const { genome, storage } = createGenome();
    genome.stop();
    const saved = storage.store['genome.json'];
    assert(saved !== undefined, 'genome.json should be persisted');
    assert(saved.traits !== undefined, 'should have traits');
    assertEqual(saved.generation, 1);
  });

  test('asyncLoad() restores traits from storage', async () => {
    const { genome: g1, storage } = createGenome();
    g1.adjustTrait('curiosity', +0.05, 'modify');
    g1.stop();

    const g2 = new Genome({ bus: mockBus(), storage });
    await g2.asyncLoad();
    assertEqual(g2.trait('curiosity'), g1.trait('curiosity'));
  });

  test('asyncLoad() handles missing file gracefully', async () => {
    const { genome } = createGenome();
    await genome.asyncLoad(); // no saved file — should use defaults
    assertEqual(genome.trait('curiosity'), DEFAULT_TRAITS.curiosity);
  });
});

run();
