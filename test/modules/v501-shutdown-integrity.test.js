#!/usr/bin/env node
// ============================================================
// Test: v5.1.0 Shutdown Integrity Completion (C-1, H-1, L-3)
//
// Covers:
//   C-1: 9 services now use sync write in stop() instead of debounced
//   H-1: Metabolism has persistence (save + load)
//   L-3: ConsciousnessExtensionAdapter uses sync write in stop()
//   WorldState uses saveSync() in shutdown path
// ============================================================
const { describe, test, assert, assertEqual, run } = require('../harness');
const fs = require('fs');
const path = require('path');

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
  const syncFiles = [];
  const debouncedFiles = [];
  return {
    readJSONAsync: async (file) => store[file] || null,
    readJSON: (file, fallback) => store[file] || fallback,
    writeJSON: (file, data) => {
      store[file] = JSON.parse(JSON.stringify(data));
      syncWrites++;
      syncFiles.push(file);
    },
    writeJSONDebounced: (file, data) => {
      store[file] = JSON.parse(JSON.stringify(data));
      debouncedWrites++;
      debouncedFiles.push(file);
    },
    writeJSONAsync: async (file, data) => {
      store[file] = JSON.parse(JSON.stringify(data));
    },
    store,
    get syncWrites() { return syncWrites; },
    get debouncedWrites() { return debouncedWrites; },
    get syncFiles() { return syncFiles; },
    get debouncedFiles() { return debouncedFiles; },
    _reset() { syncWrites = 0; debouncedWrites = 0; syncFiles.length = 0; debouncedFiles.length = 0; },
  };
}

function mockIntervals() {
  return { register: () => {}, clear: () => {}, shutdown: () => {}, getStatus: () => ({}) };
}

// ════════════════════════════════════════════════════════════
// C-1: Homeostasis
// ════════════════════════════════════════════════════════════

describe('C-1: Homeostasis.stop() uses sync persist', () => {
  const { Homeostasis } = require('../../src/agent/organism/Homeostasis');

  test('stop() calls writeJSON (sync), not writeJSONDebounced', () => {
    const storage = mockStorage();
    const h = new Homeostasis({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    h.stop();

    assert(storage.syncFiles.includes('homeostasis.json'), 'sync write to homeostasis.json expected');
    assert(!storage.debouncedFiles.includes('homeostasis.json'), 'debounced write should NOT occur in stop()');
  });

  test('_save() still uses debounced for runtime', () => {
    const storage = mockStorage();
    const h = new Homeostasis({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    h._save();

    assert(storage.debouncedFiles.includes('homeostasis.json'), '_save() should use debounced');
  });
});

// ════════════════════════════════════════════════════════════
// C-1: EmotionalState
// ════════════════════════════════════════════════════════════

describe('C-1: EmotionalState.stop() uses sync persist', () => {
  const { EmotionalState } = require('../../src/agent/organism/EmotionalState');

  test('stop() calls writeJSON (sync)', () => {
    const storage = mockStorage();
    const e = new EmotionalState({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    e.stop();

    assert(storage.syncFiles.includes('emotional-state.json'), 'sync write expected');
    assert(!storage.debouncedFiles.includes('emotional-state.json'), 'no debounced write in stop()');
  });
});

// ════════════════════════════════════════════════════════════
// C-1: ImmuneSystem
// ════════════════════════════════════════════════════════════

describe('C-1: ImmuneSystem.stop() uses sync persist', () => {
  const { ImmuneSystem } = require('../../src/agent/organism/ImmuneSystem');

  test('stop() calls writeJSON (sync)', () => {
    const storage = mockStorage();
    const i = new ImmuneSystem({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    i.stop();

    assert(storage.syncFiles.includes('immune-memory.json'), 'sync write expected');
    assert(!storage.debouncedFiles.includes('immune-memory.json'), 'no debounced write in stop()');
  });
});

// ════════════════════════════════════════════════════════════
// C-1: NeedsSystem
// ════════════════════════════════════════════════════════════

describe('C-1: NeedsSystem.stop() uses sync persist', () => {
  const { NeedsSystem } = require('../../src/agent/organism/NeedsSystem');

  test('stop() calls writeJSON (sync)', () => {
    const storage = mockStorage();
    const n = new NeedsSystem({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    n.stop();

    assert(storage.syncFiles.includes('needs-system.json'), 'sync write expected');
    assert(!storage.debouncedFiles.includes('needs-system.json'), 'no debounced write in stop()');
  });
});

// ════════════════════════════════════════════════════════════
// C-1: LearningService
// ════════════════════════════════════════════════════════════

describe('C-1: LearningService.stop() uses sync persist', () => {
  const { LearningService } = require('../../src/agent/hexagonal/LearningService');

  test('stop() calls writeJSON (sync), not writeJSONDebounced', () => {
    const storage = mockStorage();
    const ls = new LearningService({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    ls.stop();

    assert(storage.syncFiles.includes('learning-metrics.json'), 'sync write expected');
    assert(!storage.debouncedFiles.includes('learning-metrics.json'), 'no debounced write in stop()');
  });
});

// ════════════════════════════════════════════════════════════
// WorldState.saveSync()
// ════════════════════════════════════════════════════════════

describe('C-1: WorldState.saveSync() for shutdown', () => {
  const { WorldState } = require('../../src/agent/foundation/WorldState');
  const os = require('os');

  test('saveSync() uses sync writeJSON', () => {
    const storage = mockStorage();
    const ws = new WorldState({ bus: mockBus(), storage, intervals: mockIntervals(), rootDir: os.tmpdir() });
    storage._reset();

    ws.saveSync();

    assert(storage.syncFiles.includes('world-state.json'), 'sync write expected');
  });

  test('save() still uses debounced for runtime', () => {
    const storage = mockStorage();
    const ws = new WorldState({ bus: mockBus(), storage, intervals: mockIntervals(), rootDir: os.tmpdir() });
    storage._reset();

    ws.save();

    assert(storage.debouncedFiles.includes('world-state.json'), 'debounced write expected for runtime');
  });
});

describe('H-1: Metabolism persistence', () => {
  const { Metabolism } = require('../../src/agent/organism/Metabolism');

  test('stop() persists energy state via sync write', () => {
    const storage = mockStorage();
    const m = new Metabolism({ bus: mockBus(), storage, intervals: mockIntervals() });
    storage._reset();

    m.stop();

    assert(storage.syncFiles.includes('metabolism.json'), 'sync write to metabolism.json expected');
  });

  test('persisted data includes energy, callCount, totalEnergySpent', () => {
    const storage = mockStorage();
    const m = new Metabolism({ bus: mockBus(), storage, intervals: mockIntervals() });

    m._energy = 350;
    m._callCount = 42;
    m._totalEnergySpent = 150;
    m._totalEnergyRecovered = 80;
    m._periodEnergySpent = 25;

    m.stop();

    const saved = storage.store['metabolism.json'];
    assert(saved, 'metabolism.json should be in store');
    assertEqual(saved.energy, 350);
    assertEqual(saved.callCount, 42);
    assertEqual(saved.totalEnergySpent, 150);
    assertEqual(saved.totalEnergyRecovered, 80);
    assertEqual(saved.periodEnergySpent, 25);
  });

  test('asyncLoad() restores energy state from storage', async () => {
    const storage = mockStorage();
    storage.store['metabolism.json'] = {
      energy: 200,
      callCount: 10,
      totalEnergySpent: 300,
      totalEnergyRecovered: 100,
      periodEnergySpent: 15,
      recentCosts: [5, 10, 8],
      lastEnergyState: 'low',
    };

    const m = new Metabolism({ bus: mockBus(), storage, intervals: mockIntervals() });
    await m.asyncLoad();

    assertEqual(m._energy, 200);
    assertEqual(m._callCount, 10);
    assertEqual(m._totalEnergySpent, 300);
    assertEqual(m._totalEnergyRecovered, 100);
    assertEqual(m._periodEnergySpent, 15);
    assertEqual(m._lastEnergyState, 'low');
  });

  test('_load() clamps energy to [0, maxEnergy]', async () => {
    const storage = mockStorage();
    storage.store['metabolism.json'] = { energy: 99999 };

    const m = new Metabolism({ bus: mockBus(), storage, intervals: mockIntervals() });
    await m.asyncLoad();

    assert(m._energy <= m._maxEnergy, `energy ${m._energy} should be <= maxEnergy ${m._maxEnergy}`);
  });

  test('_load() handles missing file gracefully', async () => {
    const storage = mockStorage();
    const m = new Metabolism({ bus: mockBus(), storage, intervals: mockIntervals() });
    const defaultEnergy = m._energy;

    await m.asyncLoad();

    assertEqual(m._energy, defaultEnergy);
  });
});

// ════════════════════════════════════════════════════════════
// Source-level: AgentCoreHealth references saveSync
// ════════════════════════════════════════════════════════════

describe('AgentCoreHealth shutdown calls saveSync for worldState', () => {
  test('source contains saveSync(), not save()', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '../../src/agent/AgentCoreHealth.js'), 'utf-8'
    );
    assert(src.includes('saveSync()'), 'AgentCoreHealth must call saveSync()');
    assert(!src.match(/worldState.*\?\.save\(\)/), 'must NOT call worldState.save() (debounced)');
  });
});

run();
