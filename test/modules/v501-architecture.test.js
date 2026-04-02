#!/usr/bin/env node
// ============================================================
// Test: v5.1.0 Architecture — Critical Untested Modules
//
// Covers:
//   AgentCoreBoot (382 LOC) — boot orchestration
//   AgentCoreWire (278 LOC) — declarative event bridge
//   WorldStateQueries (235 LOC) — extracted query methods
//   HomeostasisEffectors (308 LOC) — organism corrections
// ============================================================
const { describe, test, assert, assertEqual, assertDeepEqual, run } = require('../harness');
const path = require('path');
const os = require('os');

// ── Shared Mocks ─────────────────────────────────────────

function mockBus() {
  const handlers = new Map();
  const emitted = [];
  return {
    on(event, handler, opts) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push({ handler, opts });
    },
    emit(ev, d, opts) { emitted.push({ ev, d }); },
    fire(ev, d, opts) { emitted.push({ ev, d }); },
    handlers, emitted,
  };
}

function mockStorage() {
  const store = {};
  return {
    readJSON: (f, fb) => store[f] || fb,
    readJSONAsync: async (f) => store[f] || null,
    writeJSON: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    writeJSONDebounced: (f, d) => { store[f] = JSON.parse(JSON.stringify(d)); },
    store,
  };
}

function mockIntervals() {
  const registered = new Map();
  return {
    register(name, fn, ms) { registered.set(name, { fn, ms }); },
    clear(name) { registered.delete(name); },
    shutdown() { registered.clear(); },
    getStatus: () => ({}),
    registered,
  };
}

// ════════════════════════════════════════════════════════════
// AgentCoreBoot
// ════════════════════════════════════════════════════════════

describe('AgentCoreBoot — boot phase methods exist', () => {
  const { AgentCoreBoot } = require('../../src/agent/AgentCoreBoot');

  test('constructor accepts core object', () => {
    const boot = new AgentCoreBoot({ container: null, _bus: mockBus(), intervals: mockIntervals() });
    assert(boot._core, 'core reference stored');
  });

  test('has all boot phase methods', () => {
    const boot = new AgentCoreBoot({ container: null, _bus: mockBus(), intervals: mockIntervals() });
    assert(typeof boot._bootstrapInstances === 'function', '_bootstrapInstances exists');
    assert(typeof boot._registerFromManifest === 'function', '_registerFromManifest exists');
    assert(typeof boot._registerBiologicalAliases === 'function', '_registerBiologicalAliases exists');
    assert(typeof boot._resolveAndInit === 'function', '_resolveAndInit exists');
    assert(typeof boot._wireAndStart === 'function', '_wireAndStart exists');
  });
});

// ════════════════════════════════════════════════════════════
// AgentCoreWire — Declarative Event Bridge
// ════════════════════════════════════════════════════════════

describe('AgentCoreWire — declarative STATUS_BRIDGE', () => {
  const { AgentCoreWire } = require('../../src/agent/AgentCoreWire');

  test('_wireUIEvents builds STATUS_BRIDGE table', () => {
    const bus = mockBus();
    const core = {
      container: { resolve: () => ({}), has: () => false, tryResolve: () => null },
      _bus: bus,
      intervals: mockIntervals(),
      window: null,
    };
    const wire = new AgentCoreWire(core);
    wire._wireUIEvents();

    assert(wire._uiBridgeTable, 'STATUS_BRIDGE table exposed');
    assert(wire._uiBridgeTable.length >= 30, `Bridge has ${wire._uiBridgeTable.length} mappings (expected ≥30)`);
  });

  test('bridge table covers all architectural domains', () => {
    const bus = mockBus();
    const core = { container: { resolve: () => ({}), has: () => false, tryResolve: () => null }, _bus: bus, intervals: mockIntervals(), window: null };
    const wire = new AgentCoreWire(core);
    wire._wireUIEvents();

    const events = wire._uiBridgeTable.map(m => m.event);
    // Spot-check domain coverage
    assert(events.some(e => e.startsWith('homeostasis:')), 'organism domain');
    assert(events.some(e => e.startsWith('consciousness:')), 'consciousness domain');
    assert(events.some(e => e.startsWith('health:')), 'health domain');
    assert(events.some(e => e.startsWith('agent-loop:')), 'agentloop domain');
    assert(events.some(e => e.startsWith('metabolism:')), 'metabolism domain');
    assert(events.some(e => e.startsWith('cognitive:')), 'cognitive domain');
  });

  test('bridge uses key-based dedup on bus.on()', () => {
    const bus = mockBus();
    const core = { container: { resolve: () => ({}), has: () => false, tryResolve: () => null }, _bus: bus, intervals: mockIntervals(), window: null };
    const wire = new AgentCoreWire(core);
    wire._wireUIEvents();

    // Check that handlers were registered with keys
    for (const [event, entries] of bus.handlers) {
      for (const entry of entries) {
        if (entry.opts?.source === 'AgentCore:ui') {
          assert(entry.opts.key, `Handler for ${event} should have a key`);
          assert(entry.opts.key.startsWith('ui:'), `Key should start with ui: (got ${entry.opts.key})`);
        }
      }
    }
  });

  test('bridge handlers have error isolation', () => {
    const bus = mockBus();
    const sent = [];
    const core = {
      container: { resolve: () => ({}), has: () => false, tryResolve: () => null },
      _bus: bus, intervals: mockIntervals(),
      window: { isDestroyed: () => false, webContents: { send: (ch, d) => sent.push({ ch, d }) } },
    };
    const wire = new AgentCoreWire(core);
    wire._wireUIEvents();

    // Emit an event that triggers a detail function that would throw on undefined
    const handlers = bus.handlers.get('consciousness:insight');
    if (handlers && handlers.length > 0) {
      // Pass data without .description — should not throw, should be caught
      let threw = false;
      try {
        handlers[0].handler({});
      } catch (e) { threw = true; }
      assert(!threw, 'Handler should catch errors internally');
    }
  });
});

// ════════════════════════════════════════════════════════════
// WorldStateQueries — extracted query methods
// ════════════════════════════════════════════════════════════

describe('WorldStateQueries — prototype extension', () => {
  const { WorldState } = require('../../src/agent/foundation/WorldState');

  test('query methods applied to WorldState prototype', () => {
    const ws = new WorldState({ bus: mockBus(), storage: mockStorage(), rootDir: os.tmpdir() });
    const queryMethods = [
      'getProjectStructure', 'getGitStatus', 'getAvailableModels',
      'getOllamaStatus', 'getUserExpertise', 'getRecentTopics',
      'getRecentlyModified', 'getRuntime', 'getSystem', 'getFullState',
    ];
    for (const m of queryMethods) {
      assert(typeof ws[m] === 'function', `${m}() should exist on WorldState`);
    }
  });

  test('precondition methods applied to WorldState prototype', () => {
    const ws = new WorldState({ bus: mockBus(), storage: mockStorage(), rootDir: os.tmpdir() });
    const precondMethods = [
      'canWriteFile', 'isKernelFile', 'canRunTests',
      'canUseModel', 'canRunShell', 'isGitClean', 'hasFreeDiskSpace',
    ];
    for (const m of precondMethods) {
      assert(typeof ws[m] === 'function', `${m}() should exist on WorldState`);
    }
  });

  test('buildContextSlice works after extraction', () => {
    const ws = new WorldState({ bus: mockBus(), storage: mockStorage(), rootDir: os.tmpdir() });
    const ctx = ws.buildContextSlice(['system']);
    assert(typeof ctx === 'string', 'buildContextSlice returns string');
    assert(ctx.includes('SYSTEM:'), 'contains system info');
  });

  test('canWriteFile blocks kernel paths', () => {
    const ws = new WorldState({ bus: mockBus(), storage: mockStorage(), rootDir: os.tmpdir() });
    // node_modules should be blocked
    assert(!ws.canWriteFile(path.join(os.tmpdir(), 'node_modules', 'foo.js')), 'node_modules blocked');
    // .git should be blocked
    assert(!ws.canWriteFile(path.join(os.tmpdir(), '.git', 'config')), '.git blocked');
    // Normal file should be allowed
    assert(ws.canWriteFile(path.join(os.tmpdir(), 'src', 'test.js')), 'normal file allowed');
  });

  test('getRuntime includes uptime', () => {
    const ws = new WorldState({ bus: mockBus(), storage: mockStorage(), rootDir: os.tmpdir() });
    const rt = ws.getRuntime();
    assert(typeof rt.uptime === 'number', 'uptime is number');
    assert(rt.uptime >= 0, 'uptime is non-negative');
  });
});

// ════════════════════════════════════════════════════════════
// HomeostasisEffectors — organism corrections
// ════════════════════════════════════════════════════════════

describe('HomeostasisEffectors — construction and lifecycle', () => {
  const { HomeostasisEffectors } = require('../../src/agent/organism/HomeostasisEffectors');

  test('constructs with minimal dependencies', () => {
    const eff = new HomeostasisEffectors({ bus: mockBus(), storage: mockStorage() });
    assert(eff, 'instance created');
    assert(typeof eff.stop === 'function', 'has stop()');
    assert(typeof eff.getReport === 'function', 'has getReport()');
  });

  test('stop clears timers without error', () => {
    const eff = new HomeostasisEffectors({ bus: mockBus(), storage: mockStorage() });
    let ok = true;
    try { eff.stop(); } catch (e) { ok = false; }
    assert(ok, 'stop() does not throw');
  });

  test('getReport returns structured data', () => {
    const eff = new HomeostasisEffectors({ bus: mockBus(), storage: mockStorage() });
    const report = eff.getReport();
    assert(typeof report === 'object', 'report is object');
  });

  test('has containerConfig with correct phase', () => {
    assert(HomeostasisEffectors.containerConfig, 'has containerConfig');
    assertEqual(HomeostasisEffectors.containerConfig.phase, 7);
    assert(HomeostasisEffectors.containerConfig.tags.includes('organism'), 'tagged organism');
  });
});

run();
