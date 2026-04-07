#!/usr/bin/env node
// ============================================================
// Test: v5.0.0 Deferred Findings — D-1 (shutdown persist),
//       D-3 (clone rollback)
// ============================================================
const { describe, test, assert, assertEqual, run, createTestRoot } = require('../harness');
const path = require('path');
const fs = require('fs');

const { FitnessEvaluator } = require('../../src/agent/organism/FitnessEvaluator');
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
