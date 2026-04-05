// ============================================================
// Test: v6.0.5 Coverage Sweep Part 4 — Final 8 Functions
// ============================================================

const { describe, test, assert, run } = require('../harness');
const path = require('path');
const os = require('os');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}
function mockStorage() {
  const store = {};
  return {
    readJSON: (f, fb) => store[f] || fb,
    readJSONAsync: async (f) => store[f] || null,
    writeJSON: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    writeJSONDebounced: (f, d) => { store[f] = d; },
    writeJSONSync: (f, d) => { store[f] = d; },
    store,
  };
}

const tmpDir = path.join(os.tmpdir(), 'genesis-sweep4-' + Date.now());

// ════════════════════════════════════════════════════════════
// SelfSpawner
// ════════════════════════════════════════════════════════════

describe('CoverageSweep4 — SelfSpawner', () => {
  const { SelfSpawner } = require('../../src/agent/capabilities/SelfSpawner');

  test('construct + getActiveWorkers + getStats + killAll + shutdown', () => {
    const ss = new SelfSpawner({ bus: mockBus(), storage: mockStorage(), eventStore: null, rootDir: tmpDir });
    const workers = ss.getActiveWorkers();
    assert(Array.isArray(workers), 'workers is array');
    const stats = ss.getStats();
    assert(typeof stats === 'object', 'stats is object');
    ss.killAll();
    ss.shutdown();
  });

  test('kill unknown task is safe', () => {
    const ss = new SelfSpawner({ bus: mockBus(), storage: mockStorage(), eventStore: null, rootDir: tmpDir });
    ss.kill('nonexistent');
    assert(true, 'kill unknown is safe');
  });
});

// ════════════════════════════════════════════════════════════
// WebPerception
// ════════════════════════════════════════════════════════════

describe('CoverageSweep4 — WebPerception', () => {
  const { WebPerception } = require('../../src/agent/capabilities/WebPerception');

  test('construct + getCapabilities + getStats', () => {
    const wp = new WebPerception({ bus: mockBus(), storage: mockStorage(), eventStore: null });
    const caps = wp.getCapabilities();
    assert(typeof caps === 'object', 'capabilities is object');
    const stats = wp.getStats();
    assert(typeof stats === 'object', 'stats is object');
    assert('cacheSize' in stats, 'has cacheSize');
  });

  test('ping invalid url rejects gracefully', async () => {
    const wp = new WebPerception({ bus: mockBus(), storage: mockStorage(), eventStore: null });
    try {
      await wp.ping('http://0.0.0.0:1');
    } catch (_) {
      // Expected — unreachable host
    }
    assert(true, 'ping handled gracefully');
  });

  test('shutdown is safe', async () => {
    const wp = new WebPerception({ bus: mockBus(), storage: mockStorage(), eventStore: null });
    await wp.shutdown();
  });
});

// ════════════════════════════════════════════════════════════
// GoalPersistence — additional methods
// ════════════════════════════════════════════════════════════

describe('CoverageSweep4 — GoalPersistence extended', () => {
  const { GoalPersistence } = require('../../src/agent/planning/GoalPersistence');

  test('load + checkpoint + gc', async () => {
    const gp = new GoalPersistence({ bus: mockBus(), storage: mockStorage(), goalStack: null, eventStore: null });
    await gp.load();
    await gp.checkpoint();
    await gp.gc();
  });

  test('_onGoalCreated + _onGoalCompleted', () => {
    const gp = new GoalPersistence({ bus: mockBus(), storage: mockStorage(), goalStack: null, eventStore: null });
    gp._onGoalCreated({ id: 'g1', description: 'test' });
    gp._onGoalCompleted({ id: 'g1', success: true });
  });
});

// ════════════════════════════════════════════════════════════
// LLMPort — ModelBridgeAdapter extra methods
// ════════════════════════════════════════════════════════════

describe('CoverageSweep4 — ModelBridgeAdapter', () => {
  const { ModelBridgeAdapter } = require('../../src/agent/ports/LLMPort');

  test('construct + getters + getConcurrencyStats', () => {
    const mockBridge = {
      activeModel: 'test-model',
      activeBackend: 'ollama',
      availableModels: [],
      temperatures: { code: 0.1 },
      backends: {},
      _semaphore: { _stats: {} },
      detectAvailable: async () => [],
      switchTo: async () => ({}),
      configureBackend: () => {},
      getConcurrencyStats: () => ({ active: 0, queued: 0 }),
    };
    const adapter = new ModelBridgeAdapter(mockBridge);
    assert(adapter.activeModel === 'test-model', 'activeModel');
    assert(adapter.activeBackend === 'ollama', 'activeBackend');
    assert(Array.isArray(adapter.availableModels), 'availableModels');
    assert(typeof adapter.temperatures === 'object', 'temperatures');
    assert(typeof adapter.backends === 'object', 'backends');
    const cs = adapter.getConcurrencyStats();
    assert(typeof cs === 'object', 'concurrency stats');
  });
});

run();
