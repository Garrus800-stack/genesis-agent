// Test: v6.1.0 — SelfModificationPipeline gate statistics
// Verifies that all self-modification gates (circuit breaker,
// consciousness, energy) are counted and exposed via getGateStats().

const { describe, test, assert, assertEqual, run } = require('../harness');
const { SelfModificationPipeline } = require('../../src/agent/hexagonal/SelfModificationPipeline');

function mockBus() {
  return { on: () => () => {}, emit() {}, fire() {}, off() {} };
}

function createPipeline(overrides = {}) {
  return new SelfModificationPipeline({
    bus: mockBus(),
    lang: { t: k => k, detect: () => {}, current: 'en' },
    selfModel: null, model: null, prompts: null, sandbox: null,
    reflector: null, skills: null, cloner: null, reasoning: null,
    hotReloader: null, guard: null, tools: null, eventStore: null,
    rootDir: '/tmp', astDiff: null,
    ...overrides,
  });
}

describe('GateStats — initial state', () => {
  test('all counters start at zero', () => {
    const p = createPipeline();
    const stats = p.getGateStats();
    assertEqual(stats.totalAttempts, 0);
    assertEqual(stats.passed, 0);
    assertEqual(stats.consciousnessBlocked, 0);
    assertEqual(stats.energyBlocked, 0);
    assertEqual(stats.circuitBreakerBlocked, 0);
    assertEqual(stats.blockRate, 0);
    assertEqual(stats.consciousnessBlockRate, 0);
    assert(stats.lastBlockedAt === null, 'lastBlockedAt should be null');
    assert(stats.lastCoherence === null, 'lastCoherence should be null');
  });
});

describe('GateStats — circuit breaker', () => {
  test('frozen pipeline increments circuitBreakerBlocked', async () => {
    const p = createPipeline();
    // Force freeze
    p._frozen = true;
    p._frozenReason = 'test';
    p._consecutiveFailures = 3;

    await p.modify('test modification');

    const stats = p.getGateStats();
    assertEqual(stats.totalAttempts, 1);
    assertEqual(stats.circuitBreakerBlocked, 1);
    assertEqual(stats.passed, 0);
    assertEqual(stats.blockRate, 100);
  });
});

describe('GateStats — consciousness gate', () => {
  test('low coherence increments consciousnessBlocked', async () => {
    const p = createPipeline();
    // Bind a phenomenal field with low coherence
    p._awareness = {
      getCoherence: () => 0.2,
    };

    await p.modify('test modification');

    const stats = p.getGateStats();
    assertEqual(stats.totalAttempts, 1);
    assertEqual(stats.consciousnessBlocked, 1);
    assertEqual(stats.passed, 0);
    assertEqual(stats.consciousnessBlockRate, 100);
    assert(stats.lastBlockedAt !== null, 'lastBlockedAt should be set');
    assert(typeof stats.lastCoherence === 'number', 'lastCoherence should be set');
  });

  test('high coherence does NOT block', async () => {
    const p = createPipeline();
    p._awareness = {
      getCoherence: () => 0.8,
    };
    // Will fail downstream (no model), but consciousness gate should pass
    try { await p.modify('test modification'); } catch (_e) { /* expected — no model */ }

    const stats = p.getGateStats();
    assertEqual(stats.consciousnessBlocked, 0);
    assertEqual(stats.passed, 1, 'should have passed all gates');
  });
});

describe('GateStats — energy gate', () => {
  test('insufficient energy increments energyBlocked', async () => {
    const p = createPipeline();
    p._metabolism = {
      canAfford: () => false,
      getEnergyLevel: () => ({ current: 10, max: 100 }),
    };

    await p.modify('test modification');

    const stats = p.getGateStats();
    assertEqual(stats.totalAttempts, 1);
    assertEqual(stats.energyBlocked, 1);
    assertEqual(stats.passed, 0);
  });
});

describe('GateStats — blockRate computation', () => {
  test('mixed blocks compute correct rates', async () => {
    const p = createPipeline();

    // 1: consciousness block
    p._awareness = { getCoherence: () => 0.1 };
    await p.modify('test1');

    // 2: circuit breaker block
    p._awareness = null;
    p._frozen = true;
    p._frozenReason = 'test';
    await p.modify('test2');

    // 3: energy block
    p._frozen = false;
    p._metabolism = {
      canAfford: () => false,
      getEnergyLevel: () => ({ current: 0, max: 100 }),
    };
    await p.modify('test3');

    const stats = p.getGateStats();
    assertEqual(stats.totalAttempts, 3);
    assertEqual(stats.consciousnessBlocked, 1);
    assertEqual(stats.circuitBreakerBlocked, 1);
    assertEqual(stats.energyBlocked, 1);
    assertEqual(stats.passed, 0);
    assertEqual(stats.blockRate, 100);
    // consciousness = 1/3 ≈ 33.33%
    assert(stats.consciousnessBlockRate > 33 && stats.consciousnessBlockRate < 34,
      `consciousnessBlockRate should be ~33.33, got ${stats.consciousnessBlockRate}`);
  });
});

describe('GateStats — awarenessActive (v7.0.0)', () => {
  test('awarenessActive is false when no awareness wired', () => {
    const p = createPipeline();
    // _awareness is null by default
    assertEqual(p.getGateStats().awarenessActive, false);
  });

  test('awarenessActive is false for NullAwareness (getReport().active === false)', () => {
    const p = createPipeline();
    p._awareness = {
      getCoherence: () => 1.0,
      getReport: () => ({ active: false, coherence: 1.0, mode: 'diffuse' }),
    };
    assertEqual(p.getGateStats().awarenessActive, false);
  });

  test('awarenessActive is true for a real awareness implementation', () => {
    const p = createPipeline();
    p._awareness = {
      getCoherence: () => 0.85,
      getReport: () => ({ active: true, coherence: 0.85, mode: 'focused' }),
    };
    assertEqual(p.getGateStats().awarenessActive, true);
  });

  test('awarenessActive is false when getReport is not available', () => {
    const p = createPipeline();
    // Awareness without getReport — safe fallback
    p._awareness = { getCoherence: () => 1.0 };
    assertEqual(p.getGateStats().awarenessActive, false);
  });

  test('awarenessActive present alongside all existing counter fields', () => {
    const p = createPipeline();
    const stats = p.getGateStats();
    assert('awarenessActive' in stats, 'awarenessActive should be in stats');
    assert('blockRate' in stats, 'blockRate should still be present');
    assert('consciousnessBlockRate' in stats, 'consciousnessBlockRate should still be present');
    assert('totalAttempts' in stats, 'totalAttempts should still be present');
  });
});

run();
