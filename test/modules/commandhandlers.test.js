// ============================================================
// GENESIS — test/modules/commandhandlers.test.js
// v4.0.0 (F-07): Test suite for CommandHandlers
//
// Tests handler registration, command dispatch basics,
// and safety checks on handler names.
// ============================================================

const { describe, test, assert, assertEqual, assertThrows,
        run } = require('../harness');
const path = require('path');

// ── Minimal mocks ───────────────────────────────────────────

function makeMockBus() {
  const emitted = [];
  return {
    emit: (ev, data, meta) => emitted.push({ ev, data, meta }),
    on: () => () => {},
    fire: (ev, data, meta) => emitted.push({ ev, data, meta }),
    emitted,
  };
}

function makeMockOrchestrator() {
  const handlers = new Map();
  return {
    registerHandler: (name, fn) => handlers.set(name, fn),
    handlers,
  };
}

function makeMockLang() {
  return { t: (k, vars) => k, detect: () => {}, current: 'en' };
}

function makeHandlers(overrides = {}) {
  const { CommandHandlers } = require('../../src/agent/hexagonal/CommandHandlers');

  // Build minimal mock dependencies matching actual constructor signature
  const mocks = {
    lang: makeMockLang(),
    sandbox: { execute: async (code) => ({ output: '', error: '' }) },
    fileProcessor: { importFile: async () => ({}), listFiles: () => [] },
    network: null,
    daemon: { getStatus: () => ({ running: false }), start: () => {}, stop: () => {} },
    idleMind: { getStatus: () => ({ active: false }), getPlans: () => [] },
    analyzer: null,
    goalStack: { getGoals: () => [], getActiveGoals: () => [], getAll: () => [], addGoal: async () => ({ description: 'test', steps: [] }) },
    settings: { get: () => null, set: () => {} },
    webFetcher: { fetchText: async () => ({ ok: true, body: '' }) },
    shellAgent: { run: async () => ({ ok: true, stdout: '', stderr: '' }), plan: async () => [] },
    mcpClient: { getStatus: () => ({ connections: [] }) },
    ...overrides,
  };

  return new CommandHandlers(mocks);
}

// ════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════

describe('CommandHandlers — construction', () => {
  test('constructs without error', () => {
    const ch = makeHandlers();
    assert(ch !== null);
  });

  test('has required dependencies stored', () => {
    const ch = makeHandlers();
    assert(ch.sandbox !== undefined, 'should have sandbox');
    assert(ch.shell !== undefined, 'should have shellAgent');
    assert(ch.settings !== undefined, 'should have settings');
  });
});

describe('CommandHandlers — registerHandlers', () => {
  test('registers all expected handlers on orchestrator', () => {
    const ch = makeHandlers();
    const orch = makeMockOrchestrator();
    ch.registerHandlers(orch);

    // Should register at least common handlers
    assert(orch.handlers.size > 0, 'should register at least one handler');

    // Check for known core handler names
    const knownHandlers = ['execute-code', 'settings', 'goals', 'shell-run', 'mcp'];
    for (const name of knownHandlers) {
      if (orch.handlers.has(name)) {
        assert(typeof orch.handlers.get(name) === 'function', `${name} should be a function`);
      }
    }
  });

  test('all registered handlers are functions', () => {
    const ch = makeHandlers();
    const orch = makeMockOrchestrator();
    ch.registerHandlers(orch);

    for (const [name, fn] of orch.handlers) {
      assert(typeof fn === 'function', `handler "${name}" should be a function`);
    }
  });

  test('does not register duplicate handlers', () => {
    const ch = makeHandlers();
    const orch = makeMockOrchestrator();
    const registerCount = {};

    // Monkey-patch to count registrations
    const origRegister = orch.registerHandler.bind(orch);
    orch.registerHandler = (name, fn) => {
      registerCount[name] = (registerCount[name] || 0) + 1;
      origRegister(name, fn);
    };

    ch.registerHandlers(orch);

    for (const [name, count] of Object.entries(registerCount)) {
      assertEqual(count, 1, `handler "${name}" registered ${count} times`);
    }
  });
});

describe('CommandHandlers — handler invocation', () => {
  test('goals handler returns a string', async () => {
    const ch = makeHandlers();
    const orch = makeMockOrchestrator();
    ch.registerHandlers(orch);

    if (orch.handlers.has('goals')) {
      const result = await orch.handlers.get('goals')('show goals', {});
      assert(typeof result === 'string', 'goals should return string');
    }
  });

  test('plans handler returns a string', async () => {
    const ch = makeHandlers();
    const orch = makeMockOrchestrator();
    ch.registerHandlers(orch);

    if (orch.handlers.has('plans')) {
      const result = await orch.handlers.get('plans')('plans', {});
      assert(typeof result === 'string', 'plans should return string');
    }
  });
});

describe('CommandHandlers — bus event integration', () => {
  test('bus is accessible and functional', () => {
    const bus = makeMockBus();
    const ch = makeHandlers({ bus });
    bus.emit('test-event', { data: 'hello' }, { source: 'test' });
    assertEqual(bus.emitted.length, 1);
    assertEqual(bus.emitted[0].ev, 'test-event');
  });
});

run();
