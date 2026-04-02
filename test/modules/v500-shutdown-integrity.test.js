#!/usr/bin/env node
// ============================================================
// Test: v5.0.0 Shutdown Integrity
//
// Covers:
//   D-1 extended: 7 additional services that previously used
//       writeJSONDebounced in stop() — now all use sync write.
//   TO_STOP:      6 services added to AgentCoreHealth shutdown list.
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');

// ── Shared Mocks ─────────────────────────────────────────

function mockBus() {
  const handlers = new Map();
  return {
    emit: () => {},
    fire: () => {},
    on: (event, handler, opts) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    handlers,
  };
}

function mockStorage() {
  const store = {};
  let syncWrites = 0;
  let debouncedWrites = 0;
  return {
    readJSONAsync: async (file) => store[file] || null,
    readJSON: (file, fallback) => store[file] || fallback,
    writeJSON: (file, data) => {
      store[file] = JSON.parse(JSON.stringify(data));
      syncWrites++;
    },
    writeJSONDebounced: (file, data) => {
      store[file] = JSON.parse(JSON.stringify(data));
      debouncedWrites++;
    },
    store,
    get syncWrites() { return syncWrites; },
    get debouncedWrites() { return debouncedWrites; },
  };
}

// ════════════════════════════════════════════════════════════
// D-1 extended: Genome.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: Genome.stop() uses sync persist', () => {
  const { Genome } = require('../../src/agent/organism/Genome');

  test('stop() calls writeJSON (sync), not writeJSONDebounced', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const genome = new Genome({ bus, storage });

    // Mutate a trait so there's data to persist
    genome.adjustTrait('curiosity', 0.01, 'test');
    const syncBefore = storage.syncWrites;

    genome.stop();

    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
  });

  test('stop() persists current traits to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const genome = new Genome({ bus, storage });

    genome.adjustTrait('caution', 0.05, 'test');
    genome.stop();

    const saved = storage.store['genome.json'];
    assert(saved, 'genome.json should exist after stop()');
    assert(saved.traits.caution > 0.5, 'Adjusted trait should be persisted');
  });

  test('adjustTrait() still uses debounced write (runtime path)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const genome = new Genome({ bus, storage });

    const debouncedBefore = storage.debouncedWrites;
    genome.adjustTrait('curiosity', 0.01, 'test');
    assert(storage.debouncedWrites > debouncedBefore,
      'adjustTrait() should use debounced write at runtime');
  });
});

// ════════════════════════════════════════════════════════════
// D-1 extended: DreamCycle.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: DreamCycle.stop() uses sync persist', () => {
  const { DreamCycle } = require('../../src/agent/cognitive/DreamCycle');

  test('stop() calls writeJSON (sync)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const dc = new DreamCycle({ bus, storage, eventStore: null, model: null });

    const syncBefore = storage.syncWrites;
    dc.stop();
    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
  });

  test('stop() persists dream state to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const dc = new DreamCycle({ bus, storage, eventStore: null, model: null });

    dc.stop();
    const saved = storage.store['dream-state.json'];
    assert(saved, 'dream-state.json should exist after stop()');
    assert(saved.savedAt > 0, 'Should have a savedAt timestamp');
  });
});

// ════════════════════════════════════════════════════════════
// D-1 extended: SelfNarrative.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: SelfNarrative.stop() uses sync persist', () => {
  const { SelfNarrative } = require('../../src/agent/cognitive/SelfNarrative');

  test('stop() calls writeJSON (sync)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const sn = new SelfNarrative({ bus, storage, model: null });

    const syncBefore = storage.syncWrites;
    sn.stop();
    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
  });

  test('stop() persists narrative to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const sn = new SelfNarrative({ bus, storage, model: null });

    sn.stop();
    const saved = storage.store['self-narrative.json'];
    assert(saved, 'self-narrative.json should exist after stop()');
    assert(saved.narrative, 'Should contain the narrative object');
  });
});

// ════════════════════════════════════════════════════════════
// D-1 extended: SchemaStore.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: SchemaStore.stop() uses sync persist', () => {
  const { SchemaStore } = require('../../src/agent/planning/SchemaStore');

  test('stop() calls writeJSON (sync) when dirty', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const ss = new SchemaStore({ bus, storage, config: {} });

    // Mark dirty by storing a schema
    ss.store({ name: 'test-schema', description: 'test', confidence: 0.8 });
    const syncBefore = storage.syncWrites;

    ss.stop();
    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync) when dirty');
  });

  test('stop() persists schemas to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const ss = new SchemaStore({ bus, storage, config: {} });

    ss.store({ name: 'test-schema', description: 'xyz', confidence: 0.9 });
    ss.stop();

    const saved = storage.store['schemas.json'];
    assert(saved, 'schemas.json should exist after stop()');
    assert(saved.schemas.length >= 1, 'Should contain the stored schema');
  });
});

// ════════════════════════════════════════════════════════════
// D-1 extended: ValueStore.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: ValueStore.stop() uses sync persist', () => {
  const { ValueStore } = require('../../src/agent/planning/ValueStore');

  test('stop() calls writeJSON (sync) when dirty', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const vs = new ValueStore({ bus, storage });

    // Make it dirty
    vs.store({ name: 'helpfulness', description: 'positive interaction', weight: 0.8 });
    const syncBefore = storage.syncWrites;

    vs.stop();
    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync) when dirty');
  });

  test('stop() persists values to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const vs = new ValueStore({ bus, storage });

    vs.store({ name: 'helpfulness', description: 'test', weight: 0.8 });
    vs.stop();

    const saved = storage.store['values.json'];
    assert(saved, 'values.json should exist after stop()');
    assert(saved.values, 'Should contain the values map');
  });
});

// ════════════════════════════════════════════════════════════
// D-1 extended: UserModel.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: UserModel.stop() uses sync persist', () => {
  const { UserModel } = require('../../src/agent/intelligence/UserModel');

  test('stop() calls writeJSON (sync)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const um = new UserModel({ bus, storage });

    // Trigger an observation to dirty the model
    um.observe({ type: 'chat', message: 'hello', timestamp: Date.now() });
    const syncBefore = storage.syncWrites;

    um.stop();
    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
  });

  test('stop() persists user profile to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const um = new UserModel({ bus, storage });

    um.observe({ type: 'chat', message: 'test', timestamp: Date.now() });
    um.stop();

    const saved = storage.store['user-model.json'];
    assert(saved, 'user-model.json should exist after stop()');
    assert(saved.profile, 'Should contain the user profile');
  });
});

// ════════════════════════════════════════════════════════════
// D-1 extended: SurpriseAccumulator.stop() sync persist
// ════════════════════════════════════════════════════════════

describe('D-1: SurpriseAccumulator.stop() uses sync persist', () => {
  const { SurpriseAccumulator } = require('../../src/agent/cognitive/SurpriseAccumulator');

  test('stop() calls writeJSON (sync)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const sa = new SurpriseAccumulator({ bus, storage });

    const syncBefore = storage.syncWrites;
    sa.stop();
    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
  });

  test('stop() persists surprise stats to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const sa = new SurpriseAccumulator({ bus, storage });

    sa.stop();
    const saved = storage.store['surprise-stats.json'];
    assert(saved, 'surprise-stats.json should exist after stop()');
    assert(saved.stats, 'Should contain the stats object');
  });
});

// ════════════════════════════════════════════════════════════
// TO_STOP: AgentCoreHealth shutdown list completeness
// ════════════════════════════════════════════════════════════

describe('TO_STOP: shutdown list includes all stoppable services', () => {
  test('AgentCoreHealth TO_STOP contains newly added services', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../src/agent/AgentCoreHealth.js'), 'utf-8'
    );

    const required = [
      'emotionalSteering', 'errorAggregator',
      'dreamCycle', 'selfNarrative', 'schemaStore', 'surpriseAccumulator',
    ];

    for (const svc of required) {
      assert(src.includes(`'${svc}'`),
        `TO_STOP should include '${svc}'`);
    }
  });

  test('emotionalSteering.stop() clears interval', () => {
    const { EmotionalSteering } = require('../../src/agent/organism/EmotionalSteering');
    const bus = mockBus();
    const storage = mockStorage();
    const es = new EmotionalSteering({ bus, storage, emotionalState: { getState: () => ({}) } });

    // Simulate that start() was called and interval is running
    es._tickTimer = setInterval(() => {}, 999999);
    es.stop();
    assertEqual(es._tickTimer, null, 'Interval should be cleared after stop()');
  });

  test('errorAggregator.stop() clears interval and unsubscribes', () => {
    const { ErrorAggregator } = require('../../src/agent/autonomy/ErrorAggregator');
    const bus = mockBus();
    const ea = new ErrorAggregator({ bus, config: {} });

    // Simulate start state
    ea._healthInterval = setInterval(() => {}, 999999);
    ea._unsubs = [() => {}, () => {}];

    ea.stop();
    assertEqual(ea._healthInterval, null, 'Interval should be cleared');
    assertEqual(ea._unsubs.length, 0, 'Event unsubscriptions should be cleared');
  });
});

run();
