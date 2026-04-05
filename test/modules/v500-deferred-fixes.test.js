#!/usr/bin/env node
// ============================================================
// Test: v5.0.0 Deferred Findings — D-1 (shutdown persist),
//       D-2 (stale window expiry), D-3 (clone rollback)
// ============================================================
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const { FitnessEvaluator } = require('../../src/agent/organism/FitnessEvaluator');
const { EpigeneticLayer, CONDITIONING_RULES } = require('../../src/agent/organism/EpigeneticLayer');
const { Genome } = require('../../src/agent/organism/Genome');
const { CloneFactory } = require('../../src/agent/capabilities/CloneFactory');

// ── Shared Mocks ─────────────────────────────────────────

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
  let syncWrites = 0;
  let debouncedWrites = 0;
  return {
    readJSONAsync: async (file) => store[file] || null,
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

function mockEventStore(events = []) {
  return {
    query: ({ since }) => events.filter(e => (e.timestamp || 0) >= since),
    getRecent: (n) => events.slice(-n),
  };
}

// ════════════════════════════════════════════════════════════
// D-1: Shutdown Persist — sync write on stop()
// ════════════════════════════════════════════════════════════

describe('D-1: FitnessEvaluator.stop() uses sync persist', () => {
  test('stop() calls writeJSON (sync), not writeJSONDebounced', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const fe = new FitnessEvaluator({
      bus, eventStore: mockEventStore(), storage, intervals: null, config: {},
    });
    fe.genome = { hash: () => 'test', generation: 1 };

    // Do one evaluation so there's data to persist
    fe.evaluate('manual');
    const debouncedBefore = storage.debouncedWrites;
    const syncBefore = storage.syncWrites;

    // stop() should use sync write
    fe.stop();

    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
    // The debounced count may have increased from evaluate(), but stop() itself should not add another
  });

  test('stop() persists latest fitness history to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const fe = new FitnessEvaluator({
      bus, eventStore: mockEventStore(), storage, intervals: null, config: {},
    });
    fe.genome = { hash: () => 'abc', generation: 2 };

    fe.evaluate('manual');
    fe.stop();

    const saved = storage.store['fitness-history.json'];
    assert(saved, 'fitness-history.json should exist after stop()');
    assert(saved.history.length > 0, 'history should contain the evaluation');
    assertEqual(saved.history[0].genomeHash, 'abc');
  });

  test('evaluate() still uses debounced write (runtime path)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const fe = new FitnessEvaluator({
      bus, eventStore: mockEventStore(), storage, intervals: null, config: {},
    });
    fe.genome = { hash: () => 'xyz', generation: 1 };

    const debouncedBefore = storage.debouncedWrites;
    fe.evaluate('manual');
    assert(storage.debouncedWrites > debouncedBefore,
      'evaluate() should use debounced write at runtime');
  });
});

describe('D-1: EpigeneticLayer.stop() uses sync persist', () => {
  test('stop() calls writeJSON (sync), not writeJSONDebounced', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
    layer.genome = new Genome({ bus, storage });

    // Simulate some conditioning history
    layer._conditioningHistory.push({
      ruleId: 'test', trait: 'curiosity', delta: 0.02, timestamp: Date.now(),
    });

    const syncBefore = storage.syncWrites;
    layer.stop();

    assert(storage.syncWrites > syncBefore,
      'stop() should call writeJSON (sync)');
  });

  test('stop() persists conditioning history to storage', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
    layer.genome = new Genome({ bus, storage });

    layer._conditioningHistory.push({
      ruleId: 'test-rule', trait: 'caution', delta: 0.04, timestamp: Date.now(),
    });
    layer._lastFired.set('test-rule', Date.now());
    layer.stop();

    const saved = storage.store['epigenetic-history.json'];
    assert(saved, 'epigenetic-history.json should exist after stop()');
    assertEqual(saved.history.length, 1);
    assertEqual(saved.history[0].ruleId, 'test-rule');
    assert(saved.lastFired['test-rule'], 'lastFired should be persisted');
  });

  test('consolidate() still uses debounced write (runtime path)', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
    layer.genome = new Genome({ bus, storage });

    const debouncedBefore = storage.debouncedWrites;
    layer.consolidate();
    assert(storage.debouncedWrites > debouncedBefore,
      'consolidate() should use debounced write at runtime');
  });
});

// ════════════════════════════════════════════════════════════
// D-2: Stale Event Window Expiry
// ════════════════════════════════════════════════════════════

describe('D-2: EpigeneticLayer prunes stale events from windows', () => {
  test('events older than 24h are pruned during consolidate()', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
    layer.genome = new Genome({ bus, storage });

    // Inject old events (48 hours ago) into a window
    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    const window = layer._windows.get('selfmod:success');
    for (let i = 0; i < 5; i++) {
      window.push({ data: {}, timestamp: twoDaysAgo });
    }
    assertEqual(window.length, 5);

    layer.consolidate();

    // After consolidation, stale events should be gone
    const after = layer._windows.get('selfmod:success');
    assertEqual(after.length, 0, 'All 48h-old events should be pruned');
  });

  test('fresh events are preserved during prune', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
    layer.genome = new Genome({ bus, storage });

    const now = Date.now();
    const twoDaysAgo = now - 48 * 60 * 60 * 1000;
    const window = layer._windows.get('selfmod:success');

    // Mix of stale and fresh events
    window.push({ data: {}, timestamp: twoDaysAgo });
    window.push({ data: {}, timestamp: twoDaysAgo });
    window.push({ data: {}, timestamp: now - 1000 });  // 1 second ago — fresh
    window.push({ data: {}, timestamp: now });

    layer.consolidate();

    const after = layer._windows.get('selfmod:success');
    assertEqual(after.length, 2, 'Only the 2 fresh events should remain');
  });

  test('stale events do not trigger conditioning rules', () => {
    const bus = mockBus();
    const storage = mockStorage();
    const layer = new EpigeneticLayer({ bus, eventStore: null, storage });
    const genome = new Genome({ bus, storage });
    layer.genome = genome;

    const twoDaysAgo = Date.now() - 48 * 60 * 60 * 1000;
    const window = layer._windows.get('selfmod:success');

    // 'selfmod-success-streak' requires >= 3 events.
    // Inject 5 stale events — should NOT trigger after prune.
    for (let i = 0; i < 5; i++) {
      window.push({ data: {}, timestamp: twoDaysAgo });
    }

    const riskBefore = genome.traits.riskTolerance;
    layer.consolidate();
    const riskAfter = genome.traits.riskTolerance;

    assertEqual(riskBefore, riskAfter,
      'Stale events should not trigger trait adjustment');
  });
});

// ════════════════════════════════════════════════════════════
// D-3: CloneFactory Rollback on Partial Copy Failure
// ════════════════════════════════════════════════════════════

describe('D-3: CloneFactory._removeRecursive', () => {
  test('removes directory tree', () => {
    const tmpRoot = createTestRoot('clone-d3');
    const factory = new CloneFactory(
      tmpRoot,
      { getFullModel: () => ({ identity: 'G', version: '1.0' }), getModuleSummary: () => [] },
      { chat: async () => 'NAME: test-clone' },
      { build: () => '' },
    );

    // Create a nested structure
    const target = path.join(tmpRoot, 'test-dir');
    fs.mkdirSync(path.join(target, 'sub', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(target, 'file.txt'), 'data');
    fs.writeFileSync(path.join(target, 'sub', 'file2.txt'), 'data2');
    fs.writeFileSync(path.join(target, 'sub', 'deep', 'file3.txt'), 'data3');

    assert(fs.existsSync(target), 'Directory should exist before removal');
    factory._removeRecursive(target);
    assert(!fs.existsSync(target), 'Directory should be gone after removal');
  });

  test('_removeRecursive on non-existent dir does not throw', () => {
    const tmpRoot = createTestRoot('clone-d3-noexist');
    const factory = new CloneFactory(
      tmpRoot,
      { getFullModel: () => ({ identity: 'G', version: '1.0' }), getModuleSummary: () => [] },
      { chat: async () => '' },
      { build: () => '' },
    );

    // Should not throw
    factory._removeRecursive(path.join(tmpRoot, 'does-not-exist'));
  });
});

describe('D-3: CloneFactory rollback on createClone failure', () => {
  test('partial clone directory is cleaned up on copy failure', async () => {
    const tmpRoot = createTestRoot('clone-d3-rollback');
    // Write a minimal structure so _copyRecursive has something
    fs.writeFileSync(path.join(tmpRoot, 'package.json'), JSON.stringify({ name: 'test', version: '1.0.0' }));

    const factory = new CloneFactory(
      tmpRoot,
      {
        getFullModel: () => ({ identity: 'Genesis', version: '5.0.0' }),
        getModuleSummary: () => [],
        getCapabilities: () => [],
      },
      {
        chat: async () => 'NAME: rollback-test',
      },
      { build: () => '' },
    );

    // Sabotage _generateModifications to throw mid-clone
    factory._generateModifications = async () => {
      throw new Error('Simulated disk full');
    };

    const result = await factory.createClone({
      improvements: 'test',
      conversation: [],
    });

    assert(result.includes('⚠️'), 'Should return error message');
    assert(result.includes('Simulated disk full'), 'Should contain error reason');

    // The clone directory should NOT exist
    const clonesDir = path.join(tmpRoot, 'clones', 'rollback-test');
    assert(!fs.existsSync(clonesDir),
      'Partial clone directory should be cleaned up after failure');
  });
});

run();
